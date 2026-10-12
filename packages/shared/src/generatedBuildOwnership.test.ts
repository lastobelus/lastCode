import * as FS from "node:fs";
import * as Path from "node:path";
import * as OS from "node:os";
import { assert, it, onTestFinished } from "vite-plus/test";
import { createGeneratedBuildStage, inspectGeneratedBuildOwnership, removeGeneratedBuildFiles, copyOwnedGeneratedBuild, recordGeneratedBuildUse } from "./generatedBuildOwnership.ts";

const fixture = () => {
  const temporary = FS.realpathSync(FS.mkdtempSync(Path.join(OS.tmpdir(), "build-provenance-")));
  onTestFinished(() => FS.rmSync(temporary, { recursive: true, force: true }));
  const cwd = Path.join(temporary, "worktree");
  const metadata = Path.join(temporary, "git-metadata");
  FS.mkdirSync(cwd);
  FS.mkdirSync(metadata);
  FS.writeFileSync(Path.join(cwd, ".git"), `gitdir: ${metadata}\n`);
  const emit = (stage: string, file: string, contents: string) => {
    FS.mkdirSync(Path.dirname(Path.join(stage, file)), { recursive: true });
    FS.writeFileSync(Path.join(stage, file), contents);
  };
  return { cwd, metadata, temporary, emit };
};

it("reclaims unchanged staged emissions, retains additions/modified files, and rebuilds after removal", () => {
  const { cwd, metadata, emit } = fixture();
  const root = "apps/web/dist";
  const build = createGeneratedBuildStage(cwd, root)!;
  emit(build.directory, "assets/main.js", "compiler output");
  emit(build.directory, "index.html", "compiler html");
  build.publish(100);
  const output = Path.join(cwd, root);
  emit(output, "notes.txt", "retained addition");
  emit(output, "index.html", "user edit");
  const before = inspectGeneratedBuildOwnership(cwd, root)!;
  assert.equal(before.lastUsedAt, 100);
  assert.equal(before.files.find((file) => file.path === "index.html")?.reason, "Generated file changed since emission");
  const receipt = Path.join(metadata, "retained-review.json");
  FS.writeFileSync(receipt, "reviewed retained additions and partial removal remain protected");
  const removed = removeGeneratedBuildFiles(cwd, root, before.token, ["assets/main.js", "index.html"]);
  assert.equal(removed.files, 1);
  assert.equal(removed.kept.length, 1);
  assert.isFalse(FS.existsSync(Path.join(output, "assets")));
  assert.equal(FS.readFileSync(Path.join(output, "notes.txt"), "utf8"), "retained addition");
  assert.equal(FS.readFileSync(Path.join(output, "index.html"), "utf8"), "user edit");
  assert.equal(FS.readFileSync(receipt, "utf8"), "reviewed retained additions and partial removal remain protected");
  const rebuild = createGeneratedBuildStage(cwd, root)!;
  emit(rebuild.directory, "assets/main.js", "rebuilt compiler output");
  rebuild.publish(200);
  const after = inspectGeneratedBuildOwnership(cwd, root)!;
  assert.equal(after.lastUsedAt, 200);
  assert.equal(after.files.find((file) => file.path === "assets/main.js")?.reason, null);
  assert.equal(FS.readFileSync(Path.join(output, "notes.txt"), "utf8"), "retained addition");
  assert.throws(() => removeGeneratedBuildFiles(cwd, root, before.token, ["assets/main.js"]), "ownership changed");
});

it("never claims preexisting matching output or overwrites unknown collisions", () => {
  const { cwd, emit } = fixture();
  const root = "apps/server/dist";
  emit(Path.join(cwd, root), "same.js", "same emission");
  emit(Path.join(cwd, root), "notes.js", "unknown addition");
  const stage = createGeneratedBuildStage(cwd, root)!;
  emit(stage.directory, "same.js", "same emission");
  stage.publish(100);
  assert.deepEqual(inspectGeneratedBuildOwnership(cwd, root)!.files, []);
  const collision = createGeneratedBuildStage(cwd, root)!;
  emit(collision.directory, "notes.js", "different emission");
  assert.throws(() => collision.publish(200), "requires file review");
  collision.discard();
  assert.equal(FS.readFileSync(Path.join(cwd, root, "notes.js"), "utf8"), "unknown addition");
});

