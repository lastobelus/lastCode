// @effect-diagnostics nodeBuiltinImport:off -- Native emission and hardlink fixtures exercise filesystem identity boundaries.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import { assert, it, onTestFinished } from "vite-plus/test";
import {
  createGeneratedBuildStage,
  inspectGeneratedBuildOwnership,
  removeGeneratedBuildFiles,
  removeGeneratedBuildFilesAsync,
  copyOwnedGeneratedBuild,
  recordGeneratedBuildUse,
} from "./generatedBuildOwnership.ts";

const fixture = () => {
  const temporary = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "build-provenance-")),
  );
  onTestFinished(() => NodeFS.rmSync(temporary, { recursive: true, force: true }));
  const cwd = NodePath.join(temporary, "worktree");
  const metadata = NodePath.join(temporary, "git-metadata");
  NodeFS.mkdirSync(cwd);
  NodeFS.mkdirSync(metadata);
  NodeFS.writeFileSync(NodePath.join(cwd, ".git"), `gitdir: ${metadata}\n`);
  const emit = (stage: string, file: string, contents: string) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(stage, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(stage, file), contents);
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
  const output = NodePath.join(cwd, root);
  emit(output, "notes.txt", "retained addition");
  emit(output, "index.html", "user edit");
  const before = inspectGeneratedBuildOwnership(cwd, root)!;
  assert.equal(before.lastUsedAt, 100);
  assert.equal(
    before.files.find((file) => file.path === "index.html")?.reason,
    "Generated file changed since emission",
  );
  const receipt = NodePath.join(metadata, "retained-review.json");
  NodeFS.writeFileSync(receipt, "reviewed retained additions and partial removal remain protected");
  const removed = removeGeneratedBuildFiles(cwd, root, before.token, [
    "assets/main.js",
    "index.html",
  ]);
  assert.equal(removed.files, 1);
  assert.equal(removed.kept.length, 1);
  assert.isFalse(NodeFS.existsSync(NodePath.join(output, "assets")));
  assert.equal(
    NodeFS.readFileSync(NodePath.join(output, "notes.txt"), "utf8"),
    "retained addition",
  );
  assert.equal(NodeFS.readFileSync(NodePath.join(output, "index.html"), "utf8"), "user edit");
  assert.equal(
    NodeFS.readFileSync(receipt, "utf8"),
    "reviewed retained additions and partial removal remain protected",
  );
  const rebuild = createGeneratedBuildStage(cwd, root)!;
  emit(rebuild.directory, "assets/main.js", "rebuilt compiler output");
  rebuild.publish(200);
  const after = inspectGeneratedBuildOwnership(cwd, root)!;
  assert.equal(after.lastUsedAt, 200);
  assert.equal(after.files.find((file) => file.path === "assets/main.js")?.reason, null);
  assert.equal(
    NodeFS.readFileSync(NodePath.join(output, "notes.txt"), "utf8"),
    "retained addition",
  );
  assert.throws(
    () => removeGeneratedBuildFiles(cwd, root, before.token, ["assets/main.js"]),
    "ownership changed",
  );
});

it("never claims preexisting matching output or overwrites unknown collisions", () => {
  const { cwd, emit } = fixture();
  const root = "apps/server/dist";
  emit(NodePath.join(cwd, root), "same.js", "same emission");
  emit(NodePath.join(cwd, root), "notes.js", "unknown addition");
  const stage = createGeneratedBuildStage(cwd, root)!;
  emit(stage.directory, "same.js", "same emission");
  stage.publish(100);
  assert.deepEqual(inspectGeneratedBuildOwnership(cwd, root)!.files, []);
  const collision = createGeneratedBuildStage(cwd, root)!;
  emit(collision.directory, "notes.js", "different emission");
  assert.throws(() => collision.publish(200), "requires file review");
  collision.discard();
  assert.equal(
    NodeFS.readFileSync(NodePath.join(cwd, root, "notes.js"), "utf8"),
    "unknown addition",
  );
});

