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

function acquireDirectoryLock(lockDirectory, lockName, activity) {
  const lockPath = NodePath.join(lockDirectory, `${lockName}.d`);
  const ownerPath = NodePath.join(lockPath, "owner.json");
  const owner = {
    schemaVersion: 2,
    pid: NodeProcess.pid,
    token: NodeCrypto.randomUUID(),
    startedAt: new Date().toISOString(),
  };

  const tryAcquire = (mayRecoverStaleOwner) => {
    try {
      NodeFS.mkdirSync(lockPath);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existingOwner = readLockOwner(ownerPath);
      if (
        mayRecoverStaleOwner &&
        existingOwner !== undefined &&
        !isProcessRunning(existingOwner.pid)
      ) {
        const stalePath = `${lockPath}.stale-${NodeProcess.pid}-${NodeCrypto.randomUUID()}`;
        try {
          NodeFS.renameSync(lockPath, stalePath);
        } catch (renameError) {
          if (renameError?.code === "ENOENT") return tryAcquire(false);
          throw renameError;
        }
        NodeFS.rmSync(stalePath, { force: true, recursive: true });
        return tryAcquire(false);
      }
      throw new PortableLockContentionError(
        `Another LastCode ${activity} is already running (PID ${existingOwner?.pid ?? "unknown"}, started ${existingOwner?.startedAt ?? "at an unknown time"}).`,
        { cause: error },
      );
    }

    try {
      NodeFS.writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
    } catch (error) {
      NodeFS.rmSync(lockPath, { force: true, recursive: true });
      throw error;
    }
  };

  tryAcquire(true);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const currentOwner = readLockOwner(ownerPath);
    if (currentOwner?.token !== owner.token) return;
    NodeFS.rmSync(lockPath, { force: true, recursive: true });
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
