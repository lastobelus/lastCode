// @effect-diagnostics nodeBuiltinImport:off -- Real child processes inject filesystem failures and exercise crash recovery.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import { assert, expect, it, onTestFinished } from "vite-plus/test";
import {
  copyOwnedGeneratedBuild,
  createGeneratedBuildStage,
  generatedBuildActivity,
  inspectGeneratedBuildOwnership,
  inspectGeneratedBuildOwnershipAsync,
  recordGeneratedBuildUse,
  removeGeneratedBuildFiles,
  removeGeneratedBuildFilesAsync,
} from "./generatedBuildOwnership.ts";

const root = "apps/web/dist";
const nextEmission = { "a.js": "new first output", "b.js": "new second output" };
const fixture = (seed = true) => {
  const temporary = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "build-publication-recovery-")),
  );
  onTestFinished(() => NodeFS.rmSync(temporary, { recursive: true, force: true }));
  const cwd = NodePath.join(temporary, "worktree");
  const metadata = NodePath.join(temporary, "git-metadata");
  NodeFS.mkdirSync(cwd);
  NodeFS.mkdirSync(metadata);
  NodeFS.writeFileSync(NodePath.join(cwd, ".git"), `gitdir: ${metadata}\n`);
  const output = NodePath.join(cwd, root);
  const record = NodePath.join(
    metadata,
    `t3-build-${NodeCrypto.createHash("sha256").update(root).digest("hex")}.json`,
  );
  const emit = (directory: string, file: string, contents: string) => {
    const target = NodePath.join(directory, file);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, contents);
  };
  if (seed) {
    const initial = createGeneratedBuildStage(cwd, root)!;
    emit(initial.directory, "a.js", "prior first output");
    emit(initial.directory, "b.js", "prior second output");
    emit(initial.directory, "obsolete.js", "chunk needed by prior entrypoint");
    emit(initial.directory, "edited.js", "prior editable output");
    initial.publish(100);
    emit(output, "edited.js", "retained user edit");
  }
  emit(output, "notes.txt", "retained arbitrary note");
  return { cwd, metadata, temporary, output, record, pending: `${record}.pending`, emit };
};

type Message =
  | { kind: "installed"; path: string }
  | { kind: "failure"; hits: number; message: string }
  | { kind: "watch-failed"; hits: number; message: string }
  | {
      kind: "success";
      hits: number;
      inspection: ReturnType<typeof inspectGeneratedBuildOwnership>;
    };