it("rejects linked or hardlinked destinations and forged roots; ordinary checkout builds keep their behavior", () => {
  const { cwd, temporary, emit } = fixture();
  const stage = createGeneratedBuildStage(cwd, "apps/web/dist")!;
  emit(stage.directory, "index.html", "output");
  const retained = Path.join(temporary, "retained");
  FS.mkdirSync(retained);
  FS.mkdirSync(Path.join(cwd, "apps/web"), { recursive: true });
  FS.symlinkSync(retained, Path.join(cwd, "apps/web/dist"));
  assert.throws(() => stage.publish(100), "Linked or invalid");
  stage.discard();
  assert.isFalse(FS.existsSync(Path.join(retained, "index.html")));
  assert.throws(() => createGeneratedBuildStage(cwd, "notes"), "Unrecognized");
  FS.unlinkSync(Path.join(cwd, ".git"));
  FS.mkdirSync(Path.join(cwd, ".git"));
  assert.equal(createGeneratedBuildStage(cwd, "apps/web/dist"), null);
});

it("copies only verified web emissions into an owned server stage", () => {
  const { cwd, emit } = fixture();
  const web = createGeneratedBuildStage(cwd, "apps/web/dist")!;
  emit(web.directory, "assets/main.js", "web compiler output");
  web.publish(100);
  emit(Path.join(cwd, "apps/web/dist"), "personal-note.txt", "unknown");
  const server = createGeneratedBuildStage(cwd, "apps/server/dist")!;
  copyOwnedGeneratedBuild(cwd, "apps/web/dist", Path.join(server.directory, "client"));
  server.publish(200);
  assert.equal(FS.readFileSync(Path.join(cwd, "apps/server/dist/client/assets/main.js"), "utf8"), "web compiler output");
  assert.isFalse(FS.existsSync(Path.join(cwd, "apps/server/dist/client/personal-note.txt")));
});

it("publishes only debug outputs from a clean Cargo target and retains arbitrary debug additions on rebuild", () => {
  const { cwd, emit } = fixture();
  const root = "native/resource-monitor/target/debug";
  const cargo = createGeneratedBuildStage(cwd, root)!;
  emit(cargo.directory, "debug/deps/monitor", "compiled debug binary");
  emit(cargo.directory, "CACHEDIR.TAG", "cargo metadata");
  cargo.publish(100, Path.join(cargo.directory, "debug"));
  emit(Path.join(cwd, root), "qa.txt", "retained QA note");
  const first = inspectGeneratedBuildOwnership(cwd, root)!;
  assert.deepEqual(first.files.map((file) => file.path), ["deps/monitor"]);
  assert.equal(removeGeneratedBuildFiles(cwd, root, first.token, ["deps/monitor"]).files, 1);
  const rebuilt = createGeneratedBuildStage(cwd, root)!;
  emit(rebuilt.directory, "debug/deps/monitor", "new compiled binary");
  rebuilt.publish(200, Path.join(rebuilt.directory, "debug"));
  assert.equal(FS.readFileSync(Path.join(cwd, root, "qa.txt"), "utf8"), "retained QA note");
  assert.equal(inspectGeneratedBuildOwnership(cwd, root)!.files[0]?.reason, null);
});

it("positive compiled-output use renews tokens, while malformed provenance is never replaced", () => {
  const { cwd, metadata, emit } = fixture();
  const root = "apps/web/dist";
  assert.isFalse(recordGeneratedBuildUse(cwd, root, 100));
  const stage = createGeneratedBuildStage(cwd, root)!;
  emit(stage.directory, "main.js", "output");
  stage.publish(100);
  const previous = inspectGeneratedBuildOwnership(cwd, root)!;
  assert.isTrue(recordGeneratedBuildUse(cwd, root, 200));
  assert.equal(inspectGeneratedBuildOwnership(cwd, root)!.lastUsedAt, 200);
  assert.throws(() => removeGeneratedBuildFiles(cwd, root, previous.token, ["main.js"]), "ownership changed");
  const record = FS.readdirSync(metadata).find((file) => file.startsWith("t3-build-") && file.endsWith(".json"))!;
  FS.writeFileSync(Path.join(metadata, record), "invalid record");
  assert.throws(() => recordGeneratedBuildUse(cwd, root, 300));
  assert.equal(FS.readFileSync(Path.join(metadata, record), "utf8"), "invalid record");
});

