#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const DEFAULT_COUNT = 8;
const CHECKPOINT_PREFIX = "lastcode/checkpoint/";
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
  let repoRoot;
  let verbose = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--install") install = true;
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
      return { help: true, count, install, repoRoot, verbose };
    } else {
      throw new Error(`Unknown argument '${arg}'.`);
    }
  }
  return { help: false, count, install, repoRoot, verbose };
}

function parseNightly(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)-nightly\.(\d{8})\.(\d+)$/.exec(tag);
  return match ? match.slice(1).map(Number) : undefined;
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
  return latestUpstream === latestCheckpoint ? "Up to date" : "Checkpoint pending";
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
        return record.schemaVersion === 1 && ["failed", "success"].includes(record.status)
          ? [record]
          : [];
      } catch {
        return [];
      }
    });
}

export function latestRunsByUpstreamTag(records) {
  const latest = new Map();
  for (const record of records) latest.set(record.upstreamTag, record);
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
      return `Failure ${failure.upstreamTag}: ${failure.error ?? "unknown error"}${recovery}`;
    });
}

export function checkpointTagsWithoutUnpublishedFailures(tags, publishedTags, records) {
  const published = new Set(publishedTags);
  const latestRuns = latestRunsByUpstreamTag(records);
  return tags.filter((tag) => {
    const latestRun = latestRuns.get(tag.slice(CHECKPOINT_PREFIX.length));
    return published.has(tag) || latestRun?.status !== "failed";
  });
}

export function parseRemotePublicationState(output) {
  let remoteMain;
  const publishedTags = [];
  for (const line of splitLines(output)) {
    const [commit, ref] = line.split(/\s+/);
    if (ref === "refs/heads/lastcode/main") remoteMain = commit;
    else if (ref?.startsWith("refs/tags/") && !ref.endsWith("^{}")) {
      publishedTags.push(ref.slice("refs/tags/".length));
    }
  }
  return { publishedTags, remoteMain };
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
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: REMOTE_PROBE_TIMEOUT_MS,
    },
  );
  if (result.error || result.status !== 0) {
    return { publishedTags: [], remoteMain: cachedRemoteMain };
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

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
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
      "LastCode automation worktree is not installed. Run pnpm lastcode:checkpoint:service install first.",
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
    const match = /^(v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+)\.(\d+)$/.exec(
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
  const buildNumbers = latestBuildNumbers(
    splitLines(git(repoRoot, ["tag", "--list", `${BUILD_PREFIX}*`])),
  );
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
    return {
      status: "success",
      upstreamTag,
      commitsRebased: Number(trailers["Fork-Commits-Rebased"] ?? inferredCommits),
      finishedAt: trailers["Finished-At"] ?? trailers["Created-At"] ?? taggerDate,
      durationMs: Number(trailers["Duration-Ms"]),
      checkpoint: commit.slice(0, 9),
      main: commit === remoteState.remoteMain ? "yes" : "—",
      build: build === undefined ? "—" : `#${build}`,
    };
  });
  const failures = failedRunsWithoutPublishedTags(remoteState.publishedTags, runs).map(
    (record) => ({
      status: "failed",
      upstreamTag: record.upstreamTag,
      commitsRebased: Number(record.commitsRebased),
      finishedAt: record.finishedAt,
      durationMs: Number(record.durationMs),
      checkpoint: "—",
      main: "—",
      build: "—",
      error: record.error,
      recoveryBranch: record.recoveryBranch,
    }),
  );
  return [...successes, ...failures].sort(
    (left, right) => new Date(right.finishedAt).getTime() - new Date(left.finishedAt).getTime(),
  );
}

function styledStatus(status) {
  if (status === "success") return style(ansi.green, "✓");
  if (status === "failed") return style(ansi.error, "✗");
  return style(ansi.pacific, "●");
}

