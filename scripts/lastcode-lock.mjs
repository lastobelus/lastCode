// LastCode managed companion: lastcode-lock
//
// Keep this dependency-free: `lastcode-install` copies it beside its standalone
// installed entrypoint, and the local update helper runs before dependencies for
// a newer checkpoint are installed.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

export const LOCK_MODULE_MANAGED_MARKER = "LastCode managed companion: lastcode-lock";
// Darwin's <fcntl.h> O_EXLOCK. Node exposes the other open(2) flags but not this one.
export const DARWIN_O_EXLOCK = 0x20;

export class PortableLockContentionError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "PortableLockContentionError";
  }
}

function readLockOwner(lockPath) {
  try {
    const owner = JSON.parse(NodeFS.readFileSync(lockPath, "utf8"));
    if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) return undefined;
    return owner;
  } catch {
    return undefined;
  }
}

function isProcessRunning(pid) {
  try {
    NodeProcess.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

// A record names one live process. It appears complete or not at all: it is linked from a
// finished temporary file, and linking never replaces an existing record.
function writeRecordExclusively(recordPath, record) {
  const temporaryPath = `${recordPath}.${record.token}.tmp`;
  NodeFS.writeFileSync(temporaryPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  try {
    NodeFS.linkSync(temporaryPath, recordPath);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  } finally {
    NodeFS.rmSync(temporaryPath, { force: true });
  }
}

function takeRecord(recordPath, record) {
  if (writeRecordExclusively(recordPath, record)) return true;
  const holder = readLockOwner(recordPath);
  // A record that vanished was just released; an unreadable one is never treated as dead.
  if (holder === undefined) {
    return !NodeFS.existsSync(recordPath) && writeRecordExclusively(recordPath, record);
  }
  return !isProcessRunning(holder.pid) && replaceDeadRecord(recordPath, holder, record);
}

/**
 * Replaces a dead holder's record. Only the contender holding that holder's own claim record may
 * remove it, and a claim is itself a record, so a claimant that dies is replaced the same way while
 * a merely suspended one keeps its claim.
 */
export function replaceDeadRecord(recordPath, deadHolder, record) {
  const claimPath = `${recordPath}.${deadHolder.token ?? "untokened"}`;
  if (!takeRecord(claimPath, record)) return false;
  try {
    if (readLockOwner(recordPath)?.token === deadHolder.token) {
      NodeFS.rmSync(recordPath, { force: true });
    }
  } finally {
    NodeFS.rmSync(claimPath, { force: true });
  }
  return writeRecordExclusively(recordPath, record);
}

export function acquireDirectoryLock(lockDirectory, lockName, activity) {
  const lockPath = NodePath.join(lockDirectory, `${lockName}.d`);
  const ownerPath = NodePath.join(lockPath, "owner.json");
  const owner = {
    schemaVersion: 2,
    pid: NodeProcess.pid,
    token: NodeCrypto.randomUUID(),
    startedAt: new Date().toISOString(),
  };

  // The directory only holds records; releasing leaves it in place, so it never vanishes mid-acquire.
  NodeFS.mkdirSync(lockPath, { recursive: true });
  if (!takeRecord(ownerPath, owner)) {
    const existingOwner = readLockOwner(ownerPath);
    throw new PortableLockContentionError(
      `Another LastCode ${activity} is already running (PID ${existingOwner?.pid ?? "unknown"}, started ${existingOwner?.startedAt ?? "at an unknown time"}).`,
    );
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (readLockOwner(ownerPath)?.token !== owner.token) return;
    NodeFS.rmSync(ownerPath, { force: true });
  };
}

/**
 * Acquires a process-local filesystem lock without external commands. Darwin
 * uses a kernel-owned lock; other platforms use an atomic lock directory and
 * reclaim it only after its recorded process has exited.
 */
export function acquirePortableLock(lockDirectory, lockName, activity) {
  NodeFS.mkdirSync(lockDirectory, { recursive: true });
  if (NodeProcess.platform !== "darwin") {
    return acquireDirectoryLock(lockDirectory, lockName, activity);
  }
  const pid = NodeProcess.pid;
  const lockPath = NodePath.join(lockDirectory, lockName);

  const owner = {
    schemaVersion: 2,
    pid,
    startedAt: new Date().toISOString(),
  };
  // Darwin open(2): O_EXLOCK (0x20) obtains an advisory exclusive flock lock;
  // O_NONBLOCK makes contention immediately report EAGAIN instead of waiting.
  const flags =
    NodeFS.constants.O_CREAT |
    NodeFS.constants.O_RDWR |
    NodeFS.constants.O_NONBLOCK |
    DARWIN_O_EXLOCK;
  let descriptor;
  try {
    descriptor = NodeFS.openSync(lockPath, flags, 0o600);
  } catch (error) {
    if (error?.code === "EAGAIN") {
      const existingOwner = readLockOwner(lockPath);
      throw new PortableLockContentionError(
        `Another LastCode ${activity} is already running (PID ${existingOwner?.pid ?? "unknown"}, started ${existingOwner?.startedAt ?? "at an unknown time"}).`,
        { cause: error },
      );
    }
    throw error;
  }
  try {
    NodeFS.ftruncateSync(descriptor, 0);
    NodeFS.writeSync(descriptor, `${JSON.stringify(owner)}\n`);
    NodeFS.fsyncSync(descriptor);
  } catch (error) {
    NodeFS.closeSync(descriptor);
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    NodeFS.closeSync(descriptor);
    released = true;
  };
}
