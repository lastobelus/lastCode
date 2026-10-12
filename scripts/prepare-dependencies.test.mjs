import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it, onTestFinished } from "vite-plus/test";
import { prepareDependencies, runPreparation } from "./prepare-dependencies.ts";

function fixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "dependency-preparation-"));
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
  const target = fixture();
  const source = NodePath.join(target, "anchor");
  NodeFS.mkdirSync(NodePath.join(source, "infra", "relay"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(source, ".env"), "fixture source\n");
  NodeFS.writeFileSync(NodePath.join(source, "infra", "relay", ".env"), "fixture relay\n");
  NodeFS.writeFileSync(NodePath.join(target, ".env"), "fixture target\n");
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [NodePath.join(import.meta.dirname, "setup-worktree.ts")],
    {
      cwd: target,
      env: { ...process.env, T3CODE_PROJECT_ROOT: source, PATH: "" },
      encoding: "utf8",
    },
  );
  NodeAssert.equal(result.status, 0, result.stderr);
  NodeAssert.equal(NodeFS.readFileSync(NodePath.join(target, ".env"), "utf8"), "fixture target\n");
  NodeAssert.equal(
    NodeFS.readlinkSync(NodePath.join(target, "infra", "relay", ".env")),
    NodePath.join(source, "infra", "relay", ".env"),
  );
  NodeAssert.equal(NodeFS.existsSync(NodePath.join(target, "node_modules")), false);
  NodeAssert.match(result.stdout, /deferred/);
});
