#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const CHECKPOINT_PREFIX = "lastcode/checkpoint/";
const RESULT_PREFIX = "LASTCODE_LOCAL_UPDATE_RESULT=";

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
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--install") install = true;
    else if (arg === "-c" || arg === "--checkpoint" || arg === "--repo") {
      const value = argv[index + 1];
      if (!value) throw new Error(`Missing value for ${arg}.`);
      if (arg === "--repo") repoRoot = value;
      else checkpoint = value;
      index += 1;
    } else if (arg === "-h" || arg === "--help") {
      return { help: true, checkpoint, install, repoRoot };
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown argument '${arg}'.`);
    } else if (checkpoint) {
      throw new Error(`Unexpected second checkpoint selector '${arg}'.`);
    } else {
      checkpoint = arg;
    }
  }
  return { help: false, checkpoint, install, repoRoot };
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
  const target = NodePath.join(binDirectory, "lastcode-build");
  const exposedDirectory = NodePath.join(home, ".local", "bin");
  const exposed = NodePath.join(exposedDirectory, "lastcode-build");
  const configPath = NodePath.join(home, ".lastcode", "dashboard.json");

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
  replaceManagedSymlink(exposed, target);

  console.log(`Installed ${target} with the pinned Node 24 runtime`);
  console.log(`Exposed on PATH as ${exposed}`);
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

function buildCheckpoint(repoRoot, home, checkpointTag) {
  const helperPath = NodePath.join(repoRoot, "scripts", "lastcode-local-update.mjs");
  if (!NodeFS.existsSync(helperPath)) {
    throw new Error(`Local build helper is missing at ${helperPath}.`);
  }
  const logPath = NodePath.join(home, ".lastcode", "local-updates", "build.log");
  console.log(
    `${style(ansi.projectName, "LastCode")} ${style(ansi.pacific, "build")} ${style(ansi.iceBold, checkpointTag)}`,
  );
  console.log(style(ansi.lavender, `Full CI and packaging logs: ${logPath}`));

  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [helperPath, "build", "--repo", repoRoot, "--home", home, "--checkpoint", checkpointTag],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `Local build failed with exit code ${result.status}.`);
  }
  const build = parseBuildResult(result.stdout);
  const dmg = NodeFS.readdirSync(build.outputDir).find((entry) => entry.endsWith(".dmg"));
  if (!dmg) throw new Error(`Build completed without a DMG in ${build.outputDir}.`);
  console.log(style(ansi.green, "Build ready"));
  console.log(NodePath.join(build.outputDir, dmg));
}

function main(argv) {
  const options = parseOptions(argv);
  if (options.help) {
    console.log("Usage: lastcode-build [CHECKPOINT]");
    console.log("       lastcode-build --checkpoint CHECKPOINT");
    console.log("");
    console.log("CHECKPOINT may be 1090, a full nightly tag, or a lastcode/checkpoint tag.");
    console.log("Without CHECKPOINT, the newest local checkpoint is built.");
    return;
  }
  const home = NodeOS.homedir();
  const repoRoot = resolveConfiguredRepo(home, options.repoRoot);
  if (options.install) {
    installCommand(repoRoot, home);
    return;
  }
  const tags = splitLines(runGit(repoRoot, ["tag", "--list", `${CHECKPOINT_PREFIX}v*-nightly.*`]));
  buildCheckpoint(repoRoot, home, resolveCheckpointTag(tags, options.checkpoint));
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
      style(
        ansi.error,
        `lastcode-build: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    process.exitCode = 1;
  }
}
