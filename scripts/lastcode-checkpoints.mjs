#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const DEFAULT_COUNT = 8;
const CHECKPOINT_PREFIX = "lastcode/checkpoint/";
const REVISION_PREFIX = "lastcode/revision/";
const BUILD_PREFIX = "lastcode/build/";
const SERVICE_LABEL = "codes.lastobelus.lastcode-nightly-checkpoint";
const REMOTE_PROBE_TIMEOUT_MS = 3_000;

const ansiEnabled =
  process.stdout.isTTY && !("NO_COLOR" in process.env) && process.env.TERM !== "dumb";
const ansi = {
  reset: "\u001b[0m",
  projectName: "\u001b[1m\u001b[38;2;255;162;28m",
  amber: "\u001b[38;2;255;162;28m",
  lavender: "\u001b[38;2;126;107;143m",
  pacific: "\u001b[38;2;24;143;167m",
  iceBold: "\u001b[1m\u001b[38;2;203;247;237m",
  error: "\u001b[38;2;203;0;44m",
  green: "\u001b[1;32m",
  yellow: "\u001b[1;33m",
};

function style(code, value) {
  return ansiEnabled ? `${code}${value}${ansi.reset}` : value;
}

function git(repoRoot, args, { allowFailure = false } = {}) {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (allowFailure) return "";
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed.`);
  }
  return result.stdout.trim();
}

function splitLines(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function parseOptions(argv) {
  let count = DEFAULT_COUNT;
  let install = false;
  let repairPersistentThread = false;
  let repoRoot;
  let verbose = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--install") install = true;
    else if (arg === "--repair-persistent-thread") repairPersistentThread = true;
    else if (arg === "-v" || arg === "--verbose") verbose = true;
    else if (arg === "-n" || arg === "--count" || arg === "--repo") {
      const value = argv[index + 1];
      if (!value) throw new Error(`Missing value for ${arg}.`);
      if (arg === "--repo") repoRoot = value;
      else {
        count = Number(value);
        if (!Number.isSafeInteger(count) || count < 1) {
          throw new Error(`Invalid checkpoint count '${value}'.`);
        }
      }
      index += 1;
    } else if (arg === "-h" || arg === "--help") {
      return { help: true, count, install, repairPersistentThread, repoRoot, verbose };
    } else {
      throw new Error(`Unknown argument '${arg}'.`);
    }
  }
  return { help: false, count, install, repairPersistentThread, repoRoot, verbose };
}

export function readCheckpointSupervisorConfig(home) {
  const configPath = NodePath.join(home, ".lastcode", "automation", "checkpoint-supervisor.json");
  if (!NodeFS.existsSync(configPath)) return { configPath, config: null };
  try {
    const config = JSON.parse(NodeFS.readFileSync(configPath, "utf8"));
    return { configPath, config: config?.schemaVersion === 1 ? config : null };
  } catch {
    return { configPath, config: null };
  }
}

export function persistentThreadRepairStatus(config, threads) {
  const configuredId =
    typeof config?.recoveryThreadId === "string" ? config.recoveryThreadId : undefined;
  if (!configuredId) return { kind: "disabled" };
  if (threads === null) return { kind: "unavailable", configuredId };
  const configuredThread = threads.find((thread) => thread.threadId === configuredId);
  if (configuredThread?.persistent === true) return { kind: "healthy", configuredId };
  const replacement = threads.find((thread) => thread.persistent === true);
  return {
    kind: configuredThread ? "not-persistent" : "stale",
    configuredId,
    ...(replacement
      ? { replacementId: replacement.threadId, replacementTitle: replacement.title }
      : {}),
  };
}

function readLastCodeThreads(home) {
  const toolPath = NodePath.join(home, ".lastcode", "userdata", "bin", "lastcode-thread");
  if (!NodeFS.existsSync(toolPath)) return null;
  const result = NodeChildProcess.spawnSync(toolPath, ["list", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed?.threads) ? parsed.threads : [];
  } catch {
    return null;
  }
}

function readLastCodeThread(home, threadId) {
  const toolPath = NodePath.join(home, ".lastcode", "userdata", "bin", "lastcode-thread");
  if (!NodeFS.existsSync(toolPath)) return null;
  const result = NodeChildProcess.spawnSync(
    toolPath,
    ["read", threadId, "--turn-limit", "1", "--json"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    },
  );
  if (result.error || result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    return parsed?.kind === "read" ? parsed : null;
  } catch {
    return null;
  }
}

function readCheckpointThreads(home, config) {
  const threads = readLastCodeThreads(home);
  if (threads === null) return null;
  const configuredId =
    typeof config?.recoveryThreadId === "string" ? config.recoveryThreadId : undefined;
  if (!configuredId || threads.some((thread) => thread.threadId === configuredId)) return threads;
  const configuredThread = readLastCodeThread(home, configuredId);
  return configuredThread === null ? threads : [...threads, configuredThread];
}

function repairPersistentThreadConfig(home) {
  const { configPath, config } = readCheckpointSupervisorConfig(home);
  if (!config) throw new Error("Checkpoint supervisor configuration is unavailable.");
  const threads = readLastCodeThreads(home);
  if (threads === null) throw new Error("LastCode thread state is unavailable.");
  const persistentThreads = threads.filter((thread) => thread.persistent === true);
  if (persistentThreads.length !== 1) {
    throw new Error(
      persistentThreads.length === 0
        ? "No persistent thread is designated. Mark one in LastCode, then retry."
        : "More than one persistent thread was found; disable the extras before retrying.",
    );
  }
  const recoveryThreadId = persistentThreads[0].threadId;
  const temporaryPath = `${configPath}.tmp`;
  NodeFS.writeFileSync(
    temporaryPath,
    `${JSON.stringify({ ...config, recoveryThreadId }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  NodeFS.renameSync(temporaryPath, configPath);
  console.log(`Repaired checkpoint recovery delivery to persistent thread ${recoveryThreadId}.`);
}

function parseNightly(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)-nightly\.(\d{8})\.(\d+)(?:\.(\d+))?$/.exec(tag);
  return match ? [...match.slice(1, 6).map(Number), Number(match[6] ?? 0)] : undefined;
}

function compareNightlies(left, right) {
  const leftParts = parseNightly(left);
  const rightParts = parseNightly(right);
  if (!leftParts || !rightParts) return left.localeCompare(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

export function parseTrailers(contents) {
  return Object.fromEntries(
    contents
      .split(/\r?\n/)
      .map((line) => /^([A-Za-z][A-Za-z-]+):\s*(.*)$/.exec(line))
      .filter(Boolean)
      .map((match) => [match[1], match[2]]),
  );
}

export function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "—";
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export function checkpointFreshness(latestUpstream, latestCheckpoint) {
  if (!latestUpstream) return "Upstream unavailable";
  if (!latestCheckpoint) return "Checkpoint pending";
  return compareNightlies(latestCheckpoint, latestUpstream) >= 0
    ? "Up to date"
    : "Checkpoint pending";
}

export function latestNightlyTag(tags) {
  return tags.toSorted((left, right) => compareNightlies(right, left)).at(0);
}

export function latestKnownUpstreamTag(remoteLatest, localLatest, latestCheckpoint) {
  return latestNightlyTag([remoteLatest, localLatest, latestCheckpoint].filter(Boolean));
}

function formatFinished(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function readRuns(home) {
  const historyPath = NodePath.join(home, ".lastcode", "automation", "checkpoint-runs.jsonl");
  if (!NodeFS.existsSync(historyPath)) return [];
  return NodeFS.readFileSync(historyPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const record = JSON.parse(line);
        return record.schemaVersion === 1 && ["failed", "shadow", "success"].includes(record.status)
          ? [record]
          : [];
      } catch {
        return [];
      }
    });
}

export function readCheckpointServiceState(home) {
  const statePath = NodePath.join(home, ".lastcode", "automation", "checkpoint-service-state.json");
  if (!NodeFS.existsSync(statePath)) return null;
  try {
    const state = JSON.parse(NodeFS.readFileSync(statePath, "utf8"));
    return state?.schemaVersion === 1 && ["failed", "success"].includes(state.status)
      ? state
      : null;
  } catch {
    return null;
  }
}

export function serviceFailureDetailLines(state, verbose) {
  if (state?.status !== "failed" || !state.incident?.failure) return [];
  const failure = state.incident.failure;
  const phase = failure.phase ?? state.phase ?? "unknown phase";
  const lines = [`Service failure (${phase}): ${failure.error ?? "unknown error"}`];
  if (verbose && failure.diagnostic) lines.push(`Diagnostic: ${failure.diagnostic}`);
  return lines;
}

export function carrySetShadowDetailLines(records, verbose) {
  const latest = records.findLast((record) => record.status === "shadow");
  if (!latest) return [];
  if (latest.outcome === "failed") {
    return [
      `Carry-set shadow check failed for ${latest.checkpointTag}: ${latest.error ?? "unknown error"}`,
    ];
  }
  return verbose ? [`Carry-set shadow check passed for ${latest.checkpointTag}.`] : [];
}

export function latestRunsByUpstreamTag(records) {
  const latest = new Map();
  for (const record of records) {
    if (typeof record.upstreamTag === "string") latest.set(record.upstreamTag, record);
  }
  return latest;
}

export function failedRunsWithoutPublishedTags(publishedTags, records) {
  const publishedNightlies = new Set(
    publishedTags.map((tag) => tag.slice(CHECKPOINT_PREFIX.length)),
  );
  return [...latestRunsByUpstreamTag(records).values()].filter(
    (record) => record.status === "failed" && !publishedNightlies.has(record.upstreamTag),
  );
}

export function failureDetailLines(rows, verbose) {
  if (!verbose) return [];
  return rows
    .filter((row) => row.status === "failed")
    .map((failure) => {
      const recovery = failure.recoveryBranch ? ` · Recovery: ${failure.recoveryBranch}` : "";
      const rollback = failure.rollbackReason ? ` · Rollback: ${failure.rollbackReason}` : "";
      return `Failure ${failure.upstreamTag}: ${failure.error ?? "unknown error"}${recovery}${rollback}`;
    });
}

export function rollbackDetailLines(rows) {
  return rows
    .filter((row) => row.replayMode === "historical" && row.rollbackReason)
    .map((row) => `Historical rollback ${row.upstreamTag}: ${row.rollbackReason}`);
}

export function provenanceDetailLines(rows, verbose) {
  if (!verbose) return [];
  return rows
    .filter((row) => row.sourceCommit || row.sourceObjectRef)
    .map((row) => {
      const source = row.sourceCommit ? `source ${row.sourceCommit}` : "source unknown";
      const object = row.sourceObjectRef ? ` · immutable ref ${row.sourceObjectRef}` : "";
      return `Provenance ${row.upstreamTag}: ${source}${object}`;
    });
}

export function failureWasDuringRebase(record) {
  if (record?.failurePhase !== undefined) return record.failurePhase === "rebase";
  return (
    typeof record?.error === "string" && /^git(?:\s+-c\s+\S+)*\s+rebase(?:\s|$)/.test(record.error)
  );
}

export function parseRebaseRange(error) {
  if (typeof error !== "string") return undefined;
  const match = /\brebase\s+--onto\s+(\S+)\s+(\S+)(?:\s|$)/.exec(error);
  return match ? { upstreamTag: match[1], previousUpstreamTag: match[2] } : undefined;
}

export function selectRebaseRange(error, retainedRange) {
  return parseRebaseRange(error) ?? retainedRange;
}

export function formatRecoveryProblemLines({
  stoppedCommit,
  conflictPaths = [],
  previousUpstreamTag,
  upstreamTag,
  overlappingUpstreamCommits = [],
}) {
  if (!stoppedCommit && conflictPaths.length === 0) return [];
  const lines = [
    stoppedCommit
      ? `Problem: Git could not replay LastCode commit ${stoppedCommit}.`
      : "Problem: Git could not automatically combine LastCode and upstream changes.",
  ];
  if (conflictPaths.length > 0) {
    lines.push(`Conflicted ${conflictPaths.length === 1 ? "file" : "files"}:`);
    lines.push(...conflictPaths.map((path) => `  ${path}`));
  }
  if (overlappingUpstreamCommits.length > 0) {
    const range =
      previousUpstreamTag && upstreamTag
        ? ` between ${previousUpstreamTag} and ${upstreamTag}`
        : "";
    lines.push(
      `Upstream commits touching ${conflictPaths.length === 1 ? "that file" : "those files"}${range}:`,
    );
    lines.push(...overlappingUpstreamCommits.map((commit) => `  ${commit}`));
  }
  return lines;
}

export function checkpointTagsWithoutUnpublishedFailures(tags, publishedTags, records) {
  const published = new Set(publishedTags);
  const latestRuns = latestRunsByUpstreamTag(records);
  return tags.filter((tag) => {
    const latestRun = latestRuns.get(tag.slice(CHECKPOINT_PREFIX.length));
    return published.has(tag) || latestRun?.status !== "failed";
  });
}

export function latestPublishedCheckpointTag(localTags, publishedTags, records) {
  return checkpointTagsWithoutUnpublishedFailures(
    [
      ...new Set([
        ...localTags,
        ...publishedTags.filter((tag) => tag.startsWith(CHECKPOINT_PREFIX)),
      ]),
    ],
    publishedTags,
    records,
  )
    .map((tag) => tag.slice(CHECKPOINT_PREFIX.length))
    .sort((left, right) => compareNightlies(right, left))
    .at(0);
}

export function latestPublishedInstallableTag(localTags, publishedTags) {
  return [
    ...new Set([
      ...localTags,
      ...publishedTags.filter(
        (tag) => tag.startsWith(CHECKPOINT_PREFIX) || tag.startsWith(REVISION_PREFIX),
      ),
    ]),
  ]
    .map((tag) => ({
      tag,
      version: tag.slice(
        tag.startsWith(REVISION_PREFIX) ? REVISION_PREFIX.length : CHECKPOINT_PREFIX.length,
      ),
    }))
    .sort((left, right) => compareNightlies(right.version, left.version))
    .at(0);
}

export function parseRemotePublicationState(output) {
  let remoteMain;
  const publishedTags = [];
  const publishedTagCommits = {};
  const publishedTagObjects = {};
  for (const line of splitLines(output)) {
    const [commit, ref] = line.split(/\s+/);
    if (ref === "refs/heads/lastcode/main") remoteMain = commit;
    else if (ref?.startsWith("refs/tags/")) {
      const tag = ref.slice("refs/tags/".length).replace(/\^\{\}$/, "");
      if (ref.endsWith("^{}")) publishedTagCommits[tag] = commit;
      else {
        publishedTags.push(tag);
        publishedTagObjects[tag] = commit;
      }
    }
  }
  for (const tag of publishedTags) publishedTagCommits[tag] ??= publishedTagObjects[tag];
  return { publishedTags, publishedTagCommits, remoteMain };
}

export function parseRemoteUpstreamTags(output) {
  return splitLines(output).flatMap((line) => {
    const [, ref] = line.split(/\s+/);
    if (!ref?.startsWith("refs/tags/") || ref.endsWith("^{}")) return [];
    const tag = ref.slice("refs/tags/".length);
    return parseNightly(tag) ? [tag] : [];
  });
}

function remoteLatestUpstreamTag(repoRoot) {
  const result = NodeChildProcess.spawnSync(
    "git",
    ["ls-remote", "upstream", "refs/tags/v*-nightly.*"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: REMOTE_PROBE_TIMEOUT_MS,
    },
  );
  if (result.error || result.status !== 0) return undefined;
  return latestNightlyTag(parseRemoteUpstreamTags(result.stdout));
}

function remotePublicationState(repoRoot) {
  const cachedRemoteMain = git(repoRoot, ["rev-parse", "refs/remotes/origin/lastcode/main"], {
    allowFailure: true,
  });
  const result = NodeChildProcess.spawnSync(
    "git",
    [
      "ls-remote",
      "origin",
      "refs/heads/lastcode/main",
      `refs/tags/${CHECKPOINT_PREFIX}v*-nightly.*`,
      `refs/tags/${REVISION_PREFIX}v*-nightly.*`,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: REMOTE_PROBE_TIMEOUT_MS,
    },
  );
  if (result.error || result.status !== 0) {
    return { publishedTags: [], publishedTagCommits: {}, remoteMain: cachedRemoteMain };
  }
  const remote = parseRemotePublicationState(result.stdout);
  return { ...remote, remoteMain: remote.remoteMain ?? cachedRemoteMain };
}

function resolveConfiguredRepo(home, override) {
  if (override) return NodePath.resolve(override);
  if (process.env.LASTCODE_REPO) return NodePath.resolve(process.env.LASTCODE_REPO);
  const configPath = NodePath.join(home, ".lastcode", "dashboard.json");
  if (NodeFS.existsSync(configPath)) {
    const config = JSON.parse(NodeFS.readFileSync(configPath, "utf8"));
    if (typeof config.repoRoot === "string") return config.repoRoot;
  }
  return git(process.cwd(), ["rev-parse", "--show-toplevel"]);
}

export function selectAutomationWorktree(worktreeList) {
  const worktrees = worktreeList
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
  return worktrees.find((path) => NodePath.basename(path) === "lastcode-automation");
}

export function selectNightlySyncWorktree(worktreeList) {
  const worktrees = worktreeList
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
  return worktrees.find((path) => NodePath.basename(path) === "lastcode-nightly-sync");
}

function findAutomationWorktree(repoRoot) {
  return selectAutomationWorktree(git(repoRoot, ["worktree", "list", "--porcelain"]));
}

function findNightlySyncWorktree(repoRoot) {
  return selectNightlySyncWorktree(git(repoRoot, ["worktree", "list", "--porcelain"]));
}

function rebaseInProgress(worktree) {
  return ["rebase-merge", "rebase-apply"].some((stateDirectory) => {
    const gitPath = git(worktree, ["rev-parse", "--git-path", stateDirectory], {
      allowFailure: true,
    });
    if (!gitPath) return false;
    return NodeFS.existsSync(
      NodePath.isAbsolute(gitPath) ? gitPath : NodePath.join(worktree, gitPath),
    );
  });
}

function readRebaseState(worktree, filename) {
  for (const stateDirectory of ["rebase-merge", "rebase-apply"]) {
    const gitPath = git(worktree, ["rev-parse", "--git-path", `${stateDirectory}/${filename}`], {
      allowFailure: true,
    });
    if (!gitPath) continue;
    const path = NodePath.isAbsolute(gitPath) ? gitPath : NodePath.join(worktree, gitPath);
    if (NodeFS.existsSync(path)) return NodeFS.readFileSync(path, "utf8").trim();
  }
  return undefined;
}

function retainedRebaseRange(worktree) {
  const onto = readRebaseState(worktree, "onto");
  const originalHead = readRebaseState(worktree, "orig-head");
  if (!onto || !originalHead) return undefined;
  const upstreamTag = git(
    worktree,
    ["describe", "--tags", "--exact-match", "--match", "v*-nightly.*", onto],
    { allowFailure: true },
  );
  const previousUpstreamTag = git(
    worktree,
    ["describe", "--tags", "--abbrev=0", "--match", "v*-nightly.*", originalHead],
    { allowFailure: true },
  );
  return upstreamTag && previousUpstreamTag ? { upstreamTag, previousUpstreamTag } : undefined;
}

function recoveryProblemLines(repoRoot, worktree, failure) {
  if (!rebaseInProgress(worktree)) return [];
  const conflictPaths = splitLines(
    git(worktree, ["diff", "--name-only", "--diff-filter=U"], { allowFailure: true }),
  );
  const stoppedCommit = git(worktree, ["show", "-s", "--format=%h %s", "REBASE_HEAD"], {
    allowFailure: true,
  });
  const range = selectRebaseRange(failure?.error, retainedRebaseRange(worktree));
  const overlappingUpstreamCommits =
    range && conflictPaths.length > 0
      ? splitLines(
          git(
            repoRoot,
            [
              "log",
              "--format=%h %s",
              `${range.previousUpstreamTag}..${range.upstreamTag}`,
              "--",
              ...conflictPaths,
            ],
            { allowFailure: true },
          ),
        )
      : [];
  return formatRecoveryProblemLines({
    stoppedCommit,
    conflictPaths,
    previousUpstreamTag: range?.previousUpstreamTag,
    upstreamTag: range?.upstreamTag,
    overlappingUpstreamCommits,
  });
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function recoveryActionLines({
  repoRoot,
  worktree,
  automationWorktree,
  recoveryBranch,
  isRebaseInProgress,
  failedDuringRebase,
  hasFailureRecord = true,
  isDaemonRunning = false,
  carryPhase,
  recoverySource,
  replayMode,
  rollbackReason,
}) {
  const lines = [];
  if (isRebaseInProgress) {
    lines.push(
      `Resolve and stage conflicts, then repeat until the rebase finishes: git -C ${shellQuote(worktree)} rebase --continue`,
    );
    if (carryPhase && automationWorktree && recoverySource) {
      lines.push(
        carryRecoverySelectionLine({
          automationWorktree,
          worktree,
          recoverySource,
          replayMode,
          rollbackReason,
        }),
      );
      return lines;
    }
  } else if (isDaemonRunning) {
    return [
      "Automation is still working or has not recorded the failure yet; wait for it to finish before changing the retained attempt.",
    ];
  } else if (carryPhase && automationWorktree && recoverySource) {
    return [
      carryRecoverySelectionLine({
        automationWorktree,
        worktree,
        recoverySource,
        replayMode,
        rollbackReason,
      }),
    ];
  } else if (failedDuringRebase) {
    lines.push(
      "The retained rebase is complete; release it so the daemon can replay the recorded resolution.",
    );
  } else if (hasFailureRecord) {
    lines.push(
      "No rebase is in progress. Fix the smoke failure on lastcode/main, then discard this retained attempt.",
    );
  } else if (recoveryBranch?.startsWith("sync/revision/")) {
    lines.push(
      "Revision automation stopped after retaining this attempt. Inspect the daemon log for the smoke or publication error, then discard the attempt.",
    );
  } else {
    lines.push(
      "Automation stopped before recording failure details. Inspect the daemon log, then discard this retained attempt.",
    );
  }
  lines.push(
    `Release the daemon: git -C ${shellQuote(repoRoot)} worktree remove ${shellQuote(worktree)}`,
  );
  if (recoveryBranch) {
    lines.push(
      `Delete the generated recovery branch: git -C ${shellQuote(repoRoot)} branch -D ${shellQuote(recoveryBranch)}`,
    );
  }
  if (automationWorktree) {
    lines.push(
      `Retry now: pnpm --dir ${shellQuote(automationWorktree)} lastcode:checkpoint:service run-now`,
    );
  }
  return lines;
}

function carryRecoverySelectionLine({
  automationWorktree,
  worktree,
  recoverySource,
  replayMode,
  rollbackReason,
}) {
  const mode = replayMode ?? "carry";
  if (mode === "historical" && !rollbackReason) {
    return "Cannot continue the retained historical replay: its rollback reason is missing from checkpoint history.";
  }
  const rollback = rollbackReason ? ` --rollback-reason ${shellQuote(rollbackReason)}` : "";
  return `Continue the retained ${mode} replay: pnpm --dir ${shellQuote(automationWorktree)} lastcode:checkpoint -- --select-recovery "$(git -C ${shellQuote(worktree)} rev-parse HEAD)" --recovery-source ${shellQuote(recoverySource)} --replay-mode ${mode}${rollback}`;
}

function readCarryReplayPlan(worktree) {
  try {
    const gitDirectory = git(worktree, ["rev-parse", "--absolute-git-dir"]);
    const path = NodePath.join(gitDirectory, "lastcode-carry-replay-plan.json");
    return NodeFS.existsSync(path) ? JSON.parse(NodeFS.readFileSync(path, "utf8")) : null;
  } catch {
    return null;
  }
}

export function renderLauncher(modulePath) {
  return `#!/bin/sh\nexec mise exec node@24.13.1 -- node ${shellQuote(modulePath)} "$@"\n`;
}

function installCommand(repoRoot, home) {
  const binDirectory = NodePath.join(home, ".lastcode", "bin");
  const target = NodePath.join(binDirectory, "lastcode-checkpoints");
  const moduleTarget = NodePath.join(binDirectory, "lastcode-checkpoints.mjs");
  const exposedDirectory = NodePath.join(home, ".local", "bin");
  const exposed = NodePath.join(exposedDirectory, "lastcode-checkpoints");
  const configPath = NodePath.join(home, ".lastcode", "dashboard.json");
  const automationWorktree = findAutomationWorktree(repoRoot);
  if (!automationWorktree) {
    throw new Error(
      "LastCode automation worktree is not installed. Install the checkpoint service with a deployment-defined interval first.",
    );
  }
  NodeFS.mkdirSync(binDirectory, { recursive: true });
  NodeFS.mkdirSync(exposedDirectory, { recursive: true });
  NodeFS.copyFileSync(NodeURL.fileURLToPath(import.meta.url), moduleTarget);
  NodeFS.writeFileSync(target, renderLauncher(moduleTarget), { encoding: "utf8", mode: 0o755 });
  NodeFS.chmodSync(target, 0o755);
  NodeFS.writeFileSync(
    configPath,
    `${JSON.stringify({ repoRoot: automationWorktree }, undefined, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  if (NodeFS.existsSync(exposed) || NodeFS.lstatSync(exposed, { throwIfNoEntry: false })) {
    const current = NodeFS.lstatSync(exposed);
    if (!current.isSymbolicLink() || NodeFS.readlinkSync(exposed) !== target) {
      throw new Error(`${exposed} already exists and is not managed by LastCode.`);
    }
    NodeFS.unlinkSync(exposed);
  }
  NodeFS.symlinkSync(target, exposed);
  console.log(`Installed ${target} with the pinned Node 24 runtime`);
  console.log(`Exposed on PATH as ${exposed}`);
}

export function selectCheckpointTags(tags, count) {
  return tags
    .toSorted((left, right) =>
      compareNightlies(right.slice(CHECKPOINT_PREFIX.length), left.slice(CHECKPOINT_PREFIX.length)),
    )
    .slice(0, count);
}

function latestBuildNumbers(tags) {
  const latestByUpstreamTag = new Map();
  for (const tag of tags) {
    const match = /^(v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+(?:\.\d+)?)\.(\d+)$/.exec(
      tag.slice(BUILD_PREFIX.length),
    );
    if (!match) continue;
    const upstreamTag = match[1];
    const build = Number(match[2]);
    latestByUpstreamTag.set(
      upstreamTag,
      Math.max(latestByUpstreamTag.get(upstreamTag) ?? 0, build),
    );
  }
  return latestByUpstreamTag;
}

export function selectRevisionBuilds(checkpointTag, buildTags) {
  const checkpointVersion = checkpointTag.slice(CHECKPOINT_PREFIX.length);
  const builds = latestBuildNumbers(buildTags);
  return [...builds.entries()]
    .filter(([version]) => {
      const parsed = parseNightly(version);
      return version.startsWith(`${checkpointVersion}.`) && parsed?.[5] > 0;
    })
    .map(([version, build]) => ({
      build,
      buildTag: `${BUILD_PREFIX}${version}.${build}`,
      revisionTag: `${REVISION_PREFIX}${version}`,
      version,
    }))
    .toSorted((left, right) => compareNightlies(left.version, right.version));
}

function checkpointRows(repoRoot, home, count, remoteState) {
  const runs = readRuns(home);
  const allCheckpointTags = splitLines(
    git(repoRoot, ["tag", "--list", `${CHECKPOINT_PREFIX}v*-nightly.*`]),
  );
  const checkpointTags = checkpointTagsWithoutUnpublishedFailures(
    allCheckpointTags,
    remoteState.publishedTags,
    runs,
  );
  const selectedCheckpointTags = selectCheckpointTags(checkpointTags, count);
  const buildTags = splitLines(git(repoRoot, ["tag", "--list", `${BUILD_PREFIX}*`]));
  const buildNumbers = latestBuildNumbers(buildTags);
  const successes = selectedCheckpointTags.map((checkpointTag) => {
    const upstreamTag = checkpointTag.slice(CHECKPOINT_PREFIX.length);
    const contents = git(repoRoot, [
      "for-each-ref",
      "--format=%(contents)",
      `refs/tags/${checkpointTag}`,
    ]);
    const trailers = parseTrailers(contents);
    const commit =
      trailers["LastCode-Commit"] ?? git(repoRoot, ["rev-list", "-n", "1", checkpointTag]);
    const taggerDate = git(repoRoot, [
      "for-each-ref",
      "--format=%(taggerdate:iso8601-strict)",
      `refs/tags/${checkpointTag}`,
    ]);
    const inferredCommits = git(repoRoot, ["rev-list", "--count", `${upstreamTag}..${commit}`], {
      allowFailure: true,
    });
    const build = buildNumbers.get(upstreamTag);
    const row = {
      status: "success",
      upstreamTag,
      commitsRebased: Number(trailers["Fork-Commits-Rebased"] ?? inferredCommits),
      finishedAt: trailers["Finished-At"] ?? trailers["Created-At"] ?? taggerDate,
      durationMs: Number(trailers["Duration-Ms"]),
      checkpoint: commit.slice(0, 9),
      main: commit === remoteState.remoteMain ? "yes" : "—",
      build: build === undefined ? "—" : `#${build}`,
      replay:
        trailers["Replay-Mode"] === "historical" && trailers["Rollback-Reason"]
          ? "historical*"
          : (trailers["Replay-Mode"] ?? "legacy"),
      replayMode: trailers["Replay-Mode"],
      rollbackReason: trailers["Rollback-Reason"],
      sourceCommit: trailers["Source-Commit"],
      sourceObjectRef: trailers["Source-Object-Ref"],
    };
    const revisionBuildRows = selectRevisionBuilds(checkpointTag, buildTags).map(
      ({ build: revisionBuild, buildTag, revisionTag, version }) => {
        const revisionCommit = git(repoRoot, ["rev-list", "-n", "1", revisionTag]);
        const revisionTrailers = parseTrailers(
          git(repoRoot, ["for-each-ref", "--format=%(contents)", `refs/tags/${revisionTag}`]),
        );
        return {
          status: "build",
          upstreamTag: `  ${version}`,
          commitsRebased: "—",
          finishedAt: git(repoRoot, [
            "for-each-ref",
            "--format=%(taggerdate:iso8601-strict)",
            `refs/tags/${buildTag}`,
          ]),
          durationMs: Number.NaN,
          checkpoint: revisionCommit.slice(0, 9),
          main: revisionCommit === remoteState.remoteMain ? "yes" : "—",
          build: `#${revisionBuild}`,
          replay:
            revisionTrailers["Replay-Mode"] === "historical" && revisionTrailers["Rollback-Reason"]
              ? "historical*"
              : (revisionTrailers["Replay-Mode"] ?? "revision"),
          replayMode: revisionTrailers["Replay-Mode"],
          rollbackReason: revisionTrailers["Rollback-Reason"],
          sourceCommit: revisionTrailers["Source-Commit"],
          sourceObjectRef: revisionTrailers["Source-Object-Ref"],
        };
      },
    );
    return { finishedAt: row.finishedAt, rows: [row, ...revisionBuildRows] };
  });
  const failures = failedRunsWithoutPublishedTags(remoteState.publishedTags, runs).map(
    (record) => ({
      finishedAt: record.finishedAt,
      rows: [
        {
          status: "failed",
          upstreamTag: record.upstreamTag,
          commitsRebased: Number(record.commitsRebased),
          finishedAt: record.finishedAt,
          durationMs: Number(record.durationMs),
          checkpoint: "—",
          main: "—",
          build: "—",
          error: record.error,
          failurePhase: record.failurePhase,
          recoveryBranch: record.recoveryBranch,
          replay:
            record.replayMode === "historical" && record.rollbackReason
              ? "historical*"
              : (record.replayMode ?? "legacy"),
          replayMode: record.replayMode,
          rollbackReason: record.rollbackReason,
          sourceCommit: record.sourceCommit,
          sourceObjectRef: record.sourceObjectRef,
        },
      ],
    }),
  );
  return [...successes, ...failures]
    .sort(
      (left, right) => new Date(right.finishedAt).getTime() - new Date(left.finishedAt).getTime(),
    )
    .slice(0, count)
    .flatMap(({ rows }) => rows);
}

function styledStatus(status) {
  if (status === "success") return style(ansi.green, "✓");
  if (status === "failed") return style(ansi.error, "✗");
  if (status === "build") return style(ansi.pacific, "↳");
  return style(ansi.pacific, "●");
}

function daemonStatus() {
  const uid = NodeOS.userInfo().uid;
  const result = NodeChildProcess.spawnSync("launchctl", ["print", `gui/${uid}/${SERVICE_LABEL}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error) return { summary: "Daemon: unavailable", running: false };
  if (result.status !== 0) return { summary: "Daemon: not installed", running: false };
  const state = /^\s*state = (.+)$/m.exec(result.stdout)?.[1] ?? "unknown";
  const exit = /^\s*last exit code = (.+)$/m.exec(result.stdout)?.[1] ?? "—";
  const label = state === "running" ? "running" : "idle";
  return { summary: `Daemon: ${label} · Last exit: ${exit}`, running: state === "running" };
}

function printDashboard(repoRoot, home, count, verbose) {
  const daemon = daemonStatus();
  const remoteState = remotePublicationState(repoRoot);
  const rows = checkpointRows(repoRoot, home, count, remoteState);
  const columns = [
    {
      key: "status",
      label: "STATUS",
      value: (row) => (row.status === "success" ? "✓" : row.status === "failed" ? "✗" : "↳"),
    },
    { key: "upstreamTag", label: "UPSTREAM NIGHTLY", value: (row) => row.upstreamTag },
    { key: "commitsRebased", label: "REBASED", value: (row) => String(row.commitsRebased) },
    { key: "finishedAt", label: "FINISHED", value: (row) => formatFinished(row.finishedAt) },
    { key: "durationMs", label: "DURATION", value: (row) => formatDuration(row.durationMs) },
    { key: "checkpoint", label: "CHECKPOINT", value: (row) => row.checkpoint },
    { key: "main", label: "MAIN", value: (row) => row.main },
    { key: "build", label: "BUILD", value: (row) => row.build },
    { key: "replay", label: "REPLAY", value: (row) => row.replay },
  ].map((column) => ({
    ...column,
    width: Math.max(column.label.length, ...rows.map((row) => column.value(row).length)),
  }));
  const line = (values) =>
    values
      .map((value, index) => value.padEnd(columns[index].width))
      .join("  ")
      .trimEnd();

  console.log(
    `${style(ansi.projectName, "LastCode")} ${style(ansi.pacific, "nightly checkpoints")} ${style(ansi.lavender, `Showing ${rows.filter((row) => row.status !== "build").length}`)}`,
  );
  console.log("");
  console.log(style(ansi.iceBold, line(columns.map((column) => column.label))));
  for (const row of rows) {
    const raw = columns.map((column) => column.value(row));
    const padded = raw.map((value, index) => value.padEnd(columns[index].width));
    padded[0] = `${styledStatus(row.status)}${" ".repeat(columns[0].width - raw[0].length)}`;
    if (row.status === "build") {
      for (let index = 1; index < padded.length; index += 1) {
        padded[index] = style(ansi.pacific, padded[index]);
      }
      console.log(padded.join("  ").trimEnd());
      continue;
    }
    padded[1] = style(ansi.amber, padded[1]);
    for (const index of [3, 4, 5]) padded[index] = style(ansi.lavender, padded[index]);
    if (row.main === "yes") padded[6] = style(ansi.green, padded[6]);
    console.log(padded.join("  ").trimEnd());
  }

  const selectedFailures = failedRunsWithoutPublishedTags(
    remoteState.publishedTags,
    readRuns(home),
  );
  for (const detail of failureDetailLines(rows, verbose)) {
    console.log(style(ansi.error, detail));
  }
  for (const detail of rollbackDetailLines(rows)) {
    console.log(style(ansi.yellow, detail));
  }
  for (const detail of provenanceDetailLines(rows, verbose)) {
    console.log(style(ansi.lavender, detail));
  }

  const recoveryWorktree = findNightlySyncWorktree(repoRoot);
  if (recoveryWorktree) {
    const recoveryFailure = selectedFailures.find((failure) => failure.recoveryBranch);
    const recoveryBranch =
      recoveryFailure?.recoveryBranch ??
      git(recoveryWorktree, ["branch", "--show-current"], { allowFailure: true });
    const nightly = recoveryFailure ? ` for ${recoveryFailure.upstreamTag}` : "";
    const carryPlan = readCarryReplayPlan(recoveryWorktree);
    console.log("");
    console.log(
      style(
        ansi.yellow,
        `Action required: automation recovery${nightly} is blocking the daemon at ${recoveryWorktree}.`,
      ),
    );
    console.log(style(ansi.lavender, `Start with: git -C ${shellQuote(recoveryWorktree)} status`));
    for (const line of recoveryProblemLines(repoRoot, recoveryWorktree, recoveryFailure)) {
      console.log(style(ansi.error, line));
    }
    const automationWorktree = findAutomationWorktree(repoRoot);
    for (const line of recoveryActionLines({
      repoRoot,
      worktree: recoveryWorktree,
      automationWorktree,
      recoveryBranch,
      isRebaseInProgress: rebaseInProgress(recoveryWorktree),
      failedDuringRebase: failureWasDuringRebase(recoveryFailure),
      hasFailureRecord: recoveryFailure !== undefined,
      isDaemonRunning: daemon.running,
      carryPhase: carryPlan?.phase,
      recoverySource: recoveryFailure?.sourceCommit,
      replayMode: recoveryFailure?.replayMode,
      rollbackReason: recoveryFailure?.rollbackReason,
    })) {
      console.log(style(ansi.lavender, line));
    }
  }

  const upstreamTags = splitLines(git(repoRoot, ["tag", "--list", "v*-nightly.*"]));
  const latestVisibleCheckpoint = rows.find((row) => row.status === "success");
  const localCheckpointTags = splitLines(
    git(repoRoot, ["tag", "--list", `${CHECKPOINT_PREFIX}v*-nightly.*`]),
  );
  const latestCheckpoint = latestPublishedCheckpointTag(
    localCheckpointTags,
    remoteState.publishedTags,
    readRuns(home),
  );
  const latestUpstream = latestKnownUpstreamTag(
    remoteLatestUpstreamTag(repoRoot),
    latestNightlyTag(upstreamTags),
    latestCheckpoint,
  );
  const freshness = checkpointFreshness(latestUpstream, latestCheckpoint);
  const latestInstallableTag = latestPublishedInstallableTag(
    splitLines(
      git(repoRoot, [
        "tag",
        "--list",
        `${CHECKPOINT_PREFIX}v*-nightly.*`,
        `${REVISION_PREFIX}v*-nightly.*`,
      ]),
    ),
    remoteState.publishedTags,
  );
  const latestInstallableCommit = latestInstallableTag
    ? git(repoRoot, ["rev-list", "-n", "1", latestInstallableTag.tag], {
        allowFailure: true,
      }) || remoteState.publishedTagCommits[latestInstallableTag.tag]
    : undefined;
  const latestInstallableTrailers = latestInstallableTag
    ? parseTrailers(
        git(
          repoRoot,
          ["for-each-ref", "--format=%(contents)", `refs/tags/${latestInstallableTag.tag}`],
          { allowFailure: true },
        ),
      )
    : {};
  const latestReplay = latestInstallableTrailers["Replay-Mode"];
  const latestRollback = latestInstallableTrailers["Rollback-Reason"];
  const latestInstallableBuild = latestInstallableTag
    ? latestBuildNumbers(splitLines(git(repoRoot, ["tag", "--list", `${BUILD_PREFIX}*`]))).get(
        latestInstallableTag.version,
      )
    : undefined;
  console.log("");
  console.log(style(ansi.lavender, daemon.summary));
  for (const detail of serviceFailureDetailLines(readCheckpointServiceState(home), verbose)) {
    console.log(style(ansi.error, detail));
  }
  for (const detail of carrySetShadowDetailLines(readRuns(home), verbose)) {
    console.log(style(detail.includes(" failed ") ? ansi.error : ansi.green, detail));
  }
  const { config: supervisorConfig } = readCheckpointSupervisorConfig(home);
  const persistentStatus = persistentThreadRepairStatus(
    supervisorConfig,
    readCheckpointThreads(home, supervisorConfig),
  );
  if (persistentStatus.kind === "stale" || persistentStatus.kind === "not-persistent") {
    console.log(
      style(
        ansi.yellow,
        persistentStatus.kind === "stale"
          ? `Persistent thread safeguard: configured recovery thread ${persistentStatus.configuredId} no longer exists.`
          : `Persistent thread safeguard: configured recovery thread ${persistentStatus.configuredId} is not marked persistent.`,
      ),
    );
    if (persistentStatus.replacementId) {
      console.log(
        style(
          ansi.lavender,
          `Repair to “${persistentStatus.replacementTitle}” (${persistentStatus.replacementId}): lastcode-checkpoints --repair-persistent-thread`,
        ),
      );
    } else {
      console.log(
        style(
          ansi.lavender,
          "Right-click the replacement thread in LastCode and choose “Mark as persistent thread”, then run lastcode-checkpoints --repair-persistent-thread.",
        ),
      );
    }
  }
  console.log(
    style(
      freshness === "Up to date"
        ? ansi.green
        : freshness === "Checkpoint pending"
          ? ansi.yellow
          : ansi.pacific,
      `Latest upstream: ${latestUpstream ?? "—"} · Latest checkpoint: ${latestCheckpoint ?? latestVisibleCheckpoint?.upstreamTag ?? "—"} · ${freshness}`,
    ),
  );
  console.log(
    style(
      ansi.lavender,
      `Latest installable: ${latestInstallableTag?.version ?? "—"}${latestInstallableCommit === remoteState.remoteMain ? " · on main" : ""}${latestInstallableBuild ? ` · build #${latestInstallableBuild}` : ""}${latestReplay ? ` · replay ${latestReplay}` : ""}${latestRollback ? ` · rollback: ${latestRollback}` : ""}`,
    ),
  );
}

function main(argv) {
  const options = parseOptions(argv);
  if (options.help) {
    console.log(
      "Usage: lastcode-checkpoints [-n COUNT] [--verbose] [--repo PATH] [--install] [--repair-persistent-thread]",
    );
    return;
  }
  const home = NodeOS.homedir();
  const repoRoot = resolveConfiguredRepo(home, options.repoRoot);
  if (options.install) {
    installCommand(repoRoot, home);
    return;
  }
  if (options.repairPersistentThread) {
    repairPersistentThreadConfig(home);
    return;
  }
  printDashboard(repoRoot, home, options.count, options.verbose);
}

if (
  process.argv[1] &&
  NodeFS.realpathSync(process.argv[1]) ===
    NodeFS.realpathSync(NodeURL.fileURLToPath(import.meta.url))
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(
      `lastcode-checkpoints: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
