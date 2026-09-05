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
  "--supersede-failed-recovery",
];
const DIAGNOSTIC_MAX_CHARACTERS = 1_200;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

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

export function selectPrimaryWorktree(worktreeList) {
  const primaryWorktree = worktreeList
    .split(/\r?\n/u)
    .find((line) => line.startsWith("worktree "))
    ?.slice("worktree ".length);
  if (!primaryWorktree) {
    throw new Error("Could not resolve the repository's primary worktree.");
  }
  return primaryWorktree;
}

export function changedGitlink(rawDiff) {
  const fields = rawDiff.split("\0");
  for (let index = 0; index < fields.length;) {
    const metadata = fields[index++];
    if (!metadata) continue;
    const match = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/u.exec(metadata);
    if (!match) throw new Error(`Primary checkout reported invalid raw diff '${metadata}'.`);
    const sourcePath = fields[index++];
    if (!sourcePath) throw new Error("Primary checkout reported a raw diff without a path.");
    const destinationPath = match[3] === "R" || match[3] === "C" ? fields[index++] : sourcePath;
    if (!destinationPath)
      throw new Error("Primary checkout reported a renamed diff without a path.");
    if (match[1] === "160000" || match[2] === "160000") return sourcePath;
  }
  return null;
}

function assertPrimaryCheckoutReady(primaryWorktree, environment, execute) {
  const branch = execute(
    "checkout-refresh",
    primaryWorktree,
    "git",
    ["branch", "--show-current"],
    environment,
    { capture: true },
  );
  if (branch !== "lastcode/main") {
    throw new Error(
      `Primary LastCode checkout must be on lastcode/main; found '${branch || "detached HEAD"}'.`,
    );
  }
  const status = execute(
    "checkout-refresh",
    primaryWorktree,
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    environment,
    { capture: true },
  );
  if (status) throw new Error("Primary LastCode checkout has uncommitted or untracked changes.");
}

export function refreshPrimaryCheckout(repoRoot, environment, execute = runCommand) {
  const worktreeList = execute(
    "checkout-refresh",
    repoRoot,
    "git",
    ["worktree", "list", "--porcelain"],
    environment,
    { capture: true },
  );
  const primaryWorktree = selectPrimaryWorktree(worktreeList);
  assertPrimaryCheckoutReady(primaryWorktree, environment, execute);
  const previousCommit = execute(
    "checkout-refresh",
    primaryWorktree,
    "git",
    ["rev-parse", "HEAD"],
    environment,
    { capture: true },
  );
  execute(
    "checkout-refresh",
    primaryWorktree,
    "git",
    ["fetch", "--no-tags", "origin", "+refs/heads/lastcode/main:refs/remotes/origin/lastcode/main"],
    environment,
  );
  assertPrimaryCheckoutReady(primaryWorktree, environment, execute);
  const verifiedCommit = execute(
    "checkout-refresh",
    primaryWorktree,
    "git",
    ["rev-parse", "HEAD"],
    environment,
    { capture: true },
  );
  if (verifiedCommit !== previousCommit) {
    throw new Error("Primary LastCode checkout changed while its remote was being refreshed.");
  }
  const promotedCommit = execute(
    "checkout-refresh",
    primaryWorktree,
    "git",
    ["rev-parse", "refs/remotes/origin/lastcode/main"],
    environment,
    { capture: true },
  );
  const installDependencies = () =>
    execute(
      "checkout-dependencies",
      primaryWorktree,
      NodePath.join(repoRoot, "node_modules", ".bin", "vp"),
      ["install", "--frozen-lockfile"],
      environment,
    );
  if (previousCommit === promotedCommit) {
    installDependencies();
    return primaryWorktree;
  }
  const rawDiff = execute(
    "checkout-refresh",
    primaryWorktree,
    "git",
    ["diff-tree", "-r", "--no-commit-id", "--raw", "-z", previousCommit, promotedCommit],
    environment,
    { capture: true, maxBuffer: GIT_MAX_BUFFER },
  );
  const gitlink = changedGitlink(rawDiff);
  if (gitlink) {
    throw new Error(`Primary LastCode checkout target changes submodule gitlink '${gitlink}'.`);
  }
  execute(
    "checkout-refresh",
    primaryWorktree,
    "git",
    ["update-ref", `refs/lastcode/primary-checkout-backups/${previousCommit}`, previousCommit],
    environment,
  );
  execute(
    "checkout-refresh",
    repoRoot,
    process.execPath,
    [
      NodePath.join(repoRoot, "scripts", "lastcode-primary-checkout-transaction.mjs"),
      primaryWorktree,
      previousCommit,
      promotedCommit,
    ],
    environment,
  );
  assertPrimaryCheckoutReady(primaryWorktree, environment, execute);
  const refreshedCommit = execute(
    "checkout-refresh",
    primaryWorktree,
    "git",
    ["rev-parse", "HEAD"],
    environment,
    { capture: true },
  );
  if (refreshedCommit !== promotedCommit) {
    throw new Error("Primary LastCode checkout did not reach the promoted commit.");
  }
  installDependencies();
  return primaryWorktree;
}

