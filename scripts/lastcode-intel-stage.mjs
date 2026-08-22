#!/usr/bin/env node

// LastCode-only staging for immutable Intel desktop releases. This command never stops or installs LastCode.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { acquireInstallLock, validateDmgArtifact } from "./lastcode-install.mjs";
import { validateIntelReleaseDirectory } from "./lastcode-intel-release.mjs";

const DEFAULT_REPOSITORY = "lastobelus/lastCode";
const PENDING_NAME = "pending.json";
const SHA1_PATTERN = /^[a-f0-9]{40}$/u;

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`Could not parse ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseInstallableTag(tag) {
  const match =
    /^lastcode\/(checkpoint|revision)\/v(\d+)\.(\d+)\.(\d+)-nightly\.(\d{8})\.(\d+)(?:\.(\d+))?$/u.exec(
      tag,
    );
  if (!match) return undefined;
  const [, kind, major, minor, patch, date, runNumber, rawRevision] = match;
  const revision = rawRevision === undefined ? 0 : Number(rawRevision);
  if (
    (kind === "checkpoint" && rawRevision !== undefined) ||
    (kind === "revision" && revision < 1)
  ) {
    return undefined;
  }
  const order = [major, minor, patch, date, runNumber, revision].map(Number);
  if (order.some((value) => !Number.isSafeInteger(value))) return undefined;
  return {
    order,
    tag,
    version: tag.replace(/^lastcode\/(?:checkpoint|revision)\/v/u, ""),
  };
}

export function compareInstallables(left, right) {
  for (let index = 0; index < left.order.length; index += 1) {
    const difference = left.order[index] - right.order[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

function parseInstalledVersion(version) {
  return (
    parseInstallableTag(`lastcode/checkpoint/v${version}`) ??
    parseInstallableTag(`lastcode/revision/v${version}`)
  );
}

function run(command, args, options = {}) {
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    env: options.environment ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `${command} failed with exit code ${result.status}.`);
  }
  return result.stdout.trim();
}

function ghJson(args, label, runCommand = run) {
  return parseJson(runCommand("gh", args), label);
}

export function listIntelReleases(repository, options = {}) {
  const pages = ghJson(
    ["api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`],
    "GitHub release list",
    options.runCommand,
  );
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    fail("GitHub paginated release list must be an array of pages.");
  }
  return pages.flatMap((page) =>
    page.map((release) => {
      if (!isRecord(release)) fail("GitHub release list contains an invalid release.");
      return {
        tagName: release.tag_name,
        isDraft: release.draft,
        isImmutable: release.immutable,
        isPrerelease: release.prerelease,
      };
    }),
  );
}

export function resolveRemoteTagCommit(repository, tag) {
  const encodedTag = encodeURIComponent(tag);
  let object = ghJson(
    ["api", `repos/${repository}/git/ref/tags/${encodedTag}`],
    `GitHub tag ref ${tag}`,
  )?.object;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!isRecord(object) || !SHA1_PATTERN.test(object.sha ?? "")) {
      fail(`GitHub returned an invalid object for tag ${tag}.`);
    }
    if (object.type === "commit") return object.sha;
    if (object.type !== "tag")
      fail(`Tag ${tag} resolves to unsupported object type ${object.type}.`);
    object = ghJson(
      ["api", `repos/${repository}/git/tags/${object.sha}`],
      `GitHub annotated tag ${tag}`,
    )?.object;
  }
  fail(`Tag ${tag} contains too many nested annotated tags.`);
}

