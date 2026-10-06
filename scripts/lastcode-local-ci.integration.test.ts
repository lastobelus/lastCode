// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { ACTION_EVENT_TOKEN_ENV, ACTION_RUN_ID_ENV } from "@t3tools/shared/actionResumeProtocol";
import { expect, it } from "vite-plus/test";
import { getCurrentProcessStartIdentity } from "./lib/lastcode-ci-process-identity.ts";
import { runCiProcess } from "./lib/lastcode-ci-process.ts";
import {
  assertSupportedNodeVersion,
  resolveLocalCiSteps,
  resolveQuickCiReceiptPath,
} from "./lastcode-local-ci.ts";

it.skipIf(NodeProcess.platform === "win32").each([0, 1])(
  "checks Homebrew prerequisites without background work and preserves exit code %i",
  async (exitCode) => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-brew-check-"));
    try {
      const brew = NodePath.join(directory, "brew");
      NodeFS.writeFileSync(
        brew,
        [
          `#!${fixtureNodeExecutable()}`,
          "if (process.env.HOMEBREW_NO_AUTO_UPDATE !== '1' || process.env.HOMEBREW_NO_ANALYTICS !== '1') process.exit(9);",
          "if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['bundle', 'check', '--file', 'apps/mobile/Brewfile'])) process.exit(8);",
          `process.stdout.write(${JSON.stringify(exitCode === 0 ? "Tools available\n" : "Missing tool\n")});`,
          `process.exit(${exitCode});`,
        ].join("\n"),
        { mode: 0o755 },
      );
      const step = resolveLocalCiSteps("full").find(
        ({ label }) => label === "Mobile native tool prerequisites",
      );
      if (step?.kind !== "command") throw new Error("Missing Homebrew prerequisite check.");
      let output = "";
      const result = runCiProcess({
        cwd: directory,
        command: step.command,
        args: step.args,
        env: {
          ...process.env,
          PATH: `${directory}${NodePath.delimiter}${process.env.PATH ?? ""}`,
          HOMEBREW_NO_AUTO_UPDATE: "0",
          HOMEBREW_NO_ANALYTICS: "0",
        },
        signal: new AbortController().signal,
        failureHelp: step.failureHelp,
        onOutput: (value) => {
          output += value;
        },
      });
      if (exitCode === 0) {
        await result;
        expect(output).toBe("Tools available\n");
      } else {
        await expect(result).rejects.toThrow("failed with exit code 1");
        expect(output).toBe("Missing tool\n");
      }
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  },
);

