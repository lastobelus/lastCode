// @effect-diagnostics nodeBuiltinImport:off
// LastCode managed module: packaged server supervisor

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const LASTCODE_PACKAGED_SERVER_SUPERVISOR_FILE =
  "lastcode-packaged-server-supervisor.mjs" as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const validatedSupervisor = Symbol("LastCodeValidatedPackagedServerSupervisor");

export type ValidatedPackagedServerSupervisor = {
  readonly [validatedSupervisor]: true;
  readonly path: string;
  readonly sha256: string;
};

function hashFile(path: string): string {
  const hash = NodeCrypto.createHash("sha256");
  const descriptor = NodeFS.openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytesRead = NodeFS.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    NodeFS.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function supervisorPath(runtimeRoot: string, sha256: string): string {
  return NodePath.join(
    runtimeRoot,
    "supervisors",
    sha256,
    LASTCODE_PACKAGED_SERVER_SUPERVISOR_FILE,
  );
}

export function validatePackagedServerSupervisor(input: {
  readonly runtimeRoot: string;
  readonly sha256: string;
}): ValidatedPackagedServerSupervisor {
  if (!SHA256_PATTERN.test(input.sha256)) {
    throw new Error("LastCode packaged server supervisor checksum is invalid.");
  }
  const path = supervisorPath(input.runtimeRoot, input.sha256);
  if (!NodeFS.statSync(path, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`LastCode packaged server supervisor is missing at ${path}.`);
  }
  if ((NodeFS.statSync(path).mode & 0o222) !== 0) {
    throw new Error("LastCode packaged server supervisor must be read-only.");
  }
  if ((NodeFS.statSync(NodePath.dirname(path)).mode & 0o222) !== 0) {
    throw new Error("LastCode packaged server supervisor directory must be read-only.");
  }
  if (hashFile(path) !== input.sha256) {
    throw new Error("LastCode packaged server supervisor checksum does not match its path.");
  }
  return { [validatedSupervisor]: true, path, sha256: input.sha256 };
}

/**
 * Publishes the LastCode-owned preflight supervisor outside every versioned
 * candidate. A service manager can run it with an independently managed Node
 * executable before any candidate Electron binary is allowed to execute.
 */
export function preparePackagedServerSupervisor(input: {
  readonly runtimeRoot: string;
  readonly sourcePath?: string;
}): ValidatedPackagedServerSupervisor {
  const sourcePath =
    input.sourcePath ??
    NodePath.join(import.meta.dirname, "..", LASTCODE_PACKAGED_SERVER_SUPERVISOR_FILE);
  const sha256 = hashFile(sourcePath);
  const path = supervisorPath(input.runtimeRoot, sha256);
  const supervisorDir = NodePath.dirname(path);
  if (NodeFS.existsSync(supervisorDir)) {
    return validatePackagedServerSupervisor({ runtimeRoot: input.runtimeRoot, sha256 });
  }

  const supervisorsDir = NodePath.dirname(supervisorDir);
  NodeFS.mkdirSync(supervisorsDir, { recursive: true, mode: 0o700 });
  const stagingDir = NodeFS.mkdtempSync(NodePath.join(supervisorsDir, ".staging-"));
  try {
    const stagingPath = NodePath.join(stagingDir, LASTCODE_PACKAGED_SERVER_SUPERVISOR_FILE);
    NodeFS.copyFileSync(sourcePath, stagingPath);
    NodeFS.chmodSync(stagingPath, 0o400);
    const fileDescriptor = NodeFS.openSync(stagingPath, "r");
    try {
      NodeFS.fsyncSync(fileDescriptor);
    } finally {
      NodeFS.closeSync(fileDescriptor);
    }
    const stagingDescriptor = NodeFS.openSync(stagingDir, "r");
    try {
      NodeFS.fsyncSync(stagingDescriptor);
    } finally {
      NodeFS.closeSync(stagingDescriptor);
    }
    NodeFS.renameSync(stagingDir, supervisorDir);
    NodeFS.chmodSync(supervisorDir, 0o500);
    const supervisorsDescriptor = NodeFS.openSync(supervisorsDir, "r");
    try {
      NodeFS.fsyncSync(supervisorsDescriptor);
    } finally {
      NodeFS.closeSync(supervisorsDescriptor);
    }
  } catch (cause) {
    if (NodeFS.existsSync(stagingDir)) {
      NodeFS.chmodSync(stagingDir, 0o700);
      const stagingPath = NodePath.join(stagingDir, LASTCODE_PACKAGED_SERVER_SUPERVISOR_FILE);
      if (NodeFS.existsSync(stagingPath)) NodeFS.chmodSync(stagingPath, 0o600);
    }
    NodeFS.rmSync(stagingDir, { recursive: true, force: true });
    throw cause;
  }
  return validatePackagedServerSupervisor({ runtimeRoot: input.runtimeRoot, sha256 });
}
