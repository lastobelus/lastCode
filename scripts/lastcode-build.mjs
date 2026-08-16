#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const CHECKPOINT_PREFIX = "lastcode/checkpoint/";
const RESULT_PREFIX = "LASTCODE_LOCAL_UPDATE_RESULT=";
const LOG_POLL_INTERVAL_MS = 400;

export const BUILD_PHASES = [
  { marker: "Building lastcode/checkpoint/", start: 0, estimateMs: 10_000 },
  { marker: "Preparing worktree", start: 0.01, estimateMs: 20_000 },
  { marker: "Scope: all", start: 0.03, estimateMs: 45_000 },
  { marker: "Done in", start: 0.08, estimateMs: 5_000 },
  { marker: "[lastcode:ci] 1/11", start: 0.09, estimateMs: 5_000 },
  { marker: "[lastcode:ci] 2/11", start: 0.1, estimateMs: 30_000 },
  { marker: "[lastcode:ci] 3/11", start: 0.14, estimateMs: 50_000 },
  { marker: "[lastcode:ci] 4/11", start: 0.2, estimateMs: 300_000 },
  { marker: "[lastcode:ci] 5/11", start: 0.35, estimateMs: 10_000 },
  { marker: "[lastcode:ci] 6/11", start: 0.36, estimateMs: 120_000 },
  { marker: "[lastcode:ci] 7/11", start: 0.49, estimateMs: 5_000 },
  { marker: "[lastcode:ci] 8/11", start: 0.5, estimateMs: 60_000 },
  { marker: "[lastcode:ci] 9/11", start: 0.55, estimateMs: 5_000 },
  { marker: "[lastcode:ci] 10/11", start: 0.56, estimateMs: 90_000 },
  { marker: "[lastcode:ci] 11/11", start: 0.64, estimateMs: 120_000 },
  { marker: "[lastcode:ci] Full local CI passed", start: 0.75, estimateMs: 5_000 },
  { marker: "Reusing full local CI stamp", start: 0.75, estimateMs: 5_000 },
  { marker: "[lastcode:build] Building", start: 0.76, estimateMs: 10_000 },
  {
    marker: "[desktop-artifact] Building desktop/server/web artifacts",
    start: 0.78,
    estimateMs: 35_000,
  },
  { marker: "web client branding", start: 0.84, estimateMs: 10_000 },
  { marker: "[desktop-artifact] Staging release app", start: 0.86, estimateMs: 15_000 },
  {
    marker: "[desktop-artifact] Installing staged production dependencies",
    start: 0.88,
    estimateMs: 12_000,
  },
  { marker: "[desktop-artifact] Building mac/dmg", start: 0.94, estimateMs: 110_000 },
  { marker: "[desktop-artifact] Done. Artifacts", start: 0.99, estimateMs: 10_000 },
  { marker: "[lastcode:build] Created", start: 0.995, estimateMs: 5_000 },
];

const ansiEnabled =
  process.stdout.isTTY && !("NO_COLOR" in process.env) && process.env.TERM !== "dumb";
const ansi = {
  reset: "\u001b[0m",
  projectName: "\u001b[1m\u001b[38;2;255;162;28m",
  lavender: "\u001b[38;2;126;107;143m",
  pacific: "\u001b[38;2;24;143;167m",
  iceBold: "\u001b[1m\u001b[38;2;203;247;237m",
  error: "\u001b[38;2;203;0;44m",
  green: "\u001b[1;32m",
};

function style(code, value) {
  return ansiEnabled ? `${code}${value}${ansi.reset}` : value;
}

export function resolveBuildPhaseIndex(logChunk, currentIndex = 0) {
  let resolved = currentIndex;
  for (let index = currentIndex; index < BUILD_PHASES.length; index += 1) {
    if (logChunk.includes(BUILD_PHASES[index].marker)) resolved = index;
  }
  return resolved;
}

export function estimateBuildProgress(phaseIndex, elapsedMs) {
  const phase = BUILD_PHASES[phaseIndex] ?? BUILD_PHASES[0];
  const nextStart = BUILD_PHASES[phaseIndex + 1]?.start ?? 1;
  const phaseFraction = Math.min(0.95, Math.max(0, elapsedMs) / phase.estimateMs);
  return phase.start + (nextStart - phase.start) * phaseFraction;
}

export function renderProgressBar(progress, width = 44) {
  const bounded = Math.min(1, Math.max(0, progress));
  const filled = Math.round(bounded * width);
  return `<${"=".repeat(filled)}${"-".repeat(width - filled)}> ${String(Math.round(bounded * 100)).padStart(3)}% est.`;
}

export function sanitizeLogLine(value, width = 80) {
  const normalized = NodeUtil.stripVTControlCharacters(value).replaceAll(/\s+/g, " ").trim();
  if (normalized.length <= width) return normalized;
  return `${normalized.slice(0, Math.max(1, width - 1))}…`;
}