it.skipIf(NodeProcess.platform === "win32")(
  "runs the affected-workspace command through the installed task runner",
  () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-ci-runner-"));
    const callsPath = NodePath.join(directory, "calls.jsonl");
    const testArgsPath = NodePath.join(directory, "test-args.jsonl");
    try {
      NodeFS.writeFileSync(
        NodePath.join(directory, "package.json"),
        JSON.stringify({ name: "fixture-root", private: true }),
      );
      NodeFS.writeFileSync(
        NodePath.join(directory, "pnpm-workspace.yaml"),
        "packages:\n  - 'packages/*'\n",
      );
      for (const name of ["selected", "unrelated"]) {
        const packageRoot = NodePath.join(directory, "packages", name);
        NodeFS.mkdirSync(packageRoot, { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(packageRoot, "package.json"),
          JSON.stringify({
            name: `@fixture/${name}`,
            scripts: { typecheck: "node check.cjs", test: "node test.cjs" },
          }),
        );
        NodeFS.writeFileSync(
          NodePath.join(packageRoot, "check.cjs"),
          `require('node:fs').appendFileSync(${JSON.stringify(callsPath)}, ${JSON.stringify(`${name}\n`)});`,
        );
        NodeFS.writeFileSync(
          NodePath.join(packageRoot, "test.cjs"),
          `require('node:fs').appendFileSync(${JSON.stringify(testArgsPath)}, JSON.stringify({name:${JSON.stringify(name)},args:process.argv.slice(2)})+${JSON.stringify("\n")});`,
        );
      }
      const step = resolveLocalCiSteps("quick", {
        kind: "affected",
        packages: ["@fixture/selected"],
        changedFiles: [],
        reason: "Fixture source edit",
      }).find(({ label }) => label === "Workspace typecheck");
      if (step?.kind !== "command") throw new Error("Missing workspace typecheck command.");
      const result = NodeChildProcess.spawnSync(
        NodePath.resolve(import.meta.dirname, "../node_modules/.bin/vp"),
        step.args,
        { cwd: directory, encoding: "utf8", timeout: 15_000 },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(NodeFS.readFileSync(callsPath, "utf8")).toBe("selected\n");
      const tests = resolveLocalCiSteps("full").find(({ label }) => label === "Workspace tests");
      if (tests?.kind !== "command") throw new Error("Missing workspace tests command.");
      const tested = NodeChildProcess.spawnSync(
        NodePath.resolve(import.meta.dirname, "../node_modules/.bin/vp"),
        tests.args,
        { cwd: directory, encoding: "utf8", timeout: 15_000 },
      );
      expect(tested.status, `${tested.stdout}\n${tested.stderr}`).toBe(0);
      const argumentsByPackage = NodeFS.readFileSync(testArgsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(argumentsByPackage).toEqual(
        expect.arrayContaining([
          { name: "selected", args: ["--maxWorkers=1", "--maxConcurrency=1"] },
          { name: "unrelated", args: ["--maxWorkers=1", "--maxConcurrency=1"] },
        ]),
      );
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  },
);

function fixtureNodeExecutable(): string {
  // Vite+ can execute tests with its own newer Node. The actual CI CLI must
  // still run with the repository's supported runtime from the caller's PATH.
  const candidates = [
    process.execPath,
    ...(process.env.PATH?.split(NodePath.delimiter).map((path) => NodePath.join(path, "node")) ??
      []),
  ];
  for (const candidate of new Set(candidates)) {
    if (!NodeFS.existsSync(candidate)) continue;
    const version = NodeChildProcess.spawnSync(candidate, ["-p", "process.versions.node"], {
      encoding: "utf8",
      timeout: 2_000,
    });
    if (version.status !== 0) continue;
    try {
      assertSupportedNodeVersion(version.stdout.trim());
      return candidate;
    } catch {
      // An unrelated runtime on PATH is not the project runtime.
    }
  }
  throw new Error("The CI integration fixture requires the supported project Node on PATH.");
}

it.skipIf(NodeProcess.platform === "win32").each(["standalone", "enclosing Action"] as const)(
  "checks docs once and reuses the exact receipt from both entrypoints under %s",
  (context) => {
    const directory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "lastcode-quick-entrypoints-"),
    );
    const repoRoot = NodePath.join(directory, "repo");
    const nodeExecutable = fixtureNodeExecutable();
    NodeFS.mkdirSync(repoRoot);
    const git = (...args: string[]) =>
      NodeChildProcess.execFileSync("git", args, {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    const write = (path: string, text: string) => {
      const absolute = NodePath.join(repoRoot, path);
      NodeFS.mkdirSync(NodePath.dirname(absolute), { recursive: true });
      NodeFS.writeFileSync(absolute, text);
    };
    try {
      git("init", "-b", "lastcode/main");
      git("config", "user.name", "CI fixture");
      git("config", "user.email", "fixture@example.com");
      write(".gitignore", "node_modules\n");
      write("README.md", "Initial documentation.\n");
      write("pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n");
      write(
        "packages/example/package.json",
        JSON.stringify({
          name: "@fixture/example",
          scripts: { typecheck: "tsc --noEmit" },
        }),
      );
      write("packages/example/tsconfig.json", JSON.stringify({ include: ["src"] }));
      write("packages/example/src/index.ts", "export const value = 1;\n");
      git("add", ".");
      git("commit", "-m", "fixture base");
      git("remote", "add", "origin", repoRoot);
      git("switch", "-c", "lastcode/fixture-docs");
      write("README.md", "Updated documentation.\n");
      git("add", "README.md");
      git("commit", "-m", "fixture documentation");
      const head = git("rev-parse", "HEAD");
      const callsPath = NodePath.join(directory, "calls.jsonl");
      write(
        "node_modules/.bin/vp",
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({args:process.argv.slice(2),cpu:process.env.GOMAXPROCS})+'\\n');`,
        ].join("\n"),
      );
      NodeFS.chmodSync(NodePath.join(repoRoot, "node_modules/.bin/vp"), 0o755);
      const settingsPath = NodePath.join(directory, "settings.json");
      NodeFS.writeFileSync(
        settingsPath,
        JSON.stringify({ lastcodeLocalCi: { backgroundPriority: false } }),
      );
      const inheritedEnv = {
        ...process.env,
        ...(context === "enclosing Action"
          ? {
              [ACTION_RUN_ID_ENV]: "fixture-enclosing-run",
              [ACTION_EVENT_TOKEN_ENV]: "fixture-enclosing-token",
            }
          : {}),
      };
      // Full CI already holds the real host's admission slot while running
      // this test. Isolate homedir in this subprocess so its CLI fixture cannot
      // wait for its enclosing run or touch the operator's admission files.
      const isolatedHome = NodePath.join(directory, "home");
      const preload = NodePath.join(directory, "isolated-home.mjs");
      const receiptPath = resolveQuickCiReceiptPath(NodePath.join(repoRoot, ".git"), head);
      const releasedReceiptPath = NodePath.join(directory, "receipt-at-release.json");
      NodeFS.writeFileSync(
        preload,
        [
          "import os from 'node:os';",
          "import fs from 'node:fs';",
          "import { syncBuiltinESMExports } from 'node:module';",
          `os.homedir = () => ${JSON.stringify(isolatedHome)};`,
          "const rmSync = fs.rmSync;",
          // Observe the receipt before the slot becomes available to queued runs.
          "fs.rmSync = (path, options) => {",
          "  if (String(path).endsWith('.lease.json')) {",
          `    const receipt = fs.existsSync(${JSON.stringify(receiptPath)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(receiptPath)}, 'utf8')) : null;`,
          `    fs.writeFileSync(${JSON.stringify(releasedReceiptPath)}, JSON.stringify(receipt));`,
          "  }",
          "  return rmSync(path, options);",
          "};",
          "syncBuiltinESMExports();",
        ].join("\n"),
      );
      const command = (prePush = false, requireLocal = false) =>
        NodeChildProcess.spawnSync(
          nodeExecutable,
          [
            "--import",
            preload,
            NodePath.resolve(import.meta.dirname, "lastcode-local-ci.ts"),
            "--quick",
            ...(prePush ? ["--pre-push"] : []),
            ...(requireLocal ? ["--require-local"] : []),
          ],
          {
            cwd: repoRoot,
            encoding: "utf8",
            // The fixture invokes a standalone CLI, not the enclosing build's
            // Action. Keep its reports readable and owned by this subprocess.
            env: {
              ...inheritedEnv,
              [ACTION_RUN_ID_ENV]: undefined,
              [ACTION_EVENT_TOKEN_ENV]: undefined,
              T3CODE_LOCAL_CI_SETTINGS_PATH: settingsPath,
            },
            timeout: 60_000,
            input: prePush
              ? `refs/heads/lastcode/fixture-docs ${git("rev-parse", "HEAD")} refs/heads/lastcode/fixture-docs ${"0".repeat(40)}\n`
              : undefined,
          },
        );
      const first = command();
      expect(first.status, first.stderr).toBe(0);
      expect(JSON.parse(NodeFS.readFileSync(releasedReceiptPath, "utf8"))).toMatchObject({
        commit: head,
        baseCommit: git("rev-parse", "lastcode/main"),
        baseRef: "refs/remotes/origin/lastcode/main",
      });
      expect(NodeFS.existsSync(NodePath.join(isolatedHome, ".cache", "lastcode", "local-ci"))).toBe(
        true,
      );
      expect(first.stdout).toContain("Typecheck scope: none");
      const repeatedAction = command();
      expect(repeatedAction.status, repeatedAction.stderr).toBe(0);
      expect(repeatedAction.stdout).toContain("Reusing Quick CI receipt");
      expect(repeatedAction.stdout).toContain('"outcome":"success"');
      expect(repeatedAction.stdout).not.toContain("\u001b]777;T3ActionEvent;");
      const push = command(true);
      expect(push.status, push.stderr).toBe(0);
      expect(push.stdout).toContain("Reusing Quick CI receipt");
      const calls = NodeFS.readFileSync(callsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls).toEqual([
        { args: ["check", "--no-error-on-unmatched-pattern", "./README.md"], cpu: "2" },
      ]);

      write("README.md", "Documentation for the next revision.\n");
      git("add", "README.md");
      git("commit", "-m", "fixture next documentation");
      const nextHead = git("rev-parse", "HEAD");
      const nextReceipt = resolveQuickCiReceiptPath(NodePath.join(repoRoot, ".git"), nextHead);
      const budgetDirectory = NodePath.join(isolatedHome, ".cache", "lastcode", "local-ci");
      const occupiedLease = NodePath.join(budgetDirectory, "fixture-active.lease.json");
      NodeFS.writeFileSync(
        occupiedLease,
        JSON.stringify({
          pid: process.pid,
          startIdentity: getCurrentProcessStartIdentity(),
          childPid: null,
          childStartIdentity: null,
          token: "fixture-active",
          maxConcurrentRuns: 1,
          repoRoot,
        }),
      );
      for (const prePush of [false, true]) {
        const busy = command(prePush);
        expect(busy.status, busy.stderr).toBe(0);
        expect(busy.stdout).toContain('"validation":"github-only"');
        expect(busy.stdout).toContain('"skipReason":"busy"');
        expect(busy.stdout).not.toContain('"outcome":"success"');
        expect(NodeFS.existsSync(nextReceipt)).toBe(false);
        expect(NodeFS.readFileSync(callsPath, "utf8").trim().split("\n")).toHaveLength(1);
        expect(
          NodeFS.readdirSync(budgetDirectory).filter((name) => name.endsWith(".waiter.json")),
        ).toEqual([]);
      }
      NodeFS.rmSync(occupiedLease);
      NodeFS.writeFileSync(
        settingsPath,
        JSON.stringify({ lastcodeLocalCi: { quickCiMode: "github", backgroundPriority: false } }),
      );
      for (const prePush of [false, true]) {
        const remote = command(prePush);
        expect(remote.status, remote.stderr).toBe(0);
        expect(remote.stdout).toContain('"validation":"github-only"');
        expect(remote.stdout).toContain('"skipReason":"configured"');
        expect(NodeFS.existsSync(nextReceipt)).toBe(false);
      }
      const explicitLocal = command(false, true);
      expect(explicitLocal.status, explicitLocal.stderr).toBe(0);
      expect(explicitLocal.stdout).toContain("Quick local CI passed");
      expect(JSON.parse(NodeFS.readFileSync(nextReceipt, "utf8"))).toMatchObject({
        commit: nextHead,
      });
      expect(NodeFS.readFileSync(callsPath, "utf8").trim().split("\n")).toHaveLength(2);

      const realGit = process.env.PATH?.split(NodePath.delimiter)
        .map((path) => NodePath.join(path, "git"))
        .find((path) => NodeFS.existsSync(path));
      expect(realGit).toBeDefined();
      // Simulate an edit arriving during the explicit Action's fetch. A receipt
      // for the old clean checkout must not become success for the dirty one.
      write(
        "node_modules/.bin/git",
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "const cp = require('node:child_process');",
          "const args = process.argv.slice(2);",
          "if (args[0] === 'fetch') fs.appendFileSync('README.md', 'Edit during fetch.\\n');",
          `try { cp.execFileSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' }); } catch (error) { process.exit(error.status ?? 1); }`,
        ].join("\n"),
      );
      NodeFS.chmodSync(NodePath.join(repoRoot, "node_modules/.bin/git"), 0o755);
      const changedDuringFetch = command();
      expect(changedDuringFetch.status).toBe(1);
      expect(changedDuringFetch.stderr).toContain("Working tree must be clean");
      expect(changedDuringFetch.stdout).not.toContain("Reusing Quick CI receipt");
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  },
  240_000,
);

for (const { signal, milestone } of [
  { signal: "SIGTERM", milestone: "diff-whitespace" },
  { signal: "SIGINT", milestone: "diff-whitespace" },
  { signal: "SIGTERM", milestone: "final-worktree-check" },
] as const) {
  it.skipIf(NodeProcess.platform === "win32")(
    `does not publish a deletion-only docs receipt after ${signal} during ${milestone}`,
    () => {
      const directory = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "lastcode-quick-cancel-"),
      );
      const repoRoot = NodePath.join(directory, "repo");
      const nodeExecutable = fixtureNodeExecutable();
      const realGit = process.env.PATH?.split(NodePath.delimiter)
        .map((path) => NodePath.join(path, "git"))
        .find((path) => NodeFS.existsSync(path));
      if (!realGit) throw new Error("The CI integration fixture requires Git on PATH.");
      NodeFS.mkdirSync(repoRoot);
      const git = (...args: string[]) =>
        NodeChildProcess.execFileSync(realGit, args, {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
      try {
        git("init", "-b", "lastcode/main");
        git("config", "user.name", "CI fixture");
        git("config", "user.email", "fixture@example.com");
        NodeFS.writeFileSync(NodePath.join(repoRoot, ".gitignore"), "node_modules\n");
        NodeFS.writeFileSync(NodePath.join(repoRoot, "README.md"), "Initial documentation.\n");
        NodeFS.writeFileSync(
          NodePath.join(repoRoot, "pnpm-workspace.yaml"),
          "packages:\n  - 'packages/*'\n",
        );
        const packageRoot = NodePath.join(repoRoot, "packages/example");
        NodeFS.mkdirSync(NodePath.join(packageRoot, "src"), { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(packageRoot, "package.json"),
          JSON.stringify({ name: "@fixture/example", scripts: { typecheck: "tsc --noEmit" } }),
        );
        NodeFS.writeFileSync(
          NodePath.join(packageRoot, "tsconfig.json"),
          JSON.stringify({ include: ["src"] }),
        );
        NodeFS.writeFileSync(
          NodePath.join(packageRoot, "src/index.ts"),
          "export const value = 1;\n",
        );
        git("add", ".");
        git("commit", "-m", "fixture base");
        git("remote", "add", "origin", repoRoot);
        git("switch", "-c", "lastcode/fixture-docs");
        git("rm", "README.md");
        git("commit", "-m", "fixture documentation deletion");
        const head = git("rev-parse", "HEAD");
        const receiptPath = resolveQuickCiReceiptPath(NodePath.join(repoRoot, ".git"), head);
        const milestonePath = NodePath.join(directory, "signal-sent.json");
        const checkedDiffPath = NodePath.join(directory, "diff-checked");
        const gitWrapper = NodePath.join(repoRoot, "node_modules/.bin/git");
        NodeFS.mkdirSync(NodePath.dirname(gitWrapper), { recursive: true });
        NodeFS.writeFileSync(
          gitWrapper,
          [
            `#!${nodeExecutable}`,
            "const fs = require('node:fs');",
            "const cp = require('node:child_process');",
            "const args = process.argv.slice(2);",
            "const diffCheck = args[0] === 'diff' && args[1] === '--check';",
            `if (diffCheck) fs.writeFileSync(${JSON.stringify(checkedDiffPath)}, 'checked');`,
            // The synchronous diff and the later worker-based Git guard both
            // target the exact CLI, whose PID is inherited from its preload.
            `const cancel = ${JSON.stringify(milestone)} === 'diff-whitespace' ? diffCheck : args[0] === 'status' && fs.existsSync(${JSON.stringify(checkedDiffPath)});`,
            `if (cancel && !fs.existsSync(${JSON.stringify(milestonePath)})) {`,
            "  const parent = Number(process.env.LASTCODE_FIXTURE_CLI_PID);",
            `  fs.writeFileSync(${JSON.stringify(milestonePath)}, JSON.stringify({signal:${JSON.stringify(signal)},parent}));`,
            `  process.kill(parent, ${JSON.stringify(signal)});`,
            "}",
            `try { cp.execFileSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' }); } catch (error) { process.exit(error.status ?? 1); }`,
          ].join("\n"),
        );
        NodeFS.chmodSync(gitWrapper, 0o755);
        const settingsPath = NodePath.join(directory, "settings.json");
        NodeFS.writeFileSync(
          settingsPath,
          JSON.stringify({ lastcodeLocalCi: { backgroundPriority: false } }),
        );
        const preload = NodePath.join(directory, "isolated-home.mjs");
        NodeFS.writeFileSync(
          preload,
          [
            "import os from 'node:os';",
            "import { syncBuiltinESMExports } from 'node:module';",
            `os.homedir = () => ${JSON.stringify(NodePath.join(directory, "home"))};`,
            "process.env.LASTCODE_FIXTURE_CLI_PID = String(process.pid);",
            "syncBuiltinESMExports();",
          ].join("\n"),
        );
        const result = NodeChildProcess.spawnSync(
          nodeExecutable,
          [
            "--import",
            preload,
            NodePath.resolve(import.meta.dirname, "lastcode-local-ci.ts"),
            "--quick",
          ],
          {
            cwd: repoRoot,
            encoding: "utf8",
            env: {
              ...process.env,
              [ACTION_RUN_ID_ENV]: undefined,
              [ACTION_EVENT_TOKEN_ENV]: undefined,
              T3CODE_LOCAL_CI_SETTINGS_PATH: settingsPath,
            },
            timeout: 60_000,
          },
        );
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
        expect(result.signal).toBeNull();
        expect(JSON.parse(NodeFS.readFileSync(milestonePath, "utf8"))).toEqual({
          signal,
          parent: result.pid,
        });
        expect(result.stdout).toContain("Typecheck scope: none");
        expect(result.stderr).toContain("Local CI cancelled");
        expect(result.stdout).not.toContain('"outcome":"success"');
        expect(NodeFS.existsSync(receiptPath)).toBe(false);
      } finally {
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    },
    90_000,
  );
}
