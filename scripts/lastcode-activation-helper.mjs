#!/usr/bin/env node

// LastCode managed helper: one-owner crash-safe activation
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

export const LASTCODE_APP_BUNDLE_ID = "codes.lastobelus.lastcode";
export const LASTCODE_SERVER_LABEL = "codes.lastobelus.lastcode.server";
export const LASTCODE_ACTIVATION_STATES = [
  "prepared",
  "backup-ready",
  "trial",
  "committed",
  "rolled-back",
];

const REQUEST_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const DATABASE_FILES = ["state.sqlite", "state.sqlite-wal", "state.sqlite-shm"];
const STATE_SET = new Set(LASTCODE_ACTIVATION_STATES);
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 250;

export class SimulatedActivationCrash extends Error {
  constructor(point) {
    super(`Simulated activation crash at ${point}.`);
    this.name = "SimulatedActivationCrash";
    this.point = point;
  }
}

function fail(message, cause) {
  throw new Error(message, cause === undefined ? undefined : { cause });
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedAbsolute(path, label) {
  if (typeof path !== "string" || !NodePath.isAbsolute(path) || NodePath.resolve(path) !== path) {
    fail(`${label} must be an absolute normalized path.`);
  }
  if (NodePath.parse(path).root === path) fail(`${label} cannot be a filesystem root.`);
  return path;
}

function assertRequestId(value) {
  if (!REQUEST_ID.test(value ?? "")) fail("Activation requestId is invalid.");
  return value;
}

function assertDigest(value, label = "Activation target digest") {
  if (!SHA256.test(value ?? "")) fail(`${label} must be a lowercase SHA-256.`);
  return value;
}

function assertDirectory(path, label) {
  if (!NodeFS.statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
    fail(`${label} is missing or is not a directory.`);
  }
}

function assertFile(path, label) {
  if (!NodeFS.statSync(path, { throwIfNoEntry: false })?.isFile()) {
    fail(`${label} is missing or is not a file.`);
  }
}

function syncDirectory(path) {
  const descriptor = NodeFS.openSync(path, "r");
  try {
    NodeFS.fsyncSync(descriptor);
  } finally {
    NodeFS.closeSync(descriptor);
  }
}

function writeJsonDurably(path, value) {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${NodeCrypto.randomUUID()}`;
  const descriptor = NodeFS.openSync(temporary, "wx", 0o600);
  try {
    NodeFS.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    NodeFS.fsyncSync(descriptor);
  } finally {
    NodeFS.closeSync(descriptor);
  }
  NodeFS.renameSync(temporary, path);
  syncDirectory(NodePath.dirname(path));
}

function renameDurably(source, destination) {
  NodeFS.renameSync(source, destination);
  const sourceParent = NodePath.dirname(source);
  const destinationParent = NodePath.dirname(destination);
  syncDirectory(sourceParent);
  if (destinationParent !== sourceParent) syncDirectory(destinationParent);
}

function removeDurably(path, options = {}) {
  if (!NodeFS.existsSync(path)) return;
  NodeFS.rmSync(path, options);
  syncDirectory(NodePath.dirname(path));
}

function copyFileDurably(source, destination) {
  const temporary = `${destination}.tmp-${process.pid}-${NodeCrypto.randomUUID()}`;
  NodeFS.copyFileSync(source, temporary);
  const descriptor = NodeFS.openSync(temporary, "r");
  try {
    NodeFS.fsyncSync(descriptor);
  } finally {
    NodeFS.closeSync(descriptor);
  }
  NodeFS.renameSync(temporary, destination);
  syncDirectory(NodePath.dirname(destination));
}

export function deriveActivationPaths(input) {
  const homeDir = normalizedAbsolute(input.homeDir, "Activation home");
  const applicationsDir = normalizedAbsolute(
    input.applicationsDir ?? "/Applications",
    "Applications directory",
  );
  const requestId = assertRequestId(input.requestId);
  const baseDir = NodePath.join(homeDir, ".lastcode");
  const transactionDir = NodePath.join(baseDir, "runtime", "activation", requestId);
  const launchAgentsDir = NodePath.join(homeDir, "Library", "LaunchAgents");
  return {
    homeDir,
    applicationsDir,
    requestId,
    baseDir,
    transactionDir,
    journalPath: NodePath.join(transactionDir, "journal.json"),
    commitRecordPath: NodePath.join(transactionDir, "commit.json"),
    candidateAppPath: NodePath.join(transactionDir, "candidate", "LastCode.app"),
    candidatePlistPath: NodePath.join(
      transactionDir,
      "candidate",
      `${LASTCODE_SERVER_LABEL}.plist`,
    ),
    liveAppPath: NodePath.join(applicationsDir, "LastCode.app"),
    livePlistPath: NodePath.join(launchAgentsDir, `${LASTCODE_SERVER_LABEL}.plist`),
    previousAppPath: NodePath.join(transactionDir, "previous", "LastCode.app"),
    previousPlistPath: NodePath.join(transactionDir, "previous", `${LASTCODE_SERVER_LABEL}.plist`),
    databasePath: NodePath.join(baseDir, "userdata", "state.sqlite"),
    snapshotDir: NodePath.join(transactionDir, "database-snapshot"),
    snapshotSentinelPath: NodePath.join(transactionDir, "database-snapshot", "complete.json"),
    serverOwnerLockPath: NodePath.join(baseDir, "userdata", "server-owner.lock"),
  };
}

function samePaths(left, right) {
  return Object.keys(right).every((key) => left?.[key] === right[key]);
}

export function validateActivationJournal(value, expected = {}) {
  if (!isRecord(value) || value.schemaVersion !== 1) fail("Activation journal is invalid.");
  if (!STATE_SET.has(value.state)) fail("Activation journal state is invalid.");
  assertRequestId(value.requestId);
  assertDigest(value.targetDigest);
  if (!Number.isSafeInteger(value.uid) || value.uid <= 0) fail("Activation uid is invalid.");
  if (typeof value.attempted !== "boolean") fail("Activation attempt marker is invalid.");
  const paths = deriveActivationPaths({
    homeDir: value.homeDir,
    applicationsDir: value.applicationsDir,
    requestId: value.requestId,
  });
  if (!samePaths(value.paths, paths)) fail("Activation journal paths are not derived.");
  if (expected.journalPath !== undefined && expected.journalPath !== paths.journalPath) {
    fail("Activation journal path is not derived from its requestId.");
  }
  if (
    expected.applicationsDir !== undefined &&
    expected.applicationsDir !== paths.applicationsDir
  ) {
    fail("Activation journal uses an unexpected applications directory.");
  }
  if (value.state !== "prepared" && !value.attempted) {
    fail("Started activation journal is missing its attempt marker.");
  }
  return value;
}

export function makeActivationJournalStore(journalPath, expected = {}) {
  return {
    read() {
      let value;
      try {
        value = JSON.parse(NodeFS.readFileSync(journalPath, "utf8"));
      } catch (cause) {
        fail(`Could not read activation journal at ${journalPath}.`, cause);
      }
      return validateActivationJournal(value, { ...expected, journalPath });
    },
    write(value) {
      validateActivationJournal(value, { ...expected, journalPath });
      writeJsonDurably(journalPath, value);
    },
  };
}

function runProcess(command, args) {
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function processDetail(result) {
  return result.stderr.trim() || result.stdout.trim();
}

function launchAgentAbsent(result, uid) {
  if (result.code === 0) return false;
  const output = `${result.stdout}\n${result.stderr}`;
  return output.includes(
    `Could not find service "${LASTCODE_SERVER_LABEL}" in domain for user gui: ${uid}`,
  );
}

function bootoutAlreadyAbsent(result) {
  return result.code !== 0 && processDetail(result) === "Boot-out failed: 3: No such process";
}

function openOwnerLease(lockPath) {
  NodeFS.mkdirSync(NodePath.dirname(lockPath), { recursive: true });
  const flags =
    NodeFS.constants.O_CREAT |
    NodeFS.constants.O_RDWR |
    NodeFS.constants.O_NONBLOCK |
    0x20 |
    NodeFS.constants.O_NOFOLLOW;
  return NodeFS.openSync(lockPath, flags, 0o600);
}

function ownerLeaseState(lockPath) {
  try {
    const descriptor = openOwnerLease(lockPath);
    NodeFS.closeSync(descriptor);
    return "free";
  } catch (cause) {
    if (cause?.code === "EAGAIN" || cause?.code === "EWOULDBLOCK") return "held";
    fail("Could not inspect the LastCode server-owner lease.", cause);
  }
}

export function selectSupportedOwner(input) {
  if (input.desktopRunning && input.launchAgentLoaded) {
    fail(
      "Desktop and LaunchAgent owners are both present; activation requires one LaunchAgent owner.",
    );
  }
  if (input.desktopRunning) {
    fail("The desktop app owns this LastCode environment; remote activation is unsupported.");
  }
  if (!input.launchAgentLoaded && input.leaseHeld) {
    fail("An unknown process owns this LastCode environment; remote activation is unsupported.");
  }
  if (!input.launchAgentLoaded || !input.leaseHeld) {
    fail("No active LastCode LaunchAgent owner is available for activation.");
  }
  return LASTCODE_SERVER_LABEL;
}

function readPlistValue(path, key, run = runProcess) {
  const result = run("/usr/libexec/PlistBuddy", ["-c", `Print:${key}`, path]);
  if (result.code !== 0) fail(`Candidate service plist is missing ${key}.`);
  return result.stdout.trim();
}

export function validateTrialPlist(journal, readValue = readPlistValue) {
  const path = journal.paths.candidatePlistPath;
  const expected = [
    ["Label", LASTCODE_SERVER_LABEL],
    ["EnvironmentVariables:LASTCODE_ACTIVATION_MODE", "trial"],
    ["EnvironmentVariables:LASTCODE_ACTIVATION_REQUEST_ID", journal.requestId],
    ["EnvironmentVariables:LASTCODE_ACTIVATION_TARGET_DIGEST", journal.targetDigest],
  ];
  for (const [key, value] of expected) {
    if (readValue(path, key) !== value) fail(`Candidate service plist has the wrong ${key}.`);
  }
}

export function prepareActivationJournal(input, dependencies = {}) {
  const paths = deriveActivationPaths(input);
  const journal = {
    schemaVersion: 1,
    requestId: paths.requestId,
    targetDigest: assertDigest(input.targetDigest),
    uid: input.uid,
    homeDir: paths.homeDir,
    applicationsDir: paths.applicationsDir,
    state: "prepared",
    attempted: false,
    paths,
    updatedAt: new Date().toISOString(),
    rollbackReason: null,
  };
  validateActivationJournal(journal, {
    applicationsDir: input.expectedApplicationsDir ?? paths.applicationsDir,
  });
  assertDirectory(paths.candidateAppPath, "Prepared candidate app");
  assertFile(paths.candidatePlistPath, "Prepared candidate service plist");
  assertFile(paths.databasePath, "LastCode database");
  (dependencies.validateTrialPlist ?? validateTrialPlist)(journal);
  if (NodeFS.existsSync(paths.previousAppPath) || NodeFS.existsSync(paths.previousPlistPath)) {
    fail("Activation backup paths are already occupied.");
  }
  const store = makeActivationJournalStore(paths.journalPath, {
    applicationsDir: input.expectedApplicationsDir ?? paths.applicationsDir,
  });
  store.write(journal);
  return journal;
}

function defaultAssertSupportedOwner(journal) {
  const desktop = runProcess("osascript", [
    "-e",
    `application id "${LASTCODE_APP_BUNDLE_ID}" is running`,
  ]);
  if (desktop.code !== 0)
    fail(`Could not inspect the LastCode desktop app: ${processDetail(desktop)}`);
  const printed = runProcess("/bin/launchctl", [
    "print",
    `gui/${journal.uid}/${LASTCODE_SERVER_LABEL}`,
  ]);
  if (printed.code !== 0 && !launchAgentAbsent(printed, journal.uid)) {
    fail(`Could not inspect the LastCode LaunchAgent: ${processDetail(printed)}`);
  }
  selectSupportedOwner({
    desktopRunning: desktop.stdout.trim() === "true",
    launchAgentLoaded: printed.code === 0,
    leaseHeld: ownerLeaseState(journal.paths.serverOwnerLockPath) === "held",
  });
}

async function defaultStopService(journal, wait = NodeTimersPromises.setTimeout) {
  const service = `gui/${journal.uid}/${LASTCODE_SERVER_LABEL}`;
  const stopped = runProcess("/bin/launchctl", ["bootout", service]);
  if (stopped.code !== 0 && !bootoutAlreadyAbsent(stopped)) {
    fail(`Could not stop the LastCode LaunchAgent: ${processDetail(stopped)}`);
  }
  const deadline = Date.now() + 120_000;
  while (true) {
    const printed = runProcess("/bin/launchctl", ["print", service]);
    if (launchAgentAbsent(printed, journal.uid)) return;
    if (printed.code !== 0) fail(`Could not prove LaunchAgent shutdown: ${processDetail(printed)}`);
    if (Date.now() >= deadline) fail("Timed out waiting for the LastCode LaunchAgent to stop.");
    await wait(100);
  }
}

function defaultAcquireLease(journal) {
  let descriptor;
  try {
    descriptor = openOwnerLease(journal.paths.serverOwnerLockPath);
  } catch (cause) {
    fail("The LastCode server-owner lease did not become free after shutdown.", cause);
  }
  let released = false;
  return () => {
    if (released) return;
    NodeFS.closeSync(descriptor);
    released = true;
  };
}

function defaultStartService(journal) {
  const service = `gui/${journal.uid}/${LASTCODE_SERVER_LABEL}`;
  const printed = runProcess("/bin/launchctl", ["print", service]);
  if (printed.code === 0) return;
  if (!launchAgentAbsent(printed, journal.uid)) {
    fail(`Could not inspect the LastCode LaunchAgent: ${processDetail(printed)}`);
  }
  const result = runProcess("/bin/launchctl", [
    "bootstrap",
    `gui/${journal.uid}`,
    journal.paths.livePlistPath,
  ]);
  if (result.code !== 0) fail(`Could not start the LastCode LaunchAgent: ${processDetail(result)}`);
}

export function makeDefaultActivationExecutor() {
  return {
    assertSupportedOwner: defaultAssertSupportedOwner,
    stopService: defaultStopService,
    acquireLease: defaultAcquireLease,
    startCandidateTrial: defaultStartService,
    startPriorService: defaultStartService,
  };
}

function publishDatabaseSnapshot(journal) {
  const { paths } = journal;
  NodeFS.mkdirSync(paths.snapshotDir, { recursive: true, mode: 0o700 });
  const files = [];
  for (const name of DATABASE_FILES) {
    const source = NodePath.join(NodePath.dirname(paths.databasePath), name);
    const stat = NodeFS.statSync(source, { throwIfNoEntry: false });
    if (name === "state.sqlite" && !stat?.isFile())
      fail("LastCode database disappeared before snapshot.");
    if (stat === undefined) continue;
    if (!stat.isFile()) fail(`Database file ${name} is not a regular file.`);
    const destination = NodePath.join(paths.snapshotDir, name);
    NodeFS.copyFileSync(source, destination);
    files.push(name);
  }
  for (const name of files) {
    const descriptor = NodeFS.openSync(NodePath.join(paths.snapshotDir, name), "r");
    try {
      NodeFS.fsyncSync(descriptor);
    } finally {
      NodeFS.closeSync(descriptor);
    }
  }
  writeJsonDurably(paths.snapshotSentinelPath, { schemaVersion: 1, files });
  syncDirectory(paths.snapshotDir);
}

function readSnapshotFiles(journal) {
  const { paths } = journal;
  let sentinel;
  try {
    sentinel = JSON.parse(NodeFS.readFileSync(paths.snapshotSentinelPath, "utf8"));
  } catch {
    return null;
  }
  if (
    !isRecord(sentinel) ||
    sentinel.schemaVersion !== 1 ||
    !Array.isArray(sentinel.files) ||
    sentinel.files.some((name) => !DATABASE_FILES.includes(name)) ||
    new Set(sentinel.files).size !== sentinel.files.length ||
    sentinel.files[0] !== "state.sqlite"
  ) {
    fail("Database snapshot completion sentinel is invalid.");
  }
  for (const name of sentinel.files)
    assertFile(NodePath.join(paths.snapshotDir, name), `Snapshot ${name}`);
  return sentinel.files;
}

function restoreDatabase(journal) {
  const files = readSnapshotFiles(journal);
  if (files === null) return;
  const selected = new Set(files);
  for (const name of DATABASE_FILES) {
    const destination = NodePath.join(NodePath.dirname(journal.paths.databasePath), name);
    if (selected.has(name))
      copyFileDurably(NodePath.join(journal.paths.snapshotDir, name), destination);
    else removeDurably(destination, { force: true });
  }
}

function swapSelection(journal) {
  const { paths } = journal;
  NodeFS.mkdirSync(NodePath.dirname(paths.previousAppPath), { recursive: true, mode: 0o700 });
  assertDirectory(paths.liveAppPath, "Installed LastCode app");
  assertFile(paths.livePlistPath, "Installed LastCode service plist");
  renameDurably(paths.liveAppPath, paths.previousAppPath);
  renameDurably(paths.candidateAppPath, paths.liveAppPath);
  renameDurably(paths.livePlistPath, paths.previousPlistPath);
  renameDurably(paths.candidatePlistPath, paths.livePlistPath);
}

function restoreSelection(journal) {
  const { paths } = journal;
  if (NodeFS.existsSync(paths.previousAppPath)) {
    removeDurably(paths.liveAppPath, { force: true, recursive: true });
    renameDurably(paths.previousAppPath, paths.liveAppPath);
  }
  if (NodeFS.existsSync(paths.previousPlistPath)) {
    removeDurably(paths.livePlistPath, { force: true });
    renameDurably(paths.previousPlistPath, paths.livePlistPath);
  }
}

function finishCommittedSelection(journal) {
  removeDurably(journal.paths.previousAppPath, { force: true, recursive: true });
  removeDurably(journal.paths.previousPlistPath, { force: true });
}

export function readExactCommitRecord(journal) {
  const { commitRecordPath } = journal.paths;
  const stat = NodeFS.statSync(commitRecordPath, { throwIfNoEntry: false });
  if (stat === undefined) return null;
  if (!stat.isFile()) fail("Activation commit record is not a regular file.");
  let value;
  try {
    value = JSON.parse(NodeFS.readFileSync(commitRecordPath, "utf8"));
  } catch (cause) {
    fail("Activation commit record is not valid JSON.", cause);
  }
  const keys = Object.keys(value ?? {}).toSorted();
  if (
    !isRecord(value) ||
    JSON.stringify(keys) !==
      JSON.stringify(["requestId", "schemaVersion", "status", "targetDigest"]) ||
    value.schemaVersion !== 1 ||
    value.status !== "committed" ||
    value.requestId !== journal.requestId ||
    value.targetDigest !== journal.targetDigest
  ) {
    fail("Activation commit record does not exactly match the prepared request and target.");
  }
  return value;
}

async function awaitExactCommit(journal, input) {
  const now = input.now ?? Date.now;
  const wait = input.wait ?? NodeTimersPromises.setTimeout;
  const deadline = now() + (input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  while (true) {
    const record = readExactCommitRecord(journal);
    if (record !== null) return record;
    if (now() >= deadline) return null;
    await wait(input.pollMs ?? DEFAULT_POLL_MS);
  }
}

function transition(store, journal, state, changes = {}) {
  const next = {
    ...journal,
    ...changes,
    state,
    updatedAt: new Date().toISOString(),
  };
  store.write(next);
  return next;
}

async function rollBack(store, journal, executor, reason, hooks) {
  await executor.stopService(journal);
  const release = await executor.acquireLease(journal);
  let exactCommit = false;
  try {
    try {
      exactCommit = readExactCommitRecord(journal) !== null;
    } catch {
      exactCommit = false;
    }
    if (!exactCommit) {
      restoreDatabase(journal);
      restoreSelection(journal);
    }
  } finally {
    await release();
  }
  if (exactCommit) {
    await executor.startCandidateTrial(journal);
    return finishCommit(store, journal, hooks);
  }
  await executor.startPriorService(journal);
  return transition(store, journal, "rolled-back", { rollbackReason: reason });
}

async function finishCommit(store, journal, hooks) {
  const committed = transition(store, journal, "committed", { rollbackReason: null });
  await hooks?.afterCommitObserved?.(committed);
  finishCommittedSelection(committed);
  return committed;
}

async function recover(store, journal, executor, hooks) {
  if (journal.state === "committed") {
    finishCommittedSelection(journal);
    return journal;
  }
  if (journal.state === "rolled-back") return journal;
  let commit;
  try {
    commit = readExactCommitRecord(journal);
  } catch (cause) {
    return rollBack(
      store,
      journal,
      executor,
      cause instanceof Error ? cause.message : String(cause),
      hooks,
    );
  }
  if (commit !== null) {
    await executor.startCandidateTrial(journal);
    return finishCommit(store, journal, hooks);
  }
  return rollBack(
    store,
    journal,
    executor,
    "Helper restarted without an exact durable commit.",
    hooks,
  );
}

async function executePrepared(store, journal, executor, input) {
  assertDirectory(journal.paths.candidateAppPath, "Prepared candidate app");
  assertFile(journal.paths.candidatePlistPath, "Prepared candidate service plist");
  assertDirectory(journal.paths.liveAppPath, "Installed LastCode app");
  assertFile(journal.paths.livePlistPath, "Installed LastCode service plist");
  if (NodeFS.existsSync(journal.paths.commitRecordPath)) {
    fail("Activation commit path is already occupied before shutdown.");
  }
  (input.validateTrialPlist ?? validateTrialPlist)(journal);
  await executor.assertSupportedOwner(journal);
  let current = transition(store, journal, "prepared", { attempted: true });
  try {
    await executor.stopService(current);
    const release = await executor.acquireLease(current);
    try {
      publishDatabaseSnapshot(current);
      current = transition(store, current, "backup-ready");
      swapSelection(current);
      await input.hooks?.afterSwap?.(current);
    } finally {
      await release();
    }
    await executor.startCandidateTrial(current);
    current = transition(store, current, "trial");
    const commit = await awaitExactCommit(current, input);
    if (commit === null) fail("Timed out waiting for the exact activation commit record.");
    return await finishCommit(store, current, input.hooks);
  } catch (cause) {
    if (cause instanceof SimulatedActivationCrash) throw cause;
    const durable = store.read();
    let exactCommit = false;
    try {
      exactCommit = readExactCommitRecord(durable) !== null;
    } catch {
      exactCommit = false;
    }
    if (durable.state === "committed" || exactCommit) throw cause;
    return rollBack(
      store,
      durable,
      executor,
      cause instanceof Error ? cause.message : String(cause),
      input.hooks,
    );
  }
}

export async function runActivationTransaction(input) {
  const store =
    input.store ??
    makeActivationJournalStore(input.journalPath, {
      applicationsDir: input.expectedApplicationsDir ?? "/Applications",
    });
  const journal = store.read();
  const executor = input.executor ?? makeDefaultActivationExecutor();
  if (journal.state !== "prepared" || journal.attempted) {
    return recover(store, journal, executor, input.hooks);
  }
  return executePrepared(store, journal, executor, input);
}

async function main(argv) {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone recovery helper has no Effect runtime.
  if (process.platform !== "darwin") fail("LastCode activation is supported only on macOS.");
  if (argv.length !== 1 || !NodePath.isAbsolute(argv[0]))
    fail("Expected one absolute journal path.");
  const result = await runActivationTransaction({ journalPath: argv[0] });
  process.stdout.write(`${JSON.stringify({ requestId: result.requestId, state: result.state })}\n`);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((cause) => {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    process.stderr.write(`[lastcode-activation-helper] ${error.message}\n`);
    process.exitCode = 1;
  });
}