class BuildProgressDisplay {
  constructor(logPath) {
    this.logPath = logPath;
    this.offset = NodeFS.existsSync(logPath) ? NodeFS.statSync(logPath).size : 0;
    this.phaseIndex = 0;
    this.phaseStartedAt = Date.now();
    this.lastLine = "Starting local build…";
    this.scanCarry = "";
    this.rendered = false;
    this.lastNonTtyPhase = -1;
  }

  readNewLog() {
    if (!NodeFS.existsSync(this.logPath)) return;
    const size = NodeFS.statSync(this.logPath).size;
    if (size < this.offset) this.offset = 0;
    if (size === this.offset) return;
    const maximumRead = 2 * 1024 * 1024;
    const position = Math.max(this.offset, size - maximumRead);
    const length = size - position;
    const buffer = Buffer.alloc(length);
    const descriptor = NodeFS.openSync(this.logPath, "r");
    try {
      NodeFS.readSync(descriptor, buffer, 0, length, position);
    } finally {
      NodeFS.closeSync(descriptor);
    }
    this.offset = size;
    const chunk = buffer.toString("utf8");
    const scanText = `${this.scanCarry}${NodeUtil.stripVTControlCharacters(chunk)}`;
    this.scanCarry = scanText.slice(-256);
    const resolvedPhase = resolveBuildPhaseIndex(scanText, this.phaseIndex);
    if (resolvedPhase !== this.phaseIndex) {
      this.phaseIndex = resolvedPhase;
      this.phaseStartedAt = Date.now();
    }
    const lines = chunk.replaceAll("\r", "\n").split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = sanitizeLogLine(lines[index], Math.max(30, (process.stdout.columns ?? 80) - 1));
      if (line) {
        this.lastLine = line;
        break;
      }
    }
  }

  progress() {
    return estimateBuildProgress(this.phaseIndex, Date.now() - this.phaseStartedAt);
  }

  render() {
    this.readNewLog();
    const progress = this.progress();
    if (!process.stdout.isTTY) {
      if (this.lastNonTtyPhase !== this.phaseIndex) {
        console.log(`[${Math.round(progress * 100)}% est.] ${this.lastLine}`);
        this.lastNonTtyPhase = this.phaseIndex;
      }
      return;
    }
    const terminalWidth = process.stdout.columns ?? 80;
    const barWidth = Math.max(16, Math.min(52, terminalWidth - 12));
    const status = sanitizeLogLine(this.lastLine, Math.max(30, terminalWidth - 1));
    const bar = renderProgressBar(progress, barWidth);
    if (this.rendered) process.stdout.write("\r\u001b[2K\u001b[1A\r\u001b[2K");
    process.stdout.write(`${status}\n${bar}`);
    this.rendered = true;
  }

  start() {
    this.render();
    this.timer = setInterval(() => this.render(), LOG_POLL_INTERVAL_MS);
  }

  stop(completed) {
    if (this.timer) clearInterval(this.timer);
    this.readNewLog();
    if (completed) {
      this.phaseIndex = BUILD_PHASES.length - 1;
      this.phaseStartedAt = Date.now() - BUILD_PHASES.at(-1).estimateMs;
      this.lastLine = "Build complete";
    }
    this.render();
    if (process.stdout.isTTY && this.rendered) process.stdout.write("\n");
  }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function renderLauncher(modulePath) {
  return `#!/bin/sh\nexec mise exec node@24.13.1 -- node ${shellQuote(modulePath)} "$@"\n`;
}

