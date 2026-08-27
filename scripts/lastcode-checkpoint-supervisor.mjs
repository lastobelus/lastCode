#!/usr/bin/env node

// Standalone launchd supervisor for the LastCode checkpoint job. This file is
// copied outside the automation checkout so it can report checkout/setup
// failures as well as failures from the checkpoint command itself.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const CHECKPOINT_ARGS = [
  "scripts/lastcode-checkpoint.ts",
  "--push-tags",
  "--promote-if-no-open-prs",
  "--mirror-upstream-main",
];
const DIAGNOSTIC_MAX_CHARACTERS = 1_200;

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Could not parse ${label}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function readJson(path, label) {
  try {
    return parseJson(NodeFS.readFileSync(path, "utf8"), label);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
}

function writeJsonAtomic(path, value) {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp`;
  NodeFS.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  NodeFS.renameSync(temporaryPath, path);
}

export function supervisorPaths(home = NodeOS.homedir()) {
  const rootDirectory = NodePath.join(home, ".lastcode", "automation");
  return {
    configPath: NodePath.join(rootDirectory, "checkpoint-supervisor.json"),
    runHistoryPath: NodePath.join(rootDirectory, "checkpoint-runs.jsonl"),
    statePath: NodePath.join(rootDirectory, "checkpoint-service-state.json"),
    threadToolPath: NodePath.join(home, ".lastcode", "userdata", "bin", "lastcode-thread"),
  };
}

export function checkpointEnvironment(
  source = process.env,
  home = NodeOS.homedir(),
  nodePath = process.execPath,
) {
  const environment = {
    HOME: home,
    PATH: `${NodePath.dirname(nodePath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
  };
  for (const name of ["LANG", "LC_ALL", "LOGNAME", "SHELL", "SSH_AUTH_SOCK", "TMPDIR", "USER"]) {
    const value = source[name];
    if (value) environment[name] = value;
  }
  return environment;
}

class CommandFailure extends Error {
  constructor(phase, command, status, diagnostic) {
    super(`${command} failed with exit code ${status ?? "unknown"}.`);
    this.diagnostic = diagnostic;
    this.phase = phase;
    this.status = status;
  }
}

export function boundedCommandDiagnostic(raw) {
  const redacted = NodeUtil.stripVTControlCharacters(raw)
    .replaceAll(/(https?:\/\/)[^/@\s]+@/giu, "$1<redacted>@")
    .replaceAll(/\b(?:github_pat_|gh[pousr]_|ctx7sk-|sk-)[A-Za-z0-9_-]{8,}\b/gu, "<redacted>")
    .replaceAll(/\b((?:api[_-]?key|password|secret|token)\s*[=:]\s*)\S+/giu, "$1<redacted>")
    .split("")
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (code < 32 && character !== "\n" && character !== "\r" && character !== "\t") ||
        code === 127
        ? " "
        : character;
    })
    .join("")
    .trim();
  return redacted.length > DIAGNOSTIC_MAX_CHARACTERS
    ? `...${redacted.slice(-DIAGNOSTIC_MAX_CHARACTERS)}`
    : redacted;
}

function runCommand(phase, cwd, command, args, environment, options = {}) {
  if (options.capture) {
    const result = NodeChildProcess.spawnSync(command, args, {
      cwd,
      encoding: "utf8",
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new CommandFailure(
        phase,
        command,
        result.status,
        boundedCommandDiagnostic(result.stderr),
      );
    }
    return result.stdout.trim();
  }

  const temporaryDirectory = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "lastcode-checkpoint-command-"),
  );
  const stderrPath = NodePath.join(temporaryDirectory, "stderr.log");
  let stderrDescriptor;
  try {
    stderrDescriptor = NodeFS.openSync(stderrPath, "w", 0o600);
    const result = NodeChildProcess.spawnSync(command, args, {
      cwd,
      env: environment,
      stdio: ["ignore", "inherit", stderrDescriptor],
    });
    NodeFS.closeSync(stderrDescriptor);
    stderrDescriptor = undefined;
    const stderr = NodeFS.readFileSync(stderrPath, "utf8");
    if (stderr) process.stderr.write(stderr);
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new CommandFailure(phase, command, result.status, boundedCommandDiagnostic(stderr));
    }
    return "";
  } finally {
    if (stderrDescriptor !== undefined) NodeFS.closeSync(stderrDescriptor);
    NodeFS.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

export function latestFailedCheckpointRun(path) {
  try {
    const lines = NodeFS.readFileSync(path, "utf8").trim().split(/\r?\n/u);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line) continue;
      let record;
      try {
        record = parseJson(line, "checkpoint run history");
      } catch {
        console.error(
          "[lastcode:checkpoint-supervisor] Ignoring an incomplete checkpoint history record.",
        );
        continue;
      }
      if (!record || typeof record !== "object" || Array.isArray(record)) continue;
      if (record.status === "failed") return record;
      if (record.status === "success") return null;
    }
    return null;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
}

