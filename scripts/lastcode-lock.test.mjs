import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  acquireDirectoryLock,
  acquirePortableLock,
  PortableLockContentionError,
  replaceDeadRecord,
} from "./lastcode-lock.mjs";

const temporaryDirectories = [];
// oxlint-disable-next-line t3code/no-global-process-runtime -- This regression exercises Darwin's O_EXLOCK behavior.
const itMacOnly = it.runIf(process.platform === "darwin");

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-lock-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function exitedPid() {
  return NodeChildProcess.spawnSync(process.execPath, ["--eval", ""]).pid;
}

function spawnLockHolder(root) {
  const moduleUrl = new NodeURL.URL("./lastcode-lock.mjs", import.meta.url).href;
  const source = [
    `import { acquirePortableLock } from ${JSON.stringify(moduleUrl)};`,
    `acquirePortableLock(${JSON.stringify(root)}, "update.lock", "test");`,
    'process.stdout.write("locked\\n");',
    "setInterval(() => {}, 1_000);",
  ].join("\n");
  return NodeChildProcess.spawn(process.execPath, ["--input-type=module", "--eval", source], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("LastCode portable update lock", () => {
  it("rejects a concurrent owner and recovers when that owner dies", async () => {
    const root = temporaryDirectory();
    const holder = spawnLockHolder(root);
    await NodeEvents.once(holder.stdout, "data");

    expect(() => acquirePortableLock(root, "update.lock", "test")).toThrow(
      PortableLockContentionError,
    );

    // This is the exact child spawned above, not a process located by pattern.
    holder.kill();
    await NodeEvents.once(holder, "exit");

    const release = acquirePortableLock(root, "update.lock", "test");
    release();
  });

  it("lets only one contender recover a dead owner's directory lock", () => {
    const root = temporaryDirectory();
    const lockPath = NodePath.join(root, "update.lock.d");
    const ownerPath = NodePath.join(lockPath, "owner.json");
    const staleOwner = { schemaVersion: 2, pid: exitedPid(), token: "stale-owner" };
    NodeFS.mkdirSync(lockPath);
    NodeFS.writeFileSync(ownerPath, JSON.stringify(staleOwner));

    const release = acquireDirectoryLock(root, "update.lock", "test");
    const recoveredOwner = NodeFS.readFileSync(ownerPath, "utf8");
    // A contender that read the dead owner before the recovery must not take the lock.
    expect(
      replaceDeadRecord(ownerPath, staleOwner, { pid: process.pid, token: "late-contender" }),
    ).toBe(false);
    expect(NodeFS.readFileSync(ownerPath, "utf8")).toBe(recoveredOwner);
    expect(NodeFS.readdirSync(lockPath)).toEqual(["owner.json"]);
    expect(() => acquireDirectoryLock(root, "update.lock", "test")).toThrow(
      PortableLockContentionError,
    );

    release();
    expect(NodeFS.existsSync(ownerPath)).toBe(false);
    acquireDirectoryLock(root, "update.lock", "test")();
  });

  it("keeps a live claimant's claim and replaces a dead claimant's", () => {
    const root = temporaryDirectory();
    const lockPath = NodePath.join(root, "update.lock.d");
    const ownerPath = NodePath.join(lockPath, "owner.json");
    NodeFS.mkdirSync(lockPath);
    NodeFS.writeFileSync(ownerPath, JSON.stringify({ pid: exitedPid(), token: "stale-owner" }));
    const claimPath = `${ownerPath}.stale-owner`;

    // A claimant suspended mid-recovery is still alive, so nobody may take over its claim.
    NodeFS.writeFileSync(claimPath, JSON.stringify({ pid: process.pid, token: "suspended" }));
    expect(() => acquireDirectoryLock(root, "update.lock", "test")).toThrow(
      PortableLockContentionError,
    );

    NodeFS.writeFileSync(claimPath, JSON.stringify({ pid: exitedPid(), token: "crashed" }));
    acquireDirectoryLock(root, "update.lock", "test")();
    expect(NodeFS.readdirSync(lockPath)).toEqual([]);
  });

  itMacOnly("does not classify lock-file permission failures as contention", () => {
    const root = temporaryDirectory();
    const lockPath = NodePath.join(root, "update.lock");
    NodeFS.writeFileSync(lockPath, "");
    NodeFS.chmodSync(lockPath, 0o000);

    let failure;
    try {
      acquirePortableLock(root, "update.lock", "test");
    } catch (error) {
      failure = error;
    } finally {
      NodeFS.chmodSync(lockPath, 0o600);
    }

    expect(failure).toMatchObject({ code: "EACCES" });
    expect(failure).not.toBeInstanceOf(PortableLockContentionError);
  });
});
