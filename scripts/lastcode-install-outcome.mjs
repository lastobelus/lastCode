// LastCode managed companion: lastcode-install-outcome

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const INSTALL_OUTCOME_MANAGED_MARKER =
  "LastCode managed companion: lastcode-install-outcome";

const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const identityPattern = /^\d+:\d+$/u;
const phases = ["pending", "failed-before-swap", "backend-failed", "healthy"];

export function bundleIdentity(path) {
  const stat = NodeFS.lstatSync(path, { bigint: true, throwIfNoEntry: false });
  return stat?.isDirectory() ? `${stat.dev}:${stat.ino}` : null;
}

export function syncDirectory(path) {
  const fd = NodeFS.openSync(path, "r");
  try {
    NodeFS.fsyncSync(fd);
  } finally {
    NodeFS.closeSync(fd);
  }
}

function writeRecord(path, value) {
  const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    NodeFS.writeFileSync(temporary, `${JSON.stringify(value)}\n`, {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    NodeFS.renameSync(temporary, path);
    syncDirectory(NodePath.dirname(path));
  } finally {
    NodeFS.rmSync(temporary, { force: true });
  }
}

function outcomeDirectory(updateDirectory) {
  return NodePath.join(updateDirectory, "install-outcomes");
}

function readOutcomes(updateDirectory, targetPath) {
  const directory = outcomeDirectory(updateDirectory);
  let entries;
  try {
    entries = NodeFS.readdirSync(directory);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .flatMap((entry) => {
      if (!entry.endsWith(".json")) return [];
      const id = entry.slice(0, -5);
      if (!idPattern.test(id)) return [];
      const path = NodePath.join(directory, entry);
      const record = JSON.parse(NodeFS.readFileSync(path, "utf8"));
      if (
        record?.schemaVersion !== 1 ||
        record.id !== id ||
        record.targetPath !== targetPath ||
        typeof record.version !== "string" ||
        typeof record.stateDir !== "string" ||
        !Number.isSafeInteger(record.startedAt) ||
        !Number.isSafeInteger(record.installerPid) ||
        !identityPattern.test(record.replacement) ||
        (record.previous !== null && !identityPattern.test(record.previous)) ||
        !Array.isArray(record.priorBackups) ||
        !record.priorBackups.every(
          (backup) => idPattern.test(backup?.id) && identityPattern.test(backup?.identity),
        ) ||
        !phases.includes(record.phase)
      )
        return [];
      return [{ path, record }];
    })
    .toSorted((left, right) => right.record.startedAt - left.record.startedAt);
}

export function retainedBundlePath(targetPath, id) {
  return NodePath.join(NodePath.dirname(targetPath), `.LastCode.retained-${id}.app`);
}

export function beginInstallOutcome(updateDirectory, prepared) {
  const { targetPath, staging, version } = prepared;
  const replacement = bundleIdentity(staging);
  if (replacement === null) throw new Error("The staged app is missing.");
  const previous = bundleIdentity(targetPath);
  if (previous === null && NodeFS.lstatSync(targetPath, { throwIfNoEntry: false })) {
    throw new Error("The installed app is not a bundle directory.");
  }
  const directory = outcomeDirectory(updateDirectory);
  NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
  syncDirectory(updateDirectory);
  const id = NodeCrypto.randomUUID();
  const stateDir = NodePath.join(prepared.t3Home, "userdata");
  const priorBackups = readOutcomes(updateDirectory, targetPath).flatMap(({ record }) =>
    record.stateDir === stateDir &&
    record.previous !== null &&
    bundleIdentity(retainedBundlePath(targetPath, record.id)) === record.previous
      ? [{ id: record.id, identity: record.previous }]
      : [],
  );
  const path = NodePath.join(directory, `${id}.json`);
  const record = {
    schemaVersion: 1,
    id,
    targetPath,
    version,
    stateDir,
    startedAt: Date.now(),
    installerPid: process.pid,
    replacement,
    previous,
    priorBackups,
    phase: "pending",
  };
  writeRecord(path, record);
  return { path, record };
}

export function markInstallFailure(outcome, error, replacementPublished) {
  const detail = error instanceof Error ? error.message : String(error);
  if (replacementPublished) {
    // The desktop may already have confirmed readiness while open was still returning.
    writeRecord(`${outcome.path}.launch-error`, { detail });
  } else {
    writeRecord(outcome.path, { ...outcome.record, phase: "failed-before-swap", detail });
  }
}

export function recoverRecordedSwap(updateDirectory, targetPath) {
  const outcomes = readOutcomes(updateDirectory, targetPath);
  if (outcomes.length === 0) return;
  if (NodeFS.existsSync(targetPath)) return null;
  for (const outcome of outcomes) {
    const { record } = outcome;
    const staging = NodePath.join(
      NodePath.dirname(targetPath),
      `.LastCode.install-${record.installerPid}.app`,
    );
    const beforePublication =
      record.phase === "failed-before-swap" ||
      (record.phase === "pending" && bundleIdentity(staging) === record.replacement);
    if (!beforePublication) return record.replacement;
    // A retry with no app at the target leaves the previous install's evidence in force.
    if (record.previous === null) continue;
    const backup = retainedBundlePath(targetPath, record.id);
    if (bundleIdentity(backup) !== record.previous) return record.previous;
    markInstallFailure(outcome, new Error("Interrupted before publishing the replacement."), false);
    NodeFS.renameSync(backup, targetPath);
    syncDirectory(NodePath.dirname(targetPath));
    console.log(`Restored ${targetPath} left aside by an interrupted install.`);
    try {
      if (bundleIdentity(staging) === record.replacement)
        NodeFS.rmSync(staging, { force: true, recursive: true });
    } catch (error) {
      console.error(
        `Warning: could not remove the interrupted install's staged app: ${error.message}`,
      );
    }
    return null;
  }
  // With recorded history, an unknown identity is insufficient for automatic restoration.
  return null;
}

export function readDesktopInstallOutcome(updateDirectory, targetPath, version, stateDir) {
  const identity = bundleIdentity(targetPath);
  if (identity === null) return null;
  const outcomes = readOutcomes(updateDirectory, targetPath).filter(
    ({ record }) => record.stateDir === stateDir,
  );
  const replacement = outcomes.find(
    ({ record }) =>
      record.replacement === identity &&
      record.version === version &&
      record.phase !== "failed-before-swap",
  );
  const outcome = replacement ?? outcomes.find(({ record }) => record.previous === identity);
  if (!outcome) return null;
  const launchFailed = NodeFS.existsSync(`${outcome.path}.launch-error`);
  const status =
    outcome.record.phase === "pending" && launchFailed ? "launch-failed" : outcome.record.phase;
  return { ...outcome, status, matchesReplacement: replacement !== undefined };
}

export async function recordReplacementBackend(outcome, ready) {
  if (!outcome.matchesReplacement) return;
  const record = JSON.parse(NodeFS.readFileSync(outcome.path, "utf8"));
  if (
    record.id !== outcome.record.id ||
    record.phase === "failed-before-swap" ||
    bundleIdentity(record.targetPath) !== record.replacement
  )
    return;
  if (record.phase !== "healthy") {
    const phase = ready ? "healthy" : "backend-failed";
    if (record.phase !== phase) writeRecord(outcome.path, { ...record, phase });
  }
  if (!ready) return;
  const backups =
    record.previous === null
      ? record.priorBackups
      : [...record.priorBackups, { id: record.id, identity: record.previous }];
  for (const { id, identity } of backups) {
    const path = retainedBundlePath(record.targetPath, id);
    if (bundleIdentity(path) === identity)
      await NodeFS.promises.rm(path, { recursive: true, force: true });
  }
}
