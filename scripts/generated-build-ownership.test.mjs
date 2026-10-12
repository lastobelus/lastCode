import * as FS from "node:fs";
import * as Path from "node:path";
import * as OS from "node:os";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createGeneratedBuildStage,
  inspectGeneratedBuildOwnership,
  removeGeneratedBuildFiles,
  recordGeneratedBuildUse,
  inspectGeneratedBuildOwnershipAsync,
  removeGeneratedBuildFilesAsync,
} from "../packages/shared/src/generatedBuildOwnership.ts";

const fixture = (t) => {
  const directory = FS.realpathSync(FS.mkdtempSync(Path.join(OS.tmpdir(), "compiler-ownership-")));
  t.after(() => FS.rmSync(directory, { recursive: true, force: true }));
  const cwd = Path.join(directory, "worktree");
  const metadata = Path.join(directory, "git-metadata");
  FS.mkdirSync(cwd);
  FS.mkdirSync(metadata);
  FS.writeFileSync(Path.join(cwd, ".git"), `gitdir: ${metadata}\n`);
  return { cwd, metadata, directory };
};
const compiler = (stage, output, contents) => {
  // A separate process writes only to the directory freshly allocated by its runner.
  const result = spawnSync(process.execPath, ["-e", `
    const fs = require('node:fs'), path = require('node:path');
    fs.mkdirSync(path.dirname(process.argv[1]), {recursive:true});
    fs.writeFileSync(process.argv[1], process.argv[2]);
  `, Path.join(stage, output), contents], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
};

test("compiler emission -> guarded exact removal -> rebuild preserves arbitrary additions", (t) => {
  const { cwd, metadata } = fixture(t);
  for (const root of ["apps/web/dist", "apps/server/dist", "native/resource-monitor/target/debug"]) {
    const build = createGeneratedBuildStage(cwd, root);
    compiler(build.directory, "assets/emitted.bin", "first compiler emission");
    build.publish(100);
    const addition = Path.join(cwd, root, "qa-note.txt");
    FS.writeFileSync(addition, "retained QA addition");
    const approval = Path.join(metadata, "review-state.txt");
    FS.writeFileSync(approval, "retained review state");
    const inspected = inspectGeneratedBuildOwnership(cwd, root);
    assert.equal(removeGeneratedBuildFiles(cwd, root, inspected.token, ["assets/emitted.bin"]).files, 1);
    assert.equal(FS.readFileSync(addition, "utf8"), "retained QA addition");
    const rebuild = createGeneratedBuildStage(cwd, root);
    compiler(rebuild.directory, "assets/emitted.bin", "second compiler emission");
    rebuild.publish(200);
    const current = inspectGeneratedBuildOwnership(cwd, root);
    assert.equal(current.files[0].reason, null);
    assert.equal(current.lastUsedAt, 200);
    assert.equal(FS.readFileSync(approval, "utf8"), "retained review state");
    assert.throws(() => removeGeneratedBuildFiles(cwd, root, inspected.token, ["assets/emitted.bin"]), /ownership changed/);
  }
});

test("changed emissions, unknown collisions and administrative inspection convey no fresh authority", (t) => {
  const { cwd, metadata } = fixture(t);
  const root = "apps/web/dist";
  const build = createGeneratedBuildStage(cwd, root);
  compiler(build.directory, "index.html", "emitted html");
  build.publish(100);
  const output = Path.join(cwd, root, "index.html");
  FS.writeFileSync(output, "retained user edit");
  const inspected = inspectGeneratedBuildOwnership(cwd, root);
  assert.equal(inspected.lastUsedAt, 100);
  assert.equal(removeGeneratedBuildFiles(cwd, root, inspected.token, ["index.html"]).files, 0);
  const collision = createGeneratedBuildStage(cwd, root);
  compiler(collision.directory, "index.html", "new compiler html");
  assert.throws(() => collision.publish(200), /requires file review/);
  collision.discard();
  assert.equal(FS.readFileSync(output, "utf8"), "retained user edit");
  recordGeneratedBuildUse(cwd, root, 300);
  assert.equal(inspectGeneratedBuildOwnership(cwd, root).lastUsedAt, 300);
  const record = FS.readdirSync(metadata).find((name) => name.endsWith(".json"));
  FS.writeFileSync(Path.join(metadata, record), "invalid provenance");
  assert.throws(() => recordGeneratedBuildUse(cwd, root, 400));
  assert.equal(FS.readFileSync(Path.join(metadata, record), "utf8"), "invalid provenance");
});

test("Cargo internal hardlinks are copied exclusively; external links never become owned", (t) => {
  const { cwd, directory } = fixture(t);
  const root = "native/resource-monitor/target/debug";
  const build = createGeneratedBuildStage(cwd, root);
  compiler(build.directory, "debug/deps/monitor", "compiled binary");
  FS.linkSync(Path.join(build.directory, "debug/deps/monitor"), Path.join(build.directory, "debug/monitor"));
  build.publish(100, Path.join(build.directory, "debug"));
  assert.equal(FS.lstatSync(Path.join(cwd, root, "monitor")).nlink, 1);
  const unsafe = createGeneratedBuildStage(cwd, root);
  const retained = Path.join(directory, "retained-binary");
  FS.writeFileSync(retained, "external binary");
  FS.linkSync(retained, Path.join(unsafe.directory, "unsafe"));
  assert.throws(() => unsafe.publish(200), /external hardlink/);
  unsafe.discard();
  assert.equal(FS.readFileSync(retained, "utf8"), "external binary");
});

test("server streamed hashes use bounded fresh guards and retain mutations/renewals after hashing", async (t) => {
  const { cwd } = fixture(t);
  const root = "apps/server/dist";
  const stage = createGeneratedBuildStage(cwd, root);
  for (let index = 0; index < 65; index++) FS.writeFileSync(Path.join(stage.directory, `${String(index).padStart(2, "0")}.js`), `emitted ${index}`);
  stage.publish(100);
  const inspected = await inspectGeneratedBuildOwnershipAsync(cwd, root);
  assert.equal(inspected.files.filter((file) => file.reason === null).length, 65);
  let guards = 0;
  const removed = await removeGeneratedBuildFilesAsync(cwd, root, inspected.token, inspected.files.map((file) => file.path), async () => {
    guards++;
    if (guards === 1) FS.writeFileSync(Path.join(cwd, root, "00.js"), "changed after awaited hashes");
    else recordGeneratedBuildUse(cwd, root, 200);
    return true;
  });
  assert.equal(guards, 2);
  assert.equal(removed.files, 63);
  assert.equal(removed.kept.length, 2);
  assert.equal(FS.readFileSync(Path.join(cwd, root, "00.js"), "utf8"), "changed after awaited hashes");
  assert.equal(FS.readFileSync(Path.join(cwd, root, "64.js"), "utf8"), "emitted 64");
});

test("a failed fresh caller guard retains all verified emitted bytes", async (t) => {
  const { cwd } = fixture(t);
  const root = "apps/web/dist";
  const stage = createGeneratedBuildStage(cwd, root);
  FS.writeFileSync(Path.join(stage.directory, "main.js"), "emitted");
  stage.publish(100);
  const inspected = await inspectGeneratedBuildOwnershipAsync(cwd, root);
  const removed = await removeGeneratedBuildFilesAsync(cwd, root, inspected.token, ["main.js"], async () => false);
  assert.equal(removed.files, 0);
  assert.equal(FS.readFileSync(Path.join(cwd, root, "main.js"), "utf8"), "emitted");
});

test("ordinary source archives without Git metadata keep their build behavior", (t) => {
  const { cwd } = fixture(t);
  FS.unlinkSync(Path.join(cwd, ".git"));
  assert.equal(createGeneratedBuildStage(cwd, "apps/web/dist"), null);
  assert.equal(createGeneratedBuildStage(cwd, "apps/server/dist"), null);
});

test("a staged rebuild tolerates timestamp-only consumer renewal and preserves its latest clock", (t) => {
  const { cwd } = fixture(t);
  const root = "apps/web/dist";
  const original = createGeneratedBuildStage(cwd, root);
  compiler(original.directory, "main.js", "original emitted bytes");
  original.publish(100);
  const previous = inspectGeneratedBuildOwnership(cwd, root);
  const rebuild = createGeneratedBuildStage(cwd, root);
  compiler(rebuild.directory, "main.js", "rebuilt emitted bytes");
  assert.equal(recordGeneratedBuildUse(cwd, root, 1000), true);
  const renewed = inspectGeneratedBuildOwnership(cwd, root);
  assert.notEqual(renewed.token, previous.token);
  rebuild.publish(500);
  const published = inspectGeneratedBuildOwnership(cwd, root);
  assert.equal(published.lastUsedAt, 1000);
  assert.equal(published.files[0].reason, null);
  assert.equal(FS.readFileSync(Path.join(cwd, root, "main.js"), "utf8"), "rebuilt emitted bytes");
  assert.throws(() => removeGeneratedBuildFiles(cwd, root, renewed.token, ["main.js"]), /ownership changed/);
});

test("a competing compiler ownership generation still rejects a stale staged rebuild", (t) => {
  const { cwd } = fixture(t);
  const root = "apps/server/dist";
  const original = createGeneratedBuildStage(cwd, root);
  compiler(original.directory, "main.js", "original compiler");
  original.publish(100);
  const stale = createGeneratedBuildStage(cwd, root);
  compiler(stale.directory, "main.js", "stale compiler");
  const competitor = createGeneratedBuildStage(cwd, root);
  compiler(competitor.directory, "main.js", "new compiler generation");
  competitor.publish(200);
  assert.throws(() => stale.publish(300), /Another build changed output ownership/);
  stale.discard();
  assert.equal(FS.readFileSync(Path.join(cwd, root, "main.js"), "utf8"), "new compiler generation");
  assert.equal(inspectGeneratedBuildOwnership(cwd, root).lastUsedAt, 200);
});
