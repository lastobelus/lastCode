// @effect-diagnostics nodeBuiltinImport:off -- Isolated native staging fixtures exercise the real provenance helper.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { it, assert } from "@effect/vitest";
import {
  createGeneratedBuildStage,
  generatedBuildActivity,
} from "@t3tools/shared/generatedBuildOwnership";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ServerConfig from "../config.ts";
import * as GeneratedBuilds from "./GeneratedBuilds.ts";
import * as WorktreeConsumers from "./WorktreeConsumers.ts";
import * as DependencyMounts from "./DependencyMounts.ts";
import { acquirePortableLock } from "../../../../scripts/lastcode-lock.mjs";

const DAY = 86_400_000;
const testLayer = GeneratedBuilds.layer.pipe(
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provide(VcsProcess.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "generated-builds-test-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(Layer.succeed(WorktreeConsumers.ProcessPaths, Effect.succeed([]))),
  Layer.provideMerge(Layer.succeed(DependencyMounts.MountPoints, Effect.succeed([]))),
);
const fixture = Effect.fn("test.generatedBuildFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const builds = yield* GeneratedBuilds.GeneratedBuilds;
  const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "generated-builds-" });
  const root = yield* fs.realPath(temporary);
  const repositoryRoot = NodePath.join(root, "repository");
  const managedWorktreesRoot = NodePath.join(root, "worktrees");
  const worktreePath = NodePath.join(managedWorktreesRoot, "feature");
  yield* fs.makeDirectory(repositoryRoot);
  yield* fs.makeDirectory(managedWorktreesRoot);
  const runGit = (cwd: string, args: readonly string[]) =>
    git.execute({ operation: "test.GeneratedBuilds", cwd, args });
  yield* runGit(repositoryRoot, ["init"]);
  yield* fs.writeFileString(NodePath.join(repositoryRoot, ".gitignore"), "dist/\ntarget/\n");
  for (const app of ["web", "server"]) {
    yield* fs.makeDirectory(NodePath.join(repositoryRoot, "apps", app), { recursive: true });
    yield* fs.writeFileString(
      NodePath.join(repositoryRoot, "apps", app, "package.json"),
      '{"name":"fixture"}\n',
    );
    yield* fs.writeFileString(
      NodePath.join(repositoryRoot, "apps", app, "vite.config.ts"),
      'export default { build: { outDir: "dist" } };\n',
    );
  }
  yield* fs.makeDirectory(NodePath.join(repositoryRoot, "native/resource-monitor"), {
    recursive: true,
  });
  yield* fs.writeFileString(
    NodePath.join(repositoryRoot, "native/resource-monitor/Cargo.toml"),
    '[package]\nname = "fixture-monitor"\nversion = "0.1.0"\n',
  );
  yield* fs.writeFileString(
    NodePath.join(repositoryRoot, "native/resource-monitor/Cargo.lock"),
    "version = 4\n",
  );
  yield* runGit(repositoryRoot, ["add", "."]);
  yield* runGit(repositoryRoot, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "fixture",
  ]);
  yield* runGit(repositoryRoot, ["worktree", "add", "-b", "feature", worktreePath]);
  const emit = (output: string, when: number, names: readonly string[] = ["main.js"]) =>
    Effect.sync(() => {
      const stage = createGeneratedBuildStage(worktreePath, output)!;
      for (const name of names) {
        NodeFS.mkdirSync(NodePath.dirname(NodePath.join(stage.directory, name)), {
          recursive: true,
        });
        NodeFS.writeFileSync(NodePath.join(stage.directory, name), `compiler emission ${name}`);
      }
      stage.publish(when);
    });
  const input = { repositoryRoot, managedWorktreesRoot, worktreePath };
  const remove = (
    now: number,
    days: number,
    archived = false,
    canRemove = Effect.succeed(true),
    isStillEligible = Effect.succeed(true),
  ) => builds.remove(input, now, days, archived, canRemove, isStillEligible);
  return { builds, fs, root, input, runGit, emit, remove };
});

