#!/usr/bin/env node
// LastCode managed command: lastcode-build

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import { LOCK_MODULE_MANAGED_MARKER } from "./lastcode-lock.mjs";
import {
  BUILD_PHASES,
  estimateBuildProgress,
  resolveBuildPhaseIndex,
} from "./lib/lastcode-build-progress.ts";
const CHECKPOINT_PREFIX = "lastcode/checkpoint/";
const REVISION_PREFIX = "lastcode/revision/";
const RESULT_PREFIX = "LASTCODE_LOCAL_UPDATE_RESULT=";
const LOG_POLL_INTERVAL_MS = 400;
const BUILD_MANAGED_MARKER = "LastCode managed command: lastcode-build";
const UPDATE_HELPER_MANAGED_MARKER = "LastCode managed helper: lastcode-local-update";
const PROGRESS_MODEL_MANAGED_MARKER = "LastCode managed module: local-build-progress";

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
  return `#!/bin/sh\n# ${BUILD_MANAGED_MARKER}\nexec mise exec node@24.13.1 -- node ${shellQuote(modulePath)} "$@"\n`;
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
  const match = /^v(\d+)\.(\d+)\.(\d+)-nightly\.(\d{8})\.(\d+)(?:\.(\d+))?$/.exec(tag);
  if (!match) return undefined;
  return [...match.slice(1, 6).map(Number), Number(match[6] ?? 0)];
}

function installableVersion(tag) {
  const prefix = tag.startsWith(CHECKPOINT_PREFIX)
    ? CHECKPOINT_PREFIX
    : tag.startsWith(REVISION_PREFIX)
      ? REVISION_PREFIX
      : undefined;
  if (!prefix) return undefined;
  const version = tag.slice(prefix.length);
  const parts = parseNightly(version);
  if (!parts) return undefined;
  const revision = parts.at(-1);
  if (prefix === CHECKPOINT_PREFIX && revision !== 0) return undefined;
  if (prefix === REVISION_PREFIX && revision === 0) return undefined;
  return { parts, prefix, version };
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
  const validTags = tags.filter((tag) => installableVersion(tag) !== undefined);
  if (validTags.length === 0) throw new Error("No local LastCode installable tags were found.");
  if (!selector) {
    return validTags.toSorted((left, right) =>
      compareNightlies(installableVersion(right).version, installableVersion(left).version),
    )[0];
  }

  const normalized =
    selector.startsWith(CHECKPOINT_PREFIX) || selector.startsWith(REVISION_PREFIX)
      ? selector
      : selector.startsWith("v")
        ? `${parseNightly(selector)?.at(-1) === 0 ? CHECKPOINT_PREFIX : REVISION_PREFIX}${selector}`
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
  const matches = validTags.filter((tag) => installableVersion(tag).parts[4] === Number(selector));
  if (matches.length > 0) {
    const nightlyIdentities = new Set(
      matches.map((tag) => installableVersion(tag).parts.slice(0, 5).join(".")),
    );
    if (nightlyIdentities.size > 1) {
      throw new Error(
        `Checkpoint selector '${selector}' is ambiguous:\n${matches.map((tag) => `  ${tag}`).join("\n")}`,
      );
    }
    return matches.toSorted((left, right) =>
      compareNightlies(installableVersion(right).version, installableVersion(left).version),
    )[0];
  }
  if (matches.length === 0) throw new Error(`Checkpoint ending in .${selector} was not found.`);
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
  assertManagedSymlink(exposed, target);
  const existing = NodeFS.lstatSync(exposed, { throwIfNoEntry: false });
  if (existing) {
    NodeFS.unlinkSync(exposed);
  }
  NodeFS.symlinkSync(target, exposed);
}

function assertManagedSymlink(exposed, target) {
  const existing = NodeFS.lstatSync(exposed, { throwIfNoEntry: false });
  if (existing && (!existing.isSymbolicLink() || NodeFS.readlinkSync(exposed) !== target)) {
    throw new Error(`${exposed} already exists and is not managed by LastCode.`);
  }
}

function assertManagedProgressModelDirectory(directory, progressModel) {
  const existing = NodeFS.lstatSync(directory, { throwIfNoEntry: false });
  if (!existing) return;

  const installedModel = NodeFS.lstatSync(progressModel, { throwIfNoEntry: false });
  if (
    !existing.isDirectory() ||
    !installedModel?.isFile() ||
    !NodeFS.readFileSync(progressModel, "utf8").includes(PROGRESS_MODEL_MANAGED_MARKER)
  ) {
    throw new Error(
      `Refusing to modify ${directory} because it is not a LastCode-managed directory.`,
    );
  }
}