function readPendingPointer(path) {
  try {
    return NodeFS.readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

export function readPending(root, options = {}) {
  const path = NodePath.join(root, PENDING_NAME);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const rawPointer = readPendingPointer(path);
    if (rawPointer === undefined) return undefined;
    try {
      const pending = parseJson(rawPointer, "pending Intel candidate");
      if (
        !isRecord(pending) ||
        pending.schemaVersion !== 1 ||
        typeof pending.candidateId !== "string" ||
        NodePath.basename(pending.candidateId) !== pending.candidateId ||
        !parseInstallableTag(pending.tag) ||
        !SHA1_PATTERN.test(pending.commit ?? "") ||
        typeof pending.version !== "string" ||
        typeof pending.dmgName !== "string" ||
        NodePath.basename(pending.dmgName) !== pending.dmgName ||
        !/^[a-f0-9]{64}$/u.test(pending.dmgSha256 ?? "")
      ) {
        fail("Pending Intel candidate metadata is invalid.");
      }
      const parsedTag = parseInstallableTag(pending.tag);
      if (parsedTag.version !== pending.version) {
        fail("Pending Intel candidate version disagrees with its immutable tag.");
      }
      options.afterPointerRead?.({ attempt, pending });
      const candidateDirectory = NodePath.join(root, "candidates", pending.candidateId);
      const assetsDirectory = NodePath.join(candidateDirectory, "assets");
      const candidateMetadataPath = NodePath.join(candidateDirectory, "candidate.json");
      const dmgPath = NodePath.join(assetsDirectory, pending.dmgName);
      if (
        !NodeFS.lstatSync(candidateDirectory, { throwIfNoEntry: false })?.isDirectory() ||
        !NodeFS.lstatSync(assetsDirectory, { throwIfNoEntry: false })?.isDirectory() ||
        !NodeFS.lstatSync(dmgPath, { throwIfNoEntry: false })?.isFile()
      ) {
        fail("Pending Intel candidate artifact is missing.");
      }
      const candidateMetadata = parseJson(
        NodeFS.readFileSync(candidateMetadataPath, "utf8"),
        "Intel candidate metadata",
      );
      for (const key of [
        "schemaVersion",
        "candidateId",
        "commit",
        "dmgName",
        "dmgSha256",
        "stagedAt",
        "tag",
        "version",
      ]) {
        if (candidateMetadata?.[key] !== pending[key]) {
          fail("Pending pointer disagrees with its Intel candidate metadata.");
        }
      }
      if (readPendingPointer(path) !== rawPointer) continue;
      return { ...pending, candidateDirectory, dmgPath };
    } catch (error) {
      if (readPendingPointer(path) !== rawPointer) continue;
      throw error;
    }
  }
  fail("Pending Intel candidate changed repeatedly while it was being inspected.");
}

function syncDirectory(path) {
  const descriptor = NodeFS.openSync(path, "r");
  try {
    NodeFS.fsyncSync(descriptor);
  } finally {
    NodeFS.closeSync(descriptor);
  }
}

function writeJsonAtomically(path, value) {
  const temporary = `${path}.tmp-${process.pid}-${NodeCrypto.randomUUID()}`;
  try {
    const descriptor = NodeFS.openSync(temporary, "wx", 0o600);
    try {
      NodeFS.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
      NodeFS.fsyncSync(descriptor);
    } finally {
      NodeFS.closeSync(descriptor);
    }
    NodeFS.renameSync(temporary, path);
  } catch (error) {
    NodeFS.rmSync(temporary, { force: true });
    throw error;
  }
  syncDirectory(NodePath.dirname(path));
}

function cleanupUnreferencedCandidates(root, pendingId) {
  const candidates = NodePath.join(root, "candidates");
  for (const entry of NodeFS.readdirSync(candidates, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== pendingId) {
      NodeFS.rmSync(NodePath.join(candidates, entry.name), { force: true, recursive: true });
    }
  }
}

function clearPending(root) {
  NodeFS.rmSync(NodePath.join(root, PENDING_NAME), { force: true });
  syncDirectory(root);
  cleanupUnreferencedCandidates(root, undefined);
}

function defaultDownloadRelease({ directory, releaseJsonPath, repository, tag }) {
  const release = run("gh", [
    "release",
    "view",
    tag,
    "--repo",
    repository,
    "--json",
    "assets,isDraft,isImmutable,isPrerelease,tagName",
  ]);
  NodeFS.writeFileSync(releaseJsonPath, `${release}\n`, { mode: 0o600 });
  run("gh", ["release", "download", tag, "--repo", repository, "--dir", directory]);
}

function readInstalledVersion(appPath = "/Applications/LastCode.app") {
  return run("/usr/libexec/PlistBuddy", [
    "-c",
    "Print:CFBundleShortVersionString",
    NodePath.join(appPath, "Contents", "Info.plist"),
  ]);
}

export async function stageIntelUpdate(options, dependencies = {}) {
  const repository = options.repository ?? DEFAULT_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    fail("GitHub repository must be owner/name.");
  }
  const root = NodePath.resolve(
    options.homeDirectory ?? NodePath.join(NodeOS.homedir(), ".lastcode", "intel-updates"),
  );
  const candidatesDirectory = NodePath.join(root, "candidates");
  NodeFS.mkdirSync(candidatesDirectory, { recursive: true, mode: 0o700 });
  const acquireLock = dependencies.acquireLock ?? acquireInstallLock;
  const releaseLock = acquireLock(NodePath.join(root, "stage-lock"));
  try {
    return await stageIntelUpdateLocked(
      options,
      dependencies,
      repository,
      root,
      candidatesDirectory,
    );
  } finally {
    releaseLock();
  }
}

