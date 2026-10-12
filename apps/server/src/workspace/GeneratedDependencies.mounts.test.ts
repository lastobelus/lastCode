// @effect-diagnostics nodeBuiltinImport:off - Substitute filesystem device metadata without mounting anything.
import * as NodeFSP from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
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
  return { ...original, lstat: vi.fn(original.lstat), rm: vi.fn(original.rm) };
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
        yield* f.cleanup.removeBatch([
          {
            inspection: inspected!,
            canRemove: Effect.succeed(true),
            isStillEligible: Effect.succeed(true),
          },
        ]),
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

it.effect.each(["root", "directory", "file", "unavailable"] as const)(
  "preserves data when eligibility changes the mount inventory to %s",
  (location) => {
    let points: ReadonlyArray<string> | null = ["/"];
    let reads = 0;
    return Effect.gen(function* () {
      const f = yield* fixture();
      const inspected = yield* f.cleanup.inspect(f.input);
      assert.isNotNull(inspected);
      const canRemove = Effect.sync(() => {
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
        return true;
      });
      assert.isEmpty(
        yield* f.cleanup.removeBatch([
          { inspection: inspected!, canRemove, isStillEligible: Effect.succeed(true) },
        ]),
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

it.effect(
  "waits for every eligibility callback before sharing the final cohort mount snapshot",
  () => {
    let points: ReadonlyArray<string> | null = ["/"];
    let completed = 0;
    const snapshotCompletions: number[] = [];
    return Effect.gen(function* () {
      const fixtures = yield* Effect.forEach([0, 1, 2, 3], () => fixture());
      const inspections = yield* Effect.forEach(fixtures, (f) => f.cleanup.inspect(f.input));
      for (const inspection of inspections) assert.isNotNull(inspection);
      const earlierEligibilityFinished = yield* Deferred.make<void>();
      const earlier = Effect.gen(function* () {
        completed++;
        yield* Deferred.succeed(earlierEligibilityFinished, undefined);
        return true;
      });
      const later = Effect.gen(function* () {
        yield* Deferred.await(earlierEligibilityFinished);
        points = ["/", fixtures[0]!.data];
        completed++;
        return true;
      });
      const eligible = Effect.sync(() => {
        completed++;
        return true;
      });
      const ineligible = Effect.sync(() => {
        completed++;
        return false;
      });
      const callbacks = [earlier, later, eligible, ineligible];
      const removed = yield* fixtures[0]!.cleanup.removeBatch(
        inspections.map((inspection, index) => ({
          inspection: inspection!,
          canRemove: callbacks[index]!,
          isStillEligible: Effect.succeed(true),
        })),
      );
      assert.lengthOf(removed, 2);
      assert.deepEqual(snapshotCompletions, [0, 0, 0, 0, 4, 4, 4]);
      for (const f of [fixtures[0]!, fixtures[3]!]) {
        assert.equal(yield* f.fs.readFileString(f.data), "preserve mounted data\n");
      }
      for (const f of [fixtures[1]!, fixtures[2]!]) {
        assert.isFalse(yield* f.fs.exists(f.dependencyPath));
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        testLayer(
          Effect.sync(() => {
            snapshotCompletions.push(completed);
            return points;
          }),
        ),
      ),
    );
  },
);

it.effect(
  "preserves ineligible installs without taking an unnecessary final mount snapshot",
  () => {
    let reads = 0;
    return Effect.gen(function* () {
      const f = yield* fixture();
      const inspected = yield* f.cleanup.inspect(f.input);
      assert.isNotNull(inspected);
      assert.isEmpty(
        yield* f.cleanup.removeBatch([
          {
            inspection: inspected!,
            canRemove: Effect.succeed(false),
            isStillEligible: Effect.succeed(true),
          },
        ]),
      );
      assert.equal(reads, 1);
      assert.equal(yield* f.fs.readFileString(f.data), "preserve mounted data\n");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        testLayer(
          Effect.sync(() => {
            reads++;
            return ["/"];
          }),
        ),
      ),
    );
  },
);

it.effect("preserves an earlier cohort member invalidated by a later eligibility callback", () => {
  let earlierEligible = true;
  let reads = 0;
  return Effect.gen(function* () {
    const fixtures = yield* Effect.forEach([0, 1], () => fixture());
    const inspections = yield* Effect.forEach(fixtures, (f) => f.cleanup.inspect(f.input));
    for (const inspection of inspections) assert.isNotNull(inspection);
    const earlierEligibilityFinished = yield* Deferred.make<void>();
    const earlier = Effect.gen(function* () {
      yield* Deferred.succeed(earlierEligibilityFinished, undefined);
      return true;
    });
    const later = Effect.gen(function* () {
      yield* Deferred.await(earlierEligibilityFinished);
      earlierEligible = false;
      return true;
    });
    const removed = yield* fixtures[0]!.cleanup.removeBatch([
      {
        inspection: inspections[0]!,
        canRemove: earlier,
        isStillEligible: Effect.sync(() => earlierEligible),
      },
      { inspection: inspections[1]!, canRemove: later, isStillEligible: Effect.succeed(true) },
    ]);
    assert.deepEqual(
      removed.map((entry) => entry.dependencyPath),
      [fixtures[1]!.dependencyPath],
    );
    assert.equal(reads, 4);
    assert.equal(
      yield* fixtures[0]!.fs.readFileString(fixtures[0]!.data),
      "preserve mounted data\n",
    );
    assert.isFalse(yield* fixtures[1]!.fs.exists(fixtures[1]!.dependencyPath));
  }).pipe(
    Effect.scoped,
    Effect.provide(
      testLayer(
        Effect.sync(() => {
          reads++;
          return ["/"];
        }),
      ),
    ),
  );
});

it.effect("preserves an install invalidated while the final mount inventory is captured", () => {
  let eligible = true;
  let reads = 0;
  return Effect.gen(function* () {
    const f = yield* fixture();
    const inspected = yield* f.cleanup.inspect(f.input);
    assert.isNotNull(inspected);
    assert.isEmpty(
      yield* f.cleanup.removeBatch([
        {
          inspection: inspected!,
          canRemove: Effect.succeed(true),
          isStillEligible: Effect.sync(() => eligible),
        },
      ]),
    );
    assert.equal(reads, 2);
    assert.equal(yield* f.fs.readFileString(f.data), "preserve mounted data\n");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      testLayer(
        Effect.sync(() => {
          reads++;
          if (reads === 2) eligible = false;
          return ["/"];
        }),
      ),
    ),
  );
});

it.effect.each(["root", "directory", "file", "unavailable"] as const)(
  "preserves data when the final eligibility guard changes mounts to %s",
  (location) => {
    let points: ReadonlyArray<string> | null = ["/"];
    return Effect.gen(function* () {
      const f = yield* fixture();
      const inspected = yield* f.cleanup.inspect(f.input);
      assert.isNotNull(inspected);
      const isStillEligible = Effect.sync(() => {
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
        return true;
      });
      assert.isEmpty(
        yield* f.cleanup.removeBatch([
          { inspection: inspected!, canRemove: Effect.succeed(true), isStillEligible },
        ]),
      );
      assert.equal(yield* f.fs.readFileString(f.data), "preserve mounted data\n");
    }).pipe(Effect.scoped, Effect.provide(testLayer(Effect.sync(() => points))));
  },
);

it.effect(
  "a delayed final eligibility guard detects new mounts while its sibling deletion proceeds independently",
  () => {
    let points: ReadonlyArray<string> | null = ["/"];
    return Effect.gen(function* () {
      const protectedInstall = yield* fixture();
      const sibling = yield* fixture();
      const protectedInspection = yield* protectedInstall.cleanup.inspect(protectedInstall.input);
      const siblingInspection = yield* sibling.cleanup.inspect(sibling.input);
      assert.isNotNull(protectedInspection);
      assert.isNotNull(siblingInspection);
      const siblingDeletionStarted = yield* Deferred.make<void>();
      const finalGuardFinished = yield* Deferred.make<void>();
      let releaseNativeDeletion = (): void => undefined;
      const nativeDeletionGate = new Promise<void>((resolve) => {
        releaseNativeDeletion = resolve;
      });
      const release = Effect.sync(() => releaseNativeDeletion());
      const rm = vi.mocked(NodeFSP.rm);
      const original = rm.getMockImplementation()!;
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          rm.mockImplementation(async (...args) => {
            if (args[0] === sibling.dependencyPath) {
              Deferred.doneUnsafe(siblingDeletionStarted, Effect.void);
              await nativeDeletionGate;
            }
            return await original(...args);
          }),
        ),
        () => Effect.sync(() => rm.mockImplementation(original)),
      );
      yield* Effect.gen(function* () {
        const finalGuard = Effect.gen(function* () {
          yield* Deferred.await(siblingDeletionStarted);
          points = ["/", protectedInstall.data];
          yield* Deferred.succeed(finalGuardFinished, undefined);
          return true;
        });
        const removal = yield* protectedInstall.cleanup
          .removeBatch([
            {
              inspection: protectedInspection!,
              canRemove: Effect.succeed(true),
              isStillEligible: finalGuard,
            },
            {
              inspection: siblingInspection!,
              canRemove: Effect.succeed(true),
              isStillEligible: Effect.succeed(true),
            },
          ])
          .pipe(Effect.forkScoped);
        yield* Deferred.await(finalGuardFinished);
        assert.isTrue(yield* sibling.fs.exists(sibling.dependencyPath));
        yield* release;
        const removed = yield* Fiber.join(removal);
        assert.deepEqual(
          removed.map((entry) => entry.dependencyPath),
          [sibling.dependencyPath],
        );
        assert.equal(
          yield* protectedInstall.fs.readFileString(protectedInstall.data),
          "preserve mounted data\n",
        );
        assert.isFalse(yield* sibling.fs.exists(sibling.dependencyPath));
      }).pipe(Effect.ensuring(release));
    }).pipe(Effect.scoped, Effect.provide(testLayer(Effect.sync(() => points))));
  },
);

it.effect(
  "preserves original and replacement data when root identity changes during the final mount inventory",
  () => {
    let reads = 0;
    let replaceRoot: Effect.Effect<void> = Effect.void;
    return Effect.gen(function* () {
      const f = yield* fixture();
      const inspected = yield* f.cleanup.inspect(f.input);
      assert.isNotNull(inspected);
      const displacedPath = `${f.dependencyPath}-original`;
      replaceRoot = Effect.gen(function* () {
        yield* f.fs.rename(f.dependencyPath, displacedPath);
        yield* f.fs.makeDirectory(f.path.dirname(f.data), { recursive: true });
        yield* f.fs.writeFileString(f.data, "preserve replacement data\n");
      }).pipe(Effect.orDie);
      assert.isEmpty(
        yield* f.cleanup.removeBatch([
          {
            inspection: inspected!,
            canRemove: Effect.succeed(true),
            isStillEligible: Effect.succeed(true),
          },
        ]),
      );
      assert.equal(reads, 3);
      assert.equal(
        yield* f.fs.readFileString(f.path.join(displacedPath, "package", "index.js")),
        "preserve mounted data\n",
      );
      assert.equal(yield* f.fs.readFileString(f.data), "preserve replacement data\n");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        testLayer(
          Effect.gen(function* () {
            reads++;
            if (reads === 3) yield* replaceRoot;
            return ["/"];
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

it.effect(
  "shares a mount prefilter and refreshes only unmounted eligible batch members before removal",
  () => {
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
          isStillEligible: Effect.succeed(true),
        })),
      );
      assert.lengthOf(removed, 3);
      assert.equal(reads, 8);
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
  },
);

it.effect("allows mount ancestors and path-prefix siblings outside the dependency root", () => {
  let points: ReadonlyArray<string> | null = ["/"];
  return Effect.gen(function* () {
    const f = yield* fixture();
    points = ["/", f.input.worktreePath, `${f.dependencyPath}-other`];
    const inspected = yield* f.cleanup.inspect(f.input);
    assert.isNotNull(inspected);
    assert.lengthOf(
      yield* f.cleanup.removeBatch([
        {
          inspection: inspected!,
          canRemove: Effect.succeed(true),
          isStillEligible: Effect.succeed(true),
        },
      ]),
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
