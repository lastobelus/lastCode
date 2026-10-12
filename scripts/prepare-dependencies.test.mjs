import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it, onTestFinished } from "vite-plus/test";
import { prepareDependencies, runPreparation } from "./prepare-dependencies.ts";

const declarations = JSON.parse(
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, "..", "t3.json"), "utf8"),
).scripts;

function declaredLauncher(name) {
  const command = declarations.find((declaration) => declaration.name === name)?.command;
  const match = command?.match(/^mise exec node@24\.13\.1 -- node -e "([^"]+)"$/);
  NodeAssert.ok(match, `${name} must use the pinned Node inline launcher`);
  return match[1];
}

function runDeclaredLauncher(name, target, anchor, env = {}) {
  return NodeChildProcess.spawnSync(process.execPath, ["-e", declaredLauncher(name)], {
    cwd: target,
    env: { ...process.env, T3CODE_PROJECT_ROOT: anchor, ...env },
    encoding: "utf8",
  });
}

function fixture() {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "dependency-preparation-")),
  );
  onTestFinished(() => NodeFS.rmSync(root, { recursive: true, force: true }));
  NodeFS.writeFileSync(
    NodePath.join(root, "package.json"),
    JSON.stringify({ packageManager: "pnpm@11.10.0" }),
  );
  NodeFS.writeFileSync(NodePath.join(root, "pnpm-lock.yaml"), "fixture-lock\n");
  return root;
}

it("preparation invokes the pinned installer in the target checkout on each run", () => {
  const root = fixture();
  const calls = [];
  const execute = (command, args, options) => {
    calls.push({ command, args, options });
    NodeAssert.equal(options.cwd, root);
    if (args[0] === "--version") return { status: 0, stdout: "11.10.0\n" };
    return { status: 0 };
  };
  prepareDependencies(root, execute);
  prepareDependencies(root, execute);
  NodeAssert.equal(calls.filter((call) => call.args[0] === "install").length, 2);
  NodeAssert.deepEqual(calls[1].args, ["install", "--frozen-lockfile"]);
});

it("missing installer, mismatched version, and failed install cannot report readiness", () => {
  const root = fixture();
  NodeAssert.throws(
    () => prepareDependencies(root, () => ({ error: new Error("ENOENT") })),
    /installer unavailable/,
  );
  NodeAssert.throws(
    () => prepareDependencies(root, () => ({ status: 0, stdout: "10.0.0" })),
    /requires pnpm@11.10.0/,
  );
  NodeAssert.throws(
    () =>
      prepareDependencies(root, (_command, args) =>
        args[0] === "--version" ? { status: 0, stdout: "11.10.0" } : { status: 7 },
      ),
    /failed \(7\)/,
  );
});

it("standalone preparation emits one result; chained CI owns success and stops on failure", () => {
  const events = [];
  const reporter = {
    progress: (event) => events.push(["progress", event]),
    result: (event) => events.push(["result", event]),
  };
  NodeAssert.equal(
    runPreparation([], "/fixture", () => {}, reporter),
    0,
  );
  NodeAssert.equal(events.filter(([kind]) => kind === "result").length, 1);
  events.length = 0;
  NodeAssert.equal(
    runPreparation(["--for-ci"], "/fixture", () => {}, reporter),
    0,
  );
  NodeAssert.equal(events.filter(([kind]) => kind === "result").length, 0);
  NodeAssert.equal(
    runPreparation(
      ["--for-ci"],
      "/fixture",
      () => {
        throw new Error("child failed");
      },
      reporter,
    ),
    1,
  );
  NodeAssert.equal(events.filter(([kind]) => kind === "result").length, 1);
  NodeAssert.equal(events.at(-1)[1].outcome, "attention");
});

it("bare setup works from an older target checkout without dependencies and preserves real env files", () => {
  const root = fixture();
  const target = NodePath.join(root, "older target checkout");
  NodeFS.mkdirSync(target);
  const source = NodePath.join(root, "primary checkout");
  NodeFS.mkdirSync(NodePath.join(source, "infra", "relay"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(source, "scripts"));
  NodeFS.copyFileSync(
    NodePath.join(import.meta.dirname, "setup-worktree.ts"),
    NodePath.join(source, "scripts", "setup-worktree.ts"),
  );
  NodeFS.writeFileSync(NodePath.join(source, ".env"), "fixture source\n");
  NodeFS.writeFileSync(NodePath.join(source, "infra", "relay", ".env"), "fixture relay\n");
  NodeFS.writeFileSync(NodePath.join(target, ".env"), "fixture target\n");
  const result = runDeclaredLauncher("Setup Worktree", target, source, { PATH: "" });
  NodeAssert.equal(result.status, 0, result.stderr);
  NodeAssert.equal(NodeFS.readFileSync(NodePath.join(target, ".env"), "utf8"), "fixture target\n");
  NodeAssert.equal(
    NodeFS.readlinkSync(NodePath.join(target, "infra", "relay", ".env")),
    NodePath.join(source, "infra", "relay", ".env"),
  );
  NodeAssert.equal(NodeFS.existsSync(NodePath.join(target, "node_modules")), false);
  NodeAssert.match(result.stdout, /deferred/);
});

function launcherFixture() {
  const root = fixture();
  const target = NodePath.join(root, "older target checkout");
  const anchor = NodePath.join(root, "primary checkout");
  for (const directory of [target, anchor]) {
    NodeFS.mkdirSync(NodePath.join(directory, "scripts"), { recursive: true });
  }
  const child = (kind, status) =>
    `console.log(JSON.stringify({kind:${JSON.stringify(kind)},cwd:process.cwd(),args:process.argv.slice(2)}));process.exit(Number(process.env.${status}||0));`;
  NodeFS.writeFileSync(
    NodePath.join(anchor, "scripts", "prepare-dependencies.ts"),
    child("prepare", "FIXTURE_PREP_STATUS"),
  );
  NodeFS.writeFileSync(
    NodePath.join(target, "scripts", "lastcode-local-ci.ts"),
    child("ci", "FIXTURE_CI_STATUS"),
  );
  return { target, anchor };
}

it("declared preparation launches the primary helper in the older target cwd and propagates its exit", () => {
  const { target, anchor } = launcherFixture();
  const result = runDeclaredLauncher("Prepare Dependencies", target, anchor, {
    FIXTURE_PREP_STATUS: "7",
  });
  NodeAssert.equal(result.status, 7, result.stderr);
  NodeAssert.deepEqual(JSON.parse(result.stdout), { kind: "prepare", cwd: target, args: [] });
});

it("declared CI launcher stops after preparation failure and propagates CI failure after successful preparation", () => {
  const { target, anchor } = launcherFixture();
  const failure = runDeclaredLauncher("Run Quick CI", target, anchor, {
    FIXTURE_PREP_STATUS: "9",
  });
  NodeAssert.equal(failure.status, 9, failure.stderr);
  NodeAssert.deepEqual(JSON.parse(failure.stdout), {
    kind: "prepare",
    cwd: target,
    args: ["--for-ci"],
  });
  const result = runDeclaredLauncher("Run Quick CI", target, anchor, {
    FIXTURE_CI_STATUS: "13",
  });
  NodeAssert.equal(result.status, 13, result.stderr);
  NodeAssert.deepEqual(
    result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
    [
      { kind: "prepare", cwd: target, args: ["--for-ci"] },
      { kind: "ci", cwd: target, args: ["--quick"] },
    ],
  );
  const success = runDeclaredLauncher("Run Quick CI", target, anchor);
  NodeAssert.equal(success.status, 0, success.stderr);
});
