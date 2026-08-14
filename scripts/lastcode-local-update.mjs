#!/usr/bin/env node

// The desktop app runs this file with Electron's bundled Node runtime. Keep it
// dependency-free so an older LastCode build can inspect and build a newer
// checkpoint before that checkpoint's dependencies have been installed.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const CHECKPOINT_PREFIX = "lastcode/checkpoint/";
const RESULT_PREFIX = "LASTCODE_LOCAL_UPDATE_RESULT=";

function run(cwd, command, args, options = {}) {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio:
      options.logFd === undefined
        ? ["ignore", "pipe", "pipe"]
        : ["ignore", options.logFd, options.logFd],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = options.logFd === undefined ? result.stderr.trim() : "";
    throw new Error(
      [`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.`, details]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return options.logFd === undefined ? result.stdout.trim() : "";
}

function git(repoRoot, args) {
  return run(repoRoot, "git", args);
}

function splitLines(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function parseNightlyVersion(value) {
  const normalized = value.startsWith("v") ? value : `v${value}`;
  const match = /^v(\d+)\.(\d+)\.(\d+)-nightly\.(\d{8})\.(\d+)$/.exec(normalized);
  if (!match) return undefined;
  return { tag: normalized, parts: match.slice(1).map(Number) };
}

export function compareNightlyVersions(left, right) {
  const leftVersion = parseNightlyVersion(left);
  const rightVersion = parseNightlyVersion(right);
  if (!leftVersion || !rightVersion) throw new Error("Cannot compare invalid nightly versions.");
  for (let index = 0; index < leftVersion.parts.length; index += 1) {
    const difference = leftVersion.parts[index] - rightVersion.parts[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

export function resolveLatestCheckpointTag(tags) {
  return tags
    .filter((tag) => tag.startsWith(CHECKPOINT_PREFIX))
    .filter((tag) => parseNightlyVersion(tag.slice(CHECKPOINT_PREFIX.length)) !== undefined)
    .toSorted((left, right) =>
      compareNightlyVersions(
        right.slice(CHECKPOINT_PREFIX.length),
        left.slice(CHECKPOINT_PREFIX.length),
      ),
    )[0];
}

export function parseOptions(argv) {
  const command = argv[0];
  if (command !== "inspect" && command !== "build") {
    throw new Error("Expected 'inspect' or 'build'.");
  }
  let repoRoot;
  let currentVersion;
  let checkpointTag;
  let home = NodeOS.homedir();
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!["--repo", "--current-version", "--checkpoint", "--home"].includes(arg)) {
      throw new Error(`Unknown argument '${arg}'.`);
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${arg}.`);
    if (arg === "--repo") repoRoot = NodePath.resolve(value);
    else if (arg === "--current-version") currentVersion = value;
    else if (arg === "--checkpoint") checkpointTag = value;
    else home = NodePath.resolve(value);
    index += 1;
  }
  if (!repoRoot) throw new Error("Missing --repo.");
  if (command === "inspect" && !currentVersion) throw new Error("Missing --current-version.");
  if (command === "build" && !checkpointTag) throw new Error("Missing --checkpoint.");
  return { command, repoRoot, home, currentVersion, checkpointTag };
}

export function resolveExistingBuild(outputRoot, checkpointTag, checkpointCommit) {
  const nightlyTag = checkpointTag.slice(CHECKPOINT_PREFIX.length);
  const shortCommit = checkpointCommit.slice(0, 10);
  const outputDir = NodePath.join(outputRoot, nightlyTag, shortCommit);
  const manifestPath = NodePath.join(outputDir, "build-manifest.json");
  if (!NodeFS.existsSync(manifestPath)) return undefined;
  const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8"));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.checkpointTag !== checkpointTag ||
    manifest.lastCodeCommit !== checkpointCommit
  ) {
    throw new Error(`Existing build manifest does not match ${checkpointTag}: ${manifestPath}`);
  }
  const required = ["nightly-mac.yml", ".dmg", ".zip"];
  const artifacts = NodeFS.readdirSync(outputDir);
  for (const suffix of required) {
    if (
      !artifacts.some((name) => (suffix.startsWith(".") ? name.endsWith(suffix) : name === suffix))
    ) {
      throw new Error(`Existing build is incomplete at ${outputDir}; missing ${suffix}.`);
    }
  }
  return { outputDir, manifestPath };
}

export function quarantineIncompleteBuild(
  outputRoot,
  checkpointTag,
  checkpointCommit,
  suffix = `${new Date().toISOString().replaceAll(":", "").replaceAll(".", "")}-${process.pid}`,
) {
  const nightlyTag = checkpointTag.slice(CHECKPOINT_PREFIX.length);
  const shortCommit = checkpointCommit.slice(0, 10);
  const outputDir = NodePath.join(outputRoot, nightlyTag, shortCommit);
  if (!NodeFS.existsSync(outputDir)) return undefined;
  const quarantinePath = `${outputDir}.incomplete-${suffix}`;
  if (NodeFS.existsSync(quarantinePath)) {
    throw new Error(`Incomplete-build quarantine already exists at ${quarantinePath}.`);
  }
  NodeFS.renameSync(outputDir, quarantinePath);
  return quarantinePath;
}

function inspect(options) {
  if (!parseNightlyVersion(options.currentVersion)) {
    throw new Error(`Installed version '${options.currentVersion}' is not a LastCode nightly.`);
  }
  const checkpointTags = splitLines(
    git(options.repoRoot, ["tag", "--list", `${CHECKPOINT_PREFIX}v*-nightly.*`]),
  );
  const checkpointTag = resolveLatestCheckpointTag(checkpointTags);
  if (!checkpointTag) throw new Error("No local LastCode checkpoint tags were found.");
  const nightlyTag = checkpointTag.slice(CHECKPOINT_PREFIX.length);
  const availableVersion = nightlyTag.slice(1);
  if (compareNightlyVersions(availableVersion, options.currentVersion) <= 0) {
    return { schemaVersion: 1, status: "up-to-date", checkpointTag, availableVersion };
  }

  const currentCheckpoint = `${CHECKPOINT_PREFIX}v${options.currentVersion}`;
  const hasCurrentCheckpoint =
    git(options.repoRoot, ["tag", "--list", currentCheckpoint]) === currentCheckpoint;
  const base = hasCurrentCheckpoint ? currentCheckpoint : `v${options.currentVersion}`;
  const releaseNotes = splitLines(
    git(options.repoRoot, ["log", "--format=%s", "--no-merges", `${base}..${checkpointTag}`]),
  ).slice(0, 40);
  return {
    schemaVersion: 1,
    status: "available",
    checkpointTag,
    availableVersion,
    releaseNotes,
  };
}

function resolveMise(home) {
  const candidates = [
    process.env.MISE_BIN,
    "/opt/homebrew/bin/mise",
    "/usr/local/bin/mise",
    NodePath.join(home, ".local", "bin", "mise"),
  ].filter(Boolean);
  const found = candidates.find((candidate) => NodeFS.existsSync(candidate));
  if (!found) throw new Error("mise was not found. Install mise or set MISE_BIN.");
  return found;
}

export function prepareBuildWorktree(repoRoot, worktreePath, checkpointTag, logFd) {
  const sourceCommonDir = NodePath.resolve(
    repoRoot,
    git(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  );
  if (NodeFS.existsSync(worktreePath)) {
    const status = git(worktreePath, ["status", "--porcelain", "--untracked-files=all"]);
    if (status) throw new Error(`Dedicated local-update worktree is not clean:\n${status}`);
    const targetCommonDir = git(worktreePath, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    if (NodePath.resolve(targetCommonDir) !== sourceCommonDir) {
      throw new Error(`Refusing to reuse unrelated directory ${worktreePath}.`);
    }
    run(worktreePath, "git", ["checkout", "--detach", "--force", checkpointTag], { logFd });
  } else {
    NodeFS.mkdirSync(NodePath.dirname(worktreePath), { recursive: true });
    run(repoRoot, "git", ["worktree", "add", "--detach", worktreePath, checkpointTag], { logFd });
  }
  const status = git(worktreePath, ["status", "--porcelain", "--untracked-files=all"]);
  if (status) throw new Error(`Dedicated local-update worktree is not clean:\n${status}`);
}

function build(options) {
  if (!options.checkpointTag.startsWith(CHECKPOINT_PREFIX)) {
    throw new Error(`Invalid checkpoint tag '${options.checkpointTag}'.`);
  }
  const checkpointCommit = git(options.repoRoot, [
    "rev-parse",
    `${options.checkpointTag}^{commit}`,
  ]);
  const updateRoot = NodePath.join(options.home, ".lastcode", "local-updates");
  const outputRoot = NodePath.join(updateRoot, "artifacts");
  let existing;
  let incompleteBuildError;
  try {
    existing = resolveExistingBuild(outputRoot, options.checkpointTag, checkpointCommit);
  } catch (error) {
    incompleteBuildError = error;
  }
  if (existing) {
    return { schemaVersion: 1, status: "built", checkpointTag: options.checkpointTag, ...existing };
  }

  NodeFS.mkdirSync(updateRoot, { recursive: true });
  const logPath = NodePath.join(updateRoot, "build.log");
  const logFd = NodeFS.openSync(logPath, "a", 0o600);
  try {
    NodeFS.writeSync(logFd, `\n[${new Date().toISOString()}] Building ${options.checkpointTag}\n`);
    const quarantinePath = quarantineIncompleteBuild(
      outputRoot,
      options.checkpointTag,
      checkpointCommit,
    );
    if (quarantinePath) {
      NodeFS.writeSync(
        logFd,
        `Quarantined incomplete output at ${quarantinePath}.${
          incompleteBuildError instanceof Error ? ` ${incompleteBuildError.message}` : ""
        }\n`,
      );
    }
    const worktreePath = NodePath.join(updateRoot, "build-worktree");
    prepareBuildWorktree(options.repoRoot, worktreePath, options.checkpointTag, logFd);
    const installer = NodePath.join(options.repoRoot, "node_modules", ".bin", "vp");
    if (!NodeFS.existsSync(installer)) {
      throw new Error(`Checkpoint automation dependencies are missing at ${installer}.`);
    }
    run(worktreePath, installer, ["install", "--frozen-lockfile"], { logFd });
    const mise = resolveMise(options.home);
    const nodeCommand = ["exec", "node@24.13.1", "--", "node"];
    run(
      worktreePath,
      mise,
      [
        ...nodeCommand,
        "scripts/lastcode-local-ci.ts",
        "--full",
        "--checkpoint",
        options.checkpointTag,
      ],
      { logFd },
    );
    run(
      worktreePath,
      mise,
      [
        ...nodeCommand,
        "scripts/lastcode-build-mac-arm64.ts",
        "--checkpoint",
        options.checkpointTag,
        "--output-root",
        outputRoot,
      ],
      { logFd },
    );
  } catch (error) {
    throw new Error(
      `Local LastCode build failed. See ${logPath}. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    NodeFS.closeSync(logFd);
  }

  const built = resolveExistingBuild(outputRoot, options.checkpointTag, checkpointCommit);
  if (!built)
    throw new Error(`Build completed without a usable artifact for ${options.checkpointTag}.`);
  return {
    schemaVersion: 1,
    status: "built",
    checkpointTag: options.checkpointTag,
    ...built,
  };
}

function main(argv) {
  const options = parseOptions(argv);
  const result = options.command === "inspect" ? inspect(options) : build(options);
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `[lastcode:local-update] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

export { RESULT_PREFIX };