async function stageIntelUpdateLocked(
  options,
  dependencies,
  repository,
  root,
  candidatesDirectory,
) {
  let pending = readPending(root);
  const currentVersion = options.currentVersion ?? readInstalledVersion(options.appPath);
  const current = parseInstalledVersion(currentVersion);
  if (!current) fail(`Installed version '${currentVersion}' is not a LastCode nightly.`);
  if (pending && compareInstallables(parseInstallableTag(pending.tag), current) <= 0) {
    clearPending(root);
    pending = undefined;
  }

  const listReleases = dependencies.listReleases ?? listIntelReleases;
  const releases = await listReleases(repository);
  const available = releases
    .filter(
      (release) =>
        isRecord(release) &&
        release.isDraft === false &&
        release.isImmutable === true &&
        release.isPrerelease === true,
    )
    .flatMap((release) => {
      const parsed = parseInstallableTag(release.tagName);
      return parsed ? [parsed] : [];
    })
    .toSorted((left, right) => compareInstallables(right, left));
  const target = available[0];
  if (!target || compareInstallables(target, current) <= 0) {
    if (pending) cleanupUnreferencedCandidates(root, pending.candidateId);
    return { schemaVersion: 1, status: pending ? "pending" : "up-to-date", pending };
  }
  if (pending) {
    const pendingTag = parseInstallableTag(pending.tag);
    if (compareInstallables(target, pendingTag) <= 0) {
      cleanupUnreferencedCandidates(root, pending.candidateId);
      return { schemaVersion: 1, status: "pending", pending };
    }
  }

  const resolveCommit = dependencies.resolveCommit ?? resolveRemoteTagCommit;
  const commit = await resolveCommit(repository, target.tag);
  if (!SHA1_PATTERN.test(commit)) fail(`Could not resolve an exact commit for ${target.tag}.`);
  const identifier = `${target.version}-${commit.slice(0, 12)}-${NodeCrypto.randomUUID()}`;
  const incomplete = NodePath.join(root, `.incomplete-${NodeCrypto.randomUUID()}`);
  const assets = NodePath.join(incomplete, "assets");
  const releaseJsonPath = NodePath.join(incomplete, "release.json");
  const candidateDirectory = NodePath.join(candidatesDirectory, identifier);
  let candidateMoved = false;
  let pointerCommitted = false;
  try {
    NodeFS.mkdirSync(assets, { recursive: true, mode: 0o700 });
    const downloadRelease = dependencies.downloadRelease ?? defaultDownloadRelease;
    await downloadRelease({ directory: assets, releaseJsonPath, repository, tag: target.tag });
    const release = validateIntelReleaseDirectory({
      checkpointTag: target.tag,
      directory: assets,
      lastCodeCommit: commit,
      releaseJsonPath,
    });
    if (release.version !== target.version)
      fail("Release version disagrees with its immutable tag.");
    const inspectDmg = dependencies.inspectDmg ?? validateDmgArtifact;
    const inspected = await inspectDmg(NodePath.join(assets, release.dmgName), {
      expectedArchitecture: "x86_64",
      expectedSha256: release.dmgSha256,
      expectedVersion: target.version,
      signaturePolicy: "adhoc",
    });
    if (inspected.version !== target.version || inspected.sha256 !== release.dmgSha256) {
      fail("Validated DMG identity disagrees with the release manifest.");
    }
    const finalCommit = await resolveCommit(repository, target.tag);
    if (finalCommit !== commit) {
      fail(`Tag ${target.tag} changed while its release was being validated.`);
    }
    NodeFS.rmSync(releaseJsonPath, { force: true });
    NodeFS.renameSync(incomplete, candidateDirectory);
    candidateMoved = true;
    const syncPublishedDirectory = dependencies.syncDirectory ?? syncDirectory;
    syncPublishedDirectory(candidatesDirectory);
    const metadata = {
      schemaVersion: 1,
      candidateId: identifier,
      commit,
      dmgName: release.dmgName,
      dmgSha256: release.dmgSha256,
      stagedAt: new Date().toISOString(),
      tag: target.tag,
      version: target.version,
    };
    writeJsonAtomically(NodePath.join(candidateDirectory, "candidate.json"), metadata);
    await dependencies.beforeCommit?.(metadata);
    writeJsonAtomically(NodePath.join(root, PENDING_NAME), metadata);
    pointerCommitted = true;
    cleanupUnreferencedCandidates(root, identifier);
    return { schemaVersion: 1, status: "staged", pending: readPending(root) };
  } catch (error) {
    if (!pointerCommitted) {
      NodeFS.rmSync(candidateMoved ? candidateDirectory : incomplete, {
        force: true,
        recursive: true,
      });
    }
    throw error;
  }
}

export function parseStageOptions(argv) {
  const command = argv[0];
  if (command !== "stage" && command !== "status") fail("Expected 'stage' or 'status'.");
  const options = { command };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!["--app", "--current-version", "--home-dir", "--repository"].includes(arg)) {
      fail(`Unknown argument '${arg}'.`);
    }
    const value = argv[index + 1];
    if (!value) fail(`Missing value for ${arg}.`);
    if (arg === "--app") options.appPath = NodePath.resolve(value);
    else if (arg === "--current-version") options.currentVersion = value;
    else if (arg === "--home-dir") options.homeDirectory = NodePath.resolve(value);
    else options.repository = value;
    index += 1;
  }
  return options;
}

async function main(argv) {
  const options = parseStageOptions(argv);
  const root =
    options.homeDirectory ?? NodePath.join(NodeOS.homedir(), ".lastcode", "intel-updates");
  const pending = options.command === "status" ? readPending(root) : undefined;
  const result =
    options.command === "status"
      ? { schemaVersion: 1, status: pending ? "pending" : "empty", pending }
      : await stageIntelUpdate(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `[lastcode:intel-stage] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
