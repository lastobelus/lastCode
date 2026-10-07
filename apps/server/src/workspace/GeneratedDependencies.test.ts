import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as TestClock from "effect/testing/TestClock";
import {
  DEFAULT_SERVER_SETTINGS,
  OrchestrationV2ThreadShell,
  OrchestrationV2AppThreadJson,
  OrchestrationV2ProviderSessionJson,
  OrchestrationV2DomainEvent,
  ProjectId,
  ThreadId,
  type ServerSettings,
  type TerminalSummary,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Observe native measurement reads without exposing a test-only service API.
import * as NodeFSP from "node:fs/promises";

import * as ServerConfig from "../config.ts";
import { PersistedServerRuntimeState } from "../serverRuntimeState.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GeneratedDependencies from "./GeneratedDependencies.ts";
import * as StorageCleanup from "../storageCleanup.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Settings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as PreviewHosting from "../preview/Hosting.ts";
import * as GitManager from "../git/GitManager.ts";
import * as ServerActivation from "../serverActivation.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof NodeFSP>();
  return { ...original, opendir: vi.fn(original.opendir), rm: vi.fn(original.rm) };
});

const encodeRuntimeState = Schema.encodeSync(Schema.fromJsonString(PersistedServerRuntimeState));

const testLayer = (
  processCwds: Effect.Effect<ReadonlyArray<string> | null> = Effect.succeed([]),
  onDependencyInspection: () => void = () => undefined,
) => {
  const gitLayer = Layer.effect(
    GitVcsDriver.GitVcsDriver,
    Effect.gen(function* () {
      const git = yield* GitVcsDriver.GitVcsDriver;
      return {
        ...git,
        execute: (request: Parameters<typeof git.execute>[0]) =>
          Effect.gen(function* () {
            if (request.operation === "GeneratedDependencies.inspect") onDependencyInspection();
            return yield* git.execute(request);
          }),
      };
    }),
  ).pipe(Layer.provide(GitVcsDriver.layer));
  return GeneratedDependencies.layer.pipe(
    Layer.provideMerge(gitLayer),
    Layer.provide(VcsProcess.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-dependencies-test-" })),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Layer.succeed(GeneratedDependencies.ProcessWorkingDirectories, processCwds)),
  );
};

const fixture = Effect.fn("test.dependencyFixture")(function* (manager: "npm" | "pnpm" = "pnpm") {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const cleanup = yield* GeneratedDependencies.GeneratedDependencies;
  const remove = (
    inspection: Parameters<typeof cleanup.removeBatch>[0][number]["inspection"],
    canRemove: Effect.Effect<boolean>,
  ) =>
    cleanup
      .removeBatch([{ inspection, canRemove }])
      .pipe(Effect.map((removed) => removed[0] ?? null));
  const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dependencies-" });
  // /tmp is itself a symlink on macOS; candidates must use the actual path.
  const root = yield* fs.realPath(temporary);
  const repository = path.join(root, "repository");
  const managedWorktreesRoot = path.join(root, "worktrees");
  const worktreePath = path.join(managedWorktreesRoot, "feature");
  yield* fs.makeDirectory(repository);
  yield* fs.makeDirectory(managedWorktreesRoot);
  const runGit = (cwd: string, args: ReadonlyArray<string>) =>
    git.execute({
      operation: "test.GeneratedDependencies",
      cwd,
      args,
    });
  yield* runGit(repository, ["init"]);
  yield* fs.writeFileString(
    path.join(repository, "package.json"),
    '{"name":"fixture","private":true}\n',
  );
  const lock = manager === "pnpm" ? "pnpm-lock.yaml" : "package-lock.json";
  const marker = manager === "pnpm" ? ".modules.yaml" : ".package-lock.json";
  yield* fs.writeFileString(
    path.join(repository, lock),
    manager === "pnpm" ? "lockfileVersion: 9\n" : "{}\n",
  );
  yield* fs.writeFileString(
    path.join(repository, ".gitignore"),
    "node_modules/\ntmp/\nresearch/\n.repos/\nbuild/\ndist/\nvendor/\n",
  );
  yield* fs.writeFileString(path.join(repository, "source.ts"), "export const value = 1;\n");
  yield* runGit(repository, ["add", "."]);
  yield* runGit(repository, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "fixture",
  ]);
  yield* runGit(repository, ["worktree", "add", "-b", "feature", worktreePath]);
  const dependencyPath = path.join(worktreePath, "node_modules");
  yield* fs.makeDirectory(path.join(dependencyPath, "package"), { recursive: true });
  yield* fs.writeFileString(
    path.join(dependencyPath, marker),
    manager === "pnpm" ? "layoutVersion: 5\n" : "{}\n",
  );
  yield* fs.writeFileString(
    path.join(dependencyPath, "package", "index.js"),
    "module.exports = 1;\n",
  );
  const input = { managedWorktreesRoot, repositoryRoot: repository, worktreePath };
  return {
    fs,
    path,
    cleanup: { ...cleanup, remove },
    root,
    repository,
    input,
    dependencyPath,
    marker,
    lock,
    runGit,
  };
});

it.effect.each(["pnpm", "npm"] as const)(
  "removes a recognized %s install while preserving dirty source and unrelated ignored files",
  (manager) =>
    Effect.gen(function* () {
      const { path, fs, cleanup, input, dependencyPath } = yield* fixture(manager);
      const protectedFiles = [
        "source.ts",
        "tmp/notes.md",
        "research/data.txt",
        ".repos/vendor.txt",
        "vendor/local.txt",
        "build/output.txt",
        "dist/output.txt",
        "nested/node_modules/user.txt",
      ];
      for (const relative of protectedFiles) {
        const target = path.join(input.worktreePath, relative);
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        yield* fs.writeFileString(target, `preserve ${relative}`);
      }
      const inspected = yield* cleanup.inspect(input);
      assert.isNotNull(inspected);
      assert.equal(inspected!.packageManager, manager);
      assert.isAbove(inspected!.estimatedReclaimedBytes, 0);
      assert.isTrue(yield* fs.exists(dependencyPath));
      assert.isNotNull(yield* cleanup.remove(inspected!, Effect.succeed(true)));
      assert.isFalse(yield* fs.exists(dependencyPath));
      for (const relative of protectedFiles)
        assert.equal(
          yield* fs.readFileString(path.join(input.worktreePath, relative)),
          `preserve ${relative}`,
        );
      assert.isTrue(yield* fs.exists(path.join(input.worktreePath, ".git")));
    }).pipe(Effect.scoped, Effect.provide(testLayer())),
);

it.effect("never follows dependency links into outside files or a pnpm store", () =>
  Effect.gen(function* () {
    const { path, fs, cleanup, root, input, dependencyPath } = yield* fixture();
    const outside = path.join(root, "store");
    yield* fs.makeDirectory(outside);
    yield* fs.writeFileString(path.join(outside, "data"), "user data");
    yield* fs.symlink(outside, path.join(dependencyPath, "linked-package"));
    yield* fs.symlink(path.join(outside, "missing"), path.join(dependencyPath, "broken-link"));
    const inspected = yield* cleanup.inspect(input);
    assert.isNotNull(inspected);
    assert.isNotNull(yield* cleanup.remove(inspected!, Effect.succeed(true)));
    assert.equal(yield* fs.readFileString(path.join(outside, "data")), "user data");
  }).pipe(Effect.scoped, Effect.provide(testLayer())),
);