export function projectActionTrustAllowlist(config) {
  const trustedProjectActionIds = config?.trustedProjectActionIds ?? [];
  if (
    !Array.isArray(trustedProjectActionIds) ||
    trustedProjectActionIds.some(
      (value) => typeof value !== "string" || !/^lc-[a-z0-9-]+$/u.test(value),
    )
  ) {
    throw new Error("Checkpoint supervisor Project Action trust entries are invalid.");
  }
  return [...new Set(trustedProjectActionIds)].toSorted();
}

export function reconcilePrimaryProjectActions(
  primaryWorktree,
  home,
  trustedProjectActionIds,
  environment,
  execute = runCommand,
) {
  return execute(
    "project-actions",
    primaryWorktree,
    process.execPath,
    [
      NodePath.join(primaryWorktree, "scripts", "lastcode-project-actions.mjs"),
      "reconcile",
      "--repo-root",
      primaryWorktree,
      "--base-dir",
      NodePath.join(home, ".lastcode"),
      ...trustedProjectActionIds.flatMap((id) => ["--trusted-source-id", id]),
    ],
    environment,
  );
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
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
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

function sameCheckpointRun(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function retainedRecoveryMatches(repoRoot, checkpointRun, environment) {
  if (!checkpointRun?.recoveryBranch) return false;
  const worktree = NodePath.join(NodePath.dirname(repoRoot), "lastcode-nightly-sync");
  if (!NodeFS.existsSync(worktree)) return false;
  try {
    return (
      runCommand(
        "history-correlation",
        repoRoot,
        "git",
        ["-C", worktree, "branch", "--show-current"],
        environment,
        { capture: true },
      ) === checkpointRun.recoveryBranch
    );
  } catch {
    return false;
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
    `The checkpoint service failed during ${failure.phase}${nightly}.${recovery}`,
    diagnostic,
    "Run lastcode-checkpoints --verbose, inspect the live daemon and retained recovery state, and address the concrete problem.",
    "The bounded service logs are ~/.lastcode/automation/nightly-checkpoint.stdout.log and nightly-checkpoint.stderr.log.",
    "Use this thread for the recovery; do not create a new maintenance thread and do not only report the alert.",
    "For an already-started service run, use the resumable Wait for Checkpoint action as described in docs/lastcode/release.md instead of sleep/status loops. It only observes completion and does not start or repair the service.",
    "If an authorized recovery requires a local Apple Silicon build, follow the Resumable local builds section in docs/lastcode/release.md and use Build Local Package (lc-build-local-package), then end the turn instead of polling build logs. A pending prior Action continuation must be delivered before starting another Action.",
    "If the authorized recovery includes a LastCode PR, read .agents/skills/lastcode-pr/SKILL.md. When CI or review is passive and no current finding needs judgement, call list_project_actions, launch the eligible Wait for PR action with run_project_action_and_resume (prefer lc-wait-for-pr), and end the turn immediately without polling. This reminder does not authorize creating or merging a PR.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function checkpointResolvedMessage(incident) {
  const nightly = incident.failure.checkpointRun?.upstreamTag
    ? ` through ${incident.failure.checkpointRun.upstreamTag}`
    : "";
  return `Automated LastCode checkpoint maintenance resolved alert ${incident.fingerprint.slice(0, 12)}${nightly}. The checkpoint service completed successfully again.`;
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

function isDurableIncident(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.fingerprint === "string" &&
    value.fingerprint.length > 0 &&
    value.failure !== null &&
    typeof value.failure === "object" &&
    !Array.isArray(value.failure)
  );
}

function durableIncident(value) {
  return isDurableIncident(value) ? value : null;
}

function durableIncidentList(state, key) {
  return Array.isArray(state?.[key]) ? state[key].filter(isDurableIncident) : [];
}

function retryableIncident(incident) {
  return (
    !incident.resolvedAt &&
    (incident.alertDelivery === "pending" ||
      incident.alertDelivery === "unknown" ||
      incident.alertDelivery === "rejected")
  );
}

function attemptedIncident(incident) {
  return (
    incident.alertDelivery === "sent" ||
    incident.alertDelivery === "unknown" ||
    (incident.deliveryAttempts ?? 0) > 0
  );
}

function potentiallyDeliveredIncident(incident) {
  return (
    attemptedIncident(incident) &&
    typeof (incident.deliveryThreadId ?? incident.attemptedThreadId) === "string" &&
    (incident.deliveryThreadId ?? incident.attemptedThreadId).length > 0
  );
}

function deliveryThreadId(incident) {
  return incident.deliveryThreadId ?? incident.attemptedThreadId;
}

function rejectedThreadSend(error, target) {
  // spawnSync reports these only when the child could not be launched. Other
  // spawn errors (notably timeout/buffer limits) may follow a successful send.
  if (
    error &&
    typeof error === "object" &&
    ["ENOENT", "EACCES", "ENOTDIR", "E2BIG"].includes(error.code) &&
    typeof error.syscall === "string" &&
    error.syscall.startsWith("spawnSync ")
  ) {
    return true;
  }
  if (
    !error ||
    typeof error !== "object" ||
    error.phase !== "alert-delivery" ||
    typeof error.diagnostic !== "string"
  ) {
    return false;
  }
  // The generated shell wrapper exits before the CLI starts when exec fails.
  if (
    [126, 127].includes(error.status) &&
    /(?:^|\n)[^\n]*: (?:exec:|line \d+:)[^\n]*(?:not found|No such file or directory|Permission denied|cannot execute)[^\n]*$/imu.test(
      error.diagnostic,
    )
  ) {
    return true;
  }
  // These diagnostics originate before runThreadSend calls dispatch. Keep
  // dispatch failures out: a timeout there does not prove non-delivery.
  if (
    /(?:^|[\s:])Failed to issue session token\./u.test(error.diagnostic) ||
    /(?:^|[\s:])The owning LastCode server is not available; thread send has no offline fallback\./u.test(
      error.diagnostic,
    ) ||
    /(?:^|[\s:])LastCode thread (?:live send target lookup|send command id generation|send message id generation) failed\./u.test(
      error.diagnostic,
    )
  ) {
    return true;
  }
  const escapedTarget = target.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  // ThreadSendTargetError defines these messages before dispatch. The runtime
  // formatter need not include the error class name.
  return new RegExp(
    `(?:^|[\\s:])(?:LastCode thread '${escapedTarget}' was not found\\.|LastCode thread prefix '${escapedTarget}' is ambiguous:)`,
    "u",
  ).test(error.diagnostic);
}

function recordRejectedAttempt(incident) {
  const { attemptedThreadId: _attemptedThreadId, ...rest } = incident;
  return {
    ...rest,
    alertDelivery: rest.deliveryThreadId ? "unknown" : "rejected",
  };
}

function attemptDelivery(state, config, dependencies) {
  if (!config?.recoveryThreadId) return state;
  const recoveryThreadId = config.recoveryThreadId;
  let nextState = state;
  let pendingIncidents = [...durableIncidentList(state, "pendingIncidents")];
  while (nextState.status === "failed") {
    const pendingIncidentIndex = pendingIncidents.findIndex(retryableIncident);
    if (pendingIncidentIndex < 0) break;
    const incident = pendingIncidents[pendingIncidentIndex];
    const targetThreadId = deliveryThreadId(incident) ?? recoveryThreadId;
    const updatedIncident = {
      ...incident,
      // A failed command may have reached LastCode after it wrote the message.
      // Keep that uncertainty and its recipient durable for recovery.
      alertDelivery: "unknown",
      ...((incident.deliveryThreadId ?? incident.attemptedThreadId)
        ? { deliveryThreadId: incident.deliveryThreadId ?? incident.attemptedThreadId }
        : {}),
      attemptedThreadId: targetThreadId,
      deliveryAttempts: (incident.deliveryAttempts ?? 0) + 1,
      lastDeliveryAttemptAt: dependencies.now(),
    };
    pendingIncidents[pendingIncidentIndex] = updatedIncident;
    nextState = Object.assign({}, nextState, {
      pendingIncidents,
    });
    dependencies.writeState(nextState);
    try {
      dependencies.sendThread(
        targetThreadId,
        checkpointFailureMessage(updatedIncident.failure, updatedIncident.fingerprint),
      );
      pendingIncidents.splice(pendingIncidentIndex, 1);
      const currentIncident = nextState.incident;
      const deliveredIncident = {
        ...updatedIncident,
        alertDelivery: "sent",
        deliveryThreadId: deliveryThreadId(updatedIncident),
        attemptedThreadId: undefined,
      };
      const pendingResolutions = [...durableIncidentList(nextState, "pendingResolutions")];
      if (currentIncident?.fingerprint !== updatedIncident.fingerprint) {
        const pendingResolutionIndex = pendingResolutions.findIndex(
          (pendingIncident) => pendingIncident.fingerprint === updatedIncident.fingerprint,
        );
        if (pendingResolutionIndex >= 0) {
          pendingResolutions[pendingResolutionIndex] = {
            ...pendingResolutions[pendingResolutionIndex],
            ...deliveredIncident,
          };
        } else {
          pendingResolutions.push(deliveredIncident);
        }
      }
      nextState = Object.assign(
        {},
        nextState,
        pendingIncidents.length > 0 ? { pendingIncidents } : { pendingIncidents: undefined },
        pendingResolutions.length > 0 ? { pendingResolutions } : {},
        currentIncident?.fingerprint === updatedIncident.fingerprint
          ? {
              incident: { ...currentIncident, ...deliveredIncident },
            }
          : {},
      );
      dependencies.writeState(nextState);
    } catch (error) {
      if (rejectedThreadSend(error, targetThreadId)) {
        pendingIncidents[pendingIncidentIndex] = recordRejectedAttempt(updatedIncident);
        nextState = { ...nextState, pendingIncidents };
        dependencies.writeState(nextState);
      } else {
        pendingIncidents[pendingIncidentIndex] = {
          ...updatedIncident,
          deliveryThreadId: deliveryThreadId(updatedIncident),
          attemptedThreadId: undefined,
        };
        nextState = { ...nextState, pendingIncidents };
        dependencies.writeState(nextState);
      }
      console.error(
        `[lastcode:checkpoint-supervisor] Could not deliver a pending alert to the maintenance thread: ${error instanceof Error ? error.message : String(error)}`,
      );
      return nextState;
    }
  }

  if (nextState.status === "success") {
    let pendingResolutions = [...durableIncidentList(nextState, "pendingResolutions")];
    while (pendingResolutions.length > 0) {
      const [incident, ...remaining] = pendingResolutions;
      if (!incident) break;
      const updatedIncident = {
        ...incident,
        resolutionDelivery: "pending",
        deliveryAttempts: (incident.deliveryAttempts ?? 0) + 1,
        lastDeliveryAttemptAt: dependencies.now(),
      };
      nextState = Object.assign({}, nextState, {
        pendingResolutions: [updatedIncident, ...remaining],
      });
      dependencies.writeState(nextState);
      try {
        dependencies.sendThread(
          deliveryThreadId(updatedIncident),
          checkpointResolvedMessage(updatedIncident),
        );
        pendingResolutions = remaining;
        nextState = Object.assign(
          {},
          nextState,
          pendingResolutions.length > 0
            ? { pendingResolutions }
            : { pendingResolutions: undefined },
        );
        dependencies.writeState(nextState);
      } catch (error) {
        console.error(
          `[lastcode:checkpoint-supervisor] Could not deliver a pending resolution to the maintenance thread: ${error instanceof Error ? error.message : String(error)}`,
        );
        return nextState;
      }
    }
  }

  const incident = nextState.incident;
  if (!incident) return nextState;
  const resolving = nextState.status === "success";
  const key = resolving ? "resolutionDelivery" : "alertDelivery";
  if (!resolving && !retryableIncident(incident)) return nextState;
  if (incident[key] === "sent" || incident[key] === "not-needed") return nextState;
  const message = resolving
    ? checkpointResolvedMessage(incident)
    : checkpointFailureMessage(incident.failure, incident.fingerprint);
  const targetThreadId = resolving
    ? deliveryThreadId(incident)
    : (deliveryThreadId(incident) ?? recoveryThreadId);
  const nextIncident = {
    ...incident,
    [key]: resolving ? "pending" : "unknown",
    ...(!resolving && (incident.deliveryThreadId ?? incident.attemptedThreadId)
      ? { deliveryThreadId: incident.deliveryThreadId ?? incident.attemptedThreadId }
      : {}),
    ...(!resolving ? { attemptedThreadId: targetThreadId } : {}),
    deliveryAttempts: (incident.deliveryAttempts ?? 0) + 1,
    lastDeliveryAttemptAt: dependencies.now(),
  };
  nextState = { ...nextState, incident: nextIncident };
  dependencies.writeState(nextState);
  try {
    dependencies.sendThread(targetThreadId, message);
    nextState = {
      ...nextState,
      incident: {
        ...nextIncident,
        [key]: "sent",
        ...(!resolving
          ? { deliveryThreadId: deliveryThreadId(nextIncident), attemptedThreadId: undefined }
          : {}),
      },
    };
    dependencies.writeState(nextState);
  } catch (error) {
    if (!resolving && rejectedThreadSend(error, targetThreadId)) {
      nextState = { ...nextState, incident: recordRejectedAttempt(nextIncident) };
      dependencies.writeState(nextState);
    } else if (!resolving) {
      nextState = {
        ...nextState,
        incident: {
          ...nextIncident,
          deliveryThreadId: deliveryThreadId(nextIncident),
          attemptedThreadId: undefined,
        },
      };
      dependencies.writeState(nextState);
    }
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
    supervisorPid: process.pid,
    notify: (title, message) => notify(title, message, environment),
    reconcileProjectActions: (primaryWorktree, trustedProjectActionIds) =>
      reconcilePrimaryProjectActions(primaryWorktree, home, trustedProjectActionIds, environment),
    refreshPrimaryCheckout: () => refreshPrimaryCheckout(repoRoot, environment),
    retainedRecoveryMatches: (checkpointRun) =>
      retainedRecoveryMatches(repoRoot, checkpointRun, environment),
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
  let checkpointHistoryBeforeRun = null;
  let checkpointHistoryBaselineAvailable = false;
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
    try {
      checkpointHistoryBeforeRun = dependencies.latestFailedCheckpointRun();
      checkpointHistoryBaselineAvailable = true;
    } catch (historyError) {
      console.error(
        `[lastcode:checkpoint-supervisor] Could not snapshot checkpoint history before the run: ${historyError instanceof Error ? historyError.message : String(historyError)}`,
      );
    }
    dependencies.runPhase("checkpoint", process.execPath, CHECKPOINT_ARGS);
    phase = "checkout-refresh";
    const primaryWorktree = dependencies.refreshPrimaryCheckout();
    phase = "project-actions";
    dependencies.reconcileProjectActions(primaryWorktree, projectActionTrustAllowlist(config));
  } catch (error) {
    const finishedAt = dependencies.now();
    let checkpointRun = null;
    if (phase === "checkpoint") {
      try {
        const latestCheckpointRun = dependencies.latestFailedCheckpointRun();
        const writtenByCurrentInvocation =
          checkpointHistoryBaselineAvailable &&
          !sameCheckpointRun(checkpointHistoryBeforeRun, latestCheckpointRun);
        if (
          latestCheckpointRun &&
          (writtenByCurrentInvocation || dependencies.retainedRecoveryMatches(latestCheckpointRun))
        ) {
          checkpointRun = latestCheckpointRun;
        }
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
    const pendingIncidents = [...durableIncidentList(previous, "pendingIncidents")];
    const pendingResolutions = [...durableIncidentList(previous, "pendingResolutions")];
    const previousIncident = durableIncident(previous?.incident);
    if (
      previous?.status === "success" &&
      previousIncident &&
      previousIncident.resolutionDelivery === "pending" &&
      !pendingResolutions.some(
        (pendingIncident) => pendingIncident.fingerprint === previousIncident.fingerprint,
      )
    ) {
      pendingResolutions.push(previousIncident);
    }
    const sameOpenIncident =
      previous?.status === "failed" && previousIncident?.fingerprint === fingerprint;
    const pendingIncidentIndex = pendingIncidents.findIndex(
      (pendingIncident) => pendingIncident.fingerprint === fingerprint,
    );
    const pendingResolutionIndex = pendingResolutions.findIndex(
      (pendingIncident) => pendingIncident.fingerprint === fingerprint,
    );
    const restoredIncident =
      (pendingResolutionIndex >= 0
        ? pendingResolutions.splice(pendingResolutionIndex, 1)[0]
        : null) ??
      (pendingIncidentIndex >= 0 ? pendingIncidents.splice(pendingIncidentIndex, 1)[0] : null);
    const knownIncident = sameOpenIncident || Boolean(restoredIncident);
    const incident = {
      ...((sameOpenIncident ? previousIncident : restoredIncident) ?? {
        alertDelivery: "pending",
        deliveryAttempts: 0,
        failure,
        fingerprint,
        openedAt: finishedAt,
      }),
    };
    delete incident.resolvedAt;
    if (!sameOpenIncident && previous?.status === "failed" && previousIncident) {
      const destination =
        previousIncident.alertDelivery === "sent" ? pendingResolutions : pendingIncidents;
      if (
        !destination.some(
          (pendingIncident) => pendingIncident.fingerprint === previousIncident.fingerprint,
        )
      ) {
        destination.push(previousIncident);
      }
    }
    let state = {
      schemaVersion: 1,
      supervisorPid: dependencies.supervisorPid,
      status: "failed",
      phase: failure.phase,
      startedAt,
      finishedAt,
      ...(previous?.lastSuccessAt ? { lastSuccessAt: previous.lastSuccessAt } : {}),
      ...(pendingIncidents.length > 0 ? { pendingIncidents } : {}),
      ...(pendingResolutions.length > 0 ? { pendingResolutions } : {}),
      incident,
    };
    dependencies.writeState(state);
    state = attemptDelivery(state, config, dependencies);
    if (!knownIncident) {
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
  const deliveryConfigured = Boolean(config?.recoveryThreadId);
  let incident = durableIncident(previous?.incident);
  const pendingIncidents = durableIncidentList(previous, "pendingIncidents");
  const unresolvedIncidents = [
    ...pendingIncidents,
    ...durableIncidentList(previous, "pendingResolutions"),
  ]
    .filter(
      (pendingIncident, index, incidents) =>
        incidents.findIndex(
          (candidate) => candidate.fingerprint === pendingIncident.fingerprint,
        ) === index &&
        pendingIncident.alertDelivery !== "rejected" &&
        attemptedIncident(pendingIncident) &&
        !potentiallyDeliveredIncident(pendingIncident),
    )
    .map((pendingIncident) => ({
      ...pendingIncident,
      resolvedAt: pendingIncident.resolvedAt ?? finishedAt,
    }));
  const pendingResolutions = deliveryConfigured
    ? durableIncidentList(previous, "pendingResolutions")
        .filter(potentiallyDeliveredIncident)
        .map((pendingIncident) => ({
          ...pendingIncident,
          resolvedAt: pendingIncident.resolvedAt ?? finishedAt,
          resolutionDelivery: "pending",
        }))
    : [];
  for (const pendingIncident of pendingIncidents) {
    if (
      potentiallyDeliveredIncident(pendingIncident) &&
      !pendingResolutions.some(
        (pendingResolution) => pendingResolution.fingerprint === pendingIncident.fingerprint,
      )
    ) {
      pendingResolutions.push({
        ...pendingIncident,
        resolvedAt: pendingIncident.resolvedAt ?? finishedAt,
        resolutionDelivery: "pending",
      });
    }
  }
  if (
    incident &&
    (!attemptedIncident(incident) ||
      (incident.alertDelivery === "rejected" && !deliveryThreadId(incident)))
  ) {
    incident = {
      ...incident,
      ...(previous?.status === "failed" ? { resolvedAt: finishedAt } : {}),
      alertDelivery: "not-needed",
      resolutionDelivery: "not-needed",
    };
  } else if (previous?.status === "failed" && incident && potentiallyDeliveredIncident(incident)) {
    incident = {
      ...incident,
      resolvedAt: finishedAt,
      resolutionDelivery: deliveryConfigured ? "pending" : "not-needed",
    };
  } else if (incident && !potentiallyDeliveredIncident(incident)) {
    incident = {
      ...incident,
      resolvedAt: incident.resolvedAt ?? finishedAt,
      alertDelivery: "unknown",
      resolutionDelivery: "not-needed",
    };
  } else if (!deliveryConfigured && incident) {
    incident = { ...incident, resolutionDelivery: "not-needed" };
  }
  let state = {
    schemaVersion: 1,
    supervisorPid: dependencies.supervisorPid,
    status: "success",
    phase: "complete",
    startedAt,
    finishedAt,
    lastSuccessAt: finishedAt,
    ...(pendingResolutions.length > 0 ? { pendingResolutions } : {}),
    ...(unresolvedIncidents.length > 0 ? { pendingIncidents: unresolvedIncidents } : {}),
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