function runGit(repoRoot, args) {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
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

function parseNightly(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)-nightly\.(\d{8})\.(\d+)$/.exec(tag);
  return match?.slice(1).map(Number);
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

export function parseOptions(argv) {
  let checkpoint;
  let install = false;
  let repoRoot;
  let uninstall = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--install") install = true;
    else if (arg === "--uninstall") uninstall = true;
    else if (arg === "-c" || arg === "--checkpoint" || arg === "--repo") {
      const value = argv[index + 1];
      if (!value) throw new Error(`Missing value for ${arg}.`);
      if (arg === "--repo") repoRoot = value;
      else checkpoint = value;
      index += 1;
    } else if (arg === "-h" || arg === "--help") {
      return { help: true, checkpoint, install, repoRoot, uninstall };
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown argument '${arg}'.`);
    } else if (checkpoint) {
      throw new Error(`Unexpected second checkpoint selector '${arg}'.`);
    } else {
      checkpoint = arg;
    }
  }
  if (uninstall && (install || checkpoint || repoRoot)) {
    throw new Error("--uninstall cannot be combined with build or install options.");
  }
  return { help: false, checkpoint, install, repoRoot, uninstall };
}

export function resolveCheckpointTag(tags, selector) {
  const validTags = tags.filter((tag) => {
    if (!tag.startsWith(CHECKPOINT_PREFIX)) return false;
    return parseNightly(tag.slice(CHECKPOINT_PREFIX.length)) !== undefined;
  });
  if (validTags.length === 0) throw new Error("No local LastCode checkpoint tags were found.");
  if (!selector) {
    return validTags.toSorted((left, right) =>
      compareNightlies(right.slice(CHECKPOINT_PREFIX.length), left.slice(CHECKPOINT_PREFIX.length)),
    )[0];
  }

  const normalized = selector.startsWith(CHECKPOINT_PREFIX)
    ? selector
    : selector.startsWith("v")
      ? `${CHECKPOINT_PREFIX}${selector}`
      : undefined;
  if (normalized) {
    if (validTags.includes(normalized)) return normalized;
    throw new Error(`Checkpoint '${selector}' was not found.`);
  }
  if (!/^\d+$/.test(selector)) {
    throw new Error(
      `Invalid checkpoint selector '${selector}'. Use a number such as 1090 or a full nightly tag.`,
    );
  }
  const matches = validTags.filter((tag) => tag.endsWith(`.${selector}`));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error(`Checkpoint ending in .${selector} was not found.`);
  throw new Error(
    `Checkpoint selector '${selector}' is ambiguous:\n${matches.map((tag) => `  ${tag}`).join("\n")}`,
  );
}

function resolveConfiguredRepo(home, override) {
  if (override) return NodePath.resolve(override);
  if (process.env.LASTCODE_REPO) return NodePath.resolve(process.env.LASTCODE_REPO);
  const configPath = NodePath.join(home, ".lastcode", "dashboard.json");
  if (NodeFS.existsSync(configPath)) {
    const config = JSON.parse(NodeFS.readFileSync(configPath, "utf8"));
    if (typeof config.repoRoot === "string") return config.repoRoot;
  }
  return runGit(process.cwd(), ["rev-parse", "--show-toplevel"]);
}

function selectAutomationWorktree(repoRoot) {
  const worktrees = runGit(repoRoot, ["worktree", "list", "--porcelain"])
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
  return worktrees.find((worktree) => NodePath.basename(worktree) === "lastcode-automation");
}

function replaceManagedSymlink(exposed, target) {
  const existing = NodeFS.lstatSync(exposed, { throwIfNoEntry: false });
  if (existing) {
    if (!existing.isSymbolicLink() || NodeFS.readlinkSync(exposed) !== target) {
      throw new Error(`${exposed} already exists and is not managed by LastCode.`);
    }
    NodeFS.unlinkSync(exposed);
  }
  NodeFS.symlinkSync(target, exposed);
}

function installCommand(repoRoot, home) {
  const automationWorktree = selectAutomationWorktree(repoRoot);
  if (!automationWorktree) {
    throw new Error(
      "LastCode automation worktree is not installed. Run pnpm lastcode:checkpoint:service install first.",
    );
  }
  const binDirectory = NodePath.join(home, ".lastcode", "bin");
  const moduleTarget = NodePath.join(binDirectory, "lastcode-build.mjs");
  const helperTarget = NodePath.join(binDirectory, "lastcode-local-update.mjs");
  const target = NodePath.join(binDirectory, "lastcode-build");
  const exposedDirectory = NodePath.join(home, ".local", "bin");
  const exposed = NodePath.join(exposedDirectory, "lastcode-build");
  const configPath = NodePath.join(home, ".lastcode", "dashboard.json");

  NodeFS.mkdirSync(binDirectory, { recursive: true });
  NodeFS.mkdirSync(exposedDirectory, { recursive: true });
  NodeFS.copyFileSync(NodeURL.fileURLToPath(import.meta.url), moduleTarget);
  NodeFS.copyFileSync(
    NodePath.join(
      NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
      "lastcode-local-update.mjs",
    ),
    helperTarget,
  );
  NodeFS.writeFileSync(target, renderLauncher(moduleTarget), { encoding: "utf8", mode: 0o755 });
  NodeFS.chmodSync(target, 0o755);
  NodeFS.writeFileSync(
    configPath,
    `${JSON.stringify({ repoRoot: automationWorktree }, undefined, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  replaceManagedSymlink(exposed, target);

  console.log(`Installed ${target} with the pinned Node 24 runtime`);
  console.log(`Exposed on PATH as ${exposed}`);
}

function assertManagedFile(path) {
  const existing = NodeFS.lstatSync(path, { throwIfNoEntry: false });
  if (existing && !existing.isFile()) {
    throw new Error(`Refusing to remove ${path} because it is not a LastCode-managed file.`);
  }
}

export function uninstallCommand(home) {
  const binDirectory = NodePath.join(home, ".lastcode", "bin");
  const moduleTarget = NodePath.join(binDirectory, "lastcode-build.mjs");
  const helperTarget = NodePath.join(binDirectory, "lastcode-local-update.mjs");
  const target = NodePath.join(binDirectory, "lastcode-build");
  const exposed = NodePath.join(home, ".local", "bin", "lastcode-build");
  const exposedEntry = NodeFS.lstatSync(exposed, { throwIfNoEntry: false });
  if (exposedEntry && (!exposedEntry.isSymbolicLink() || NodeFS.readlinkSync(exposed) !== target)) {
    throw new Error(`Refusing to remove ${exposed} because it is not managed by LastCode.`);
  }
  for (const path of [moduleTarget, helperTarget, target]) assertManagedFile(path);

  if (exposedEntry) NodeFS.unlinkSync(exposed);
  for (const path of [moduleTarget, helperTarget, target]) NodeFS.rmSync(path, { force: true });
  try {
    NodeFS.rmdirSync(binDirectory);
  } catch (error) {
    if (error?.code !== "ENOTEMPTY" && error?.code !== "ENOENT") throw error;
  }
  console.log("Uninstalled lastcode-build");
}

export function parseBuildResult(stdout) {
  const line = splitLines(stdout).find((entry) => entry.startsWith(RESULT_PREFIX));
  if (!line) throw new Error("The local build helper did not return a build result.");
  const result = JSON.parse(line.slice(RESULT_PREFIX.length));
  if (
    result?.schemaVersion !== 1 ||
    result.status !== "built" ||
    typeof result.outputDir !== "string"
  ) {
    throw new Error("The local build helper returned an invalid build result.");
  }
  return result;
}

async function buildCheckpoint(repoRoot, home, checkpointTag) {
  const helperPath = NodePath.join(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
    "lastcode-local-update.mjs",
  );
  if (!NodeFS.existsSync(helperPath)) {
    throw new Error(`Local build helper is missing at ${helperPath}.`);
  }
  const logPath = NodePath.join(home, ".lastcode", "local-updates", "build.log");
  console.log(
    `${style(ansi.projectName, "LastCode")} ${style(ansi.pacific, "build")} ${style(ansi.iceBold, checkpointTag)}`,
  );
  console.log(style(ansi.lavender, `Full CI and packaging logs: ${logPath}`));

  const display = new BuildProgressDisplay(logPath);
  const child = NodeChildProcess.spawn(
    process.execPath,
    [helperPath, "build", "--repo", repoRoot, "--home", home, "--checkpoint", checkpointTag],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        PATH: `${NodePath.join(repoRoot, "node_modules", ".bin")}${NodePath.delimiter}${process.env.PATH ?? ""}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  display.start();
  let completed = false;
  try {
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    if (result.code !== 0) {
      throw new Error(
        stderr.trim() ||
          `Local build failed with ${result.signal ? `signal ${result.signal}` : `exit code ${result.code}`}.`,
      );
    }
    const build = parseBuildResult(stdout);
    const dmg = NodeFS.readdirSync(build.outputDir).find((entry) => entry.endsWith(".dmg"));
    if (!dmg) throw new Error(`Build completed without a DMG in ${build.outputDir}.`);
    completed = true;
    display.stop(true);
    console.log(style(ansi.green, "Build ready"));
    console.log(NodePath.join(build.outputDir, dmg));
  } finally {
    if (!completed) display.stop(false);
  }
}

async function main(argv) {
  const options = parseOptions(argv);
  if (options.help) {
    console.log("Usage: lastcode-build [CHECKPOINT]");
    console.log("       lastcode-build --checkpoint CHECKPOINT");
    console.log("       lastcode-build --uninstall");
    console.log("");
    console.log("CHECKPOINT may be 1090, a full nightly tag, or a lastcode/checkpoint tag.");
    console.log("Without CHECKPOINT, the newest local checkpoint is built.");
    return;
  }
  const home = NodeOS.homedir();
  if (options.uninstall) {
    uninstallCommand(home);
    return;
  }
  const repoRoot = resolveConfiguredRepo(home, options.repoRoot);
  if (options.install) {
    installCommand(repoRoot, home);
    return;
  }
  const tags = splitLines(runGit(repoRoot, ["tag", "--list", `${CHECKPOINT_PREFIX}v*-nightly.*`]));
  await buildCheckpoint(repoRoot, home, resolveCheckpointTag(tags, options.checkpoint));
}

if (
  process.argv[1] &&
  NodeFS.realpathSync(process.argv[1]) ===
    NodeFS.realpathSync(NodeURL.fileURLToPath(import.meta.url))
) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(
      style(
        ansi.error,
        `lastcode-build: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    process.exitCode = 1;
  }
}