it.effect("retains a same-branch install belonging to another project repository", () =>
  Effect.gen(function* () {
    const candidate = yield* fixture();
    const expected = yield* fixture();
    assert.equal(
      (yield* candidate.runGit(candidate.input.worktreePath, ["branch", "--show-current"])).stdout,
      (yield* expected.runGit(expected.input.worktreePath, ["branch", "--show-current"])).stdout,
    );
    assert.isNull(
      yield* candidate.cleanup.inspect({ ...candidate.input, repositoryRoot: expected.repository }),
    );
    assert.isTrue(yield* candidate.fs.exists(candidate.dependencyPath));
  }).pipe(Effect.scoped, Effect.provide(testLayer())),
);

it.effect.each(["repository-subdirectory", "linked-worktree", "linked-subdirectory"] as const)(
  "recognizes the expected repository through %s",
  (location) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const root = location === "repository-subdirectory" ? f.repository : f.input.worktreePath;
      const repositoryRoot = location === "linked-worktree" ? root : f.path.join(root, "nested");
      yield* f.fs.makeDirectory(repositoryRoot, { recursive: true });
      const inspected = yield* f.cleanup.inspect({ ...f.input, repositoryRoot });
      assert.isNotNull(inspected);
      assert.isNotNull(yield* f.cleanup.remove(inspected!, Effect.succeed(true)));
      assert.isFalse(yield* f.fs.exists(f.dependencyPath));
    }).pipe(Effect.scoped, Effect.provide(testLayer())),
);

it.effect("retains an install when the expected repository cannot be resolved", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    assert.isNull(yield* f.cleanup.inspect({ ...f.input, repositoryRoot: f.root }));
    assert.isTrue(yield* f.fs.exists(f.dependencyPath));
  }).pipe(Effect.scoped, Effect.provide(testLayer())),
);

it.effect.each(["stdoutTruncated", "stderrTruncated"] as const)(
  "retains an inspected install when expected repository metadata is truncated (%s)",
  (truncation) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const inspected = yield* f.cleanup.inspect(f.input);
      assert.isNotNull(inspected);
      const git = yield* GitVcsDriver.GitVcsDriver;
      const execute = git.execute;
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi
            .spyOn(git, "execute")
            .mockImplementation((request) =>
              execute(request).pipe(
                Effect.map((result) =>
                  request.cwd === f.repository && request.args[1] === "--git-common-dir"
                    ? { ...result, [truncation]: true }
                    : result,
                ),
              ),
            ),
        ),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
      assert.isNull(yield* f.cleanup.remove(inspected!, Effect.succeed(true)));
      assert.isTrue(yield* f.fs.exists(f.dependencyPath));
    }).pipe(Effect.scoped, Effect.provide(testLayer())),
);

it.effect.each(["repository", "linked-worktree"] as const)(
  "rechecks repository association before removal (expected %s)",
  (location) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const replacement = yield* fixture();
      const repositoryRoot = location === "repository" ? f.repository : f.input.worktreePath;
      const inspected = yield* f.cleanup.inspect({ ...f.input, repositoryRoot });
      assert.isNotNull(inspected);
      // Change only Git ownership, retaining the measured dependency directory's identity.
      const replacementGitFile = yield* f.fs.readFileString(
        f.path.join(replacement.input.worktreePath, ".git"),
      );
      yield* f.fs.writeFileString(f.path.join(f.input.worktreePath, ".git"), replacementGitFile);
      assert.isNull(yield* f.cleanup.remove(inspected!, Effect.succeed(true)));
      assert.isTrue(yield* f.fs.exists(f.path.join(f.dependencyPath, "package/index.js")));
    }).pipe(Effect.scoped, Effect.provide(testLayer())),
);

it.effect("measures an install once across inspection and removal", () =>
  Effect.gen(function* () {
    const { fs, cleanup, input, dependencyPath } = yield* fixture();
    const opendir = vi.mocked(NodeFSP.opendir);
    const rootReads = () =>
      opendir.mock.calls.filter(([target]) => target === dependencyPath).length;
    const inspected = yield* cleanup.inspect(input);
    assert.isNotNull(inspected);
    assert.equal(rootReads(), 1);
    const removed = yield* cleanup.remove(inspected!, Effect.succeed(true));
    assert.isNotNull(removed);
    assert.equal(removed!.estimatedReclaimedBytes, inspected!.estimatedReclaimedBytes);
    assert.equal(rootReads(), 1);
    assert.isFalse(yield* fs.exists(dependencyPath));
  }).pipe(Effect.scoped, Effect.provide(testLayer())),
);

it.effect.each(["tracked-content", "untracked-lock", "unignored"] as const)(
  "retains an install when Git ownership changes after inspection (%s)",
  (change) =>
    Effect.gen(function* () {
      const { path, fs, cleanup, input, dependencyPath, runGit, lock } = yield* fixture();
      const inspected = yield* cleanup.inspect(input);
      assert.isNotNull(inspected);
      if (change === "tracked-content")
        yield* runGit(input.worktreePath, ["add", "-f", "node_modules/package/index.js"]);
      else if (change === "untracked-lock")
        yield* runGit(input.worktreePath, ["rm", "--cached", lock]);
      else
        yield* fs.writeFileString(path.join(input.worktreePath, ".gitignore"), "!node_modules/\n");
      assert.isNull(yield* cleanup.remove(inspected!, Effect.succeed(true)));
      assert.isTrue(yield* fs.exists(path.join(dependencyPath, "package/index.js")));
    }).pipe(Effect.scoped, Effect.provide(testLayer())),
);

it.effect("retains an install when the latest activity/policy guard changes", () =>
  Effect.gen(function* () {
    const { fs, cleanup, input, dependencyPath } = yield* fixture();
    const inspected = yield* cleanup.inspect(input);
    assert.isNotNull(inspected);
    assert.isNull(yield* cleanup.remove(inspected!, Effect.succeed(false)));
    assert.isTrue(yield* fs.exists(dependencyPath));
  }).pipe(Effect.scoped, Effect.provide(testLayer())),
);

it.effect("retains tracked content within an otherwise ignored dependency install", () =>
  Effect.gen(function* () {
    const { cleanup, input, runGit } = yield* fixture();
    yield* runGit(input.worktreePath, ["add", "-f", "node_modules/package/index.js"]);
    assert.isNull(yield* cleanup.inspect(input));
  }).pipe(Effect.scoped, Effect.provide(testLayer())),
);

it.effect("retains unrecognized and unignored directories", () =>
  Effect.gen(function* () {
    const { path, fs, cleanup, input, dependencyPath, marker } = yield* fixture();
    yield* fs.remove(path.join(dependencyPath, marker));
    assert.isNull(yield* cleanup.inspect(input));
    yield* fs.writeFileString(path.join(dependencyPath, marker), "layoutVersion: 5\n");
    yield* fs.writeFileString(path.join(input.worktreePath, ".gitignore"), "!node_modules/\n");
    assert.isNull(yield* cleanup.inspect(input));
  }).pipe(Effect.scoped, Effect.provide(testLayer())),
);

