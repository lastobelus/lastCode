// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Option from "effect/Option";
import { afterAll, assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import {
  comparisonBase,
  defaultConcurrency,
  crossFileTests,
  gitLines,
  runSteps,
  splitTests,
  type Step,
} from "./check-changed.ts";
import { decide, readWorkspace } from "../.github/scripts/ci-changes.cjs";

const GiB = 1024 ** 3;

describe("check:changed", () => {
  it("bounds the default concurrency by the scarcer of cores and available memory", () => {
    assert.strictEqual(defaultConcurrency(32, 128 * GiB), 16);
    assert.strictEqual(defaultConcurrency(32, 20 * GiB), 3);
    assert.strictEqual(defaultConcurrency(4, 15 * GiB), 2);
    assert.strictEqual(defaultConcurrency(4, 2 * GiB), 1);
    assert.strictEqual(defaultConcurrency(1, 64 * GiB), 1);
  });

  it("runs the server tests for the one guide they read and leaves other docs inert", () => {
    const packages = readWorkspace();
    assert.isTrue(
      decide(["docs/user/t3-connect-troubleshooting.md"], packages, false).outputs.test_server,
    );
    assert.deepStrictEqual(crossFileTests(["docs/user/t3-connect-troubleshooting.md"]), [
      "apps/server/src/cloud/ConnectReachability.test.ts",
    ]);
    assert.deepStrictEqual(decide(["docs/user/install.md"], packages, false).affected, []);
  });

  it("selects checkpoint fixture tests for shared build ownership dependencies", () => {
    const expected = [
      "scripts/lastcode-checkpoint-lifecycle.test.ts",
      "scripts/lastcode-checkpoint-publication.test.ts",
    ];
    for (const file of [
      "packages/shared/src/generatedBuildOwnership.ts",
      "packages/shared/src/nativeFileSystem.ts",
    ]) {
      assert.deepStrictEqual(crossFileTests([file]), expected);
    }
    assert.deepStrictEqual(crossFileTests(["packages/shared/src/String.ts"]), []);
  });

  it.effect(
    "keeps weighted steps within the budget, in order, and serial steps one at a time",
    () =>
      Effect.gen(function* () {
        const startedAt: Record<string, number> = {};
        let active = 0;
        let maxActive = 0;
        let serialActive = 0;
        let maxSerial = 0;
        const step = (
          name: string,
          options: { weight?: number; serial?: boolean } = {},
        ): Step<never> => {
          const slots = Math.min(options.weight ?? 1, 3);
          return {
            name,
            ...options,
            run: Effect.gen(function* () {
              startedAt[name] = (yield* Clock.currentTimeMillis) / 1000;
              active += slots;
              maxActive = Math.max(maxActive, active);
              if (options.serial) maxSerial = Math.max(maxSerial, ++serialActive);
              yield* Effect.sleep("1 second");
              active -= slots;
              if (options.serial) serialActive--;
              return { ok: true, output: "" };
            }),
          };
        };
        const fiber = yield* runSteps(
          [
            step("light 1"),
            // Above the budget, so it holds every slot rather than never starting.
            step("heavy", { weight: 5 }),
            step("pair", { weight: 2 }),
            step("light 2"),
            step("test 1", { serial: true }),
            step("test 2", { serial: true }),
          ],
          { concurrency: 3, timeoutSeconds: 60 },
        ).pipe(Effect.forkChild);
        yield* TestClock.adjust("10 seconds");
        const results = yield* Fiber.join(fiber);

        assert.deepStrictEqual(
          results.map((result) => result.outcome),
          ["pass", "pass", "pass", "pass", "pass", "pass"],
        );
        assert.strictEqual(maxActive, 3);
        // Lighter steps queued behind the heavy one never start ahead of it.
        assert.deepStrictEqual(startedAt, {
          "light 1": 0,
          heavy: 1,
          pair: 2,
          "light 2": 2,
          "test 1": 3,
          "test 2": 4,
        });
        assert.strictEqual(maxSerial, 1);
      }),
  );

  it.effect("interrupts a step at its timeout and reports TIMEOUT, apart from FAIL", () =>
    Effect.gen(function* () {
      let interrupted = false;
      const fiber = yield* runSteps(
        [
          {
            name: "hangs",
            run: Effect.never.pipe(
              Effect.onInterrupt(() => Effect.sync(() => (interrupted = true))),
            ),
          },
          { name: "fails", run: Effect.succeed({ ok: false, output: "error" }) },
          { name: "passes", run: Effect.succeed({ ok: true, output: "" }) },
        ],
        { concurrency: 3, timeoutSeconds: 10 },
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("9 seconds");
      assert.isFalse(interrupted);
      yield* TestClock.adjust("1 second");
      const results = yield* Fiber.join(fiber);

      assert.isTrue(interrupted);
      assert.deepStrictEqual(
        results.map(({ name, outcome, time }) => [name, outcome, time]),
        [
          ["hangs", "TIMEOUT", "killed after 10s"],
          ["fails", "FAIL", "0.0s"],
          ["passes", "pass", "0.0s"],
        ],
      );
    }),
  );

  it("runs the .github/scripts node:test files with node --test, not vitest", () => {
    assert.deepStrictEqual(
      splitTests([
        "apps/server/src/ws.test.ts",
        ".github/scripts/ci-changes.test.cjs",
        ".github\\scripts\\thread-transfer-report.test.cjs",
        "scripts/check-changed.test.ts",
      ]),
      {
        vitestTests: ["apps/server/src/ws.test.ts", "scripts/check-changed.test.ts"],
        nodeTests: [
          ".github/scripts/ci-changes.test.cjs",
          ".github\\scripts\\thread-transfer-report.test.cjs",
        ],
      },
    );
  });

  it.effect("fails instead of returning an empty file list when git exits nonzero", () => {
    const spawner = (exitCode: number) =>
      ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.encodeText(Stream.make(exitCode === 0 ? "a.ts\nb.ts\n" : "")),
            stderr: Stream.encodeText(
              Stream.make(exitCode === 0 ? "" : "fatal: index file corrupt"),
            ),
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
    return Effect.gen(function* () {
      const listed = yield* gitLines("/repo", ["ls-files"]).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner(0)),
      );
      assert.deepStrictEqual(listed, ["a.ts", "b.ts"]);
      const error = yield* gitLines("/repo", ["ls-files"]).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner(128)),
        Effect.flip,
      );
      assert.strictEqual(
        error,
        "check:changed: git ls-files exited with 128: fatal: index file corrupt",
      );
    });
  });

  it.each([
    "packages/shared/src/testing/longTempDir.ts",
    "packages/shared/src/testing/providerEnv.ts",
  ])("tests every package when the shared test setup file %s changes", (file) => {
    assert.strictEqual(decide([file], readWorkspace(), false).outputs.test_packages, "");
  });
});