it("rejects linked or hardlinked destinations and forged roots; ordinary checkout builds keep their behavior", () => {
  const { cwd, temporary, emit } = fixture();
  const stage = createGeneratedBuildStage(cwd, "apps/web/dist")!;
  emit(stage.directory, "index.html", "output");
  const retained = NodePath.join(temporary, "retained");
  NodeFS.mkdirSync(retained);
  NodeFS.mkdirSync(NodePath.join(cwd, "apps/web"), { recursive: true });
  NodeFS.symlinkSync(retained, NodePath.join(cwd, "apps/web/dist"));
  assert.throws(() => stage.publish(100), "Linked or invalid");
  stage.discard();
  assert.isFalse(NodeFS.existsSync(NodePath.join(retained, "index.html")));
  assert.throws(() => createGeneratedBuildStage(cwd, "notes"), "Unrecognized");
  NodeFS.unlinkSync(NodePath.join(cwd, ".git"));
  assert.throws(
    () => copyOwnedGeneratedBuild(cwd, "apps/web/dist", NodePath.join(temporary, "release")),
    "requires repository metadata",
  );
  NodeFS.mkdirSync(NodePath.join(cwd, ".git"));
  assert.equal(createGeneratedBuildStage(cwd, "apps/web/dist"), null);
  assert.isFalse(
    copyOwnedGeneratedBuild(cwd, "apps/web/dist", NodePath.join(temporary, "release")),
  );
});

it("copies only verified web emissions into an owned server stage", () => {
  const { cwd, emit } = fixture();
  const web = createGeneratedBuildStage(cwd, "apps/web/dist")!;
  emit(web.directory, "assets/main.js", "web compiler output");
  web.publish(100);
  emit(NodePath.join(cwd, "apps/web/dist"), "personal-note.txt", "unknown");
  const server = createGeneratedBuildStage(cwd, "apps/server/dist")!;
  copyOwnedGeneratedBuild(cwd, "apps/web/dist", NodePath.join(server.directory, "client"));
  server.publish(200);
  assert.equal(
    NodeFS.readFileSync(NodePath.join(cwd, "apps/server/dist/client/assets/main.js"), "utf8"),
    "web compiler output",
  );
  assert.isFalse(
    NodeFS.existsSync(NodePath.join(cwd, "apps/server/dist/client/personal-note.txt")),
  );
});

it("publishes only debug outputs from a clean Cargo target and retains arbitrary debug additions on rebuild", () => {
  const { cwd, emit } = fixture();
  const root = "native/resource-monitor/target/debug";
  const cargo = createGeneratedBuildStage(cwd, root)!;
  emit(cargo.directory, "debug/deps/monitor", "compiled debug binary");
  emit(cargo.directory, "CACHEDIR.TAG", "cargo metadata");
  cargo.publish(100, NodePath.join(cargo.directory, "debug"));
  emit(NodePath.join(cwd, root), "qa.txt", "retained QA note");
  const first = inspectGeneratedBuildOwnership(cwd, root)!;
  assert.deepEqual(
    first.files.map((file) => file.path),
    ["deps/monitor"],
  );
  assert.equal(removeGeneratedBuildFiles(cwd, root, first.token, ["deps/monitor"]).files, 1);
  const rebuilt = createGeneratedBuildStage(cwd, root)!;
  emit(rebuilt.directory, "debug/deps/monitor", "new compiled binary");
  rebuilt.publish(200, NodePath.join(rebuilt.directory, "debug"));
  assert.equal(NodeFS.readFileSync(NodePath.join(cwd, root, "qa.txt"), "utf8"), "retained QA note");
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
  assert.throws(
    () => removeGeneratedBuildFiles(cwd, root, previous.token, ["main.js"]),
    "ownership changed",
  );
  const record = NodeFS.readdirSync(metadata).find(
    (file) => file.startsWith("t3-build-") && file.endsWith(".json"),
  )!;
  NodeFS.writeFileSync(NodePath.join(metadata, record), "invalid record");
  assert.throws(() => recordGeneratedBuildUse(cwd, root, 300));
  assert.equal(NodeFS.readFileSync(NodePath.join(metadata, record), "utf8"), "invalid record");
});