it.effect("requires a tracked regular manifest and lockfile", () =>
  Effect.gen(function* () {
    const { path, fs, cleanup, input, runGit, lock } = yield* fixture();
    yield* runGit(input.worktreePath, ["rm", "--cached", lock]);
    assert.isNull(yield* cleanup.inspect(input));
    yield* runGit(input.worktreePath, ["add", lock]);
    yield* fs.remove(path.join(input.worktreePath, "package.json"));
    yield* fs.symlink(lock, path.join(input.worktreePath, "package.json"));
    assert.isNull(yield* cleanup.inspect(input));
  }).pipe(Effect.scoped, Effect.provide(testLayer())),
);

it.effect("rejects a symlinked marker or dependency root", () =>
  Effect.gen(function* () {
    const { path, fs, cleanup, root, input, dependencyPath, marker } = yield* fixture();
    const markerPath = path.join(dependencyPath, marker);
    yield* fs.remove(markerPath);
    yield* fs.symlink(path.join(input.worktreePath, "pnpm-lock.yaml"), markerPath);
    assert.isNull(yield* cleanup.inspect(input));
    yield* fs.remove(markerPath);
    yield* fs.writeFileString(markerPath, "layoutVersion: 5\n");
    const moved = path.join(root, "moved-install");
    yield* fs.rename(dependencyPath, moved);
    yield* fs.symlink(moved, dependencyPath);
    assert.isNull(yield* cleanup.inspect(input));
    assert.isTrue(yield* fs.exists(path.join(moved, "package/index.js")));
  }).pipe(Effect.scoped, Effect.provide(testLayer())),
);

it.effect("rejects symlinked ancestors and checkout paths outside the managed root", () =>
  Effect.gen(function* () {
    const { path, fs, cleanup, root, input } = yield* fixture();
    const alias = path.join(root, "alias");
    yield* fs.symlink(input.managedWorktreesRoot, alias);
    assert.isNull(
      yield* cleanup.inspect({
        repositoryRoot: input.repositoryRoot,
        managedWorktreesRoot: alias,
        worktreePath: path.join(alias, "feature"),
      }),
    );
    assert.isNull(
      yield* cleanup.inspect({ ...input, managedWorktreesRoot: path.join(root, "elsewhere") }),
    );
  }).pipe(Effect.scoped, Effect.provide(testLayer())),
);

it.effect("revalidates markers and directory identity after inspection", () =>
  Effect.gen(function* () {
    const { path, fs, cleanup, input, dependencyPath, marker } = yield* fixture();
    const inspected = yield* cleanup.inspect(input);
    assert.isNotNull(inspected);
    yield* fs.remove(path.join(dependencyPath, marker));
    assert.isNull(yield* cleanup.remove(inspected!, Effect.succeed(true)));
    yield* fs.writeFileString(path.join(dependencyPath, marker), "layoutVersion: 5\n");
    const displaced = `${dependencyPath}-displaced`;
    yield* fs.rename(dependencyPath, displaced);
    yield* fs.makeDirectory(dependencyPath);
    yield* fs.writeFileString(path.join(dependencyPath, marker), "layoutVersion: 5\n");
    assert.isNull(yield* cleanup.remove(inspected!, Effect.succeed(true)));
    assert.isTrue(yield* fs.exists(displaced));
    assert.isTrue(yield* fs.exists(dependencyPath));
  }).pipe(Effect.scoped, Effect.provide(testLayer())),
);

it.effect("fails closed when dependency measurement exceeds its traversal bound", () =>
  Effect.gen(function* () {
    const { fs, path, cleanup, input, dependencyPath } = yield* fixture();
    const deep = path.join(dependencyPath, ...Array.from({ length: 66 }, () => "d"));
    yield* fs.makeDirectory(deep, { recursive: true });
    yield* fs.writeFileString(path.join(deep, "data"), "preserve");
    assert.isNull(yield* cleanup.inspect(input));
  }).pipe(Effect.scoped, Effect.provide(testLayer())),
);

it.effect("preserves a worktree's live dev runtime even when its process cwd is elsewhere", () =>
  Effect.gen(function* () {
    const { path, fs, cleanup, input, dependencyPath } = yield* fixture();
    const stateDir = path.join(input.worktreePath, ".t3", "userdata");
    yield* fs.makeDirectory(stateDir, { recursive: true });
    yield* fs.writeFileString(
      path.join(stateDir, "server-runtime.json"),
      encodeRuntimeState({
        version: 1,
        pid: process.pid,
        port: 12345,
        origin: "http://localhost:12345",
        startedAt: "2026-06-01T00:00:00.000Z",
      }),
    );
    const inspected = yield* cleanup.inspect(input);
    assert.isNotNull(inspected);
    assert.isNull(yield* cleanup.remove(inspected!, Effect.succeed(true)));
    assert.isTrue(yield* fs.exists(dependencyPath));
  }).pipe(Effect.scoped, Effect.provide(testLayer())),
);

it.effect(
  "preserves shared pnpm store hardlinks and excludes them from estimated reclaimed bytes",
  () =>
    Effect.gen(function* () {
      const { path, fs, cleanup, root, input, dependencyPath } = yield* fixture();
      const storeFile = path.join(root, "store-file");
      yield* fs.writeFileString(storeFile, "x".repeat(128 * 1024));
      yield* fs.link(storeFile, path.join(dependencyPath, "shared-file"));
      const inspected = yield* cleanup.inspect(input);
      assert.isNotNull(inspected);
      assert.isBelow(inspected!.estimatedReclaimedBytes, 128 * 1024);
      assert.isNotNull(yield* cleanup.remove(inspected!, Effect.succeed(true)));
      assert.equal((yield* fs.readFileString(storeFile)).length, 128 * 1024);
    }).pipe(Effect.scoped, Effect.provide(testLayer())),
);

const inspectedBatchFixture = Effect.fn("test.inspectedBatchFixture")(function* () {
  const f = yield* fixture();
  yield* f.fs.makeDirectory(f.path.join(f.input.worktreePath, "tmp"));
  yield* f.fs.writeFileString(f.path.join(f.input.worktreePath, "tmp/notes.md"), "private notes");
  yield* f.fs.writeFileString(f.path.join(f.input.worktreePath, "source.ts"), "unfinished source");
  const inspection = yield* f.cleanup.inspect(f.input);
  assert.isNotNull(inspection);
  return { ...f, inspection: inspection! };
});

const assertBatchWorkspacePreserved = Effect.fn("test.assertBatchWorkspacePreserved")(function* (
  f: Effect.Success<ReturnType<typeof inspectedBatchFixture>>,
) {
  assert.equal(
    yield* f.fs.readFileString(f.path.join(f.input.worktreePath, "source.ts")),
    "unfinished source",
  );
  assert.equal(
    yield* f.fs.readFileString(f.path.join(f.input.worktreePath, "tmp/notes.md")),
    "private notes",
  );
  assert.isTrue(yield* f.fs.exists(f.path.join(f.input.worktreePath, ".git")));
});