function daemonSummary() {
  const uid = NodeOS.userInfo().uid;
  const result = NodeChildProcess.spawnSync("launchctl", ["print", `gui/${uid}/${SERVICE_LABEL}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error) return "Daemon: unavailable";
  if (result.status !== 0) return "Daemon: not installed";
  const state = /^\s*state = (.+)$/m.exec(result.stdout)?.[1] ?? "unknown";
  const exit = /^\s*last exit code = (.+)$/m.exec(result.stdout)?.[1] ?? "—";
  const label = state === "running" ? "running" : "idle";
  return `Daemon: ${label} · Last exit: ${exit}`;
}

function printDashboard(repoRoot, home, count, verbose) {
  const remoteState = remotePublicationState(repoRoot);
  const rows = checkpointRows(repoRoot, home, count, remoteState).slice(0, count);
  const columns = [
    { key: "status", label: "STATUS", value: (row) => (row.status === "success" ? "✓" : "✗") },
    { key: "upstreamTag", label: "UPSTREAM NIGHTLY", value: (row) => row.upstreamTag },
    { key: "commitsRebased", label: "REBASED", value: (row) => String(row.commitsRebased) },
    { key: "finishedAt", label: "FINISHED", value: (row) => formatFinished(row.finishedAt) },
    { key: "durationMs", label: "DURATION", value: (row) => formatDuration(row.durationMs) },
    { key: "checkpoint", label: "CHECKPOINT", value: (row) => row.checkpoint },
    { key: "main", label: "MAIN", value: (row) => row.main },
    { key: "build", label: "BUILD", value: (row) => row.build },
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
    `${style(ansi.projectName, "LastCode")} ${style(ansi.pacific, "nightly checkpoints")} ${style(ansi.lavender, `Showing ${rows.length}`)}`,
  );
  console.log("");
  console.log(style(ansi.iceBold, line(columns.map((column) => column.label))));
  for (const row of rows) {
    const raw = columns.map((column) => column.value(row));
    const padded = raw.map((value, index) => value.padEnd(columns[index].width));
    padded[0] = `${styledStatus(row.status)}${" ".repeat(columns[0].width - raw[0].length)}`;
    padded[1] = style(ansi.amber, padded[1]);
    for (const index of [3, 4, 5]) padded[index] = style(ansi.lavender, padded[index]);
    if (row.main === "yes") padded[6] = style(ansi.green, padded[6]);
    console.log(padded.join("  ").trimEnd());
  }

  const selectedFailures = rows.filter((row) => row.status === "failed");
  for (const detail of failureDetailLines(rows, verbose)) {
    console.log(style(ansi.error, detail));
  }

  const recoveryWorktree = findNightlySyncWorktree(repoRoot);
  if (recoveryWorktree) {
    const recoveryFailure = selectedFailures.find((failure) => failure.recoveryBranch);
    const nightly = recoveryFailure ? ` for ${recoveryFailure.upstreamTag}` : "";
    console.log("");
    console.log(
      style(
        ansi.yellow,
        `Action required: checkpoint recovery${nightly} is blocking the daemon at ${recoveryWorktree}.`,
      ),
    );
    console.log(style(ansi.lavender, `Start with: git -C ${shellQuote(recoveryWorktree)} status`));
    console.log(
      style(
        ansi.lavender,
        `Resolve and stage the conflicts, then run: git -C ${shellQuote(recoveryWorktree)} rebase --continue`,
      ),
    );
  }

  const upstreamTags = splitLines(git(repoRoot, ["tag", "--list", "v*-nightly.*"])).sort(
    (left, right) => compareNightlies(right, left),
  );
  const latestVisibleCheckpoint = rows.find((row) => row.status === "success");
  const latestCheckpoint = checkpointTagsWithoutUnpublishedFailures(
    splitLines(git(repoRoot, ["tag", "--list", `${CHECKPOINT_PREFIX}v*-nightly.*`])),
    remoteState.publishedTags,
    readRuns(home),
  )
    .map((tag) => tag.slice(CHECKPOINT_PREFIX.length))
    .sort((left, right) => compareNightlies(right, left))
    .at(0);
  const latestUpstream = upstreamTags.at(0);
  const freshness = checkpointFreshness(latestUpstream, latestCheckpoint);
  console.log("");
  console.log(style(ansi.lavender, daemonSummary()));
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
}

function main(argv) {
  const options = parseOptions(argv);
  if (options.help) {
    console.log("Usage: lastcode-checkpoints [-n COUNT] [--verbose] [--repo PATH] [--install]");
    return;
  }
  const home = NodeOS.homedir();
  const repoRoot = resolveConfiguredRepo(home, options.repoRoot);
  if (options.install) {
    installCommand(repoRoot, home);
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
