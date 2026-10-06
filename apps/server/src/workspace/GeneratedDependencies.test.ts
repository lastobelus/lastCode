import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
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
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Settings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as PreviewHosting from "../preview/Hosting.ts";
import * as GitManager from "../git/GitManager.ts";
import * as ServerActivation from "../serverActivation.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof NodeFSP>();
  return { ...original, opendir: vi.fn(original.opendir) };
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
  const input = { managedWorktreesRoot, worktreePath };
  return { fs, path, cleanup, root, repository, input, dependencyPath, marker, lock, runGit };
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

const NOW = Date.parse("2026-06-10T12:00:00.000Z");
const day = 86_400_000;
const at = (daysAgo: number) => DateTime.makeUnsafe(NOW - daysAgo * day);
const projectId = ProjectId.make("cleanup-project");
const threadId = ThreadId.make("cleanup-thread");

const decodeShell = Schema.decodeUnknownSync(OrchestrationV2ThreadShell);
const decodeFullThread = Schema.decodeUnknownSync(OrchestrationV2AppThreadJson);
const encodeFullThread = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2AppThreadJson));
const decodeSession = Schema.decodeUnknownSync(OrchestrationV2ProviderSessionJson);
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
  | "whole-policy"
  | "whole-removal"
  | "disabled"
  | "recent"
  | "queued"
  | "background"
  | "delegated"
  | "shared"
  | "terminal"
  | "preview"
  | "project-root"
  | "policy-changed"
  | "activity-changed"
  | "session"
  | "deleted"
  | "deleted-recent"
  | "deleted-pending"
  | "deleted-event"
  | "process"
  | "process-unknown"
  | "process-started";

