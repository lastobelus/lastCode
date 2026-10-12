import * as FS from "node:fs";
import * as Path from "node:path";
import * as OS from "node:os";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// Resolve the real shared source for this dependency-free runner test. Product
// code uses its ordinary workspace package; no fallback is shipped in the app.
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "@t3tools/shared/dependencyActivity") return {
    url: new URL("../packages/shared/src/dependencyActivity.ts", import.meta.url).href,
    shortCircuit: true,
  };
  return nextResolve(specifier, context);
} });
const { createBuildOwnershipPlugin } = await import("../apps/web/vite/buildOwnership.ts");
hooks.deregister();
import { observeDependencyActivity, dependencyActivitySnapshot } from "../packages/shared/src/dependencyActivity.ts";

const fixture = (t) => {
  const root = FS.realpathSync(FS.mkdtempSync(Path.join(OS.tmpdir(), "direct-build-use-")));
  t.after(() => FS.rmSync(root, { recursive: true, force: true }));
  const cwd = Path.join(root, "worktree");
  const git = Path.join(root, "git-metadata");
  FS.mkdirSync(git);
  FS.mkdirSync(Path.join(cwd, "node_modules/package"), { recursive: true });
  FS.writeFileSync(Path.join(cwd, ".git"), `gitdir: ${git}\n`);
  FS.writeFileSync(Path.join(cwd, "node_modules/.modules.yaml"), "layoutVersion: 5\n");
  FS.writeFileSync(Path.join(cwd, "node_modules/package/index.js"), "synthetic compiler dependency");
  observeDependencyActivity(git, cwd, 1);
  const readClock = () => observeDependencyActivity(git, cwd, 10_000, false, false).lastUsedAt;
  const context = { meta: { watchMode: false } };
  return { cwd, git, readClock, context };
};
const syntheticCompiler = (cwd, fail = false) => {
  // This exercises the real plugin boundaries with an explicit synthetic
  // installed-package consumer. It does not claim Vite or tsdown acceptance.
  const result = spawnSync(process.execPath, ["-e", `
    const fs = require('node:fs');
    fs.readFileSync(process.argv[1]);
    process.exit(Number(process.argv[2]));
  `, Path.join(cwd, "node_modules/package/index.js"), fail ? "1" : "0"], { encoding: "utf8" });
  assert.equal(result.status, fail ? 1 : 0, result.stderr);
};

test("config inspection alone leaves aged dependencies unchanged; direct compiler execution renews start and completion", (t) => {
  const { cwd, git, readClock, context } = fixture(t);
  let now = 100;
  const before = dependencyActivitySnapshot(cwd);
  const plugin = createBuildOwnershipPlugin(cwd, null, () => now);
  plugin.configResolved.call(context, { build: { outDir: "dist" } });
  plugin.closeBundle.call(context);
  assert.equal(readClock(), 1);
  assert.equal(dependencyActivitySnapshot(cwd), before);
  plugin.buildStart.call(context);
  assert.equal(readClock(), 100);
  syntheticCompiler(cwd);
  plugin.buildEnd.call(context);
  plugin.writeBundle.call(context);
  now = 200;
  plugin.closeBundle.call(context);
  assert.equal(readClock(), 200);
  now = 300;
  plugin.closeWatcher.call(context);
  assert.equal(readClock(), 200);
  assert.equal(observeDependencyActivity(git, cwd, 500, false, false).renewed, false);
});

test("watch rebuilds renew each executed run and compiler failure remains positive use", (t) => {
  const { cwd, readClock, context } = fixture(t);
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
    assert.equal(readClock(), startedAt + 50);
  }
  now = 500;
  plugin.buildStart.call(context);
  syntheticCompiler(cwd, true);
  now = 550;
  plugin.buildEnd.call(context, new Error("Synthetic compiler failure"));
  assert.equal(readClock(), 550);
  now = 600;
  plugin.closeBundle.call(context);
  assert.equal(readClock(), 550);
});

test("output generation failure renews actual use; malformed optional clock cannot block compiler execution or reset records", (t) => {
  const { cwd, git, readClock, context } = fixture(t);
  let now = 100;
  const plugin = createBuildOwnershipPlugin(cwd, null, () => now);
  plugin.buildStart.call(context);
  now = 200;
  plugin.renderError.call(context);
  assert.equal(readClock(), 200);
  const target = Path.join(git, "t3-dependency-activity.json");
  FS.writeFileSync(target, "retained malformed clock");
  const warning = t.mock.method(console, "warn", () => {});
  now = 300;
  assert.doesNotThrow(() => plugin.buildStart.call(context));
  syntheticCompiler(cwd);
  plugin.writeBundle.call(context);
  now = 400;
  assert.doesNotThrow(() => plugin.closeBundle.call(context));
  assert.equal(warning.mock.callCount(), 2);
  assert.equal(FS.readFileSync(target, "utf8"), "retained malformed clock");
});
