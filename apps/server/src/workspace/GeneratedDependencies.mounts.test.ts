// @effect-diagnostics nodeBuiltinImport:off - Substitute filesystem device metadata without mounting anything.
import * as NodeFSP from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as DependencyMounts from "./DependencyMounts.ts";
import * as GeneratedDependencies from "./GeneratedDependencies.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof NodeFSP>();
  return { ...original, lstat: vi.fn(original.lstat) };
});

const testLayer = (mounts: Effect.Effect<ReadonlyArray<string> | null>) =>
  GeneratedDependencies.layer.pipe(
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provide(VcsProcess.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mounts-test-" })),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(
      Layer.succeed(GeneratedDependencies.ProcessWorkingDirectories, Effect.succeed([])),
    ),
    Layer.provideMerge(Layer.succeed(DependencyMounts.MountPoints, mounts)),
  );

const fixture = Effect.fn("test.mountedDependencyFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const cleanup = yield* GeneratedDependencies.GeneratedDependencies;
  const root = yield* fs
    .makeTempDirectoryScoped({ prefix: "t3-mounts-" })
    .pipe(Effect.flatMap(fs.realPath));
  const repositoryRoot = path.join(root, "repository");
  const managedWorktreesRoot = path.join(root, "worktrees");
  const worktreePath = path.join(managedWorktreesRoot, "feature");
  yield* fs.makeDirectory(repositoryRoot);
  const run = (args: ReadonlyArray<string>) =>
    git.execute({ operation: "test.mountedDependencies", cwd: repositoryRoot, args });
  yield* run(["init"]);
  yield* fs.writeFileString(path.join(repositoryRoot, "package.json"), '{"name":"fixture"}\n');
  yield* fs.writeFileString(path.join(repositoryRoot, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  yield* fs.writeFileString(path.join(repositoryRoot, ".gitignore"), "node_modules/\n");
  yield* run(["add", "."]);
  yield* run([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "fixture",
  ]);
  yield* run(["worktree", "add", "-b", "feature", worktreePath]);
  const dependencyPath = path.join(worktreePath, "node_modules");
  yield* fs.makeDirectory(path.join(dependencyPath, "package"), { recursive: true });
  yield* fs.writeFileString(path.join(dependencyPath, ".modules.yaml"), "layoutVersion: 5\n");
  const data = path.join(dependencyPath, "package", "index.js");
  yield* fs.writeFileString(data, "preserve mounted data\n");
  return {
    fs,
    path,
    cleanup,
    input: { repositoryRoot, managedWorktreesRoot, worktreePath },
    dependencyPath,
    data,
  };
});

it.effect.each(["root", "directory", "file"] as const)(
  "rejects a same-device %s mount before dependency measurement",
  (location) => {
    let points: ReadonlyArray<string> | null = ["/"];
    return Effect.gen(function* () {
      const f = yield* fixture();
      const mounted =
        location === "root"
          ? f.dependencyPath
          : location === "directory"
            ? f.path.dirname(f.data)
            : f.data;
      points = ["/", mounted];
      assert.isNull(yield* f.cleanup.inspect(f.input));
      assert.equal(yield* f.fs.readFileString(f.data), "preserve mounted data\n");
    }).pipe(Effect.scoped, Effect.provide(testLayer(Effect.sync(() => points))));
  },
);

it.effect.each(["root", "directory", "file", "unavailable"] as const)(
  "preserves an inspected install when the final mount snapshot becomes %s",
  (location) => {
    let points: ReadonlyArray<string> | null = ["/"];
    let reads = 0;
    return Effect.gen(function* () {
      const f = yield* fixture();
      const inspected = yield* f.cleanup.inspect(f.input);
      assert.isNotNull(inspected);
      points =
        location === "unavailable"
          ? null
          : [
              "/",
              location === "root"
                ? f.dependencyPath
                : location === "directory"
                  ? f.path.dirname(f.data)
                  : f.data,
            ];
      assert.isEmpty(
        yield* f.cleanup.removeBatch([{ inspection: inspected!, canRemove: Effect.succeed(true) }]),
      );
      assert.equal(reads, 2);
      assert.equal(yield* f.fs.readFileString(f.data), "preserve mounted data\n");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        testLayer(
          Effect.sync(() => {
            reads++;
            return points;
          }),
        ),
      ),
    );
  },
);

it.effect("preserves installs when inspection cannot read the mount table", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    assert.isNull(yield* f.cleanup.inspect(f.input));
    assert.equal(yield* f.fs.readFileString(f.data), "preserve mounted data\n");
  }).pipe(Effect.scoped, Effect.provide(testLayer(Effect.succeed(null)))),
);

it.effect("shares one final mount snapshot and only removes unmounted batch members", () => {
  let points: ReadonlyArray<string> | null = ["/"];
  let reads = 0;
  return Effect.gen(function* () {
    const fixtures = yield* Effect.forEach([0, 1, 2, 3], () => fixture());
    const inspections = yield* Effect.forEach(fixtures, (f) => f.cleanup.inspect(f.input));
    for (const inspection of inspections) assert.isNotNull(inspection);
    points = ["/", fixtures[0]!.path.dirname(fixtures[0]!.data)];
    const removed = yield* fixtures[0]!.cleanup.removeBatch(
      inspections.map((inspection) => ({
        inspection: inspection!,
        canRemove: Effect.succeed(true),
      })),
    );
    assert.lengthOf(removed, 3);
    assert.equal(reads, 5);
    assert.equal(
      yield* fixtures[0]!.fs.readFileString(fixtures[0]!.data),
      "preserve mounted data\n",
    );
    for (const f of fixtures.slice(1)) assert.isFalse(yield* f.fs.exists(f.dependencyPath));
  }).pipe(
    Effect.scoped,
    Effect.provide(
      testLayer(
        Effect.sync(() => {
          reads++;
          return points;
        }),
      ),
    ),
  );
});

it.effect("allows mount ancestors and path-prefix siblings outside the dependency root", () => {
  let points: ReadonlyArray<string> | null = ["/"];
  return Effect.gen(function* () {
    const f = yield* fixture();
    points = ["/", f.input.worktreePath, `${f.dependencyPath}-other`];
    const inspected = yield* f.cleanup.inspect(f.input);
    assert.isNotNull(inspected);
    assert.lengthOf(
      yield* f.cleanup.removeBatch([{ inspection: inspected!, canRemove: Effect.succeed(true) }]),
      1,
    );
    assert.isFalse(yield* f.fs.exists(f.dependencyPath));
  }).pipe(Effect.scoped, Effect.provide(testLayer(Effect.sync(() => points))));
});

it.effect("rejects a filesystem-device boundary encountered during measurement", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const original = vi.mocked(NodeFSP.lstat).getMockImplementation()!;
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vi.spyOn(NodeFSP, "lstat").mockImplementation(async (target, options) => {
          const stat = await original(target, options);
          return target === f.path.dirname(f.data)
            ? Object.create(stat, { dev: { value: Number(stat.dev) + 1 } })
            : stat;
        }),
      ),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );
    assert.isNull(yield* f.cleanup.inspect(f.input));
    assert.equal(yield* f.fs.readFileString(f.data), "preserve mounted data\n");
  }).pipe(Effect.scoped, Effect.provide(testLayer(Effect.succeed(["/"])))),
);