// Hooks export GIT_DIR and GIT_INDEX_FILE, and user config or the default
// ~/.config/git/ignore can ignore or sign fixture files.
// Git for Windows rejects the null device as a config path, so use an empty file.
const emptyConfigDir = NodeFS.mkdtempSync(
  NodePath.join(NodeOS.tmpdir(), "t3-check-changed-config-"),
);
const emptyConfig = NodePath.join(emptyConfigDir, "empty.gitconfig");
NodeFS.writeFileSync(emptyConfig, "");
afterAll(() => NodeFS.rmSync(emptyConfigDir, { recursive: true, force: true }));
const fixtureConfig = {
  "core.excludesFile": emptyConfig,
  "user.name": "Fixture",
  "user.email": "fixture@example.invalid",
};
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: emptyConfig,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: String(Object.keys(fixtureConfig).length),
  ...Object.fromEntries(
    Object.entries(fixtureConfig).flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${index}`, key],
      [`GIT_CONFIG_VALUE_${index}`, value],
    ]),
  ),
};

// History A -> B -> C, with HEAD at C. Each remote's main points at A or B.
function fixture(remotes: Record<string, "A" | "B">) {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-check-changed-")),
  );
  const commits: Record<string, string> = {};
  try {
    const write = (file: string, content: string) => {
      const path = NodePath.join(root, file);
      NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
      NodeFS.writeFileSync(path, content);
    };
    const git = (...args: Array<string>) =>
      NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8", env }).trim();
    git("init");
    for (const name of ["A", "B", "C"]) {
      write(`${name}.txt`, name);
      git("add", ".");
      git("commit", "-m", name);
      commits[name] = git("rev-parse", "HEAD");
    }
    for (const [remote, commit] of Object.entries(remotes)) {
      git("remote", "add", remote, NodePath.join(root, "missing"));
      git("update-ref", `refs/remotes/${remote}/main`, commits[commit]!);
    }
  } catch (error) {
    NodeFS.rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    commits,
    root,
    [Symbol.dispose]() {
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  };
}

const compare = (root: string, ref: Option.Option<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* comparisonBase(root, ref).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => spawner.spawn(ChildProcess.setEnv(command, env))),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);

it.each(["upstream", "team/upstream"])(
  "compares against %s/main when the fork's origin/main lags it",
  async (remote) => {
    using project = fixture({ origin: "A", [remote]: "B" });
    const result = await compare(project.root, Option.none());
    assert.strictEqual(result.base, project.commits.B);
    assert.strictEqual(result.ref, remote + "/main");
  },
);

it("compares against an explicit ref instead of the closest remote main", async () => {
  using project = fixture({ origin: "A", upstream: "B" });
  const result = await compare(project.root, Option.some("origin/main"));
  assert.strictEqual(result.base, project.commits.A);
  assert.strictEqual(result.ref, "origin/main");
});

function launcherFixture(nativeLauncher = false) {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3 checks & (fixture) ")),
  );
  const write = (file: string, content: string) => {
    const path = NodePath.join(root, file);
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, content);
  };
  for (const file of [
    "scripts/check-changed.ts",
    "scripts/check-changed-command.ts",
    ".github/scripts/ci-changes.cjs",
  ]) {
    write(file, NodeFS.readFileSync(NodePath.join(import.meta.dirname, "..", file), "utf8"));
  }
  write(".gitignore", "node_modules/\nrecords/\n");
  write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  write(
    "package.json",
    JSON.stringify({
      type: "module",
      scripts: {
        "knip:check:files": "knip --include files",
        "knip:check:exports": "knip --exports",
      },
    }),
  );
  write("packages/example/package.json", JSON.stringify({ name: "example" }));
  const source = "packages/example/space & (draft) %PATH% ! 研究.ts";
  write(source, "export const value = 1;\n");
  write(
    "node_modules/vite-plus/package.json",
    JSON.stringify({ type: "module", exports: { "./bin": "./cli.js" } }),
  );
  write(
    "node_modules/vite-plus/cli.js",
    `
    import fs from 'node:fs';
    import path from 'node:path';
    const args = process.argv.slice(2);
    fs.writeFileSync(path.join(process.env.RECORDS, process.pid + '.json'), JSON.stringify({ args, cwd: process.cwd() }));
    if (process.env.FAIL_STEP === 'mutate' && args[0] === 'lint') fs.appendFileSync(args[1], '// concurrent edit\\n');
    console.log('fixture stdout: ' + args[0]);
    console.error('fixture stderr: ' + args[0]);
    process.exit(args[0] === process.env.FAIL_STEP ? 23 : 0);
  `,
  );
  // Select the Windows launcher without changing the Effect runtime's host platform.
  write(
    "scripts/check-changed.ts",
    nativeLauncher
      ? NodeFS.readFileSync(NodePath.join(import.meta.dirname, "check-changed.ts"), "utf8")
      : NodeFS.readFileSync(NodePath.join(import.meta.dirname, "check-changed.ts"), "utf8").replace(
          "vitePlusCommand(args, platform)",
          'vitePlusCommand(args, "win32")',
        ),
  );
  write(
    "node_modules/.bin/vp",
    `#!/bin/sh\nexec '${process.execPath}' '${root}/node_modules/vite-plus/cli.js' "$@"\n`,
  );
  NodeFS.chmodSync(NodePath.join(root, "node_modules/.bin/vp"), 0o755);
  for (const name of ["effect", "@effect/platform-node", "@t3tools/shared"]) {
    const dest = NodePath.join(root, "node_modules", name);
    NodeFS.mkdirSync(NodePath.dirname(dest), { recursive: true });
    NodeFS.symlinkSync(
      NodeFS.realpathSync(NodePath.join(import.meta.dirname, "node_modules", name)),
      dest,
      "junction",
    );
  }
  const git = (...args: Array<string>) =>
    NodeChildProcess.execFileSync("git", args, { cwd: root, stdio: "pipe", env });
  git("init");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=",
    "commit",
    "-m",
    "fixture",
  );
  const records = NodePath.join(root, "records");
  NodeFS.mkdirSync(records);
  return {
    root,
    source,
    write,
    git: (...args: Array<string>) =>
      git(...args)
        .toString()
        .trim(),
    run(failStep = "", args = ["HEAD"]) {
      return NodeChildProcess.spawnSync(process.execPath, ["scripts/check-changed.ts", ...args], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...env,
          PATH: `${root}/node_modules/.bin:${process.env.PATH ?? ""}`,
          TEMP: NodeOS.tmpdir(),
          RECORDS: records,
          FAIL_STEP: failStep,
        },
      });
    },
    calls: (): Array<{ args: Array<string>; cwd: string }> =>
      NodeFS.readdirSync(records).map((file) =>
        JSON.parse(NodeFS.readFileSync(NodePath.join(records, file), "utf8")),
      ),
    [Symbol.dispose]() {
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  };
}

