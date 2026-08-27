#!/usr/bin/env node

// Generic, guarded synchronization for a checkout explicitly reserved for automation.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const GIT_OPERATION_MARKERS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "rebase-apply",
  "rebase-merge",
  "sequencer",
  "BISECT_LOG",
];

function fail(message, options) {
  throw new Error(message, options);
}

function validateRefName(value, label) {
  if (typeof value !== "string" || !value) fail(`${label} is required.`);
  const result = NodeChildProcess.spawnSync("git", ["check-ref-format", value], {
    encoding: "utf8",
  });
  if (result.status !== 0) fail(`${label} '${value}' is not a valid Git ref.`);
  return value;
}

function runGit(worktree, args, options = {}) {
  const result = NodeChildProcess.spawnSync("git", ["-C", worktree, ...args], {
    encoding: options.raw ? "buffer" : "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer ?? 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowStatuses?.includes(result.status)) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8").trim()
      : result.stderr.trim();
    fail(stderr || `git ${args.join(" ")} failed with ${result.status ?? "unknown"}.`);
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : result.stdout.trim();
}

function pathAndAncestors(paths) {
  const expanded = new Set();
  for (const path of paths) {
    expanded.add(path);
    let separator = path.lastIndexOf("/");
    while (separator > 0) {
      expanded.add(path.slice(0, separator));
      separator = path.lastIndexOf("/", separator - 1);
    }
  }
  return expanded;
}

function normalizeFilesystemPath(path, ignoreCase) {
  const normalized = path.normalize("NFC").replace(/\/+$/u, "");
  return ignoreCase ? normalized.toLowerCase() : normalized;
}

function ignoredTargetCollision(targetPathsRaw, ignoredPathsRaw, ignoreCase) {
  const targetPaths = targetPathsRaw.split("\0").filter(Boolean);
  const ignoredPaths = ignoredPathsRaw.split("\0").filter(Boolean);
  const normalizedTargets = targetPaths.map((path) => normalizeFilesystemPath(path, ignoreCase));
  const normalizedIgnored = ignoredPaths.map((path) => normalizeFilesystemPath(path, ignoreCase));
  const targetsAndAncestors = pathAndAncestors(normalizedTargets);
  const ignoredAndAncestors = pathAndAncestors(normalizedIgnored);
  return (
    ignoredPaths.find((_, index) => targetsAndAncestors.has(normalizedIgnored[index])) ??
    targetPaths.find((_, index) => ignoredAndAncestors.has(normalizedTargets[index])) ??
    null
  );
}

function changedInitializedGitlink(worktree, fromCommit, toCommit) {
  const raw = runGit(
    worktree,
    ["diff-tree", "-r", "--no-commit-id", "--raw", "-z", fromCommit, toCommit],
    { maxBuffer: GIT_MAX_BUFFER, raw: true },
  );
  const fields = raw.split("\0");
  for (let index = 0; index < fields.length; ) {
    const metadata = fields[index++];
    if (!metadata) continue;
    const match = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/u.exec(metadata);
    if (!match) fail(`Managed checkout reported invalid raw diff '${metadata}'.`);
    const sourcePath = fields[index++];
    if (!sourcePath) fail("Managed checkout reported a raw diff without a path.");
    const destinationPath = match[3] === "R" || match[3] === "C" ? fields[index++] : sourcePath;
    if (!destinationPath) fail("Managed checkout reported a renamed diff without a path.");
    if (
      (match[1] === "160000" || match[2] === "160000") &&
      (NodeFS.existsSync(NodePath.join(worktree, sourcePath, ".git")) ||
        NodeFS.existsSync(NodePath.join(worktree, destinationPath, ".git")))
    ) {
      return sourcePath;
    }
  }
  return null;
}

export function managedCheckoutBackupRef(prefix, commit, objectFormat = "sha1") {
  const normalizedPrefix = validateRefName(prefix, "Backup ref prefix");
  const objectIdLength = objectFormat === "sha1" ? 40 : objectFormat === "sha256" ? 64 : null;
  if (objectIdLength === null) {
    fail(`Managed checkout reported unsupported object format '${objectFormat}'.`);
  }
  if (!new RegExp(`^[0-9a-f]{${objectIdLength}}$`, "u").test(commit)) {
    fail(`Managed checkout reported invalid commit '${commit}'.`);
  }
  return `${normalizedPrefix}/${commit}`;
}

export function normalizeManagedCheckoutConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    fail("Managed checkout configuration must be an object.");
  }
  const { backupRefPrefix, branch, gitCommonDirectory, remote, remoteBranch, worktree } = config;
  if (typeof worktree !== "string" || !NodePath.isAbsolute(worktree)) {
    fail("Managed checkout worktree must be an absolute path.");
  }
  if (typeof gitCommonDirectory !== "string" || !NodePath.isAbsolute(gitCommonDirectory)) {
    fail("Managed checkout Git identity must be an absolute path.");
  }
  if (typeof remote !== "string" || !/^[A-Za-z0-9._-]+$/u.test(remote)) {
    fail("Managed checkout remote must be a simple Git remote name.");
  }
  validateRefName(`refs/heads/${branch}`, "Managed branch");
  validateRefName(`refs/heads/${remoteBranch}`, "Remote branch");
  validateRefName(backupRefPrefix, "Backup ref prefix");
  return {
    backupRefPrefix,
    branch,
    gitCommonDirectory: NodePath.resolve(gitCommonDirectory),
    remote,
    remoteBranch,
    worktree: NodePath.resolve(worktree),
  };
}