it("accepts Cargo hardlinks confined to its own stage and rejects external links", () => {
  const { cwd, emit, temporary } = fixture();
  const root = "native/resource-monitor/target/debug";
  const cargo = createGeneratedBuildStage(cwd, root)!;
  emit(cargo.directory, "debug/deps/monitor", "compiled executable");
  FS.linkSync(Path.join(cargo.directory, "debug/deps/monitor"), Path.join(cargo.directory, "debug/monitor"));
  cargo.publish(100, Path.join(cargo.directory, "debug"));
  assert.equal(inspectGeneratedBuildOwnership(cwd, root)!.files.length, 2);
  assert.equal(FS.lstatSync(Path.join(cwd, root, "monitor")).nlink, 1);
  const unsafe = createGeneratedBuildStage(cwd, root)!;
  const retained = Path.join(temporary, "retained-binary");
  FS.writeFileSync(retained, "outside stage");
  FS.mkdirSync(Path.join(unsafe.directory, "debug"));
  FS.linkSync(retained, Path.join(unsafe.directory, "debug/external"));
  assert.throws(() => unsafe.publish(200, Path.join(unsafe.directory, "debug")), "external hardlink");
  unsafe.discard();
  assert.equal(FS.readFileSync(retained, "utf8"), "outside stage");
});

it("current compiler emissions exclude historical chunks and modified current files during server copy", () => {
  const { cwd, emit } = fixture();
  const root = "apps/web/dist";
  const first = createGeneratedBuildStage(cwd, root)!;
  emit(first.directory, "old.js", "old compiler chunk");
  first.publish(100);
  const current = createGeneratedBuildStage(cwd, root)!;
  emit(current.directory, "current.js", "current compiler chunk");
  current.publish(200);
  const server = createGeneratedBuildStage(cwd, "apps/server/dist")!;
  copyOwnedGeneratedBuild(cwd, root, Path.join(server.directory, "client"));
  assert.isFalse(FS.existsSync(Path.join(server.directory, "client/old.js")));
  assert.equal(FS.readFileSync(Path.join(server.directory, "client/current.js"), "utf8"), "current compiler chunk");
  FS.writeFileSync(Path.join(cwd, root, "current.js"), "retained user edit");
  assert.throws(() => copyOwnedGeneratedBuild(cwd, root, Path.join(server.directory, "other-client")), "changed since compiler emission");
  server.discard();
});

it("a watched runner keeps its own stage and renews ownership for repeated emitted builds", () => {
  const { cwd, emit } = fixture();
  const root = "apps/web/dist";
  const watcher = createGeneratedBuildStage(cwd, root)!;
  emit(watcher.directory, "main.js", "first emission");
  watcher.publish(100, undefined, true);
  emit(watcher.directory, "main.js", "second emission");
  watcher.publish(200, undefined, true);
  assert.equal(FS.readFileSync(Path.join(cwd, root, "main.js"), "utf8"), "second emission");
  assert.equal(inspectGeneratedBuildOwnership(cwd, root)!.lastUsedAt, 200);
  watcher.discard();
});

it("usage-only renewal does not invalidate an in-progress compiler stage or erase its newer clock", () => {
  const { cwd, emit } = fixture();
  const root = "apps/web/dist";
  const original = createGeneratedBuildStage(cwd, root)!;
  emit(original.directory, "main.js", "original compiler output");
  original.publish(100);
  const stage = createGeneratedBuildStage(cwd, root)!;
  emit(stage.directory, "main.js", "rebuilt compiler output");
  assert.isTrue(recordGeneratedBuildUse(cwd, root, 1000));
  stage.publish(500);
  assert.equal(inspectGeneratedBuildOwnership(cwd, root)!.lastUsedAt, 1000);
  assert.equal(inspectGeneratedBuildOwnership(cwd, root)!.files[0]?.reason, null);
});