it("gates the completed replay's conflict files without repeating the broader CI checks", () => {
  using project = launcherFixture(true);
  const test = project.source.replace(/\.ts$/, ".test.ts");
  const unrelated = "packages/example/unrelated.ts";
  project.write(test, "export {};\n");
  project.write(unrelated, "export const unrelated = true;\n");
  project.git("add", ".");
  project.git("commit", "-m", "completed replay");
  const files = "node_modules/recovery-files.txt";
  project.write(files, `${project.source}\npackages/example/package.json\n${project.source}\n`);
  const rejected = project.run("lint", ["--checkpoint-recovery-files", files]);
  expect(rejected.status, rejected.stdout + rejected.stderr).toBe(1);
  expect(rejected.stdout).toContain("FAIL  lint");
  expect(
    NodeFS.existsSync(NodePath.join(project.root, "node_modules/.cache/check-changed.json")),
  ).toBe(false);
  const result = project.run("", ["--checkpoint-recovery-files", files]);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const commands = project.calls().map(({ args }) => args);
  expect(commands).toContainEqual(["lint", "--no-error-on-unmatched-pattern", project.source]);
  expect(commands).toContainEqual([
    "fmt",
    "--check",
    "--no-error-on-unmatched-pattern",
    "packages/example/package.json",
    project.source,
  ]);
  expect(commands.some((args) => args.includes("typecheck") && args.includes("example"))).toBe(
    true,
  );
  expect(commands).toContainEqual(["test", "run", "--passWithNoTests", test]);
  expect(
    commands.some(
      (args) => args.includes(unrelated) || args.includes("knip") || args[0] === "install",
    ),
  ).toBe(false);
  // This pass cannot satisfy an ordinary changed-file gate, even at the same HEAD.
  const ordinary = project.run("", ["HEAD^"]);
  expect(ordinary.status, ordinary.stdout + ordinary.stderr).toBe(0);
  expect(ordinary.stdout).not.toContain("Nothing changed since the last passing run");
  expect(project.calls().some(({ args }) => args.includes("knip"))).toBe(true);
});

