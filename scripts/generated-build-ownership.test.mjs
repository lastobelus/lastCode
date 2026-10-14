import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import { it, onTestFinished } from "vite-plus/test";
import * as NodeAssert from "node:assert/strict";
import {
  createGeneratedBuildStage,
  inspectGeneratedBuildOwnership,
  removeGeneratedBuildFiles,
  recordGeneratedBuildUse,
  inspectGeneratedBuildOwnershipAsync,
  removeGeneratedBuildFilesAsync,
} from "../packages/shared/src/generatedBuildOwnership.ts";

const fixture = () => {
  const directory = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "compiler-ownership-")),
  );
  onTestFinished(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
  const cwd = NodePath.join(directory, "worktree");
  const metadata = NodePath.join(directory, "git-metadata");
  NodeFS.mkdirSync(cwd);
  NodeFS.mkdirSync(metadata);
  NodeFS.writeFileSync(NodePath.join(cwd, ".git"), `gitdir: ${metadata}\n`);
  return { cwd, metadata, directory };
};
const compiler = (stage, output, contents) => {
  // A separate process writes only to the directory freshly allocated by its runner.
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [
      "-e",
      `
    const fs = require('node:fs'), path = require('node:path');
    fs.mkdirSync(path.dirname(process.argv[1]), {recursive:true});
    fs.writeFileSync(process.argv[1], process.argv[2]);
  `,
      NodePath.join(stage, output),
      contents,
    ],
    { encoding: "utf8" },
  );
  NodeAssert.equal(result.status, 0, result.stderr);
};

it("compiler emission -> guarded exact removal -> rebuild preserves arbitrary additions", () => {
  const { cwd, metadata } = fixture();
  for (const root of [
    "apps/web/dist",
    "apps/server/dist",
    "native/resource-monitor/target/debug",
  ]) {
    const build = createGeneratedBuildStage(cwd, root);
    compiler(build.directory, "assets/emitted.bin", "first compiler emission");
    build.publish(100);
    const addition = NodePath.join(cwd, root, "qa-note.txt");
    NodeFS.writeFileSync(addition, "retained QA addition");
    const approval = NodePath.join(metadata, "review-state.txt");
    NodeFS.writeFileSync(approval, "retained review state");
    const inspected = inspectGeneratedBuildOwnership(cwd, root);
    NodeAssert.equal(
      removeGeneratedBuildFiles(cwd, root, inspected.token, ["assets/emitted.bin"]).files,
      1,
    );
    NodeAssert.equal(NodeFS.readFileSync(addition, "utf8"), "retained QA addition");
    const rebuild = createGeneratedBuildStage(cwd, root);
    compiler(rebuild.directory, "assets/emitted.bin", "second compiler emission");
    rebuild.publish(200);
    const current = inspectGeneratedBuildOwnership(cwd, root);
    NodeAssert.equal(current.files[0].reason, null);
    NodeAssert.equal(current.lastUsedAt, 200);
    NodeAssert.equal(NodeFS.readFileSync(approval, "utf8"), "retained review state");
    NodeAssert.throws(
      () => removeGeneratedBuildFiles(cwd, root, inspected.token, ["assets/emitted.bin"]),
      /ownership changed/,
    );
  }
});

it("changed emissions, unknown collisions and administrative inspection convey no fresh authority", () => {
  const { cwd, metadata } = fixture();
  const root = "apps/web/dist";
  const build = createGeneratedBuildStage(cwd, root);
  compiler(build.directory, "index.html", "emitted html");
  build.publish(100);
  const output = NodePath.join(cwd, root, "index.html");
  NodeFS.writeFileSync(output, "retained user edit");
  const inspected = inspectGeneratedBuildOwnership(cwd, root);
  NodeAssert.equal(inspected.lastUsedAt, 100);
  NodeAssert.equal(removeGeneratedBuildFiles(cwd, root, inspected.token, ["index.html"]).files, 0);
  const collision = createGeneratedBuildStage(cwd, root);
  compiler(collision.directory, "index.html", "new compiler html");
  NodeAssert.throws(() => collision.publish(200), /requires file review/);
  collision.discard();
  NodeAssert.equal(NodeFS.readFileSync(output, "utf8"), "retained user edit");
  recordGeneratedBuildUse(cwd, root, 300);
  NodeAssert.equal(inspectGeneratedBuildOwnership(cwd, root).lastUsedAt, 300);
  const record = NodeFS.readdirSync(metadata).find((name) => name.endsWith(".json"));
  NodeFS.writeFileSync(NodePath.join(metadata, record), "invalid provenance");
  NodeAssert.throws(() => recordGeneratedBuildUse(cwd, root, 400));
  NodeAssert.equal(
    NodeFS.readFileSync(NodePath.join(metadata, record), "utf8"),
    "invalid provenance",
  );
});

it("Cargo internal hardlinks are copied exclusively; external links never become owned", () => {
  const { cwd, directory } = fixture();
  const root = "native/resource-monitor/target/debug";
  const build = createGeneratedBuildStage(cwd, root);
  compiler(build.directory, "debug/deps/monitor", "compiled binary");
  NodeFS.linkSync(
    NodePath.join(build.directory, "debug/deps/monitor"),
    NodePath.join(build.directory, "debug/monitor"),
  );
  build.publish(100, NodePath.join(build.directory, "debug"));
  NodeAssert.equal(NodeFS.lstatSync(NodePath.join(cwd, root, "monitor")).nlink, 1);
  const unsafe = createGeneratedBuildStage(cwd, root);
  const retained = NodePath.join(directory, "retained-binary");
  NodeFS.writeFileSync(retained, "external binary");
  NodeFS.linkSync(retained, NodePath.join(unsafe.directory, "unsafe"));
  NodeAssert.throws(() => unsafe.publish(200), /external hardlink/);
  unsafe.discard();
  NodeAssert.equal(NodeFS.readFileSync(retained, "utf8"), "external binary");
});