it.effect(
  "a delayed dependency deletion lets its sibling finish its final guard and deletion",
  () =>
    Effect.gen(function* () {
      const first = yield* inspectedBatchFixture();
      const second = yield* inspectedBatchFixture();
      const delayedStarted = yield* Deferred.make<void>();
      const siblingFinished = yield* Deferred.make<void>();
      const releaseDeletion = yield* Deferred.make<void>();
      let releaseNativeDeletion = (): void => undefined;
      const nativeDeletionGate = new Promise<void>((resolve) => {
        releaseNativeDeletion = resolve;
      });
      const release = Deferred.succeed(releaseDeletion, undefined).pipe(
        Effect.andThen(Effect.sync(() => releaseNativeDeletion())),
      );
      let siblingGuarded = false;
      const rm = vi.mocked(NodeFSP.rm);
      const original = rm.getMockImplementation()!;
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          rm.mockImplementation(async (...args) => {
            if (args[0] === first.dependencyPath) {
              Deferred.doneUnsafe(delayedStarted, Effect.void);
              await nativeDeletionGate;
            }
            await original(...args);
            if (args[0] === second.dependencyPath)
              Deferred.doneUnsafe(siblingFinished, Effect.void);
          });
        }),
        () => Effect.sync(() => rm.mockImplementation(original)),
      );
      yield* Effect.gen(function* () {
        const removal = yield* first.cleanup
          .removeBatch([
            { inspection: first.inspection, canRemove: Effect.succeed(true) },
            {
              inspection: second.inspection,
              canRemove: Effect.sync(() => {
                siblingGuarded = true;
                return true;
              }),
            },
          ])
          .pipe(Effect.forkScoped);
        yield* Deferred.await(delayedStarted);
        yield* Deferred.await(siblingFinished);
        assert.isTrue(siblingGuarded);
        assert.isTrue(yield* first.fs.exists(first.dependencyPath));
        assert.isFalse(yield* second.fs.exists(second.dependencyPath));
        assert.isFalse(yield* Deferred.isDone(releaseDeletion));
        yield* release;
        assert.lengthOf(yield* Fiber.join(removal), 2);
        assert.isFalse(yield* first.fs.exists(first.dependencyPath));
      }).pipe(Effect.ensuring(release));
      yield* assertBatchWorkspacePreserved(first);
      yield* assertBatchWorkspacePreserved(second);
    }).pipe(Effect.scoped, Effect.provide(testLayer())),
);

it.effect("one dependency removal error leaves its sibling eligible for deletion", () =>
  Effect.gen(function* () {
    const first = yield* inspectedBatchFixture();
    const second = yield* inspectedBatchFixture();
    const rm = vi.mocked(NodeFSP.rm);
    const original = rm.getMockImplementation()!;
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        rm.mockImplementation(async (...args) => {
          if (args[0] === first.dependencyPath) throw new Error("Fixture removal failure");
          return await original(...args);
        });
      }),
      () => Effect.sync(() => rm.mockImplementation(original)),
    );
    const removed = yield* first.cleanup.removeBatch([
      { inspection: first.inspection, canRemove: Effect.succeed(true) },
      { inspection: second.inspection, canRemove: Effect.succeed(true) },
    ]);
    assert.deepStrictEqual(
      removed.map((entry) => entry.dependencyPath),
      [second.dependencyPath],
    );
    assert.isTrue(yield* first.fs.exists(first.dependencyPath));
    assert.isFalse(yield* second.fs.exists(second.dependencyPath));
    yield* assertBatchWorkspacePreserved(first);
    yield* assertBatchWorkspacePreserved(second);
  }).pipe(Effect.scoped, Effect.provide(testLayer())),
);

const NOW = Date.parse("2026-06-10T12:00:00.000Z");
const day = 86_400_000;
const at = (daysAgo: number) => DateTime.makeUnsafe(NOW - daysAgo * day);
const projectId = ProjectId.make("cleanup-project");
const threadId = ThreadId.make("cleanup-thread");

const decodeShell = Schema.decodeUnknownSync(OrchestrationV2ThreadShell);
const decodeFullThread = Schema.decodeUnknownSync(OrchestrationV2AppThreadJson);
const encodeFullThread = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2AppThreadJson));
const decodeSession = Schema.decodeUnknownSync(OrchestrationV2ProviderSessionJson);
const decodeDomainEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEvent);
const encodeSession = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2ProviderSessionJson));
const makeShell = (worktreePath: string) =>
  decodeShell({
    id: threadId,
    projectId,
    title: "Fixture",
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "fixture" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath,
    branch: "feature",
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    latestRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestUserMessageAt: null,
    createdAt: at(30),
    updatedAt: at(20),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
  });

type SweepCase =
  | "eligible"
  | "archived"
  | "whole-policy"
  | "whole-removal"
  | "whole-shared-deleted-visible-pending"
  | "whole-shared-session-live"
  | "whole-shared-session-stopped"
  | "whole-shared-session-stopped-live"
  | "whole-shared-session-detached"
  | "whole-shared-session-error-released"
  | "whole-shared-session-error-live"
  | "whole-shared-session-error-ownership-changed"
  | "disabled"
  | "recent"
  | "queued"
  | "background"
  | "delegated"
  | "shared"
  | "shared-archived"
  | "shared-deleted"
  | "terminal"
  | "preview"
  | "project-root"
  | "policy-changed"
  | "activity-changed"
  | "path-changed"
  | "ownership-changed"
  | "revision-changed"
  | "initial-revision-changed"
  | "unrelated-streaming"
  | "batch"
  | "batch-five"
  | "batch-process-started"
  | "batch-process-unknown"
  | "provider-history-batch"
  | "provider-binding-changed"
  | "provider-cwd-changed"
  | "provider-event-during-capture"
  | "session"
  | "session-stopped-live"
  | "session-error-released"
  | "session-error-live"
  | "shared-session-live"
  | "shared-session-stopped"
  | "shared-session-stopped-live"
  | "shared-session-stopped-ownership-changed"
  | "shared-session-detached"
  | "shared-session-error-released"
  | "shared-session-error-live"
  | "shared-session-error-ownership-changed"
  | "shared-session-error-ownership-during-capture"
  | "shared-session-error-with-live-sibling"
  | "shared-session-starting"
  | "shared-session-running"
  | "shared-session-waiting"
  | "deleted"
  | "deleted-recent"
  | "deleted-pending"
  | "deleted-visible-pending"
  | "deleted-shared-session-live"
  | "deleted-shared-session-stopped-live"
  | "deleted-shared-session-error-released"
  | "deleted-event"
  | "process"
  | "process-unknown"
  | "process-started"
  | "worker-ready-burst"
  | "worker-terminal-burst"
  | "worker-settings-burst";

