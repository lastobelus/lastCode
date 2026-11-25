// @effect-diagnostics nodeBuiltinImport:off -- This isolated fixture verifies physical filesystem behavior under Node and Electron.
import * as NodeAssert from "node:assert";
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "../HostProcess.ts";
import { createWorktreeSuspensionStore } from "../worktreeSuspension.ts";

// Setup and assertions must inspect the physical file, even inside Electron.
const fs: typeof NodeFS = process.versions.electron
  ? NodeModule.createRequire(import.meta.url)("original-fs")
  : NodeFS;
const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

// Chromium pickle header, with one file and its raw payload.
const payload = Buffer.from("archive payload\n");
const json = Buffer.from(
  JSON.stringify({ files: { "inside.txt": { size: payload.length, offset: "0" } } }),
);
const paddedLength = (json.length + 3) & ~3;
const header = Buffer.alloc(16 + paddedLength);
header.writeUInt32LE(4, 0);
header.writeUInt32LE(8 + paddedLength, 4);
header.writeUInt32LE(4 + paddedLength, 8);
header.writeUInt32LE(json.length, 12);
json.copy(header, 16);
const archive = Buffer.concat([header, payload]);
const root = fs.realpathSync(fs.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "suspension-asar-")));
const repository = NodePath.join(root, "repository");
const workspace = NodePath.join(root, "workspace");
const assertNoArchiveDescriptor = () => {
  if (HostProcess.Platform.defaultValue() !== "darwin") return;
  const result = NodeChildProcess.execFileSync(
    "/usr/sbin/lsof",
    ["-n", "-P", "-p", String(process.pid)],
    {
      encoding: "utf8",
    },
  );
  NodeAssert.strict(
    !result.includes(NodePath.join(root, "workspace", "archive.asar")),
    "archive descriptor was retained",
  );
};
try {
  fs.mkdirSync(repository);
  git(repository, "init", "--initial-branch=main");
  git(repository, "config", "user.email", "fixture@example.invalid");
  git(repository, "config", "user.name", "Fixture");
  fs.writeFileSync(NodePath.join(repository, "tracked"), "base\n");
  fs.writeFileSync(NodePath.join(repository, ".gitignore"), "ignored\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "fixture");
  git(repository, "worktree", "add", "-b", "task", workspace, "HEAD");
  fs.writeFileSync(NodePath.join(workspace, "tracked"), "staged\n");
  git(workspace, "add", "tracked");
  fs.writeFileSync(NodePath.join(workspace, "tracked"), "dirty\n");
  fs.writeFileSync(NodePath.join(workspace, "ignored"), "ignored content\n");
  fs.writeFileSync(NodePath.join(workspace, "archive.asar"), archive);
  fs.mkdirSync(NodePath.join(workspace, "directory.asar"));
  fs.writeFileSync(NodePath.join(workspace, "directory.asar", "file"), "directory content\n");
  const store = createWorktreeSuspensionStore({ storeRoot: NodePath.join(root, "saved") });
  const snapshot = await store.capture({
    sourcePath: workspace,
    snapshotId: "asar",
    operationId: "operation",
    ownerBinding: "fixture",
  });
  assertNoArchiveDescriptor();
  await store.trialRestore(snapshot.id);
  await store.isolate(snapshot.id, { quarantineParent: NodePath.join(root, "quarantine") });
  await store.removeIsolated(snapshot.id);
  await store.restore(snapshot.id, { destinationPath: workspace });
  await store.verifyRestored(snapshot.id);
  NodeAssert.strict(fs.lstatSync(NodePath.join(workspace, "archive.asar")).isFile());
  NodeAssert.strict.deepEqual(fs.readFileSync(NodePath.join(workspace, "archive.asar")), archive);
  NodeAssert.strict(fs.lstatSync(NodePath.join(workspace, "directory.asar")).isDirectory());
  NodeAssert.strict.equal(
    fs.readFileSync(NodePath.join(workspace, "directory.asar", "file"), "utf8"),
    "directory content\n",
  );
  NodeAssert.strict.equal(fs.readFileSync(NodePath.join(workspace, "tracked"), "utf8"), "dirty\n");
  NodeAssert.strict.equal(git(workspace, "show", ":tracked"), "staged");
  NodeAssert.strict.equal(
    fs.readFileSync(NodePath.join(workspace, "ignored"), "utf8"),
    "ignored content\n",
  );
  assertNoArchiveDescriptor();
  if (process.versions.electron) {
    const control = NodePath.join(root, "control.asar");
    fs.writeFileSync(control, archive);
    NodeAssert.strict.equal(
      NodeFS.readFileSync(NodePath.join(control, "inside.txt"), "utf8"),
      payload.toString(),
    );
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