it("server streamed hashes use bounded fresh guards and retain mutations/renewals after hashing", async () => {
  const { cwd } = fixture();
  const root = "apps/server/dist";
  const stage = createGeneratedBuildStage(cwd, root);
  for (let index = 0; index < 65; index++)
    NodeFS.writeFileSync(
      NodePath.join(stage.directory, `${String(index).padStart(2, "0")}.js`),
      `emitted ${index}`,
    );
  stage.publish(100);
  const inspected = await inspectGeneratedBuildOwnershipAsync(cwd, root);
  NodeAssert.equal(inspected.files.filter((file) => file.reason === null).length, 65);
  let guards = 0;
  const removed = await removeGeneratedBuildFilesAsync(
    cwd,
    root,
    inspected.token,
    inspected.files.map((file) => file.path),
    async () => {
      guards++;
      if (guards === 1)
        NodeFS.writeFileSync(NodePath.join(cwd, root, "00.js"), "changed after awaited hashes");
      else recordGeneratedBuildUse(cwd, root, 200);
      return true;
    },
  );
  NodeAssert.equal(guards, 2);
  NodeAssert.equal(removed.files, 63);
  NodeAssert.equal(removed.kept.length, 2);
  NodeAssert.equal(
    NodeFS.readFileSync(NodePath.join(cwd, root, "00.js"), "utf8"),
    "changed after awaited hashes",
  );
  NodeAssert.equal(NodeFS.readFileSync(NodePath.join(cwd, root, "64.js"), "utf8"), "emitted 64");
});

it("a failed fresh caller guard retains all verified emitted bytes", async () => {
  const { cwd } = fixture();
  const root = "apps/web/dist";
  const stage = createGeneratedBuildStage(cwd, root);
  NodeFS.writeFileSync(NodePath.join(stage.directory, "main.js"), "emitted");
  stage.publish(100);
  const inspected = await inspectGeneratedBuildOwnershipAsync(cwd, root);
  const removed = await removeGeneratedBuildFilesAsync(
    cwd,
    root,
    inspected.token,
    ["main.js"],
    async () => false,
  );
  NodeAssert.equal(removed.files, 0);
  NodeAssert.equal(NodeFS.readFileSync(NodePath.join(cwd, root, "main.js"), "utf8"), "emitted");
});

it("ordinary source archives without Git metadata keep their build behavior", () => {
  const { cwd } = fixture();
  NodeFS.unlinkSync(NodePath.join(cwd, ".git"));
  NodeAssert.equal(createGeneratedBuildStage(cwd, "apps/web/dist"), null);
  NodeAssert.equal(createGeneratedBuildStage(cwd, "apps/server/dist"), null);
});

it("a staged rebuild tolerates timestamp-only consumer renewal and preserves its latest clock", () => {
  const { cwd } = fixture();
  const root = "apps/web/dist";
  const original = createGeneratedBuildStage(cwd, root);
  compiler(original.directory, "main.js", "original emitted bytes");
  original.publish(100);
  const previous = inspectGeneratedBuildOwnership(cwd, root);
  const rebuild = createGeneratedBuildStage(cwd, root);
  compiler(rebuild.directory, "main.js", "rebuilt emitted bytes");
  NodeAssert.equal(recordGeneratedBuildUse(cwd, root, 1000), true);
  const renewed = inspectGeneratedBuildOwnership(cwd, root);
  NodeAssert.notEqual(renewed.token, previous.token);
  rebuild.publish(500);
  const published = inspectGeneratedBuildOwnership(cwd, root);
  NodeAssert.equal(published.lastUsedAt, 1000);
  NodeAssert.equal(published.files[0].reason, null);
  NodeAssert.equal(
    NodeFS.readFileSync(NodePath.join(cwd, root, "main.js"), "utf8"),
    "rebuilt emitted bytes",
  );
  NodeAssert.throws(
    () => removeGeneratedBuildFiles(cwd, root, renewed.token, ["main.js"]),
    /ownership changed/,
  );
});

it("a competing compiler ownership generation still rejects a stale staged rebuild", () => {
  const { cwd } = fixture();
  const root = "apps/server/dist";
  const original = createGeneratedBuildStage(cwd, root);
  compiler(original.directory, "main.js", "original compiler");
  original.publish(100);
  const stale = createGeneratedBuildStage(cwd, root);
  compiler(stale.directory, "main.js", "stale compiler");
  const competitor = createGeneratedBuildStage(cwd, root);
  compiler(competitor.directory, "main.js", "new compiler generation");
  competitor.publish(200);
  NodeAssert.throws(() => stale.publish(300), /Another build changed output ownership/);
  stale.discard();
  NodeAssert.equal(
    NodeFS.readFileSync(NodePath.join(cwd, root, "main.js"), "utf8"),
    "new compiler generation",
  );
  NodeAssert.equal(inspectGeneratedBuildOwnership(cwd, root).lastUsedAt, 200);
});
