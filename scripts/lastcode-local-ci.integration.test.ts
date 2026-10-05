// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { expect, it } from "vite-plus/test";
import { assertSupportedNodeVersion, resolveLocalCiSteps } from "./lastcode-local-ci.ts";

it.skipIf(NodeProcess.platform === "win32")(
  "runs the affected-workspace command through the installed task runner",
  () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-ci-runner-"));
    const callsPath = NodePath.join(directory, "calls.jsonl");
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
          JSON.stringify({ name: `@fixture/${name}`, scripts: { typecheck: "node check.cjs" } }),
        );
        NodeFS.writeFileSync(
          NodePath.join(packageRoot, "check.cjs"),
          `require('node:fs').appendFileSync(${JSON.stringify(callsPath)}, ${JSON.stringify(`${name}\n`)});`,
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

it.skipIf(NodeProcess.platform === "win32")(
  "checks docs once and reuses the exact receipt from both Action and pre-push entrypoints",
  () => {
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
      // Full CI already holds the real host's admission slot while running
      // this test. Isolate homedir in this subprocess so its CLI fixture cannot
      // wait for its enclosing run or touch the operator's admission files.
      const isolatedHome = NodePath.join(directory, "home");
      const preload = NodePath.join(directory, "isolated-home.mjs");
      NodeFS.writeFileSync(
        preload,
        [
          "import os from 'node:os';",
          "import { syncBuiltinESMExports } from 'node:module';",
          `os.homedir = () => ${JSON.stringify(isolatedHome)};`,
          "syncBuiltinESMExports();",
        ].join("\n"),
      );
      const command = (prePush = false) =>
        NodeChildProcess.spawnSync(
          nodeExecutable,
          [
            "--import",
            preload,
            NodePath.resolve(import.meta.dirname, "lastcode-local-ci.ts"),
            "--quick",
            ...(prePush ? ["--pre-push"] : []),
          ],
          {
            cwd: repoRoot,
            encoding: "utf8",
            env: { ...process.env, T3CODE_LOCAL_CI_SETTINGS_PATH: settingsPath },
            timeout: 15_000,
            input: prePush
              ? `refs/heads/lastcode/fixture-docs ${head} refs/heads/lastcode/fixture-docs ${"0".repeat(40)}\n`
              : undefined,
          },
        );
      const first = command();
      expect(first.status, first.stderr).toBe(0);
      expect(NodeFS.existsSync(NodePath.join(isolatedHome, ".cache", "lastcode", "local-ci"))).toBe(
        true,
      );
      expect(first.stdout).toContain("Typecheck scope: none");
      const repeatedAction = command();
      expect(repeatedAction.status, repeatedAction.stderr).toBe(0);
      expect(repeatedAction.stdout).toContain("Reusing Quick CI receipt");
      expect(repeatedAction.stdout).toContain('"outcome":"success"');
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
);