it.effect(
  "ages each verified root independently using a nondefault configured dependency delay",
  () =>
    Effect.gen(function* () {
      const { builds, input, emit, remove, fs } = yield* fixture();
      yield* emit("apps/web/dist", 1);
      yield* emit("apps/server/dist", 10 * DAY);
      assert.deepEqual(yield* builds.observe(input, 11 * DAY, true), {
        lastUsedAt: 1,
        renewed: false,
      });
      const result = yield* remove(11 * DAY, 3);
      assert.equal(result.files, 1);
      assert.equal(
        yield* fs.exists(NodePath.join(input.worktreePath, "apps/web/dist/main.js")),
        false,
      );
      assert.equal(
        yield* fs.exists(NodePath.join(input.worktreePath, "apps/server/dist/main.js")),
        true,
      );
      assert.equal((yield* remove(11 * DAY, 14)).files, 0);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "archived enabled output bypasses age, while disabled policy and false final eligibility retain it",
  () =>
    Effect.gen(function* () {
      const { input, emit, remove, fs } = yield* fixture();
      yield* emit("native/resource-monitor/target/debug", 100);
      assert.equal((yield* remove(101, 0, true)).files, 0);
      assert.equal(
        (yield* remove(101, 30, true, Effect.succeed(true), Effect.succeed(false))).files,
        0,
      );
      assert.equal((yield* remove(101, 30, true)).files, 1);
      assert.equal(
        yield* fs.exists(
          NodePath.join(input.worktreePath, "native/resource-monitor/target/debug/main.js"),
        ),
        false,
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "legacy unknown outputs are discovered and kept; emitted cleanup preserves arbitrary additions and modifications",
  () =>
    Effect.gen(function* () {
      const { builds, input, fs, emit, remove } = yield* fixture();
      const web = NodePath.join(input.worktreePath, "apps/web/dist");
      yield* fs.makeDirectory(web);
      yield* fs.writeFileString(NodePath.join(web, "legacy.js"), "legacy unknown output");
      assert.equal(yield* builds.hasOutputs(input.worktreePath), true);
      assert.equal(yield* builds.observe(input, DAY), null);
      assert.match((yield* remove(DAY, 3, true)).reason, /exact-file review/);
      yield* emit("apps/web/dist", 1, ["main.js", "changed.js"]);
      yield* fs.writeFileString(NodePath.join(web, "changed.js"), "retained edit");
      yield* fs.writeFileString(NodePath.join(web, "qa-note.txt"), "retained addition");
      const result = yield* remove(DAY, 3, true);
      assert.equal(result.files, 1);
      assert.equal(yield* fs.readFileString(NodePath.join(web, "changed.js")), "retained edit");
      assert.equal(
        yield* fs.readFileString(NodePath.join(web, "qa-note.txt")),
        "retained addition",
      );
      assert.equal(
        yield* fs.readFileString(NodePath.join(web, "legacy.js")),
        "legacy unknown output",
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "preserves emitted files excluded by an ignore negation and blocks any tracked output content",
  () =>
    Effect.gen(function* () {
      const { input, fs, emit, runGit, remove } = yield* fixture();
      yield* emit("apps/web/dist", 1, ["main.js", "retained.js"]);
      yield* fs.writeFileString(
        NodePath.join(input.worktreePath, ".gitignore"),
        "apps/web/dist/**\n!apps/web/dist/retained.js\ntarget/\n",
      );
      const first = yield* remove(DAY, 3, true);
      assert.equal(first.files, 1);
      assert.equal(
        yield* fs.exists(NodePath.join(input.worktreePath, "apps/web/dist/retained.js")),
        true,
      );
      // Keep the file in the current compiler generation for the tracked-output guard;
      // a successful build now retires unchanged files omitted by its new emissions.
      yield* emit("apps/web/dist", 2, ["main.js", "retained.js"]);
      yield* fs.writeFileString(
        NodePath.join(input.worktreePath, ".gitignore"),
        "dist/\ntarget/\n",
      );
      yield* runGit(input.worktreePath, ["add", "-f", "apps/web/dist/retained.js"]);
      assert.equal((yield* remove(DAY, 3, true)).files, 0);
      assert.equal(
        yield* fs.exists(NodePath.join(input.worktreePath, "apps/web/dist/main.js")),
        true,
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "generic root/status presence never renews output age; positive output consumers renew only their root",
  () =>
    Effect.gen(function* () {
      const { input, emit, builds, remove } = yield* fixture();
      yield* emit("apps/web/dist", 1);
      yield* emit("apps/server/dist", 2);
      const generic = yield* builds
        .observe(input, DAY)
        .pipe(
          Effect.provideService(
            WorktreeConsumers.ProcessPaths,
            Effect.succeed([input.worktreePath]),
          ),
        );
      assert.deepEqual(generic, { lastUsedAt: 1, renewed: false });
      const actual = yield* builds
        .observe(input, 2 * DAY)
        .pipe(
          Effect.provideService(
            WorktreeConsumers.ProcessPaths,
            Effect.succeed([NodePath.join(input.worktreePath, "apps/web/dist/main.js")]),
          ),
        );
      assert.deepEqual(actual, { lastUsedAt: 2, renewed: true });
      assert.equal(
        generatedBuildActivity(input.worktreePath, "apps/web/dist")?.lastUsedAt,
        2 * DAY,
      );
      assert.equal(generatedBuildActivity(input.worktreePath, "apps/server/dist")?.lastUsedAt, 2);
      assert.equal(
        (yield* remove(3 * DAY, 1).pipe(
          Effect.provideService(WorktreeConsumers.ProcessPaths, Effect.succeed(null)),
        )).files,
        0,
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "renewal after asynchronous guards retains late-used output, and partial batches retain truthful removal counts",
  () =>
    Effect.gen(function* () {
      const { input, emit, remove, fs } = yield* fixture();
      yield* emit(
        "apps/web/dist",
        1,
        Array.from({ length: 65 }, (_, index) => `${String(index).padStart(2, "0")}.js`),
      );
      let checks = 0;
      const eligible = Effect.sync(() => ++checks === 1);
      const result = yield* remove(DAY, 3, true, Effect.succeed(true), eligible);
      assert.equal(result.files, 64);
      assert.equal(result.kept, 2); // One file plus the retained nonempty root.
      assert.match(
        result.reason,
        /Removed unchanged compiler-emitted files; recovered size is an estimate/,
      );
      assert.equal(
        yield* fs.exists(NodePath.join(input.worktreePath, "apps/web/dist/64.js")),
        true,
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each([0, 64] as const)(
  "reports eligibility errors after %s removals while preserving actual recovered totals",
  (completed) =>
    Effect.gen(function* () {
      const { builds, input, emit, fs } = yield* fixture();
      yield* emit(
        "apps/web/dist",
        1,
        Array.from({ length: 65 }, (_, index) => `${String(index).padStart(2, "0")}.js`),
      );
      let checks = 0;
      const eligibility = Effect.gen(function* () {
        if (++checks > completed / 64) return yield* Effect.fail("fixture eligibility failure");
        return true;
      });
      const result = yield* builds.remove(input, DAY, 3, true, Effect.succeed(true), eligibility);
      assert.isTrue(result.failed);
      assert.equal(result.files, completed);
      assert.match(result.reason, /eligibility check failed/);
      assert.equal(
        yield* fs.exists(NodePath.join(input.worktreePath, "apps/web/dist/64.js")),
        true,
      );
      if (completed === 0) assert.equal(result.bytes, 0);
      else assert.isAbove(result.bytes, 0);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "keeps an exact-delay boundary sibling even when an older root qualifies the worktree",
  () =>
    Effect.gen(function* () {
      const { input, emit, remove, fs } = yield* fixture();
      yield* emit("apps/web/dist", 1);
      yield* emit("apps/server/dist", 2 * DAY);
      const result = yield* remove(5 * DAY, 3);
      assert.equal(result.files, 1);
      assert.equal(
        yield* fs.exists(NodePath.join(input.worktreePath, "apps/server/dist/main.js")),
        true,
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "a compiled-file consumer observed in final guards renews that root and protects its output",
  () =>
    Effect.gen(function* () {
      const { input, emit, remove } = yield* fixture();
      yield* emit("apps/web/dist", 1);
      let inventoryReads = 0;
      const paths = Effect.sync(() =>
        inventoryReads++ === 0 ? [NodePath.join(input.worktreePath, "apps/web/dist/main.js")] : [],
      );
      const result = yield* remove(5 * DAY, 3).pipe(
        Effect.provideService(WorktreeConsumers.ProcessPaths, paths),
      );
      assert.equal(result.files, 0);
      assert.equal(
        generatedBuildActivity(input.worktreePath, "apps/web/dist")?.lastUsedAt,
        5 * DAY,
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each(["output file", "worktree root", "unavailable", "no consumer"] as const)(
  "captures %s evidence after the last awaited eligibility check before build removal",
  (consumer) =>
    Effect.gen(function* () {
      const { input, emit, remove, fs } = yield* fixture();
      yield* TestClock.setTime(5 * DAY);
      const now = yield* Clock.currentTimeMillis;
      yield* emit("apps/web/dist", 1);
      yield* emit("apps/server/dist", 4 * DAY);
      const output = NodePath.join(input.worktreePath, "apps/web/dist/main.js");
      let processes: readonly string[] | null = [];
      let eligibilityChecks = 0;
      const eligible = Effect.gen(function* () {
        // The consumer arrives while the final app guard is awaiting real I/O;
        // it is external evidence and does not itself update build provenance.
        yield* fs
          .readFileString(NodePath.join(input.worktreePath, "apps/web/package.json"))
          .pipe(Effect.orDie);
        eligibilityChecks++;
        processes =
          consumer === "output file"
            ? [output]
            : consumer === "worktree root"
              ? [input.worktreePath]
              : consumer === "unavailable"
                ? null
                : [];
        return true;
      });
      const result = yield* remove(now, 3, false, Effect.succeed(true), eligible).pipe(
        Effect.provideService(
          WorktreeConsumers.ProcessPaths,
          Effect.sync(() => processes),
        ),
      );
      assert.equal(eligibilityChecks, 1);
      assert.isFalse(result.failed);
      assert.equal(result.files, consumer === "no consumer" ? 1 : 0);
      if (consumer === "no consumer") assert.isAbove(result.bytes, 0);
      else assert.equal(result.bytes, 0);
      assert.equal(yield* fs.exists(output), consumer !== "no consumer");
      if (consumer === "unavailable")
        assert.include(result.reason, "Process file-consumer inventory is unavailable");
      else if (consumer !== "no consumer")
        assert.include(result.reason, "A process is using a file or directory in the worktree");
      assert.equal(
        generatedBuildActivity(input.worktreePath, "apps/web/dist")?.lastUsedAt,
        consumer === "output file" ? now : 1,
      );
      assert.equal(
        generatedBuildActivity(input.worktreePath, "apps/server/dist")?.lastUsedAt,
        4 * DAY,
      );
      assert.isTrue(
        yield* fs.exists(NodePath.join(input.worktreePath, "apps/server/dist/main.js")),
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "rejects an unrelated repository mapping and a linked generated root without removing files",
  () =>
    Effect.gen(function* () {
      const { builds, input, emit, remove, fs, root, runGit } = yield* fixture();
      yield* emit("apps/web/dist", 1);
      const unrelated = NodePath.join(root, "unrelated-repository");
      yield* fs.makeDirectory(unrelated);
      yield* runGit(unrelated, ["init"]);
      assert.equal(
        (yield* builds.remove(
          { ...input, repositoryRoot: unrelated },
          DAY,
          3,
          true,
          Effect.succeed(true),
          Effect.succeed(true),
        )).files,
        0,
      );
      const output = NodePath.join(input.worktreePath, "apps/web/dist");
      const retained = NodePath.join(root, "retained-dist");
      yield* fs.rename(output, retained);
      yield* Effect.sync(() => NodeFS.symlinkSync(retained, output, "junction"));
      assert.equal((yield* remove(DAY, 3, true)).files, 0);
      assert.equal(yield* fs.exists(NodePath.join(retained, "main.js")), true);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "reports unavailable inventory and active consumers without disclosing process names",
  () =>
    Effect.gen(function* () {
      const { input, emit, remove } = yield* fixture();
      yield* emit("apps/web/dist", 1);
      const unavailable = yield* remove(DAY, 3, true).pipe(
        Effect.provideService(WorktreeConsumers.ProcessPaths, Effect.succeed(null)),
      );
      assert.equal(unavailable.files, 0);
      assert.include(unavailable.reason, "Process file-consumer inventory is unavailable");
      const active = yield* remove(DAY, 3, true).pipe(
        Effect.provideService(
          WorktreeConsumers.ProcessPaths,
          Effect.succeed([NodePath.join(input.worktreePath, "apps/web/dist/main.js")]),
        ),
      );
      assert.equal(active.files, 0);
      assert.include(active.reason, "A process is using a file or directory in the worktree");
      assert.notInclude(active.reason, input.worktreePath);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("reports the failing consumer proof stage without copying native errors", () =>
  Effect.gen(function* () {
    const { emit, remove } = yield* fixture();
    yield* emit("apps/web/dist", 1);
    const result = yield* remove(DAY, 3, true).pipe(
      Effect.provideService(
        WorktreeConsumers.ProcessPaths,
        Effect.succeed(["invalid-native-path"]),
      ),
    );
    assert.equal(result.files, 0);
    assert.isTrue(result.failed);
    assert.include(result.reason, "output-consumer identity check failed");
    assert.notInclude(result.reason, "invalid-native-path");
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "reports changed Git recognition and workspace policy as distinct protection stages",
  () =>
    Effect.gen(function* () {
      const { builds, input, emit, remove, fs } = yield* fixture();
      yield* emit("apps/web/dist", 1);
      const protectedResult = yield* remove(DAY, 3, true, Effect.succeed(false));
      assert.equal(protectedResult.files, 0);
      assert.include(
        protectedResult.reason,
        "Current workspace ownership or policy protects build files",
      );
      const changed = yield* builds.remove(
        input,
        DAY,
        3,
        true,
        fs
          .writeFileString(NodePath.join(input.worktreePath, ".gitignore"), "")
          .pipe(Effect.as(true)),
        Effect.succeed(true),
      );
      assert.equal(changed.files, 0);
      assert.include(changed.reason, "Git or generated-path eligibility changed");
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "writing build observations share supplied inventory but final removal checks fresh consumers",
  () =>
    Effect.gen(function* () {
      const { builds, input, emit, remove, fs } = yield* fixture();
      yield* emit("apps/web/dist", 1);
      yield* emit("apps/server/dist", 2);
      const observationTargets = WorktreeConsumers.createTargetObservation();
      let observationReads = 0;
      let freshReads = 0;
      const cachedPaths = yield* Effect.cached(
        Effect.sync(() => {
          observationReads++;
          return [] as readonly string[];
        }),
      );
      const freshPaths = Effect.sync(() => {
        freshReads++;
        return [NodePath.join(input.worktreePath, "apps/web/dist/main.js")];
      });
      assert.deepEqual(
        yield* builds
          .observe(input, DAY, false, true, cachedPaths, observationTargets)
          .pipe(Effect.provideService(WorktreeConsumers.ProcessPaths, freshPaths)),
        { lastUsedAt: 1, renewed: false },
      );
      yield* builds.observe(input, 2 * DAY, false, true, cachedPaths, observationTargets);
      assert.equal(observationReads, 1);
      assert.equal(freshReads, 0);
      const removed = yield* remove(5 * DAY, 3).pipe(
        Effect.provideService(WorktreeConsumers.ProcessPaths, freshPaths),
      );
      assert.equal(removed.files, 0);
      assert.isAbove(freshReads, 0);
      assert.equal(observationReads, 1);
      assert.isTrue(yield* fs.exists(NodePath.join(input.worktreePath, "apps/web/dist/main.js")));
      assert.equal(
        generatedBuildActivity(input.worktreePath, "apps/web/dist")?.lastUsedAt,
        5 * DAY,
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "build observations capture once for verified roots and skip read-only or unrecognized outputs",
  () =>
    Effect.gen(function* () {
      const { builds, input, emit, fs } = yield* fixture();
      let reads = 0;
      const paths = Effect.sync(() => {
        reads++;
        return [] as readonly string[];
      });
      const observe = (persist = true) =>
        builds
          .observe(input, DAY, false, persist)
          .pipe(Effect.provideService(WorktreeConsumers.ProcessPaths, paths));
      assert.isNull(yield* observe());
      yield* fs.makeDirectory(NodePath.join(input.worktreePath, "apps/web/dist"));
      yield* fs.writeFileString(
        NodePath.join(input.worktreePath, "apps/web/dist/legacy.js"),
        "legacy",
      );
      assert.isNull(yield* observe());
      assert.equal(reads, 0);
      yield* emit("apps/web/dist", 1);
      yield* emit("apps/server/dist", 2);
      assert.deepEqual(yield* observe(false), { lastUsedAt: 1, renewed: false });
      assert.equal(reads, 0);
      assert.deepEqual(yield* observe(), { lastUsedAt: 1, renewed: false });
      assert.equal(reads, 1);
      assert.isNull(yield* builds.observe(input, DAY, false, true, Effect.succeed(null)));
      assert.equal(generatedBuildActivity(input.worktreePath, "apps/web/dist")?.lastUsedAt, 1);
      yield* fs.writeFileString(NodePath.join(input.worktreePath, ".gitignore"), "");
      assert.isNull(yield* observe());
      assert.equal(reads, 1);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "supplied build consumer evidence renews the matching root without evaluating default inventory",
  () =>
    Effect.gen(function* () {
      const { builds, input, emit } = yield* fixture();
      yield* emit("apps/web/dist", 1);
      yield* emit("apps/server/dist", 2);
      let suppliedReads = 0;
      let defaultReads = 0;
      const supplied = Effect.sync(() => {
        suppliedReads++;
        return [NodePath.join(input.worktreePath, "apps/web/dist/main.js")];
      });
      const result = yield* builds.observe(input, DAY, false, true, supplied).pipe(
        Effect.provideService(
          WorktreeConsumers.ProcessPaths,
          Effect.sync(() => {
            defaultReads++;
            return null;
          }),
        ),
      );
      assert.deepEqual(result, { lastUsedAt: 2, renewed: true });
      assert.equal(suppliedReads, 1);
      assert.equal(defaultReads, 0);
      assert.equal(generatedBuildActivity(input.worktreePath, "apps/web/dist")?.lastUsedAt, DAY);
      assert.equal(generatedBuildActivity(input.worktreePath, "apps/server/dist")?.lastUsedAt, 2);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("a busy output mutation does not claim or persist a usage renewal", () =>
  Effect.gen(function* () {
    const { builds, input, emit } = yield* fixture();
    yield* emit("apps/web/dist", 1);
    const metadata = NodePath.resolve(
      input.worktreePath,
      NodeFS.readFileSync(NodePath.join(input.worktreePath, ".git"), "utf8").trim().slice(8),
    );
    const record = NodeFS.readdirSync(metadata).find(
      (name) => name.startsWith("t3-build-") && name.endsWith(".json"),
    )!;
    const before = generatedBuildActivity(input.worktreePath, "apps/web/dist");
    const paths = Effect.succeed([NodePath.join(input.worktreePath, "apps/web/dist/main.js")]);
    const release = acquirePortableLock(metadata, `${record}.publish`, "test output mutation");
    try {
      assert.deepEqual(yield* builds.observe(input, DAY, false, true, paths), {
        lastUsedAt: 1,
        renewed: false,
      });
      assert.deepEqual(generatedBuildActivity(input.worktreePath, "apps/web/dist"), before);
    } finally {
      release();
    }
    assert.deepEqual(yield* builds.observe(input, DAY, false, true, paths), {
      lastUsedAt: DAY,
      renewed: true,
    });
  }).pipe(Effect.provide(testLayer)),
);
