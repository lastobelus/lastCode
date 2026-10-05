// @effect-diagnostics nodeBuiltinImport:off -- Host-side admission requires atomic local filesystem operations.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import { acquirePortableLock, PortableLockContentionError } from "../lastcode-lock.mjs";
import {
  getCurrentProcessStartIdentity,
  isProcessIdentityRunning,
  readProcessIdentities,
} from "./lastcode-ci-process-identity.ts";

const LOCK_DIRECTORY = "admission.lock.d";
const OWNER_FILENAME = /^owner-([\da-f-]+)\.json$/u;

type AdmissionLockOptions = {
  /** Exercises directory locking on hosts that normally use the kernel lock. */
  readonly forceDirectoryLock?: boolean;
  /** Test synchronization before any ownership has been published. */
  readonly onCandidatePrepared?: () => Promise<void>;
  /** Test synchronization after observing an exited owner, before reclaiming it. */
  readonly onStaleOwnerObserved?: () => Promise<void>;
};

function hasErrorCode(error: unknown, code: string) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function readOwner(lockPath: string) {
  let files: string[];
  try {
    files = NodeFS.readdirSync(lockPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
  if (files.length === 0) return undefined;
  const filename = files[0]!;
  const token = OWNER_FILENAME.exec(filename)?.[1];
  if (files.length !== 1 || token === undefined) {
    throw new Error("Invalid local CI admission owner. Admission has stopped.");
  }
  let content: string;
  try {
    content = NodeFS.readFileSync(NodePath.join(lockPath, filename), "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw new Error("Unable to read the local CI admission owner. Admission has stopped.", {
      cause: error,
    });
  }
  let owner: unknown;
  try {
    owner = JSON.parse(content);
  } catch {
    throw new Error("Invalid local CI admission owner JSON. Admission has stopped.");
  }
  if (
    typeof owner !== "object" ||
    owner === null ||
    !("pid" in owner) ||
    typeof owner.pid !== "number" ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    !("startIdentity" in owner) ||
    typeof owner.startIdentity !== "string" ||
    owner.startIdentity.length === 0 ||
    !("token" in owner) ||
    owner.token !== token
  ) {
    throw new Error("Invalid local CI admission owner. Admission has stopped.");
  }
  return { pid: owner.pid, startIdentity: owner.startIdentity, filename };
}

function removeEmptyDirectory(path: string) {
  try {
    NodeFS.rmdirSync(path);
  } catch (error) {
    // A fresh owner may have replaced the empty directory after the old unique
    // record was removed. Never remove a directory containing that new owner.
    if (
      hasErrorCode(error, "ENOENT") ||
      hasErrorCode(error, "ENOTEMPTY") ||
      hasErrorCode(error, "EEXIST")
    )
      return;
    throw error;
  }
}

function removeOwner(lockPath: string, filename: string) {
  try {
    NodeFS.unlinkSync(NodePath.join(lockPath, filename));
  } catch (error) {
    // Another reclaimer can have removed this owner and published a fresh one.
    // Its filename is different, so this operation cannot remove its metadata.
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }
  removeEmptyDirectory(lockPath);
}

/**
 * Acquires the brief admission mutex. Directory locking publishes a complete
 * unique ownership record atomically and reclaims only an exited owner's file.
 */
export async function acquireLocalCiAdmissionLock(
  directory: string,
  options: AdmissionLockOptions = {},
): Promise<() => void> {
  if (NodeProcess.platform === "darwin" && !options.forceDirectoryLock) {
    return acquirePortableLock(directory, "admission.lock", "CI admission");
  }

  NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const token = NodeCrypto.randomUUID();
  const filename = `owner-${token}.json`;
  const candidatePath = NodePath.join(
    directory,
    `.admission-candidate-${NodeProcess.pid}-${token}`,
  );
  const lockPath = NodePath.join(directory, LOCK_DIRECTORY);
  NodeFS.mkdirSync(candidatePath, { mode: 0o700 });
  try {
    NodeFS.writeFileSync(
      NodePath.join(candidatePath, filename),
      `${JSON.stringify({ pid: NodeProcess.pid, startIdentity: getCurrentProcessStartIdentity(), token })}\n`,
      { mode: 0o600 },
    );
    if (options.onCandidatePrepared !== undefined) await options.onCandidatePrepared();

    const publish = () => {
      try {
        NodeFS.renameSync(candidatePath, lockPath);
        return true;
      } catch (error) {
        if (hasErrorCode(error, "EEXIST") || hasErrorCode(error, "ENOTEMPTY")) return false;
        // Windows reports EPERM when renaming over an existing directory.
        if (
          NodeProcess.platform === "win32" &&
          hasErrorCode(error, "EPERM") &&
          NodeFS.existsSync(lockPath)
        )
          return false;
        throw error;
      }
    };
    if (!publish()) {
      const owner = readOwner(lockPath);
      if (owner === undefined) {
        removeEmptyDirectory(lockPath);
      } else if (
        !isProcessIdentityRunning(
          owner.pid,
          owner.startIdentity,
          readProcessIdentities([owner.pid]),
        )
      ) {
        if (options.onStaleOwnerObserved !== undefined) await options.onStaleOwnerObserved();
        removeOwner(lockPath, owner.filename);
      } else {
        throw new PortableLockContentionError("Another local CI run is updating admission.");
      }
      if (!publish())
        throw new PortableLockContentionError("Another local CI run is updating admission.");
    }
    let released = false;
    return () => {
      if (released) return;
      removeOwner(lockPath, filename);
      released = true;
    };
  } finally {
    // This is always our private candidate path, never the published lock path.
    // If the process crashes before publication, its orphan candidate is ignored.
    NodeFS.rmSync(candidatePath, { force: true, recursive: true });
  }
}
