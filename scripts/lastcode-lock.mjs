// LastCode managed companion: lastcode-lock
//
// Keep this dependency-free: `lastcode-install` copies it beside its standalone
// installed entrypoint, and the local update helper runs before dependencies for
// a newer checkpoint are installed.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const LOCK_MODULE_MANAGED_MARKER = "LastCode managed companion: lastcode-lock";
// Darwin's <fcntl.h> O_EXLOCK. Node exposes the other open(2) flags but not this one.
export const DARWIN_O_EXLOCK = 0x20;

function readLockOwner(lockPath) {
  try {
    const owner = JSON.parse(NodeFS.readFileSync(lockPath, "utf8"));
    if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) return undefined;
    return owner;
  } catch {
    return undefined;
  }
}

/**
 * Acquires a macOS-local lock which the kernel releases when this process exits.
 * Node does not expose Darwin's O_EXLOCK constant, so keep its documented value
 * here rather than relying on an external lock command or a PID-file protocol.
 */
export function acquirePortableLock(lockDirectory, lockName, activity) {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone installed scripts have no Effect runtime.
  if (process.platform !== "darwin") {
    throw new Error(`LastCode ${activity} locking is only available on macOS.`);
  }
  const pid = process.pid;
  const lockPath = NodePath.join(lockDirectory, lockName);
  NodeFS.mkdirSync(lockDirectory, { recursive: true });

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
    if (error?.code === "EAGAIN" || error?.code === "EACCES") {
      const existingOwner = readLockOwner(lockPath);
      throw new Error(
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