const integrationFixture = Effect.fn("test.dependencySweep")(function* (
  mode: SweepCase,
  setProcessReader: (reader: () => ReadonlyArray<string> | null) => void,
  dependencyInspections: () => number,
) {
  yield* TestClock.setTime(NOW);
  const f = yield* fixture();
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  for (const query of [
    "CREATE TABLE projection_projects (project_id TEXT, workspace_root TEXT)",
    "CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, project_id TEXT, payload_json TEXT, deleted_at TEXT)",
    "CREATE TABLE orchestration_v2_events (thread_id TEXT, occurred_at TEXT)",
    "CREATE TABLE orchestration_v2_projection_runs (thread_id TEXT, status TEXT)",
    "CREATE TABLE orchestration_v2_projection_subagents (thread_id TEXT, child_thread_id TEXT, status TEXT)",
    "CREATE TABLE orchestration_v2_projection_runtime_requests (thread_id TEXT, status TEXT)",
    "CREATE TABLE orchestration_v2_projection_provider_threads (thread_id TEXT, status TEXT, payload_json TEXT)",
    "CREATE TABLE orchestration_v2_projection_provider_sessions (status TEXT, payload_json TEXT)",
    "CREATE TABLE orchestration_v2_effect_outbox (thread_id TEXT, status TEXT)",
  ])
    yield* sql.unsafe(query);
  let thread = makeShell(f.input.worktreePath);
  let settings: ServerSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    storageCleanup: {
      ...DEFAULT_SERVER_SETTINGS.storageCleanup,
      worktreeDependenciesAfterDays: mode === "disabled" ? null : 7,
      worktreeAfterDays: mode === "whole-policy" || mode === "whole-removal" ? 1 : null,
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
  if (deleted) {
    const full = decodeFullThread({
      ...thread,
      createdAt: DateTime.formatIso(at(30)),
      updatedAt: DateTime.formatIso(at(20)),
      deletedAt: DateTime.formatIso(at(mode === "deleted-recent" ? 1 : 15)),
    });
    const payload = encodeFullThread(full);
    yield* sql`INSERT INTO projection_projects VALUES (${projectId}, ${f.repository})`;
    yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES (${threadId}, ${projectId}, ${payload}, 'deleted')`;
    if (mode === "deleted-pending")
      yield* sql`INSERT INTO orchestration_v2_effect_outbox VALUES (${threadId}, 'running')`;
    if (mode === "deleted-event")
      yield* sql`INSERT INTO orchestration_v2_events VALUES (${threadId}, ${DateTime.formatIso(at(1))})`;
  }
  if (mode === "session") {
    const payload = encodeSession(
      decodeSession({
        id: "session",
        driver: "codex",
        providerInstanceId: "codex",
        status: "ready",
        cwd: f.input.worktreePath,
        model: null,
        capabilities: CodexProviderCapabilitiesV2,
        settings: {},
        createdAt: DateTime.formatIso(at(30)),
        updatedAt: DateTime.formatIso(at(20)),
        lastError: null,
      }),
    );
    yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions VALUES ('ready', ${payload})`;
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
  let processReads = 0;
  setProcessReader(() => {
    processReads++;
    if (mode === "process-unknown") return null;
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
  const dependencies = Layer.mergeAll(
    Layer.succeed(ServerConfig.ServerConfig, {
      ...config,
      worktreesDir: f.input.managedWorktreesRoot,
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([project]) }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getShellSnapshot: (options) =>
        Effect.sync(() => {
          reads++;
          if (reads > 2 && mode === "policy-changed")
            settings = {
              ...settings,
              storageCleanup: { ...settings.storageCleanup, worktreeDependenciesAfterDays: null },
            };
          if (reads > 2 && mode === "activity-changed")
            thread = { ...thread, latestRunCompletedAt: at(0) };
          const threads =
            options?.location === "archive" || deleted
              ? []
              : mode === "shared"
                ? [thread, { ...thread, id: ThreadId.make("other") }]
                : [thread];
          return {
            schemaVersion: 1 as const,
            snapshotSequence: 0,
            projects: [project],
            threads,
            archivedThreads: [],
          };
        }),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.empty }),
    Layer.mock(Settings.ServerSettingsService)({
      getSettings: Effect.sync(() => settings),
      subscribeChanges: Effect.succeed(Stream.empty),
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
    .pipe(Effect.provideService(ServerActivation.ServerActivation, Effect.never));
  // Only the whole-removal case has no research or source changes to preserve.
  if (mode !== "whole-removal") {
    yield* f.fs.makeDirectory(f.path.join(f.input.worktreePath, "research"));
    yield* f.fs.writeFileString(
      f.path.join(f.input.worktreePath, "research", "notes.md"),
      "private research",
    );
  }
  const cleanSource = mode === "whole-policy" || mode === "whole-removal";
  const source = cleanSource ? "export const value = 1;\n" : "unfinished source";
  if (!cleanSource)
    yield* f.fs.writeFileString(f.path.join(f.input.worktreePath, "source.ts"), source);
  yield* worker.sweep();
  if (mode === "whole-removal") {
    assert.isFalse(yield* f.fs.exists(f.input.worktreePath));
    assert.equal(dependencyInspections(), 0);
    return;
  }
  const expectedRemoval = mode === "eligible" || mode === "deleted" || mode === "whole-policy";
  assert.equal(yield* f.fs.exists(f.dependencyPath), !expectedRemoval);
  assert.equal(
    yield* f.fs.readFileString(f.path.join(f.input.worktreePath, "research", "notes.md")),
    "private research",
  );
  assert.equal(yield* f.fs.readFileString(f.path.join(f.input.worktreePath, "source.ts")), source);
  assert.isTrue(yield* f.fs.exists(f.path.join(f.input.worktreePath, ".git")));
});

it.effect.each([
  "eligible",
  "whole-policy",
  "whole-removal",
  "disabled",
  "recent",
  "queued",
  "background",
  "delegated",
  "shared",
  "terminal",
  "preview",
  "project-root",
  "policy-changed",
  "activity-changed",
  "session",
  "deleted",
  "deleted-recent",
  "deleted-pending",
  "deleted-event",
  "process",
  "process-unknown",
  "process-started",
] as const)("sweep respects %s retention and protection rules", (mode) => {
  let readProcesses: () => ReadonlyArray<string> | null = () => [];
  let dependencyInspections = 0;
  const processes = Effect.sync(() => readProcesses());
  return integrationFixture(
    mode,
    (reader) => {
      readProcesses = reader;
    },
    () => dependencyInspections,
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