it("checks changed source paths through the Windows launcher", () => {
  using project = launcherFixture();
  project.write(project.source, "export const value = 2;\n");
  const result = project.run();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const calls = project.calls();
  expect(calls.find(({ args }) => args[0] === "lint")).toEqual({
    args: ["lint", "--no-error-on-unmatched-pattern", project.source],
    cwd: project.root,
  });
  expect(calls.some(({ args }) => args[0] === "fmt" && args.includes(project.source))).toBe(true);
  expect(calls.some(({ args }) => args[0] === "run" && args.includes("typecheck"))).toBe(true);
  expect(calls.some(({ args }) => args[0] === "install")).toBe(false);
  expect(result.stdout).toContain("fixture stdout: lint");
  expect(result.stdout).toContain("fixture stderr: lint");
});

it("lints an Astro component and runs knip when only it changed", () => {
  using project = launcherFixture();
  const page = "packages/example/Page.astro";
  project.write(page, "---\nconst title = 1;\n---\n<h1>{title}</h1>\n");
  const result = project.run();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const calls = project.calls();
  expect(calls.find(({ args }) => args[0] === "lint")?.args).toEqual([
    "lint",
    "--no-error-on-unmatched-pattern",
    page,
  ]);
  const commands = calls.map(({ args }) => args);
  expect(commands).toContainEqual(["exec", "knip", "--include", "files"]);
  expect(commands).toContainEqual(["exec", "knip", "--exports"]);
});

it.each(["install", "lint"])("reports a failing %s step with its output", (step) => {
  using project = launcherFixture();
  project.write(project.source, "export const value = 2;\n");
  project.write(
    "packages/example/package.json",
    JSON.stringify({ name: "example", version: "1.0.1" }),
  );
  const result = project.run(step);
  expect(result.status, result.stdout + result.stderr).toBe(1);
  const install = project.calls().find(({ args }) => args[0] === "install");
  expect(install?.args, result.stdout + result.stderr).toEqual([
    "install",
    "--lockfile-only",
    "--ignore-scripts",
  ]);
  expect(install?.cwd).not.toBe(project.root);
  expect(result.stdout + result.stderr).toContain(`fixture stdout: ${step}`);
  expect(result.stdout + result.stderr).toContain(`fixture stderr: ${step}`);
  expect(result.stdout).toContain(step === "install" ? "FAIL  unused patches" : "FAIL  lint");
  if (step === "lint") expect(result.stdout).toContain("pass  unused patches");
  expect(
    NodeFS.existsSync(NodePath.join(project.root, "node_modules/.cache/check-changed.json")),
  ).toBe(false);
});