export function installCommandAssets(automationWorktree, home) {
  const binDirectory = NodePath.join(home, ".lastcode", "bin");
  const lockModuleTarget = NodePath.join(binDirectory, "lastcode-lock.mjs");
  const libDirectory = NodePath.join(binDirectory, "lib");
  const moduleTarget = NodePath.join(binDirectory, "lastcode-build.mjs");
  const helperTarget = NodePath.join(binDirectory, "lastcode-local-update.mjs");
  const progressModelTarget = NodePath.join(libDirectory, "lastcode-build-progress.ts");
  const target = NodePath.join(binDirectory, "lastcode-build");
  const exposedDirectory = NodePath.join(home, ".local", "bin");
  const exposed = NodePath.join(exposedDirectory, "lastcode-build");
  const configPath = NodePath.join(home, ".lastcode", "dashboard.json");

  assertManagedFile(lockModuleTarget, LOCK_MODULE_MANAGED_MARKER);
  assertManagedProgressModelDirectory(libDirectory, progressModelTarget);
  assertManagedFile(moduleTarget, BUILD_MANAGED_MARKER);
  assertManagedFile(helperTarget, UPDATE_HELPER_MANAGED_MARKER);
  assertManagedFile(progressModelTarget, PROGRESS_MODEL_MANAGED_MARKER);
  assertManagedFile(target, BUILD_MANAGED_MARKER);
  assertManagedSymlink(exposed, target);

  NodeFS.mkdirSync(binDirectory, { recursive: true });
  NodeFS.mkdirSync(libDirectory, { recursive: true });
  NodeFS.mkdirSync(exposedDirectory, { recursive: true });
  NodeFS.copyFileSync(new NodeURL.URL("./lastcode-lock.mjs", import.meta.url), lockModuleTarget);
  NodeFS.copyFileSync(NodeURL.fileURLToPath(import.meta.url), moduleTarget);
  NodeFS.copyFileSync(
    NodePath.join(
      NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
      "lastcode-local-update.mjs",
    ),
    helperTarget,
  );
  NodeFS.copyFileSync(
    NodePath.join(
      NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
      "lib",
      "lastcode-build-progress.ts",
    ),
    progressModelTarget,
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

function installCommand(repoRoot, home) {
  const automationWorktree = selectAutomationWorktree(repoRoot);
  if (!automationWorktree) {
    throw new Error(
      "LastCode automation worktree is not installed. Run pnpm lastcode:checkpoint:service install first.",
    );
  }
  installCommandAssets(automationWorktree, home);
}

function assertManagedFile(path, marker) {
  const existing = NodeFS.lstatSync(path, { throwIfNoEntry: false });
  if (existing && (!existing.isFile() || !NodeFS.readFileSync(path, "utf8").includes(marker))) {
    throw new Error(`Refusing to modify ${path} because it is not a LastCode-managed file.`);
  }
}

export function uninstallCommand(home) {
  const binDirectory = NodePath.join(home, ".lastcode", "bin");
  const lockModuleTarget = NodePath.join(binDirectory, "lastcode-lock.mjs");
  const libDirectory = NodePath.join(binDirectory, "lib");
  const moduleTarget = NodePath.join(binDirectory, "lastcode-build.mjs");
  const helperTarget = NodePath.join(binDirectory, "lastcode-local-update.mjs");
  const installerModuleTarget = NodePath.join(binDirectory, "lastcode-install.mjs");
  const progressModelTarget = NodePath.join(libDirectory, "lastcode-build-progress.ts");
  const target = NodePath.join(binDirectory, "lastcode-build");
  const exposed = NodePath.join(home, ".local", "bin", "lastcode-build");
  const exposedEntry = NodeFS.lstatSync(exposed, { throwIfNoEntry: false });
  if (exposedEntry && (!exposedEntry.isSymbolicLink() || NodeFS.readlinkSync(exposed) !== target)) {
    throw new Error(`Refusing to remove ${exposed} because it is not managed by LastCode.`);
  }
  assertManagedFile(lockModuleTarget, LOCK_MODULE_MANAGED_MARKER);
  assertManagedProgressModelDirectory(libDirectory, progressModelTarget);
  assertManagedFile(moduleTarget, BUILD_MANAGED_MARKER);
  assertManagedFile(helperTarget, UPDATE_HELPER_MANAGED_MARKER);
  assertManagedFile(progressModelTarget, PROGRESS_MODEL_MANAGED_MARKER);
  assertManagedFile(target, BUILD_MANAGED_MARKER);

  if (exposedEntry) NodeFS.unlinkSync(exposed);
  for (const path of [moduleTarget, helperTarget, progressModelTarget, target]) {
    NodeFS.rmSync(path, { force: true });
  }
  if (!NodeFS.existsSync(installerModuleTarget)) NodeFS.rmSync(lockModuleTarget, { force: true });
  try {
    NodeFS.rmdirSync(libDirectory);
  } catch (error) {
    if (error?.code !== "ENOTEMPTY" && error?.code !== "ENOENT") throw error;
  }
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
    console.log("CHECKPOINT may be 1090, a full version, or a checkpoint/revision tag.");
    console.log("Without CHECKPOINT, the newest local installable revision is built.");
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
  const tags = splitLines(
    runGit(repoRoot, [
      "tag",
      "--list",
      `${CHECKPOINT_PREFIX}v*-nightly.*`,
      `${REVISION_PREFIX}v*-nightly.*`,
    ]),
  );
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