/**
 * Align an automation-owned checkout with a fetched remote branch.
 *
 * The caller must ensure no human or other process writes to the checkout while
 * this function runs. The guards detect stale configuration and ordinary dirty
 * state; they cannot make arbitrary filesystem writes participate in Git's lock.
 */
export function syncManagedCheckout(rawConfig, dependencies = {}) {
  const config = normalizeManagedCheckoutConfig(rawConfig);
  const git = dependencies.runGit ?? runGit;
  const fetch =
    dependencies.fetch ??
    (() =>
      git(config.worktree, [
        "fetch",
        "--no-tags",
        "--no-recurse-submodules",
        config.remote,
        `+refs/heads/${config.remoteBranch}:refs/remotes/${config.remote}/${config.remoteBranch}`,
      ]));
  const worktree = NodeFS.realpathSync(config.worktree);
  const configuredGitCommonDirectory = NodeFS.realpathSync(config.gitCommonDirectory);
  const branchRef = `refs/heads/${config.branch}`;
  const remoteRef = `refs/remotes/${config.remote}/${config.remoteBranch}`;

  const assertSafe = (expectedCommit) => {
    const topLevel = NodeFS.realpathSync(git(worktree, ["rev-parse", "--show-toplevel"]));
    if (topLevel !== worktree)
      fail(`Managed checkout resolved to unexpected worktree '${topLevel}'.`);
    const reportedCommon = git(worktree, ["rev-parse", "--git-common-dir"]);
    const commonDirectory = NodeFS.realpathSync(
      NodePath.isAbsolute(reportedCommon)
        ? reportedCommon
        : NodePath.join(worktree, reportedCommon),
    );
    if (commonDirectory !== configuredGitCommonDirectory) {
      fail("Managed checkout no longer belongs to the configured repository.");
    }
    const selectedBranch = git(worktree, ["branch", "--show-current"]);
    if (selectedBranch !== config.branch) {
      fail(
        `Managed checkout must be on ${config.branch}; found '${selectedBranch || "detached HEAD"}'.`,
      );
    }
    if (git(worktree, ["status", "--porcelain=v1", "--untracked-files=all"])) {
      fail("Managed checkout has uncommitted or untracked changes.");
    }
    for (const marker of GIT_OPERATION_MARKERS) {
      const markerPath = git(worktree, ["rev-parse", "--git-path", marker]);
      const resolved = NodePath.isAbsolute(markerPath)
        ? markerPath
        : NodePath.join(worktree, markerPath);
      if (NodeFS.existsSync(resolved))
        fail(`Managed checkout has an active Git operation (${marker}).`);
    }
    const commit = git(worktree, ["rev-parse", "HEAD"]);
    if (expectedCommit && commit !== expectedCommit) {
      fail("Managed checkout changed while its remote was being refreshed.");
    }
    return commit;
  };

  const currentCommit = assertSafe();
  fetch();
  assertSafe(currentCommit);
  const targetCommit = git(worktree, ["rev-parse", remoteRef]);
  if (targetCommit === currentCommit) return { commit: currentCommit, status: "current" };

  const gitlink = changedInitializedGitlink(worktree, currentCommit, targetCommit);
  if (gitlink) fail(`Managed checkout target changes initialized submodule '${gitlink}'.`);
  const targetPaths = git(worktree, ["ls-tree", "-r", "--name-only", "-z", targetCommit], {
    maxBuffer: GIT_MAX_BUFFER,
    raw: true,
  });
  const ignoredPaths = git(
    worktree,
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
    { maxBuffer: GIT_MAX_BUFFER, raw: true },
  );
  const ignoreCase =
    git(worktree, ["config", "--bool", "--default", "false", "core.ignorecase"]) === "true";
  const collision = ignoredTargetCollision(targetPaths, ignoredPaths, ignoreCase);
  if (collision) fail(`Managed checkout target would replace ignored content ('${collision}').`);

  assertSafe(currentCommit);
  const objectFormat = git(worktree, ["rev-parse", "--show-object-format"]);
  const backupRef = managedCheckoutBackupRef(config.backupRefPrefix, currentCommit, objectFormat);
  git(worktree, ["update-ref", backupRef, currentCommit]);
  git(worktree, ["update-ref", branchRef, targetCommit, currentCommit]);
  try {
    if (git(worktree, ["branch", "--show-current"]) !== config.branch) {
      fail("Managed checkout changed branches before its tree update.");
    }
    git(worktree, ["reset", "--hard", targetCommit]);
    const verifiedCommit = assertSafe(targetCommit);
    return {
      backupRef,
      fromCommit: currentCommit,
      status: "updated",
      toCommit: verifiedCommit,
    };
  } catch (error) {
    fail(
      `Managed checkout ref moved to ${targetCommit}, but its tree could not be verified; recover from ${backupRef}.`,
      { cause: error },
    );
  }
}

export function parseManagedCheckoutArgs(argv) {
  if (argv[0] !== "sync") {
    fail("Usage: lastcode-managed-checkout sync --config <absolute-json-path>");
  }
  if (argv.length !== 3 || argv[1] !== "--config" || !NodePath.isAbsolute(argv[2] ?? "")) {
    fail("sync requires --config followed by an absolute JSON path.");
  }
  return { command: "sync", configPath: argv[2] };
}

if (import.meta.main) {
  try {
    const { configPath } = parseManagedCheckoutArgs(process.argv.slice(2));
    const config = JSON.parse(NodeFS.readFileSync(configPath, "utf8"));
    console.log(JSON.stringify(syncManagedCheckout(config)));
  } catch (error) {
    console.error(
      `[lastcode:managed-checkout] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