export function refreshInstalledSupervisor(repoRoot, installedPath) {
  const sourcePath = NodePath.join(repoRoot, "scripts", "lastcode-checkpoint-supervisor.mjs");
  if (NodePath.resolve(sourcePath) === NodePath.resolve(installedPath)) return;
  if (!NodeFS.existsSync(sourcePath)) return;
  const source = NodeFS.readFileSync(sourcePath);
  const installed = NodeFS.existsSync(installedPath) ? NodeFS.readFileSync(installedPath) : null;
  if (installed?.equals(source)) return;
  const temporaryPath = `${installedPath}.tmp`;
  NodeFS.writeFileSync(temporaryPath, source, { mode: 0o700 });
  NodeFS.renameSync(temporaryPath, installedPath);
}

export function checkpointIncidentFingerprint(failure) {
  return NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify({
        error: failure.error,
        checkpointError: failure.checkpointRun?.error ?? null,
        diagnostic: failure.diagnostic ?? null,
        failurePhase: failure.checkpointRun?.failurePhase ?? null,
        phase: failure.phase,
        recoveryBranch: failure.checkpointRun?.recoveryBranch ?? null,
        upstreamTag: failure.checkpointRun?.upstreamTag ?? null,
      }),
    )
    .digest("hex");
}

export function checkpointFailureMessage(failure, fingerprint) {
  const nightly = failure.checkpointRun?.upstreamTag
    ? ` for ${failure.checkpointRun.upstreamTag}`
    : "";
  const recovery = failure.checkpointRun?.recoveryBranch
    ? ` Recovery branch: ${failure.checkpointRun.recoveryBranch}.`
    : "";
  const diagnostic = failure.diagnostic ? `Diagnostic: ${failure.diagnostic}` : null;
  return [
    `Automated LastCode checkpoint maintenance alert ${fingerprint.slice(0, 12)}.`,
    `The hourly service failed during ${failure.phase}${nightly}.${recovery}`,
    diagnostic,
    "Run lastcode-checkpoints --verbose, inspect the live daemon and retained recovery state, and address the concrete problem.",
    "The bounded service logs are ~/.lastcode/automation/nightly-checkpoint.stdout.log and nightly-checkpoint.stderr.log.",
    "Use this thread for the recovery; do not create a new maintenance thread and do not only report the alert.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function checkpointResolvedMessage(incident) {
  const nightly = incident.failure.checkpointRun?.upstreamTag
    ? ` through ${incident.failure.checkpointRun.upstreamTag}`
    : "";
  return `Automated LastCode checkpoint maintenance resolved alert ${incident.fingerprint.slice(0, 12)}${nightly}. The hourly service completed successfully again.`;
}

function sendThread(threadToolPath, threadId, message, environment) {
  runCommand(
    "alert-delivery",
    NodePath.dirname(threadToolPath),
    threadToolPath,
    ["send", threadId, "--message", message, "--json"],
    environment,
    { capture: true },
  );
}

function notify(title, message, environment) {
  const result = NodeChildProcess.spawnSync(
    "osascript",
    [
      "-e",
      "on run argv",
      "-e",
      "display notification (item 2 of argv) with title (item 1 of argv)",
      "-e",
      "end run",
      title,
      message,
    ],
    { env: environment, stdio: "inherit" },
  );
  return result.status === 0;
}

function attemptDelivery(state, config, dependencies) {
  const incident = state.incident;
  if (!incident || !config?.recoveryThreadId) return state;
  const resolving = state.status === "success";
  const key = resolving ? "resolutionDelivery" : "alertDelivery";
  if (incident[key] === "sent" || incident[key] === "not-needed") return state;
  const message = resolving
    ? checkpointResolvedMessage(incident)
    : checkpointFailureMessage(incident.failure, incident.fingerprint);
  const nextIncident = {
    ...incident,
    [key]: "pending",
    deliveryAttempts: (incident.deliveryAttempts ?? 0) + 1,
    lastDeliveryAttemptAt: dependencies.now(),
  };
  let nextState = { ...state, incident: nextIncident };
  dependencies.writeState(nextState);
  try {
    dependencies.sendThread(config.recoveryThreadId, message);
    nextState = { ...nextState, incident: { ...nextIncident, [key]: "sent" } };
    dependencies.writeState(nextState);
  } catch (error) {
    console.error(
      `[lastcode:checkpoint-supervisor] Could not deliver ${resolving ? "resolution" : "alert"} to the maintenance thread: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return nextState;
}

export function runCheckpointSupervisor(options = {}, overrides = {}) {
  const home = options.home ?? NodeOS.homedir();
  const repoRoot = options.repoRoot ?? process.cwd();
  const paths = supervisorPaths(home);
  const environment = checkpointEnvironment(options.environment ?? process.env, home);
  const installedSupervisorPath = NodeURL.fileURLToPath(import.meta.url);
  const dependencies = {
    latestFailedCheckpointRun: () => latestFailedCheckpointRun(paths.runHistoryPath),
    loadConfig: () => readJson(paths.configPath, "checkpoint supervisor config"),
    loadState: () => readJson(paths.statePath, "checkpoint supervisor state"),
    now: () => new Date().toISOString(),
    notify: (title, message) => notify(title, message, environment),
    refreshSupervisor: () => refreshInstalledSupervisor(repoRoot, installedSupervisorPath),
    runPhase: (phase, command, args) => runCommand(phase, repoRoot, command, args, environment),
    sendThread: (threadId, message) =>
      sendThread(paths.threadToolPath, threadId, message, environment),
    writeState: (state) => writeJsonAtomic(paths.statePath, state),
    ...overrides,
  };
  const startedAt = dependencies.now();
  let previous = null;
  let config = null;
  let preflightError = null;
  let phase = "supervisor-state";
  try {
    previous = dependencies.loadState();
  } catch (error) {
    preflightError = error;
  }
  try {
    config = dependencies.loadConfig();
  } catch (error) {
    if (!preflightError) {
      preflightError = error;
      phase = "supervisor-config";
    }
  }
  try {
    if (preflightError) throw preflightError;
    phase = "fetch";
    dependencies.runPhase("fetch", "git", [
      "fetch",
      "origin",
      "+refs/heads/lastcode/main:refs/remotes/origin/lastcode/main",
    ]);
    phase = "checkout";
    dependencies.runPhase("checkout", "git", [
      "checkout",
      "--detach",
      "--force",
      "refs/remotes/origin/lastcode/main",
    ]);
    phase = "supervisor-refresh";
    dependencies.refreshSupervisor();
    phase = "dependencies";
    dependencies.runPhase("dependencies", "./node_modules/.bin/vp", [
      "install",
      "--frozen-lockfile",
    ]);
    phase = "checkpoint";
    dependencies.runPhase("checkpoint", process.execPath, CHECKPOINT_ARGS);
  } catch (error) {
    const finishedAt = dependencies.now();
    let checkpointRun = null;
    if (phase === "checkpoint") {
      try {
        checkpointRun = dependencies.latestFailedCheckpointRun();
      } catch (historyError) {
        console.error(
          `[lastcode:checkpoint-supervisor] Could not enrich the incident from checkpoint history: ${historyError instanceof Error ? historyError.message : String(historyError)}`,
        );
      }
    }
    const failure = {
      checkpointRun,
      ...(error instanceof CommandFailure && error.diagnostic
        ? { diagnostic: error.diagnostic }
        : {}),
      error: error instanceof Error ? error.message : String(error),
      phase: error instanceof CommandFailure ? error.phase : phase,
    };
    const fingerprint = checkpointIncidentFingerprint(failure);
    const sameOpenIncident =
      previous?.status === "failed" && previous.incident?.fingerprint === fingerprint;
    const incident = sameOpenIncident
      ? previous.incident
      : {
          alertDelivery: "pending",
          deliveryAttempts: 0,
          failure,
          fingerprint,
          openedAt: finishedAt,
        };
    let state = {
      schemaVersion: 1,
      status: "failed",
      phase: failure.phase,
      startedAt,
      finishedAt,
      ...(previous?.lastSuccessAt ? { lastSuccessAt: previous.lastSuccessAt } : {}),
      incident,
    };
    dependencies.writeState(state);
    state = attemptDelivery(state, config, dependencies);
    if (!sameOpenIncident) {
      const delivered = state.incident.alertDelivery === "sent";
      dependencies.notify(
        "LastCode checkpoint automation needs attention",
        delivered
          ? `${failure.phase} failed; the maintenance thread was notified.`
          : `${failure.phase} failed; thread delivery is pending. Run lastcode-checkpoints --verbose.`,
      );
    }
    throw error;
  }

  const finishedAt = dependencies.now();
  let incident = previous?.incident;
  if (previous?.status === "failed" && incident) {
    incident = {
      ...incident,
      resolvedAt: finishedAt,
      resolutionDelivery: incident.alertDelivery === "sent" ? "pending" : "not-needed",
    };
  }
  let state = {
    schemaVersion: 1,
    status: "success",
    phase: "complete",
    startedAt,
    finishedAt,
    lastSuccessAt: finishedAt,
    ...(incident ? { incident } : {}),
  };
  dependencies.writeState(state);
  state = attemptDelivery(state, config, dependencies);
  return state;
}

if (import.meta.main) {
  if (process.argv.length !== 3 || process.argv[2] !== "run") {
    console.error("Usage: lastcode-checkpoint-supervisor.mjs run");
    process.exitCode = 64;
  } else {
    try {
      runCheckpointSupervisor();
    } catch (error) {
      console.error(
        `[lastcode:checkpoint-supervisor] ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    }
  }
}