const integrationFixture = Effect.fn("test.dependencySweep")(function* (
  mode: SweepCase,
  setProcessReader: (reader: () => ReadonlyArray<string> | null) => void,
  dependencyInspections: () => number,
  workerControl: {
    readonly initialInventoryEntered: Deferred.Deferred<void>;
    readonly releaseInitialInventory: Deferred.Deferred<void>;
  },
) {
  yield* TestClock.setTime(NOW);
  const f = yield* fixture();
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  for (const query of [
    "CREATE TABLE orchestration_events (sequence INTEGER PRIMARY KEY, aggregate_kind TEXT, aggregate_id TEXT, event_type TEXT)",
    "CREATE TABLE projection_projects (project_id TEXT, workspace_root TEXT)",
    "CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, project_id TEXT, payload_json TEXT, deleted_at TEXT)",
    "CREATE TABLE orchestration_v2_events (thread_id TEXT, occurred_at TEXT)",
    "CREATE TABLE orchestration_v2_projection_runs (thread_id TEXT, status TEXT)",
    "CREATE TABLE orchestration_v2_projection_subagents (thread_id TEXT, child_thread_id TEXT, status TEXT)",
    "CREATE TABLE orchestration_v2_projection_runtime_requests (thread_id TEXT, status TEXT)",
    "CREATE TABLE orchestration_v2_projection_provider_threads (thread_id TEXT, status TEXT, payload_json TEXT)",
    "CREATE TABLE orchestration_v2_projection_provider_sessions (provider_session_id TEXT, status TEXT, payload_json TEXT)",
    "CREATE TABLE orchestration_v2_projection_provider_session_bindings (provider_session_id TEXT, thread_id TEXT)",
    "CREATE TABLE orchestration_v2_effect_outbox (thread_id TEXT, status TEXT)",
  ])
    yield* sql.unsafe(query);
  let thread = makeShell(f.input.worktreePath);
  const workerLifecycle = mode.startsWith("worker-");
  const batch =
    mode === "batch" ||
    mode === "batch-five" ||
    mode === "batch-process-started" ||
    mode === "batch-process-unknown" ||
    mode === "provider-history-batch";
  const additionalThreads: Array<typeof thread> = [];
  for (let index = 0; index < (mode === "batch-five" ? 4 : batch ? 1 : 0); index++) {
    const branch = index === 0 ? "second-feature" : `feature-${index + 2}`;
    const secondPath = f.path.join(f.input.managedWorktreesRoot, branch);
    yield* f.runGit(f.repository, ["worktree", "add", "-b", branch, secondPath]);
    const secondInstall = f.path.join(secondPath, "node_modules");
    yield* f.fs.makeDirectory(f.path.join(secondInstall, "package"), { recursive: true });
    yield* f.fs.writeFileString(f.path.join(secondInstall, f.marker), "layoutVersion: 5\n");
    yield* f.fs.writeFileString(
      f.path.join(secondInstall, "package/index.js"),
      "module.exports = 1;\n",
    );
    additionalThreads.push({
      ...makeShell(secondPath),
      id: ThreadId.make(`batch-${index + 2}`),
      branch,
    });
  }
  const secondThread = additionalThreads[0] ?? null;
  const unrelatedHistory =
    mode === "batch"
      ? Array.from({ length: 40 }, (_, index) => ({
          ...thread,
          id: ThreadId.make(`unrelated-history-${index}`),
          worktreePath: null,
          archivedAt: at(15),
        }))
      : [];
  const wholeSharedDeleted = mode === "whole-shared-deleted-visible-pending";
  const sharedSession = mode.includes("shared-session");
  const wholeSession = mode.startsWith("whole-shared-session");
  const stoppedSession = mode.includes("session-stopped");
  const liveStoppedSession = mode.endsWith("-stopped-live");
  const detachedSession = mode.endsWith("-detached");
  const releasedErrorSession = mode.endsWith("-error-released");
  const liveErrorSession = mode.endsWith("-error-live");
  const managerOwnershipCase =
    mode === "whole-shared-session-error-ownership-changed" ||
    mode === "shared-session-error-ownership-changed" ||
    mode === "shared-session-stopped-ownership-changed" ||
    mode === "shared-session-error-ownership-during-capture";
  let managerOwnsSession = liveErrorSession || liveStoppedSession;
  let ownershipRevision = 0;
  const acquireManagerOwnership = () => {
    managerOwnsSession = true;
    ownershipRevision++;
  };
  const visibleDeletedThread = wholeSharedDeleted
    ? {
        ...thread,
        id: ThreadId.make("deleted-other"),
        deletedAt: at(15),
        worktreeCleanup: {
          repositoryRoot: f.repository,
          worktreePath: f.input.worktreePath,
          status: "queued" as const,
          queuedAt: DateTime.formatIso(at(15)),
          blockedByThreadId: threadId,
        },
      }
    : null;
  if (mode === "archived") thread = { ...thread, archivedAt: at(15) };
  if (mode === "deleted-visible-pending")
    thread = {
      ...thread,
      deletedAt: at(15),
      worktreeCleanup: {
        repositoryRoot: f.repository,
        worktreePath: f.input.worktreePath,
        status: "queued",
        queuedAt: DateTime.formatIso(at(15)),
        blockedByThreadId: ThreadId.make("blocking-thread"),
      },
    };
  let settings: ServerSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    storageCleanup: {
      ...DEFAULT_SERVER_SETTINGS.storageCleanup,
      worktreeDependenciesAfterDays: mode === "disabled" ? null : 7,
      worktreeAfterDays:
        wholeSharedDeleted || wholeSession
          ? 7
          : mode === "whole-policy" || mode === "whole-removal"
            ? 1
            : null,
      worktreeOnDelete: false,
      worktreeOnMerge: false,
      worktreeUnchanged: false,
    },
  };
  if (mode === "recent") thread = { ...thread, latestRunCompletedAt: at(1) };
  if (mode === "queued") thread = { ...thread, status: "queued" };
  if (mode === "background")
    thread = { ...thread, pendingBackgroundTasks: [{ taskId: "dev", kind: "command" }] };
  if (mode === "delegated")
    yield* sql`INSERT INTO orchestration_v2_projection_subagents VALUES (${threadId}, NULL, 'running')`;
  const deleted = mode.startsWith("deleted");
  if (deleted || mode === "shared-deleted" || wholeSharedDeleted) {
    const deletedThreadId =
      mode === "shared-deleted" || wholeSharedDeleted ? ThreadId.make("deleted-other") : threadId;
    const full = decodeFullThread({
      ...(visibleDeletedThread ?? thread),
      id: deletedThreadId,
      createdAt: DateTime.formatIso(at(30)),
      updatedAt: DateTime.formatIso(at(20)),
      deletedAt: DateTime.formatIso(at(mode === "deleted-recent" ? 1 : 15)),
    });
    const payload = encodeFullThread(full);
    yield* sql`INSERT INTO projection_projects VALUES (${projectId}, ${f.repository})`;
    yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES (${deletedThreadId}, ${projectId}, ${payload}, 'deleted')`;
    if (mode === "deleted-pending" || mode === "deleted-visible-pending" || wholeSharedDeleted)
      yield* sql`INSERT INTO orchestration_v2_effect_outbox VALUES (${deletedThreadId}, 'running')`;
    if (mode === "deleted-event")
      yield* sql`INSERT INTO orchestration_v2_events VALUES (${threadId}, ${DateTime.formatIso(at(1))})`;
  }
  if (mode.startsWith("session") || sharedSession) {
    const sessionStatus = mode.includes("session-error")
      ? "error"
      : stoppedSession
        ? "stopped"
        : mode.endsWith("-starting")
          ? "starting"
          : mode.endsWith("-running")
            ? "running"
            : mode.endsWith("-waiting")
              ? "waiting"
              : "ready";
    const session = decodeSession({
      id: "session",
      driver: "codex",
      providerInstanceId: "codex",
      status: sessionStatus,
      cwd: sharedSession ? f.repository : f.input.worktreePath,
      model: null,
      capabilities: CodexProviderCapabilitiesV2,
      settings: {},
      createdAt: DateTime.formatIso(at(30)),
      updatedAt: DateTime.formatIso(at(20)),
      lastError: sessionStatus === "error" ? "Fixture provider error" : null,
    });
    const payload = encodeSession(session);
    yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions VALUES ('session', ${sessionStatus}, ${payload})`;
    if (sharedSession && !detachedSession)
      yield* sql`INSERT INTO orchestration_v2_projection_provider_session_bindings VALUES ('session', ${threadId})`;
    if (mode === "shared-session-error-with-live-sibling") {
      const siblingPayload = encodeSession(
        decodeSession({
          ...session,
          id: "sibling-session",
          status: "ready",
          createdAt: DateTime.formatIso(session.createdAt),
          updatedAt: DateTime.formatIso(session.updatedAt),
          lastError: null,
        }),
      );
      yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions VALUES ('sibling-session', 'ready', ${siblingPayload})`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_session_bindings VALUES ('sibling-session', ${threadId})`;
    }
  }
  const providerPayload = (
    id: string,
    status: OrchestrationV2ProviderSessionJson["status"],
    cwd: string,
  ) =>
    encodeSession(
      decodeSession({
        id,
        driver: "codex",
        providerInstanceId: "codex",
        status,
        cwd,
        model: null,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: DateTime.formatIso(at(30)),
        updatedAt: DateTime.formatIso(at(20)),
        lastError: status === "error" ? "Fixture provider error" : null,
      }),
    );
  if (mode === "provider-history-batch") {
    for (let index = 0; index < 40; index++) {
      const sessionId = `released-session-${index}`;
      const payload = providerPayload(sessionId, "error", f.repository);
      yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions VALUES (${sessionId}, 'error', ${payload})`;
      for (const candidateId of [threadId, secondThread!.id])
        yield* sql`INSERT INTO orchestration_v2_projection_provider_session_bindings VALUES (${sessionId}, ${candidateId})`;
    }
  }
  if (mode === "provider-cwd-changed" || mode === "provider-event-during-capture") {
    const status = mode === "provider-cwd-changed" ? "ready" : "error";
    const payload = providerPayload("changed-session", status, f.repository);
    yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions VALUES ('changed-session', ${status}, ${payload})`;
  }
  if (mode === "batch") {
    yield* sql`INSERT INTO projection_projects VALUES (${projectId}, ${f.repository})`;
    for (const history of unrelatedHistory.slice(0, 8)) {
      const deletedHistoryId = ThreadId.make(`${history.id}-deleted`);
      const payload = encodeFullThread(
        decodeFullThread({
          ...history,
          id: deletedHistoryId,
          createdAt: DateTime.formatIso(at(30)),
          updatedAt: DateTime.formatIso(at(20)),
          archivedAt: DateTime.formatIso(at(15)),
          deletedAt: DateTime.formatIso(at(15)),
        }),
      );
      yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES (${deletedHistoryId}, ${projectId}, ${payload}, 'deleted')`;
    }
  }
  const project = {
    id: projectId,
    workspaceRoot: mode === "project-root" ? f.input.worktreePath : f.repository,
    title: "Fixture",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  };
  let reads = 0;
  const sessionLookups = new Map<string, number>();
  let providerEventInserted = false;
  const targetedReads: ThreadId[] = [];
  let processReads = 0;
  let processStartedDuringInspection = false;
  setProcessReader(() => {
    processReads++;
    if (mode === "process-unknown" || (mode === "batch-process-unknown" && processReads > 1))
      return null;
    if (mode === "batch-process-started" && dependencyInspections() > 0) {
      processStartedDuringInspection = true;
      return [f.path.join(f.dependencyPath, "package")];
    }
    return mode === "process" || (mode === "process-started" && processReads > 1)
      ? [f.path.join(f.dependencyPath, "package")]
      : [];
  });
  const terminals: TerminalSummary[] =
    mode === "terminal"
      ? [
          {
            threadId,
            terminalId: "terminal",
            cwd: f.input.worktreePath,
            worktreePath: f.input.worktreePath,
            status: "running",
            pid: 123,
            exitCode: null,
            exitSignal: null,
            hasRunningSubprocess: false,
            label: "fixture",
            updatedAt: "2026-06-01T00:00:00.000Z",
          },
        ]
      : [];
  const publishBurst = yield* Deferred.make<void>();
  const eventsConsumed = yield* Deferred.make<void>();
  const settingsConsumed = yield* Deferred.make<void>();
  const burstEvents = workerLifecycle
    ? Array.from({ length: 12 }, (_, index) =>
        decodeDomainEvent({
          id: `burst-event-${index}`,
          threadId: "unrelated-thread",
          occurredAt: at(0),
          type: "provider-session.updated",
          payload: decodeSession(
            JSON.parse(
              providerPayload(
                "burst-session",
                mode === "worker-ready-burst"
                  ? index % 2 === 0
                    ? "ready"
                    : "running"
                  : index % 2 === 0
                    ? "stopped"
                    : "error",
                f.repository,
              ),
            ),
          ),
        }),
      )
    : [];
  if (mode === "worker-settings-burst")
    burstEvents.push(
      decodeDomainEvent({
        id: "deleted-event",
        threadId: "unrelated-thread",
        occurredAt: at(0),
        type: "thread.deleted",
        payload: decodeFullThread({
          ...thread,
          id: "unrelated-thread",
          worktreePath: null,
          createdAt: DateTime.formatIso(at(30)),
          updatedAt: DateTime.formatIso(at(20)),
          deletedAt: DateTime.formatIso(at(0)),
        }),
      }),
    );
  const events = workerLifecycle
    ? Stream.fromEffect(Deferred.await(publishBurst)).pipe(
        Stream.flatMap(() => Stream.fromIterable(burstEvents)),
        Stream.concat(
          Stream.fromEffect(Deferred.succeed(eventsConsumed, undefined)).pipe(Stream.drain),
        ),
      )
    : Stream.empty;
  const changes =
    mode === "worker-settings-burst"
      ? Stream.fromEffect(Deferred.await(publishBurst)).pipe(
          Stream.flatMap(() =>
            Stream.fromIterable(
              [8, 9, 30].map((days) => ({
                ...settings,
                storageCleanup: { ...settings.storageCleanup, worktreeDependenciesAfterDays: days },
              })),
            ),
          ),
          Stream.tap((next) =>
            Effect.sync(() => {
              settings = next;
            }),
          ),
          Stream.concat(
            Stream.fromEffect(Deferred.succeed(settingsConsumed, undefined)).pipe(Stream.drain),
          ),
        )
      : Stream.empty;
  const dependencies = Layer.mergeAll(
    Layer.succeed(ServerConfig.ServerConfig, {
      ...config,
      worktreesDir: f.input.managedWorktreesRoot,
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([project]) }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getShellSnapshot: (options) =>
        Effect.gen(function* () {
          reads++;
          if (reads === 2 && mode === "whole-shared-session-error-ownership-changed")
            acquireManagerOwnership();
          if (reads === 1 && mode === "initial-revision-changed")
            yield* sql`INSERT INTO orchestration_events VALUES (1, 'thread', ${threadId}, 'thread.metadata-updated')`;
          const threads =
            options?.location === "archive" ||
            (deleted && mode !== "deleted-visible-pending") ||
            mode === "archived"
              ? []
              : secondThread !== null
                ? [thread, ...additionalThreads]
                : visibleDeletedThread !== null
                  ? [thread, visibleDeletedThread]
                  : mode === "shared"
                    ? [thread, { ...thread, id: ThreadId.make("other") }]
                    : [thread];
          return {
            schemaVersion: 1 as const,
            snapshotSequence: 0,
            projects: [project],
            threads,
            archivedThreads:
              mode === "batch"
                ? unrelatedHistory
                : mode === "archived"
                  ? [thread]
                  : mode === "shared-archived"
                    ? [{ ...thread, id: ThreadId.make("archived-other"), archivedAt: at(15) }]
                    : [],
          };
        }).pipe(Effect.orDie),
      getThreadShell: (requestedId) =>
        Effect.gen(function* () {
          targetedReads.push(requestedId);
          if (
            targetedReads.length === 1 &&
            (mode === "shared-session-error-ownership-changed" ||
              mode === "shared-session-stopped-ownership-changed")
          )
            acquireManagerOwnership();
          if (targetedReads.length > 2 && mode === "policy-changed")
            settings = {
              ...settings,
              storageCleanup: { ...settings.storageCleanup, worktreeDependenciesAfterDays: null },
            };
          if (targetedReads.length > 2 && mode === "activity-changed")
            thread = { ...thread, latestRunCompletedAt: at(0) };
          if (targetedReads.length > 1 && mode === "path-changed")
            thread = {
              ...thread,
              worktreePath: f.path.join(f.input.managedWorktreesRoot, "moved"),
            };
          if (targetedReads.length > 1 && mode === "ownership-changed")
            thread = { ...thread, projectId: ProjectId.make("changed-project") };
          if (targetedReads.length === 1 && mode === "revision-changed") {
            yield* sql`INSERT INTO projection_projects VALUES (${projectId}, ${f.repository})`;
            yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES ('unrelated-new-deleted', ${projectId}, '{"not":"a-thread"}', 'deleted')`;
            yield* sql`INSERT INTO orchestration_events VALUES (1, 'project', ${projectId}, 'project.updated')`;
          }
          if (targetedReads.length === 1 && mode === "unrelated-streaming")
            yield* sql`INSERT INTO orchestration_events VALUES (1, 'thread', 'unrelated-stream-thread', 'turn-item.updated')`;
          if (targetedReads.length === 1 && mode === "provider-binding-changed") {
            const payload = providerPayload("changed-session", "error", f.repository);
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions VALUES ('changed-session', 'error', ${payload})`;
                yield* sql`INSERT INTO orchestration_v2_projection_provider_session_bindings VALUES ('changed-session', ${threadId})`;
                yield* sql`INSERT INTO orchestration_events VALUES (1, 'provider-session', 'changed-session', 'provider-session.attached')`;
              }),
            );
            providerEventInserted = true;
          }
          if (targetedReads.length === 1 && mode === "provider-cwd-changed") {
            const payload = providerPayload("changed-session", "ready", f.input.worktreePath);
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`UPDATE orchestration_v2_projection_provider_sessions SET payload_json = ${payload} WHERE provider_session_id = 'changed-session'`;
                yield* sql`INSERT INTO orchestration_events VALUES (1, 'provider-session', 'changed-session', 'provider-session.updated')`;
              }),
            );
            providerEventInserted = true;
          }
          const additionalThread = additionalThreads.find(
            (candidate) => candidate.id === requestedId,
          );
          if (additionalThread !== undefined) return additionalThread;
          if (requestedId === visibleDeletedThread?.id) return visibleDeletedThread;
          if (requestedId !== thread.id || (deleted && mode !== "deleted-visible-pending"))
            return null;
          return thread;
        }).pipe(Effect.orDie),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: events }),
    Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
      ownershipRevision: Effect.sync(() => ownershipRevision),
      isLive: (sessionId) =>
        Effect.gen(function* () {
          sessionLookups.set(sessionId, (sessionLookups.get(sessionId) ?? 0) + 1);
          const live = managerOwnsSession || mode === "provider-binding-changed";
          if (
            mode === "shared-session-error-ownership-during-capture" &&
            sessionLookups.get(sessionId) === 1
          )
            acquireManagerOwnership();
          if (mode === "provider-event-during-capture" && sessionLookups.get(sessionId) === 1) {
            const payload = providerPayload(sessionId, "ready", f.input.worktreePath);
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`UPDATE orchestration_v2_projection_provider_sessions SET status = 'ready', payload_json = ${payload} WHERE provider_session_id = ${sessionId}`;
                yield* sql`INSERT INTO orchestration_events VALUES (1, 'provider-session', ${sessionId}, 'provider-session.updated')`;
              }),
            );
            providerEventInserted = true;
          }
          return live;
        }).pipe(Effect.orDie),
    }),
    Layer.mock(Settings.ServerSettingsService)({
      getSettings: Effect.sync(() => settings),
      subscribeChanges: Effect.succeed(changes),
    }),
    Layer.mock(GitManager.GitManager)({ invalidateStatus: () => Effect.void }),
    Layer.mock(TerminalManager.TerminalManager)({
      subscribeMetadata: (listener) =>
        listener({ type: "snapshot", terminals }).pipe(Effect.as(() => undefined)),
    }),
    Layer.mock(PreviewHosting.PreviewHosting)({
      protectedWorkspacePaths: () =>
        Effect.succeed(mode === "preview" ? [f.input.worktreePath] : []),
    }),
  );
  const worker = yield* StorageCleanup.make.pipe(Effect.provide(dependencies));
  yield* worker
    .start()
    .pipe(
      Effect.provideService(
        ServerActivation.ServerActivation,
        workerLifecycle ? Effect.void : Effect.never,
      ),
    );
  // Clean worktrees exercise removal or shared-owner protection without research guards.
  const preserveResearch = mode !== "whole-removal" && !wholeSharedDeleted && !wholeSession;
  if (preserveResearch) {
    yield* f.fs.makeDirectory(f.path.join(f.input.worktreePath, "research"));
    yield* f.fs.writeFileString(
      f.path.join(f.input.worktreePath, "research", "notes.md"),
      "private research",
    );
  }
  const cleanSource =
    mode === "whole-policy" || mode === "whole-removal" || wholeSharedDeleted || wholeSession;
  const source = cleanSource ? "export const value = 1;\n" : "unfinished source";
  if (!cleanSource)
    yield* f.fs.writeFileString(f.path.join(f.input.worktreePath, "source.ts"), source);
  if (batch || workerLifecycle || (stoppedSession && !wholeSession))
    for (const candidate of [thread, ...additionalThreads]) {
      yield* f.fs.makeDirectory(f.path.join(candidate.worktreePath!, "tmp"));
      yield* f.fs.writeFileString(
        f.path.join(candidate.worktreePath!, "tmp/notes.md"),
        "private notes",
      );
    }
  if (workerLifecycle) {
    yield* Effect.gen(function* () {
      yield* Deferred.await(workerControl.initialInventoryEntered);
      yield* Deferred.succeed(publishBurst, undefined);
      yield* Deferred.await(eventsConsumed);
      if (mode === "worker-settings-burst") yield* Deferred.await(settingsConsumed);
      yield* Deferred.succeed(workerControl.releaseInitialInventory, undefined);
      yield* worker.drain;
    }).pipe(Effect.ensuring(Deferred.succeed(workerControl.releaseInitialInventory, undefined)));
    assert.equal(reads, mode === "worker-ready-burst" ? 1 : 2);
    assert.equal(processReads, mode === "worker-terminal-burst" ? 3 : 2);
    assert.equal(
      yield* f.fs.readFileString(f.path.join(f.input.worktreePath, "tmp/notes.md")),
      "private notes",
    );
    if (mode === "worker-settings-burst")
      assert.equal(settings.storageCleanup.worktreeDependenciesAfterDays, 30);
  } else yield* worker.sweep();
  if (
    mode === "whole-removal" ||
    (wholeSession &&
      ((stoppedSession && !liveStoppedSession) || detachedSession || releasedErrorSession))
  ) {
    assert.isFalse(yield* f.fs.exists(f.input.worktreePath));
    assert.equal(dependencyInspections(), 0);
    return;
  }
  const expectedRemoval =
    mode === "eligible" ||
    mode === "archived" ||
    mode === "deleted" ||
    mode === "whole-policy" ||
    releasedErrorSession ||
    mode === "shared-session-stopped" ||
    mode === "shared-session-detached" ||
    mode === "unrelated-streaming" ||
    mode === "worker-ready-burst" ||
    mode === "worker-terminal-burst" ||
    (batch && mode !== "batch-process-started" && mode !== "batch-process-unknown");
  if (batch) {
    assert.equal(reads, 1);
    assert.equal(processReads, mode === "batch-five" ? 3 : 2);
    assert.include(targetedReads, threadId);
    for (const candidate of additionalThreads) {
      assert.include(targetedReads, candidate.id);
      assert.equal(
        yield* f.fs.exists(f.path.join(candidate.worktreePath!, "node_modules")),
        mode === "batch-process-unknown",
      );
      assert.equal(
        yield* f.fs.readFileString(f.path.join(candidate.worktreePath!, "source.ts")),
        "export const value = 1;\n",
      );
      assert.isTrue(yield* f.fs.exists(f.path.join(candidate.worktreePath!, ".git")));
    }
    for (const candidate of [thread, ...additionalThreads])
      assert.equal(
        yield* f.fs.readFileString(f.path.join(candidate.worktreePath!, "tmp/notes.md")),
        "private notes",
      );
    if (mode === "batch-process-started") assert.isTrue(processStartedDuringInspection);
  }
  if (mode === "provider-history-batch") {
    assert.equal(sessionLookups.size, 40);
    for (const count of sessionLookups.values()) assert.equal(count, 1);
  }
  if (managerOwnershipCase) {
    assert.equal(ownershipRevision, 1);
    assert.isTrue(managerOwnsSession);
    assert.isFalse(providerEventInserted);
    assert.deepStrictEqual(yield* sql`SELECT sequence FROM orchestration_events`, []);
  }
  if (
    mode === "provider-binding-changed" ||
    mode === "provider-cwd-changed" ||
    mode === "provider-event-during-capture"
  )
    assert.isTrue(providerEventInserted);
  if (mode === "initial-revision-changed") {
    assert.equal(targetedReads.length, 0);
    assert.equal(dependencyInspections(), 0);
  }
  if (mode === "revision-changed") {
    assert.equal(reads, 1);
    assert.equal(dependencyInspections(), 0);
  }
  assert.isTrue(yield* f.fs.exists(f.input.worktreePath));
  assert.equal(yield* f.fs.exists(f.dependencyPath), !expectedRemoval);
  if (stoppedSession && !wholeSession)
    assert.equal(
      yield* f.fs.readFileString(f.path.join(f.input.worktreePath, "tmp/notes.md")),
      "private notes",
    );
  if (preserveResearch)
    assert.equal(
      yield* f.fs.readFileString(f.path.join(f.input.worktreePath, "research", "notes.md")),
      "private research",
    );
  assert.equal(yield* f.fs.readFileString(f.path.join(f.input.worktreePath, "source.ts")), source);
  assert.isTrue(yield* f.fs.exists(f.path.join(f.input.worktreePath, ".git")));
});

it.effect.each([
  "eligible",
  "archived",
  "whole-policy",
  "whole-removal",
  "whole-shared-deleted-visible-pending",
  "whole-shared-session-live",
  "whole-shared-session-stopped",
  "whole-shared-session-stopped-live",
  "whole-shared-session-detached",
  "whole-shared-session-error-released",
  "whole-shared-session-error-live",
  "whole-shared-session-error-ownership-changed",
  "disabled",
  "recent",
  "queued",
  "background",
  "delegated",
  "shared",
  "shared-archived",
  "shared-deleted",
  "terminal",
  "preview",
  "project-root",
  "policy-changed",
  "activity-changed",
  "path-changed",
  "ownership-changed",
  "revision-changed",
  "initial-revision-changed",
  "unrelated-streaming",
  "batch",
  "batch-five",
  "batch-process-started",
  "batch-process-unknown",
  "provider-history-batch",
  "provider-binding-changed",
  "provider-cwd-changed",
  "provider-event-during-capture",
  "session",
  "session-stopped-live",
  "session-error-released",
  "session-error-live",
  "shared-session-live",
  "shared-session-stopped",
  "shared-session-stopped-live",
  "shared-session-stopped-ownership-changed",
  "shared-session-detached",
  "shared-session-error-released",
  "shared-session-error-live",
  "shared-session-error-ownership-changed",
  "shared-session-error-ownership-during-capture",
  "shared-session-error-with-live-sibling",
  "shared-session-starting",
  "shared-session-running",
  "shared-session-waiting",
  "deleted",
  "deleted-recent",
  "deleted-pending",
  "deleted-visible-pending",
  "deleted-shared-session-live",
  "deleted-shared-session-stopped-live",
  "deleted-shared-session-error-released",
  "deleted-event",
  "process",
  "process-unknown",
  "process-started",
  "worker-ready-burst",
  "worker-terminal-burst",
  "worker-settings-burst",
] as const)("sweep respects %s retention and protection rules", (mode) => {
  return Effect.gen(function* () {
    let readProcesses: () => ReadonlyArray<string> | null = () => [];
    let dependencyInspections = 0;
    let processEffectReads = 0;
    const initialInventoryEntered = yield* Deferred.make<void>();
    const releaseInitialInventory = yield* Deferred.make<void>();
    const processes = Effect.gen(function* () {
      processEffectReads++;
      if (mode.startsWith("worker-") && processEffectReads === 1) {
        yield* Deferred.succeed(initialInventoryEntered, undefined);
        yield* Deferred.await(releaseInitialInventory);
      }
      return readProcesses();
    });
    return yield* integrationFixture(
      mode,
      (reader) => {
        readProcesses = reader;
      },
      () => dependencyInspections,
      { initialInventoryEntered, releaseInitialInventory },
    ).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.merge(
          testLayer(processes, () => dependencyInspections++),
          NodeSqliteClient.layer({ filename: ":memory:" }).pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    );
  });
});