it("checks every integrated repair against a pinned snapshot across rewritten carry history", () => {
  using project = launcherFixture();
  const baseline = project.git("rev-parse", "HEAD");
  const rewritten = project.git("commit-tree", "HEAD^{tree}", "-m", "compiled carry snapshot");
  project.git("checkout", "-B", "compiled", rewritten);
  project.write(project.source, "export const value = 2;\n");
  project.git("add", ".");
  project.git("commit", "-m", "first integrated repair");
  project.git("checkout", "-b", "delegated-repair");
  const delegated = "packages/example/delegated.ts";
  project.write(delegated, "export const repaired = true;\n");
  project.git("add", ".");
  project.git("commit", "-m", "delegated repair");
  project.git("checkout", "compiled");
  const final = "packages/example/final.ts";
  project.write(final, "export const finalRepair = true;\n");
  project.git("add", ".");
  project.git("commit", "-m", "last child repair");
  project.git("merge", "--no-ff", "delegated-repair", "-m", "integrate repair batch");
  const candidate = project.git("rev-parse", "HEAD");
  // A last-patch check omits the earlier repair; these endpoints have no merge base.
  expect(project.git("diff", "--name-only", "HEAD^", "HEAD")).not.toContain(project.source);
  const result = project.run("", ["--baseline", baseline, "--candidate", candidate]);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain(baseline);
  expect(result.stdout).toContain(candidate);
  const calls = project.calls();
  expect(calls.find(({ args }) => args[0] === "lint")?.args).toEqual([
    "lint",
    "--no-error-on-unmatched-pattern",
    delegated,
    final,
    project.source,
  ]);
  expect(calls.find(({ args }) => args[0] === "fmt")?.args).toEqual([
    "fmt",
    "--check",
    "--no-error-on-unmatched-pattern",
    delegated,
    final,
    project.source,
  ]);
  expect(calls.some(({ args }) => args.includes("typecheck") && args.includes("example"))).toBe(
    true,
  );
});

it.each([
  [
    "recovery with a ref",
    ["HEAD", "--checkpoint-recovery-files", "node_modules/paths.txt"],
    "cannot be combined",
  ],
  ["missing candidate", ["--baseline", "HEAD"], "use --baseline and --candidate together"],
  ["missing baseline", ["--candidate", "HEAD"], "use --baseline and --candidate together"],
  [
    "positional ref",
    ["HEAD", "--baseline", "HEAD", "--candidate", "HEAD"],
    "without a positional ref",
  ],
  ["invalid baseline", ["--baseline", "missing-commit", "--candidate", "HEAD"], "git rev-parse"],
  ["invalid candidate", ["--baseline", "HEAD", "--candidate", "missing-commit"], "git rev-parse"],
])("rejects %s before running checks", (_name, args, message) => {
  using project = launcherFixture();
  const result = project.run("", args);
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stdout + result.stderr).toContain(message);
  expect(project.calls()).toEqual([]);
});

it.each(["tracked", "untracked", "wrong HEAD", "rebase", "merge"])(
  "rejects an incomplete candidate: %s",
  (kind) => {
    using project = launcherFixture();
    const candidate = project.git("rev-parse", "HEAD");
    if (kind === "tracked") project.write(project.source, "export const value = 2;\n");
    if (kind === "untracked") project.write("unfinished.ts", "unfinished\n");
    if (kind === "wrong HEAD") {
      project.git("commit", "--allow-empty", "-m", "another candidate");
    }
    if (kind === "rebase") project.write(".git/rebase-merge/head-name", "refs/heads/compiled");
    if (kind === "merge") project.write(".git/MERGE_HEAD", candidate + "\n");
    const result = project.run("", ["--baseline", candidate, "--candidate", candidate]);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout + result.stderr).toContain(
      kind === "wrong HEAD"
        ? "is not checkout HEAD"
        : kind === "rebase" || kind === "merge"
          ? "finish the pending Git operation"
          : "requires a clean checkout",
    );
    expect(project.calls()).toEqual([]);
  },
);

it("rejects a candidate changed while the checks run", () => {
  using project = launcherFixture();
  const baseline = project.git("rev-parse", "HEAD");
  project.write(project.source, "export const value = 2;\n");
  project.git("add", ".");
  project.git("commit", "-m", "integrated repair");
  const candidate = project.git("rev-parse", "HEAD");
  const result = project.run("mutate", ["--baseline", baseline, "--candidate", candidate]);
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stdout + result.stderr).toContain("requires a clean checkout");
  expect(
    NodeFS.existsSync(NodePath.join(project.root, "node_modules/.cache/check-changed.json")),
  ).toBe(false);
});