it("accepts Cargo hardlinks confined to its own stage and rejects external links", () => {
  const { cwd, emit, temporary } = fixture();
  const root = "native/resource-monitor/target/debug";
  const cargo = createGeneratedBuildStage(cwd, root)!;
  emit(cargo.directory, "debug/deps/monitor", "compiled executable");
  NodeFS.linkSync(
    NodePath.join(cargo.directory, "debug/deps/monitor"),
    NodePath.join(cargo.directory, "debug/monitor"),
  );
  cargo.publish(100, NodePath.join(cargo.directory, "debug"));
  assert.equal(inspectGeneratedBuildOwnership(cwd, root)!.files.length, 2);
  assert.equal(NodeFS.lstatSync(NodePath.join(cwd, root, "monitor")).nlink, 1);
  const unsafe = createGeneratedBuildStage(cwd, root)!;
  const retained = NodePath.join(temporary, "retained-binary");
  NodeFS.writeFileSync(retained, "outside stage");
  NodeFS.mkdirSync(NodePath.join(unsafe.directory, "debug"));
  NodeFS.linkSync(retained, NodePath.join(unsafe.directory, "debug/external"));
  assert.throws(
    () => unsafe.publish(200, NodePath.join(unsafe.directory, "debug")),
    "external hardlink",
  );
  unsafe.discard();
  assert.equal(NodeFS.readFileSync(retained, "utf8"), "outside stage");
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
  copyOwnedGeneratedBuild(cwd, root, NodePath.join(server.directory, "client"));
  assert.isFalse(NodeFS.existsSync(NodePath.join(server.directory, "client/old.js")));
  assert.equal(
    NodeFS.readFileSync(NodePath.join(server.directory, "client/current.js"), "utf8"),
    "current compiler chunk",
  );
  NodeFS.writeFileSync(NodePath.join(cwd, root, "current.js"), "retained user edit");
  assert.throws(
    () => copyOwnedGeneratedBuild(cwd, root, NodePath.join(server.directory, "other-client")),
    "changed since compiler emission",
  );
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
  assert.equal(NodeFS.readFileSync(NodePath.join(cwd, root, "main.js"), "utf8"), "second emission");
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

it.each(["apps/web/dist", "apps/server/dist", "native/resource-monitor/target/debug"])(
  "repeated changing compiler filenames keep only current emissions on disk and in ownership (%s)",
  (root) => {
    const { cwd, emit } = fixture();
    const output = NodePath.join(cwd, root);
    for (let generation = 0; generation < 12; generation++) {
      const build = createGeneratedBuildStage(cwd, root)!;
      const filename = `assets/chunk-${generation}.js`;
      emit(build.directory, filename, `compiler generation ${generation}`);
      emit(build.directory, "index.html", `entrypoint ${generation}`);
      build.publish(100 + generation);
      const inspection = inspectGeneratedBuildOwnership(cwd, root)!;
      assert.deepEqual(inspection.files.map((file) => file.path).sort(), [filename, "index.html"]);
      assert.isTrue(inspection.files.every((file) => file.reason === null));
      assert.deepEqual(NodeFS.readdirSync(NodePath.join(output, "assets")), [
        `chunk-${generation}.js`,
      ]);
      assert.equal(
        NodeFS.readFileSync(NodePath.join(output, "index.html"), "utf8"),
        `entrypoint ${generation}`,
      );
    }
  },
);

it("publication prunes missing ownership and preserves edited obsolete outputs and unknown additions unowned", () => {
  const { cwd, emit, temporary } = fixture();
  const root = "apps/web/dist";
  const output = NodePath.join(cwd, root);
  const first = createGeneratedBuildStage(cwd, root)!;
  for (const file of ["old.js", "missing.js", "edited.js"])
    emit(first.directory, file, `original ${file}`);
  first.publish(100);
  NodeFS.unlinkSync(NodePath.join(output, "missing.js"));
  emit(output, "edited.js", "retained user edit");
  emit(output, "notes.txt", "unknown addition");
  const next = createGeneratedBuildStage(cwd, root)!;
  emit(next.directory, "current.js", "current compiler output");
  next.publish(200);
  assert.deepEqual(
    inspectGeneratedBuildOwnership(cwd, root)!.files.map((file) => file.path),
    ["current.js"],
  );
  assert.isFalse(NodeFS.existsSync(NodePath.join(output, "old.js")));
  assert.isFalse(NodeFS.existsSync(NodePath.join(output, "missing.js")));
  assert.equal(
    NodeFS.readFileSync(NodePath.join(output, "edited.js"), "utf8"),
    "retained user edit",
  );
  assert.equal(NodeFS.readFileSync(NodePath.join(output, "notes.txt"), "utf8"), "unknown addition");
  const release = NodePath.join(temporary, "release");
  copyOwnedGeneratedBuild(cwd, root, release);
  assert.deepEqual(NodeFS.readdirSync(release), ["current.js"]);
  const collision = createGeneratedBuildStage(cwd, root)!;
  emit(collision.directory, "edited.js", "replacement compiler output");
  assert.throws(() => collision.publish(300), "requires file review");
  collision.discard();
  assert.equal(
    NodeFS.readFileSync(NodePath.join(output, "current.js"), "utf8"),
    "current compiler output",
  );
});

it("a destination collision preserves every prior emission and ownership before obsolete retirement", () => {
  const { cwd, emit } = fixture();
  const root = "apps/server/dist";
  const output = NodePath.join(cwd, root);
  const original = createGeneratedBuildStage(cwd, root)!;
  emit(original.directory, "obsolete.js", "still-needed prior chunk");
  emit(original.directory, "index.html", "still-needed prior entrypoint");
  original.publish(100);
  emit(output, "zzz-collision.js", "unknown retained output");
  const previous = inspectGeneratedBuildOwnership(cwd, root)!;
  const colliding = createGeneratedBuildStage(cwd, root)!;
  emit(colliding.directory, "index.html", "new entrypoint");
  emit(colliding.directory, "zzz-collision.js", "new compiler output");
  assert.throws(() => colliding.publish(200), "requires file review");
  assert.deepEqual(inspectGeneratedBuildOwnership(cwd, root), previous);
  assert.equal(
    NodeFS.readFileSync(NodePath.join(output, "obsolete.js"), "utf8"),
    "still-needed prior chunk",
  );
  assert.equal(
    NodeFS.readFileSync(NodePath.join(output, "index.html"), "utf8"),
    "still-needed prior entrypoint",
  );
  assert.equal(
    NodeFS.readFileSync(NodePath.join(output, "zzz-collision.js"), "utf8"),
    "unknown retained output",
  );
  colliding.discard();
});

it("watched changing emissions retire obsolete files while preserving usage-only renewal", () => {
  const { cwd, emit } = fixture();
  const root = "apps/web/dist";
  const output = NodePath.join(cwd, root);
  const watcher = createGeneratedBuildStage(cwd, root)!;
  emit(watcher.directory, "old.js", "first watched emission");
  watcher.publish(100, undefined, true);
  NodeFS.unlinkSync(NodePath.join(watcher.directory, "old.js"));
  emit(watcher.directory, "current.js", "second watched emission");
  assert.isTrue(recordGeneratedBuildUse(cwd, root, 1000));
  watcher.publish(500, undefined, true);
  assert.isFalse(NodeFS.existsSync(NodePath.join(output, "old.js")));
  const current = inspectGeneratedBuildOwnership(cwd, root)!;
  assert.equal(current.lastUsedAt, 1000);
  assert.deepEqual(
    current.files.map((file) => file.path),
    ["current.js"],
  );
  const competitor = createGeneratedBuildStage(cwd, root)!;
  emit(competitor.directory, "competitor.js", "competing generation");
  competitor.publish(1100);
  assert.throws(
    () => watcher.publish(1200, undefined, true),
    "Another build changed output ownership",
  );
  assert.isFalse(NodeFS.existsSync(NodePath.join(output, "current.js")));
  assert.equal(
    NodeFS.readFileSync(NodePath.join(output, "competitor.js"), "utf8"),
    "competing generation",
  );
  watcher.discard();
});

const startPublisher = (
  cwd: string,
  root: string,
  role: string,
  contents = "original emission",
) => {
  const child = NodeChildProcess.fork(
    new URL("./testing/generatedBuildPublisher.fixture.mjs", import.meta.url),
    [cwd, root, role, contents],
    { silent: true, execArgv: [] },
  );
  const messages: string[] = [];
  const readers: Array<{ resolve: (message: string) => void; reject: (error: Error) => void }> = [];
  let stderr = "";
  child.stderr!.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.on("message", (message) => {
    if (typeof message !== "string") return;
    const reader = readers.shift();
    if (reader) reader.resolve(message);
    else messages.push(message);
  });
  let exited = false;
  const exit = new Promise<void>((resolve) => {
    child.on("exit", () => {
      exited = true;
      for (const reader of readers.splice(0))
        reader.reject(new Error(`Publisher exited: ${stderr}`));
      resolve();
    });
  });
  onTestFinished(async () => {
    if (!exited) child.kill("SIGKILL");
    await exit;
  });
  const next = () => {
    const message = messages.shift();
    if (message !== undefined) return Promise.resolve(message);
    if (exited) return Promise.reject(new Error(`Publisher already exited: ${stderr}`));
    return new Promise<string>((resolve, reject) => readers.push({ resolve, reject }));
  };
  return { child, next, exit };
};

it.each(["complete", "throw", "owner-death"] as const)(
  "publication exclusion protects identical competing emissions and permits recovery retry after %s",
  async (completion) => {
    const { cwd, emit } = fixture();
    const root = "apps/web/dist";
    const first = createGeneratedBuildStage(cwd, root)!;
    emit(first.directory, "old.js", "original emission");
    first.publish(100);
    const publisherA = startPublisher(cwd, root, "paused");
    assert.equal(await publisherA.next(), "paused-before-retirement");
    assert.throws(() => inspectGeneratedBuildOwnership(cwd, root), "pending recovery");
    const publisherB = startPublisher(cwd, root, "competitor");
    assert.equal(await publisherB.next(), "ready");
    publisherB.child.send("publish");
    const blocked = await publisherB.next();
    assert.match(blocked, /^blocked:PortableLockContentionError:/);
    assert.match(blocked, /publication|publish|already running|retry/i);
    assert.equal(
      NodeFS.readFileSync(NodePath.join(cwd, root, "old.js"), "utf8"),
      "original emission",
    );
    if (completion === "owner-death") {
      publisherA.child.kill("SIGKILL");
    } else {
      publisherA.child.stdin!.write(completion === "throw" ? "f" : "r");
      assert.equal(
        await publisherA.next(),
        completion === "throw" ? "failed:Injected retirement failure" : "published",
      );
    }
    await publisherA.exit;
    if (completion === "complete")
      assert.isFalse(NodeFS.existsSync(NodePath.join(cwd, root, "old.js")));
    publisherB.child.send("retry");
    assert.equal(await publisherB.next(), "stage-created");
    assert.equal(await publisherB.next(), "published");
    assert.equal(
      NodeFS.readFileSync(NodePath.join(cwd, root, "old.js"), "utf8"),
      "original emission",
    );
    assert.isFalse(NodeFS.existsSync(NodePath.join(cwd, root, "current.js")));
    assert.deepEqual(
      inspectGeneratedBuildOwnership(cwd, root)!.files.map((file) => file.path),
      ["old.js"],
    );
    publisherB.child.send("close");
    await publisherB.exit;
  },
);

it.each([
  ["sync", "complete"],
  ["sync", "throw"],
  ["sync", "owner-death"],
  ["async", "complete"],
  ["async", "throw"],
  ["async", "owner-death"],
] as const)(
  "%s removal excludes replacement publication until %s and permits same-stage retry",
  async (kind, completion) => {
    const { cwd, emit } = fixture();
    const root = "apps/web/dist";
    const initial = createGeneratedBuildStage(cwd, root)!;
    emit(initial.directory, "old.js", "original emission");
    initial.publish(100);
    const remover = startPublisher(cwd, root, `remove-${kind}`);
    assert.equal(await remover.next(), "paused-before-removal");
    const publisher = startPublisher(cwd, root, "competitor", "replacement compiler emission");
    assert.equal(await publisher.next(), "ready");
    publisher.child.send("publish");
    assert.equal(await publisher.next(), "stage-created");
    assert.match(await publisher.next(), /^blocked:PortableLockContentionError:/);
    assert.equal(
      NodeFS.readFileSync(NodePath.join(cwd, root, "old.js"), "utf8"),
      "original emission",
    );
    if (completion === "owner-death") remover.child.kill("SIGKILL");
    else {
      remover.child.stdin!.write(completion === "throw" ? "f" : "r");
      const result = await remover.next();
      if (completion === "complete") assert.match(result, /^removed:.*"files":1/);
      else if (kind === "async") assert.match(result, /^removed:.*"files":0/);
      else assert.equal(result, "failed:Injected retirement failure");
    }
    await remover.exit;
    publisher.child.send("retry");
    assert.equal(await publisher.next(), "published");
    assert.equal(
      NodeFS.readFileSync(NodePath.join(cwd, root, "old.js"), "utf8"),
      "replacement compiler emission",
    );
    const current = inspectGeneratedBuildOwnership(cwd, root)!;
    assert.deepEqual(
      current.files.map((file) => file.path),
      ["old.js"],
    );
    assert.equal(current.files[0]!.reason, null);
    publisher.child.send("close");
    await publisher.exit;
  },
);

it("usage renewal leaves committed ownership unchanged while publication holds exclusion", async () => {
  const { cwd, emit } = fixture();
  const root = "apps/web/dist";
  const original = createGeneratedBuildStage(cwd, root)!;
  emit(original.directory, "old.js", "original emission");
  original.publish(100);
  const publisher = startPublisher(cwd, root, "paused");
  assert.equal(await publisher.next(), "paused-before-retirement");
  assert.throws(() => inspectGeneratedBuildOwnership(cwd, root), "pending recovery");
  assert.isFalse(recordGeneratedBuildUse(cwd, root, 1000));
  assert.throws(() => inspectGeneratedBuildOwnership(cwd, root), "pending recovery");
  publisher.child.stdin!.write("r");
  assert.equal(await publisher.next(), "published");
  await publisher.exit;
  assert.equal(inspectGeneratedBuildOwnership(cwd, root)!.lastUsedAt, 200);
});

it("a usage writer excludes publication until its clock commits without clobbering new ownership", async () => {
  const { cwd, emit } = fixture();
  const root = "apps/web/dist";
  const original = createGeneratedBuildStage(cwd, root)!;
  emit(original.directory, "old.js", "original emission");
  original.publish(100);
  const usage = startPublisher(cwd, root, "usage");
  assert.equal(await usage.next(), "paused-before-usage-write");
  const publisher = startPublisher(cwd, root, "competitor", "replacement compiler emission");
  assert.equal(await publisher.next(), "ready");
  publisher.child.send("publish");
  assert.equal(await publisher.next(), "stage-created");
  assert.match(await publisher.next(), /^blocked:PortableLockContentionError:/);
  usage.child.stdin!.write("r");
  assert.equal(await usage.next(), "usage:true");
  await usage.exit;
  publisher.child.send("retry");
  assert.equal(await publisher.next(), "published");
  const current = inspectGeneratedBuildOwnership(cwd, root)!;
  assert.equal(current.lastUsedAt, 1000);
  assert.deepEqual(
    current.files.map((file) => file.path),
    ["old.js"],
  );
  assert.equal(current.files[0]!.reason, null);
  assert.equal(
    NodeFS.readFileSync(NodePath.join(cwd, root, "old.js"), "utf8"),
    "replacement compiler emission",
  );
  publisher.child.send("close");
  await publisher.exit;
});

it("async removal preserves prior 64-file totals when the next revalidation encounters publication contention", async () => {
  const { cwd, emit } = fixture();
  const root = "apps/web/dist";
  const initial = createGeneratedBuildStage(cwd, root)!;
  const paths = Array.from({ length: 65 }, (_, index) => `${String(index).padStart(2, "0")}.js`);
  for (const file of paths) emit(initial.directory, file, "emitted");
  emit(initial.directory, "old.js", "original emission");
  initial.publish(100);
  const inspected = inspectGeneratedBuildOwnership(cwd, root)!;
  let guards = 0;
  let publisher: ReturnType<typeof startPublisher> | undefined;
  const result = await removeGeneratedBuildFilesAsync(
    cwd,
    root,
    inspected.token,
    paths,
    async () => {
      guards++;
      if (guards === 2) {
        publisher = startPublisher(cwd, root, "paused");
        assert.equal(await publisher.next(), "paused-before-retirement");
      }
      return true;
    },
  );
  assert.equal(guards, 2);
  assert.equal(result.files, 64);
  const firstBatch = new Set(paths.slice(0, 64));
  assert.equal(
    result.bytes,
    inspected.files
      .filter((file) => firstBatch.has(file.path))
      .reduce((total, file) => total + file.bytes, 0),
  );
  assert.deepEqual(
    result.kept.map((file) => file.path),
    ["64.js"],
  );
  assert.match(result.kept[0]!.reason, /busy|running|retry|publication/i);
  assert.isDefined(publisher);
  publisher!.child.stdin!.write("r");
  assert.equal(await publisher!.next(), "published");
  await publisher!.exit;
  assert.deepEqual(
    inspectGeneratedBuildOwnership(cwd, root)!.files.map((file) => file.path),
    ["current.js"],
  );
  assert.equal(
    NodeFS.readFileSync(NodePath.join(cwd, root, "current.js"), "utf8"),
    "publisher A emission",
  );
});
