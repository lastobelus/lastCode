import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import { it, onTestFinished, vi } from "vite-plus/test";
import * as NodeAssert from "node:assert/strict";
import { createBuildOwnershipPlugin } from "../apps/web/vite/buildOwnership.ts";
import {
  observeDependencyActivity,
  dependencyActivitySnapshot,
} from "../packages/shared/src/dependencyActivity.ts";

const fixture = () => {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "direct-build-use-")),
  );
  onTestFinished(() => NodeFS.rmSync(root, { recursive: true, force: true }));
  const cwd = NodePath.join(root, "worktree");
  const git = NodePath.join(root, "git-metadata");
  NodeFS.mkdirSync(git);
  NodeFS.mkdirSync(NodePath.join(cwd, "node_modules/package"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(cwd, ".git"), `gitdir: ${git}\n`);
  NodeFS.writeFileSync(NodePath.join(cwd, "node_modules/.modules.yaml"), "layoutVersion: 5\n");
  NodeFS.writeFileSync(
    NodePath.join(cwd, "node_modules/package/index.js"),
    "synthetic compiler dependency",
  );
  observeDependencyActivity(git, cwd, 1);
  const readClock = () => observeDependencyActivity(git, cwd, 10_000, false, false).lastUsedAt;
  const context = { meta: { watchMode: false } };
  return { cwd, git, readClock, context };
};
const syntheticCompiler = (cwd, fail = false) => {
  // This exercises the real plugin boundaries with an explicit synthetic
  // installed-package consumer. It does not claim Vite or tsdown acceptance.
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [
      "-e",
      `
    const fs = require('node:fs');
    fs.readFileSync(process.argv[1]);
    process.exit(Number(process.argv[2]));
  `,
      NodePath.join(cwd, "node_modules/package/index.js"),
      fail ? "1" : "0",
    ],
    { encoding: "utf8" },
  );
  NodeAssert.equal(result.status, fail ? 1 : 0, result.stderr);
};

it("config inspection alone leaves aged dependencies unchanged; direct compiler execution renews start and completion", () => {
  const { cwd, git, readClock, context } = fixture();
  let now = 100;
  const before = dependencyActivitySnapshot(cwd);
  const plugin = createBuildOwnershipPlugin(cwd, null, () => now);
  plugin.configResolved.call(context, { root: cwd, build: { outDir: "dist" } });
  plugin.closeBundle.call(context);
  NodeAssert.equal(readClock(), 1);
  NodeAssert.equal(dependencyActivitySnapshot(cwd), before);
  plugin.buildStart.call(context);
  NodeAssert.equal(readClock(), 100);
  syntheticCompiler(cwd);
  plugin.buildEnd.call(context);
  plugin.writeBundle.call(context);
  now = 200;
  plugin.closeBundle.call(context);
  NodeAssert.equal(readClock(), 200);
  now = 300;
  plugin.closeWatcher.call(context);
  NodeAssert.equal(readClock(), 200);
  NodeAssert.equal(observeDependencyActivity(git, cwd, 500, false, false).renewed, false);
});

it("watch rebuilds renew each executed run and compiler failure remains positive use", () => {
  const { cwd, readClock, context } = fixture();
  context.meta.watchMode = true;
  let now = 100;
  const plugin = createBuildOwnershipPlugin(cwd, null, () => now);
  for (const startedAt of [100, 300]) {
    now = startedAt;
    plugin.buildStart.call(context);
    syntheticCompiler(cwd);
    plugin.writeBundle.call(context);
    now = startedAt + 50;
    plugin.closeBundle.call(context);
    NodeAssert.equal(readClock(), startedAt + 50);
  }
  now = 500;
  plugin.buildStart.call(context);
  syntheticCompiler(cwd, true);
  now = 550;
  plugin.buildEnd.call(context, new Error("Synthetic compiler failure"));
  NodeAssert.equal(readClock(), 550);
  now = 600;
  plugin.closeBundle.call(context);
  NodeAssert.equal(readClock(), 550);
});

it("output generation failure renews actual use; malformed optional clock cannot block compiler execution or reset records", () => {
  const { cwd, git, readClock, context } = fixture();
  let now = 100;
  const plugin = createBuildOwnershipPlugin(cwd, null, () => now);
  plugin.buildStart.call(context);
  now = 200;
  plugin.renderError.call(context);
  NodeAssert.equal(readClock(), 200);
  const target = NodePath.join(git, "t3-dependency-activity.json");
  NodeFS.writeFileSync(target, "retained malformed clock");
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  onTestFinished(() => warning.mockRestore());
  now = 300;
  NodeAssert.doesNotThrow(() => plugin.buildStart.call(context));
  syntheticCompiler(cwd);
  plugin.writeBundle.call(context);
  now = 400;
  NodeAssert.doesNotThrow(() => plugin.closeBundle.call(context));
  NodeAssert.equal(warning.mock.calls.length, 2);
  NodeAssert.equal(NodeFS.readFileSync(target, "utf8"), "retained malformed clock");
});