const start = (
  cwd: string,
  operation = "publish",
  fault = "none",
  files: Record<string, string> = nextEmission,
) => {
  const child = NodeChildProcess.fork(
    new URL("./testing/generatedBuildRecovery.fixture.mjs", import.meta.url),
    [cwd, root, operation, fault, JSON.stringify(files)],
    { silent: true, execArgv: [] },
  );
  const messages: Message[] = [];
  const readers: Array<{ resolve: (value: Message) => void; reject: (error: Error) => void }> = [];
  let stderr = "";
  let exited = false;
  child.stderr!.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.on("message", (message) => {
    const reader = readers.shift();
    if (reader) reader.resolve(message as Message);
    else messages.push(message as Message);
  });
  const exit = new Promise<void>((resolve) => {
    child.on("exit", () => {
      exited = true;
      for (const reader of readers.splice(0)) reader.reject(new Error(`Child exited: ${stderr}`));
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
    if (exited) return Promise.reject(new Error(`Child already exited: ${stderr}`));
    return new Promise<Message>((resolve, reject) => readers.push({ resolve, reject }));
  };
  return { child, next, exit };
};

const failPublication = async (cwd: string, fault: string) => {
  const child = start(cwd, "publish", fault);
  const message = await child.next();
  assert.equal(message.kind, "failure");
  if (message.kind !== "failure") throw new Error("Expected injected filesystem failure");
  assert.isAbove(message.hits, 0, "The intended filesystem seam must have been reached");
  assert.include(message.message, "Injected ENOSPC");
  await child.exit;
};

const recover = async (cwd: string) => {
  const child = start(cwd, "recover");
  const message = await child.next();
  assert.equal(message.kind, "success");
  if (message.kind !== "success") throw new Error("Recovery failed");
  await child.exit;
  return message.inspection;
};

const assertValid = (cwd: string, paths: string[]) => {
  const observed = inspectGeneratedBuildOwnership(cwd, root)!;
  assert.deepEqual(observed.files.map((file) => file.path).sort(), paths.sort());
  assert.isTrue(observed.files.every((file) => file.reason === null));
  assert.isTrue(observed.files.every((file) => file.bytes >= 0));
  return observed;
};

const assertPendingBlocksConsumers = async (state: ReturnType<typeof fixture>, token: string) => {
  const pending = "Build publication is pending recovery";
  assert.throws(() => generatedBuildActivity(state.cwd, root), pending);
  assert.throws(() => inspectGeneratedBuildOwnership(state.cwd, root), pending);
  await expect(inspectGeneratedBuildOwnershipAsync(state.cwd, root)).rejects.toThrow(pending);
  assert.isFalse(recordGeneratedBuildUse(state.cwd, root, 1000));
  assert.throws(
    () => copyOwnedGeneratedBuild(state.cwd, root, NodePath.join(state.temporary, "release")),
    pending,
  );
  assert.throws(() => removeGeneratedBuildFiles(state.cwd, root, token, ["a.js"]), pending);
  await expect(
    removeGeneratedBuildFilesAsync(state.cwd, root, token, ["a.js"], async () => true),
  ).rejects.toThrow(pending);
  assert.isFalse(NodeFS.existsSync(NodePath.join(state.temporary, "release")));
};

it.each(["copy", "partial-write", "chmod", "hash"])(
  "a prepared-file %s failure leaves every prior output and ownership unchanged",
  async (fault) => {
    const state = fixture();
    const before = inspectGeneratedBuildOwnership(state.cwd, root);
    const ledger = NodeFS.readFileSync(state.record);
    await failPublication(state.cwd, fault);
    assert.deepEqual(NodeFS.readFileSync(state.record), ledger);
    assert.deepEqual(inspectGeneratedBuildOwnership(state.cwd, root), before);
    assert.isFalse(NodeFS.existsSync(state.pending));
    assert.equal(
      NodeFS.readFileSync(NodePath.join(state.output, "a.js"), "utf8"),
      "prior first output",
    );
    assert.equal(
      NodeFS.readFileSync(NodePath.join(state.output, "b.js"), "utf8"),
      "prior second output",
    );
    assert.equal(
      NodeFS.readFileSync(NodePath.join(state.output, "obsolete.js"), "utf8"),
      "chunk needed by prior entrypoint",
    );
    assert.equal(
      NodeFS.readFileSync(NodePath.join(state.output, "edited.js"), "utf8"),
      "retained user edit",
    );
    assert.equal(
      NodeFS.readFileSync(NodePath.join(state.output, "notes.txt"), "utf8"),
      "retained arbitrary note",
    );
    assert.deepEqual(
      NodeFS.readdirSync(state.output, { recursive: true }).filter((name) =>
        String(name).includes(".t3-build-publication-"),
      ),
      [],
    );
  },
);

it.each([
  [true, "ledger-write"],
  [false, "ledger-write"],
  [true, "ledger-partial-write"],
  [false, "ledger-partial-write"],
] as const)(
  "a recoverable ledger failure preserves prior ownership present=%s (%s)",
  async (seed, fault) => {
    const state = fixture(seed);
    const previous = inspectGeneratedBuildOwnership(state.cwd, root);
    const ledger = seed ? NodeFS.readFileSync(state.record) : null;
    await failPublication(state.cwd, fault);
    assert.isTrue(NodeFS.existsSync(state.pending));
    assert.deepEqual(
      NodeFS.readdirSync(state.metadata).filter((name) => name.startsWith("t3-build-stage-")),
      [],
      "Discarding the compiler stage must leave publication recovery independent",
    );
    if (ledger) assert.deepEqual(NodeFS.readFileSync(state.record), ledger);
    else assert.isFalse(NodeFS.existsSync(state.record));
    if (seed) assert.isTrue(NodeFS.existsSync(NodePath.join(state.output, "obsolete.js")));
    await assertPendingBlocksConsumers(state, previous?.token ?? "no-prior-record");
    const recovered = await recover(state.cwd);
    assert.deepEqual(recovered, assertValid(state.cwd, ["a.js", "b.js"]));
    assert.isFalse(NodeFS.existsSync(state.pending));
    assert.isFalse(NodeFS.existsSync(NodePath.join(state.output, "obsolete.js")));
    for (const [path, bytes] of Object.entries(nextEmission))
      assert.equal(NodeFS.readFileSync(NodePath.join(state.output, path), "utf8"), bytes);
    assert.equal(NodeFS.statSync(NodePath.join(state.output, "a.js")).mode & 0o777, 0o755);
    assert.equal(
      NodeFS.readFileSync(NodePath.join(state.output, "notes.txt"), "utf8"),
      "retained arbitrary note",
    );
    if (seed)
      assert.equal(
        NodeFS.readFileSync(NodePath.join(state.output, "edited.js"), "utf8"),
        "retained user edit",
      );
    const rebuilt = start(state.cwd, "publish", "none", {
      "a.js": "subsequent first output",
      "c.js": "subsequent changing chunk",
    });
    assert.equal((await rebuilt.next()).kind, "success");
    await rebuilt.exit;
    assertValid(state.cwd, ["a.js", "c.js"]);
    assert.isFalse(NodeFS.existsSync(NodePath.join(state.output, "b.js")));
    assert.deepEqual(
      NodeFS.readdirSync(state.output).sort(),
      seed ? ["a.js", "c.js", "edited.js", "notes.txt"] : ["a.js", "c.js", "notes.txt"],
    );
  },
);

const killAfterFirstInstall = async (state: ReturnType<typeof fixture>) => {
  const publishing = start(state.cwd, "publish", "death");
  const milestone = await publishing.next();
  assert.equal(milestone.kind, "installed");
  if (milestone.kind !== "installed") throw new Error("Expected an atomic replacement milestone");
  assert.isTrue(NodeFS.existsSync(state.pending));
  assert.equal(
    NodeFS.readFileSync(NodePath.join(state.output, milestone.path), "utf8"),
    nextEmission[milestone.path as keyof typeof nextEmission],
  );
  publishing.child.kill("SIGKILL");
  await publishing.exit;
  return milestone.path;
};

it("a killed publisher recovers in a fresh process before another compiler generation is admitted", async () => {
  const state = fixture();
  const ledger = NodeFS.readFileSync(state.record);
  const token = inspectGeneratedBuildOwnership(state.cwd, root)!.token;
  await killAfterFirstInstall(state);
  assert.deepEqual(NodeFS.readFileSync(state.record), ledger);
  assert.equal(
    NodeFS.readFileSync(NodePath.join(state.output, "obsolete.js"), "utf8"),
    "chunk needed by prior entrypoint",
  );
  await assertPendingBlocksConsumers(state, token);
  await recover(state.cwd);
  assertValid(state.cwd, ["a.js", "b.js"]);
  assert.isFalse(NodeFS.existsSync(state.pending));
  assert.deepEqual(NodeFS.readdirSync(state.output).sort(), [
    "a.js",
    "b.js",
    "edited.js",
    "notes.txt",
  ]);
  const rebuilt = start(state.cwd, "publish", "none", {
    "a.js": "subsequent first output",
    "c.js": "subsequent changing chunk",
  });
  assert.equal((await rebuilt.next()).kind, "success");
  await rebuilt.exit;
  assertValid(state.cwd, ["a.js", "c.js"]);
  assert.deepEqual(NodeFS.readdirSync(state.output).sort(), [
    "a.js",
    "c.js",
    "edited.js",
    "notes.txt",
  ]);
  assert.equal(
    NodeFS.readFileSync(NodePath.join(state.output, "edited.js"), "utf8"),
    "retained user edit",
  );
  assert.equal(
    NodeFS.readFileSync(NodePath.join(state.output, "notes.txt"), "utf8"),
    "retained arbitrary note",
  );
  const release = NodePath.join(state.temporary, "release");
  assert.isTrue(copyOwnedGeneratedBuild(state.cwd, root, release));
  assert.deepEqual(NodeFS.readdirSync(release).sort(), ["a.js", "c.js"]);
});

it("a watched compiler retries its failed publication after changing emissions in the same stage", async () => {
  const state = fixture();
  const watcher = start(state.cwd, "publish", "watch-ledger");
  const failure = await watcher.next();
  assert.equal(failure.kind, "watch-failed");
  if (failure.kind !== "watch-failed") throw new Error("Expected watched ledger failure");
  assert.equal(failure.hits, 1);
  assert.include(failure.message, "Injected ENOSPC");
  const completed = await watcher.next();
  assert.equal(completed.kind, "success");
  await watcher.exit;
  const observed = assertValid(state.cwd, ["a.js", "c.js"]);
  assert.equal(observed.lastUsedAt, 300);
  assert.isFalse(NodeFS.existsSync(state.pending));
  assert.deepEqual(NodeFS.readdirSync(state.output).sort(), [
    "a.js",
    "c.js",
    "edited.js",
    "notes.txt",
  ]);
  assert.equal(
    NodeFS.readFileSync(NodePath.join(state.output, "a.js"), "utf8"),
    "watched replacement output",
  );
  assert.equal(
    NodeFS.readFileSync(NodePath.join(state.output, "c.js"), "utf8"),
    "watched changing chunk",
  );
  assert.equal(
    NodeFS.readFileSync(NodePath.join(state.output, "edited.js"), "utf8"),
    "retained user edit",
  );
  assert.equal(
    NodeFS.readFileSync(NodePath.join(state.output, "notes.txt"), "utf8"),
    "retained arbitrary note",
  );
  assert.deepEqual(
    NodeFS.readdirSync(state.metadata).filter((name) => name.startsWith("t3-build-stage-")),
    [],
  );
});

it.each(["prepared", "destination"])(
  "recovery refuses a tampered %s file and keeps its receipt and obsolete outputs",
  async (target) => {
    const state = fixture();
    const installed = await killAfterFirstInstall(state);
    const receipt = NodeFS.readFileSync(state.pending);
    const ledger = NodeFS.readFileSync(state.record);
    let changed = NodePath.join(state.output, installed);
    if (target === "prepared") {
      const files = NodeFS.readdirSync(state.output, { recursive: true })
        .map((relative) => NodePath.join(state.output, String(relative)))
        .filter(
          (path) =>
            path.includes(`${NodePath.sep}.t3-build-publication-`) &&
            NodeFS.lstatSync(path).isFile(),
        );
      changed = files.find(
        (path) =>
          NodeFS.readFileSync(path, "utf8") ===
          nextEmission[installed === "a.js" ? "b.js" : "a.js"],
      )!;
      assert.isDefined(changed, "The uninstalled prepared emission must remain available");
    }
    NodeFS.writeFileSync(changed, "retained external edit");
    const recovering = start(state.cwd, "recover");
    const result = await recovering.next();
    assert.equal(result.kind, "failure");
    await recovering.exit;
    assert.deepEqual(NodeFS.readFileSync(state.pending), receipt);
    assert.deepEqual(NodeFS.readFileSync(state.record), ledger);
    assert.equal(NodeFS.readFileSync(changed, "utf8"), "retained external edit");
    assert.isTrue(NodeFS.existsSync(NodePath.join(state.output, "obsolete.js")));
    assert.throws(() => inspectGeneratedBuildOwnership(state.cwd, root), "pending recovery");
  },
);

it("prepares nested destinations beside their own parents before atomic replacement", async () => {
  const state = fixture();
  const files = {
    "nested/a.js": "nested first emission",
    "nested/deeper/b.js": "nested second emission",
  };
  const publishing = start(state.cwd, "publish", "none", files);
  assert.equal((await publishing.next()).kind, "success");
  await publishing.exit;
  assertValid(state.cwd, Object.keys(files));
  for (const [path, bytes] of Object.entries(files))
    assert.equal(NodeFS.readFileSync(NodePath.join(state.output, path), "utf8"), bytes);
  assert.equal(
    NodeFS.readFileSync(NodePath.join(state.output, "notes.txt"), "utf8"),
    "retained arbitrary note",
  );
  assert.equal(
    NodeFS.readFileSync(NodePath.join(state.output, "edited.js"), "utf8"),
    "retained user edit",
  );
  assert.isFalse(NodeFS.existsSync(state.pending));
});

it.each([true, false])(
  "recovery preserves an edit or addition at an uninstalled destination (prior ownership=%s)",
  async (seed) => {
    const state = fixture(seed);
    const installed = await killAfterFirstInstall(state);
    const uninstalled = installed === "a.js" ? "b.js" : "a.js";
    state.emit(state.output, uninstalled, "retained late destination change");
    const pending = NodeFS.readFileSync(state.pending);
    const ledger = seed ? NodeFS.readFileSync(state.record) : null;
    const recovering = start(state.cwd, "recover");
    const result = await recovering.next();
    assert.equal(result.kind, "failure");
    if (result.kind === "failure") assert.include(result.message, "destination changed");
    await recovering.exit;
    assert.equal(
      NodeFS.readFileSync(NodePath.join(state.output, uninstalled), "utf8"),
      "retained late destination change",
    );
    assert.deepEqual(NodeFS.readFileSync(state.pending), pending);
    if (ledger) assert.deepEqual(NodeFS.readFileSync(state.record), ledger);
    else assert.isFalse(NodeFS.existsSync(state.record));
    assert.equal(
      NodeFS.readFileSync(NodePath.join(state.output, "notes.txt"), "utf8"),
      "retained arbitrary note",
    );
  },
);
