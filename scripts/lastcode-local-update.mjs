#!/usr/bin/env node
// LastCode managed helper: lastcode-local-update

// The desktop app runs this file with Electron's bundled Node runtime. Keep it
// dependency-free so an older LastCode build can inspect and build a newer
// checkpoint before that checkpoint's dependencies have been installed.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { acquirePortableLock } from "./lastcode-lock.mjs";

const CHECKPOINT_PREFIX = "lastcode/checkpoint/";
const REVISION_PREFIX = "lastcode/revision/";
const BUILD_PREFIX = "lastcode/build/";
const RESULT_PREFIX = "LASTCODE_LOCAL_UPDATE_RESULT=";
const GROUPED_RELEASE_NOTES_FORMAT = "grouped-v1";
const MAX_RELEASE_NOTE_GROUPS = 6;
const MAX_RELEASE_NOTE_ITEMS = 8;

export function resolveDeterministicBuildEnvironment(environment = process.env) {
  return { ...environment, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" };
}

export function resolveLocalBuildEnvironment(worktreePath, environment = process.env) {
  const resolved = resolveDeterministicBuildEnvironment(environment);
  return {
    ...resolved,
    PATH: `${NodePath.join(worktreePath, "node_modules", ".bin")}${NodePath.delimiter}${resolved.PATH ?? ""}`,
  };
}

export function isReusableCheckpointCiStamp(
  stamp,
  checkpointTag,
  checkpointCommit,
  upstreamCommit,
) {
  return (
    stamp?.schemaVersion === 2 &&
    stamp.commit === checkpointCommit &&
    stamp.context?.kind === "checkpoint" &&
    stamp.context.checkpointTag === checkpointTag &&
    stamp.context.upstreamCommit === upstreamCommit
  );
}

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
  const match = /^v(\d+)\.(\d+)\.(\d+)-nightly\.(\d{8})\.(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!match) return undefined;
  const revision = Number(match[6] ?? 0);
  return {
    tag: normalized,
    nightlyTag: `v${match[1]}.${match[2]}.${match[3]}-nightly.${match[4]}.${match[5]}`,
    parts: [...match.slice(1, 6).map(Number), revision],
    revision,
  };
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

function parseInstallableTag(tag) {
  const prefix = tag.startsWith(CHECKPOINT_PREFIX)
    ? CHECKPOINT_PREFIX
    : tag.startsWith(REVISION_PREFIX)
      ? REVISION_PREFIX
      : undefined;
  if (!prefix) return undefined;
  const version = parseNightlyVersion(tag.slice(prefix.length));
  if (!version) return undefined;
  if (prefix === CHECKPOINT_PREFIX && version.revision !== 0) return undefined;
  if (prefix === REVISION_PREFIX && version.revision < 1) return undefined;
  return { prefix, tag, version };
}

function versionFromInstallableTag(tag) {
  const installable = parseInstallableTag(tag);
  if (!installable) throw new Error(`Invalid LastCode installable tag '${tag}'.`);
  return installable.version.tag.slice(1);
}

function buildTagPrefix(installableTag) {
  return `${BUILD_PREFIX}v${versionFromInstallableTag(installableTag)}.`;
}

export function resolveLatestInstallableTag(tags) {
  return tags
    .flatMap((tag) => (parseInstallableTag(tag) ? [tag] : []))
    .toSorted((left, right) =>
      compareNightlyVersions(versionFromInstallableTag(right), versionFromInstallableTag(left)),
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
  let releaseNotesFormat;
  let home = NodeOS.homedir();
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (
      !["--repo", "--current-version", "--checkpoint", "--home", "--release-notes-format"].includes(
        arg,
      )
    ) {
      throw new Error(`Unknown argument '${arg}'.`);
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${arg}.`);
    if (arg === "--repo") repoRoot = NodePath.resolve(value);
    else if (arg === "--current-version") currentVersion = value;
    else if (arg === "--checkpoint") checkpointTag = value;
    else if (arg === "--release-notes-format") releaseNotesFormat = value;
    else home = NodePath.resolve(value);
    index += 1;
  }
  if (!repoRoot) throw new Error("Missing --repo.");
  if (command === "inspect" && !currentVersion) throw new Error("Missing --current-version.");
  if (command === "build" && !checkpointTag) throw new Error("Missing --checkpoint.");
  if (command === "build" && releaseNotesFormat !== undefined) {
    throw new Error("--release-notes-format is only valid for inspect.");
  }
  if (releaseNotesFormat !== undefined && releaseNotesFormat !== GROUPED_RELEASE_NOTES_FORMAT) {
    throw new Error(`Unsupported release notes format '${releaseNotesFormat}'.`);
  }
  return { command, repoRoot, home, currentVersion, checkpointTag, releaseNotesFormat };
}

export function resolveExistingBuild({ repoRoot, outputRoot, checkpointTag, checkpointCommit }) {
  const nightlyTag = `v${versionFromInstallableTag(checkpointTag)}`;
  const shortCommit = checkpointCommit.slice(0, 10);
  const outputDir = NodePath.join(outputRoot, nightlyTag, shortCommit);
  const manifestPath = NodePath.join(outputDir, "build-manifest.json");
  if (!NodeFS.existsSync(manifestPath)) return undefined;
  const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8"));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.checkpointTag !== checkpointTag ||
    manifest.lastCodeCommit !== checkpointCommit ||
    typeof manifest.buildTag !== "string" ||
    !manifest.buildTag.startsWith(buildTagPrefix(checkpointTag))
  ) {
    throw new Error(`Existing build manifest does not match ${checkpointTag}: ${manifestPath}`);
  }
  const required = ["nightly-mac.yml", "SHA256SUMS", ".dmg", ".zip"];
  const artifacts = NodeFS.readdirSync(outputDir);
  for (const suffix of required) {
    if (
      !artifacts.some((name) => (suffix.startsWith(".") ? name.endsWith(suffix) : name === suffix))
    ) {
      throw new Error(`Existing build is incomplete at ${outputDir}; missing ${suffix}.`);
    }
  }
  const dmgNames = artifacts.filter((name) => name.endsWith(".dmg"));
  if (dmgNames.length !== 1) {
    throw new Error(
      `Existing build must contain exactly one DMG at ${outputDir}; found ${dmgNames.length}.`,
    );
  }
  const dmgName = dmgNames[0];
  const manifestArtifact = Array.isArray(manifest.artifacts)
    ? manifest.artifacts.find((artifact) => artifact?.path === dmgName)
    : undefined;
  if (!manifestArtifact || !/^[a-f0-9]{64}$/.test(manifestArtifact.sha256)) {
    throw new Error(`Existing build manifest is missing the DMG checksum: ${manifestPath}`);
  }
  if (
    git(repoRoot, ["cat-file", "-t", manifest.buildTag]) !== "tag" ||
    git(repoRoot, ["rev-parse", `${manifest.buildTag}^{commit}`]) !== checkpointCommit
  ) {
    throw new Error(
      `Existing build is incomplete at ${outputDir}; annotated tag ${manifest.buildTag} is missing or mismatched.`,
    );
  }
  return {
    outputDir,
    manifestPath,
    dmgPath: NodePath.join(outputDir, dmgName),
    dmgSha256: manifestArtifact.sha256,
  };
}

export function quarantineIncompleteBuild(
  outputRoot,
  checkpointTag,
  checkpointCommit,
  suffix = `${new Date().toISOString().replaceAll(":", "").replaceAll(".", "")}-${process.pid}`,
) {
  const nightlyTag = `v${versionFromInstallableTag(checkpointTag)}`;
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

function checkpointSourceCommit(repoRoot, tag) {
  const message = git(repoRoot, ["for-each-ref", `refs/tags/${tag}`, "--format=%(contents)"]);
  return /^Source-Commit:\s*(\S+)\s*$/m.exec(message)?.[1];
}

function hasCommit(repoRoot, ref) {
  const result = NodeChildProcess.spawnSync("git", ["cat-file", "-e", `${ref}^{commit}`], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 1 || result.status === 128) return false;
  throw new Error(
    `git cat-file -e ${ref}^{commit} failed with exit code ${result.status ?? "unknown"}.`,
  );
}

function isAncestor(repoRoot, ancestor, descendant) {
  const result = NodeChildProcess.spawnSync(
    "git",
    ["merge-base", "--is-ancestor", ancestor, descendant],
    { cwd: repoRoot, stdio: "ignore" },
  );
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(
    `git merge-base --is-ancestor ${ancestor} ${descendant} failed with exit code ${result.status ?? "unknown"}.`,
  );
}

function parseCommitSubjects(value) {
  return value
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("\0");
      if (separator < 0) throw new Error("Could not parse a Git commit subject.");
      return { commit: line.slice(0, separator), subject: line.slice(separator + 1).trim() };
    })
    .filter(({ subject }) => subject.length > 0);
}

function listInstallableRefs(repoRoot, tags) {
  return tags
    .flatMap((tag) => {
      const installable = parseInstallableTag(tag);
      if (!installable) return [];
      return [
        {
          ...installable,
          commit: git(repoRoot, ["rev-parse", `${tag}^{commit}`]),
          sourceCommit: checkpointSourceCommit(repoRoot, tag),
        },
      ];
    })
    .toSorted((left, right) => compareNightlyVersions(left.version.tag, right.version.tag));
}

function collectLastCodeReleaseNotes(repoRoot, installables, currentInstallable, target) {
  if (!currentInstallable) return { status: "unavailable" };
  const chain = installables.filter(
    ({ version }) =>
      compareNightlyVersions(version.tag, currentInstallable.version.tag) >= 0 &&
      compareNightlyVersions(version.tag, target.version.tag) <= 0,
  );
  if (
    chain[0]?.tag !== currentInstallable.tag ||
    chain.at(-1)?.tag !== target.tag ||
    chain.some(
      ({ sourceCommit }) => sourceCommit === undefined || !hasCommit(repoRoot, sourceCommit),
    )
  ) {
    return { status: "unavailable" };
  }

  let candidates = [];
  for (let index = 1; index < chain.length; index += 1) {
    const previous = chain[index - 1];
    const next = chain[index];
    if (!previous?.sourceCommit || !next?.sourceCommit) return { status: "unavailable" };
    if (previous.sourceCommit === next.sourceCommit) continue;

    const boundary = isAncestor(repoRoot, previous.commit, next.sourceCommit)
      ? previous.commit
      : isAncestor(repoRoot, previous.sourceCommit, next.sourceCommit)
        ? previous.sourceCommit
        : undefined;
    if (!boundary) return { status: "unavailable" };

    const downstreamCommits = new Set(
      splitLines(git(repoRoot, ["cherry", target.version.nightlyTag, next.sourceCommit, boundary]))
        .filter((line) => line.startsWith("+ "))
        .map((line) => line.slice(2).split(/\s+/, 1)[0])
        .filter(Boolean),
    );
    const edgeCandidates = parseCommitSubjects(
      git(repoRoot, [
        "log",
        "--format=%H%x00%s",
        "--no-merges",
        `${boundary}..${next.sourceCommit}`,
      ]),
    ).filter(({ commit }) => downstreamCommits.has(commit));
    candidates = edgeCandidates.concat(candidates);
  }

  const items = candidates.map(({ subject }) => subject);
  return {
    status: "known",
    items: items.slice(0, MAX_RELEASE_NOTE_ITEMS),
    omittedItems: Math.max(0, items.length - MAX_RELEASE_NOTE_ITEMS),
  };
}

function listUpstreamNightlyTags(repoRoot) {
  return splitLines(git(repoRoot, ["tag", "--list", "v*-nightly.*"]))
    .filter((tag) => {
      const parsed = parseNightlyVersion(tag);
      return parsed?.revision === 0 && parsed.tag === parsed.nightlyTag;
    })
    .toSorted(compareNightlyVersions);
}

function collectUpstreamReleaseNotes(repoRoot, current, target) {
  if (current.nightlyTag === target.version.nightlyTag) {
    return { groups: [], omittedGroups: 0 };
  }
  const nightlyTags = listUpstreamNightlyTags(repoRoot);
  const currentIndex = nightlyTags.indexOf(current.nightlyTag);
  const targetIndex = nightlyTags.indexOf(target.version.nightlyTag);
  if (currentIndex < 0 || targetIndex <= currentIndex) {
    throw new Error("Could not resolve the installed-to-target upstream nightly interval.");
  }

  const nonEmptyGroups = nightlyTags
    .slice(currentIndex + 1, targetIndex + 1)
    .toReversed()
    .flatMap((tag) => {
      const index = nightlyTags.indexOf(tag);
      const previous = nightlyTags[index - 1];
      if (!previous) return [];
      const subjects = splitLines(
        git(repoRoot, ["log", "--format=%s", "--no-merges", `${previous}..${tag}`]),
      );
      if (subjects.length === 0) return [];
      return [
        {
          version: tag.slice(1),
          isTarget: tag === target.version.nightlyTag,
          items: subjects.slice(0, MAX_RELEASE_NOTE_ITEMS),
          omittedItems: Math.max(0, subjects.length - MAX_RELEASE_NOTE_ITEMS),
        },
      ];
    });
  return {
    groups: nonEmptyGroups.slice(0, MAX_RELEASE_NOTE_GROUPS),
    omittedGroups: Math.max(0, nonEmptyGroups.length - MAX_RELEASE_NOTE_GROUPS),
  };
}

function inspectGrouped(options, installableTags, checkpointTag, availableVersion, current) {
  const installables = listInstallableRefs(options.repoRoot, installableTags);
  const target = installables.find(({ tag }) => tag === checkpointTag);
  if (!target) throw new Error(`Could not resolve target installable ${checkpointTag}.`);
  const currentTag =
    current.revision === 0
      ? `${CHECKPOINT_PREFIX}${current.tag}`
      : `${REVISION_PREFIX}${current.tag}`;
  const currentInstallable = installables.find(({ tag }) => tag === currentTag);
  return {
    schemaVersion: 2,
    status: "available",
    checkpointTag,
    availableVersion,
    releaseNotes: {
      lastCode: collectLastCodeReleaseNotes(
        options.repoRoot,
        installables,
        currentInstallable,
        target,
      ),
      upstream: collectUpstreamReleaseNotes(options.repoRoot, current, target),
    },
  };
}

function inspect(options) {
  if (!parseNightlyVersion(options.currentVersion)) {
    throw new Error(`Installed version '${options.currentVersion}' is not a LastCode nightly.`);
  }
  const installableTags = splitLines(
    git(options.repoRoot, [
      "tag",
      "--list",
      `${CHECKPOINT_PREFIX}v*-nightly.*`,
      `${REVISION_PREFIX}v*-nightly.*`,
    ]),
  );
  const checkpointTag = resolveLatestInstallableTag(installableTags);
  if (!checkpointTag) throw new Error("No local LastCode installable tags were found.");
  const availableVersion = versionFromInstallableTag(checkpointTag);
  if (compareNightlyVersions(availableVersion, options.currentVersion) <= 0) {
    return {
      schemaVersion: options.releaseNotesFormat === GROUPED_RELEASE_NOTES_FORMAT ? 2 : 1,
      status: "up-to-date",
      checkpointTag,
      availableVersion,
    };
  }

  const current = parseNightlyVersion(options.currentVersion);
  if (!current) throw new Error(`Installed version '${options.currentVersion}' is invalid.`);
  if (options.releaseNotesFormat === GROUPED_RELEASE_NOTES_FORMAT) {
    return inspectGrouped(options, installableTags, checkpointTag, availableVersion, current);
  }
  const currentInstallable =
    current.revision === 0
      ? `${CHECKPOINT_PREFIX}${current.tag}`
      : `${REVISION_PREFIX}${current.tag}`;
  const hasCurrentInstallable =
    git(options.repoRoot, ["tag", "--list", currentInstallable]) === currentInstallable;
  const base = hasCurrentInstallable ? currentInstallable : current.nightlyTag;
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

export function acquireBuildLock(updateRoot) {
  return acquirePortableLock(updateRoot, "build.lock", "local build");
}

function buildUnlocked(options, updateRoot) {
  const checkpointCommit = git(options.repoRoot, [
    "rev-parse",
    `${options.checkpointTag}^{commit}`,
  ]);
  const outputRoot = NodePath.join(updateRoot, "artifacts");
  let existing;
  let incompleteBuildError;
  try {
    existing = resolveExistingBuild({
      repoRoot: options.repoRoot,
      outputRoot,
      checkpointTag: options.checkpointTag,
      checkpointCommit,
    });
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
    const buildEnvironment = resolveLocalBuildEnvironment(worktreePath);
    const installer = NodePath.join(options.repoRoot, "node_modules", ".bin", "vp");
    if (!NodeFS.existsSync(installer)) {
      throw new Error(`Checkpoint automation dependencies are missing at ${installer}.`);
    }
    run(worktreePath, installer, ["install", "--frozen-lockfile"], { logFd });
    const mise = resolveMise(options.home);
    const nodeCommand = ["exec", "node@24.13.1", "--", "node"];
    const installable = parseInstallableTag(options.checkpointTag);
    if (!installable) throw new Error(`Invalid installable tag '${options.checkpointTag}'.`);
    const upstreamCommit = git(options.repoRoot, [
      "rev-parse",
      `${installable.version.nightlyTag}^{commit}`,
    ]);
    const commonGitDirectory = NodePath.resolve(
      options.repoRoot,
      git(options.repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    );
    const stampPath = NodePath.join(commonGitDirectory, "lastcode-ci", `${checkpointCommit}.json`);
    let reusableCiStamp = false;
    if (NodeFS.existsSync(stampPath)) {
      try {
        reusableCiStamp = isReusableCheckpointCiStamp(
          JSON.parse(NodeFS.readFileSync(stampPath, "utf8")),
          options.checkpointTag,
          checkpointCommit,
          upstreamCommit,
        );
      } catch {
        reusableCiStamp = false;
      }
    }
    if (reusableCiStamp) {
      NodeFS.writeSync(logFd, `Reusing full local CI stamp: ${stampPath}\n`);
    } else {
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
        { logFd, env: buildEnvironment },
      );
    }
    run(
      worktreePath,
      mise,
      [
        ...nodeCommand,
        "scripts/lastcode-build-mac.ts",
        "--arch",
        "arm64",
        "--checkpoint",
        options.checkpointTag,
        "--output-root",
        outputRoot,
      ],
      { logFd, env: buildEnvironment },
    );
  } catch (error) {
    throw new Error(
      `Local LastCode build failed. See ${logPath}. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    NodeFS.closeSync(logFd);
  }

  const built = resolveExistingBuild({
    repoRoot: options.repoRoot,
    outputRoot,
    checkpointTag: options.checkpointTag,
    checkpointCommit,
  });
  if (!built)
    throw new Error(`Build completed without a usable artifact for ${options.checkpointTag}.`);
  return {
    schemaVersion: 1,
    status: "built",
    checkpointTag: options.checkpointTag,
    ...built,
  };
}

function build(options) {
  if (!parseInstallableTag(options.checkpointTag)) {
    throw new Error(`Invalid installable tag '${options.checkpointTag}'.`);
  }
  const updateRoot = NodePath.join(options.home, ".lastcode", "local-updates");
  const releaseLock = acquireBuildLock(updateRoot);
  try {
    return buildUnlocked(options, updateRoot);
  } finally {
    releaseLock();
  }
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
