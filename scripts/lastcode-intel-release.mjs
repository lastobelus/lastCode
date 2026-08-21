#!/usr/bin/env node

// LastCode-only release validation for the manual Intel artifact workflow.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const MANIFEST_NAME = "build-manifest.json";
const CHECKSUMS_NAME = "SHA256SUMS";
const SHA1_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function fail(message) {
  throw new Error(message);
}

function readJson(path, label) {
  try {
    return JSON.parse(NodeFS.readFileSync(path, "utf8"));
  } catch (error) {
    fail(`Could not read ${label} at ${path}: ${error instanceof Error ? error.message : error}`);
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hashFile(path) {
  return NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex");
}

function assertPlainAssetName(name, options = {}) {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.startsWith(".") ||
    NodePath.basename(name) !== name ||
    name.includes("\n") ||
    name.includes("\r")
  ) {
    fail(`Build manifest contains an unsafe asset path: ${JSON.stringify(name)}.`);
  }
  if (options.allowMetadata !== true && (name === MANIFEST_NAME || name === CHECKSUMS_NAME)) {
    fail(`Build manifest must not list reserved metadata asset ${name}.`);
  }
}

function parseManifest(directory, checkpointTag, lastCodeCommit) {
  const manifestPath = NodePath.join(directory, MANIFEST_NAME);
  const manifest = readJson(manifestPath, "build manifest");
  if (!isRecord(manifest)) fail("Build manifest must be a JSON object.");
  if (manifest.schemaVersion !== 1) fail("Build manifest schemaVersion must be 1.");
  if (manifest.arch !== "x64") fail("Build manifest architecture must be x64.");
  if (manifest.platform !== "mac") fail("Build manifest platform must be mac.");
  if (manifest.checkpointTag !== checkpointTag) {
    fail(
      `Build manifest tag mismatch: expected ${checkpointTag}, found ${String(manifest.checkpointTag)}.`,
    );
  }
  if (manifest.lastCodeCommit !== lastCodeCommit) {
    fail(
      `Build manifest commit mismatch: expected ${lastCodeCommit}, found ${String(manifest.lastCodeCommit)}.`,
    );
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    fail("Build manifest must list at least one artifact.");
  }

  const artifacts = [];
  const names = new Set();
  for (const rawArtifact of manifest.artifacts) {
    if (!isRecord(rawArtifact)) fail("Build manifest contains an invalid artifact entry.");
    assertPlainAssetName(rawArtifact.path);
    if (names.has(rawArtifact.path)) {
      fail(`Build manifest lists duplicate asset ${rawArtifact.path}.`);
    }
    if (!Number.isSafeInteger(rawArtifact.bytes) || rawArtifact.bytes < 0) {
      fail(`Build manifest has an invalid byte count for ${rawArtifact.path}.`);
    }
    if (typeof rawArtifact.sha256 !== "string" || !SHA256_PATTERN.test(rawArtifact.sha256)) {
      fail(`Build manifest has an invalid SHA-256 for ${rawArtifact.path}.`);
    }
    names.add(rawArtifact.path);
    artifacts.push({
      path: rawArtifact.path,
      bytes: rawArtifact.bytes,
      sha256: rawArtifact.sha256,
    });
  }
  if (artifacts.filter((artifact) => artifact.path.endsWith(".dmg")).length !== 1) {
    fail("Build manifest must list exactly one DMG.");
  }
  return artifacts;
}

function parseChecksums(directory) {
  const checksumPath = NodePath.join(directory, CHECKSUMS_NAME);
  let raw;
  try {
    raw = NodeFS.readFileSync(checksumPath, "utf8");
  } catch (error) {
    fail(
      `Could not read checksums at ${checksumPath}: ${error instanceof Error ? error.message : error}`,
    );
  }
  const checksums = new Map();
  const lines = raw.endsWith("\n") ? raw.slice(0, -1).split("\n") : raw.split("\n");
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  ([^\r\n]+)$/.exec(line);
    if (!match) fail(`Invalid SHA256SUMS line: ${JSON.stringify(line)}.`);
    const [, sha256, name] = match;
    assertPlainAssetName(name);
    if (checksums.has(name)) fail(`SHA256SUMS lists duplicate asset ${name}.`);
    checksums.set(name, sha256);
  }
  return checksums;
}

function directoryFiles(directory) {
  let entries;
  try {
    entries = NodeFS.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    fail(
      `Could not inspect release assets at ${directory}: ${error instanceof Error ? error.message : error}`,
    );
  }
  for (const entry of entries) {
    if (!entry.isFile()) fail(`Release asset directory contains non-file entry ${entry.name}.`);
  }
  return entries.map((entry) => entry.name).toSorted();
}

function assertExactNames(actual, expected, label) {
  const actualSorted = [...actual].toSorted();
  const expectedSorted = [...expected].toSorted();
  if (JSON.stringify(actualSorted) === JSON.stringify(expectedSorted)) return;
  const expectedSet = new Set(expectedSorted);
  const actualSet = new Set(actualSorted);
  const missing = expectedSorted.filter((name) => !actualSet.has(name));
  const foreign = actualSorted.filter((name) => !expectedSet.has(name));
  fail(
    `${label} asset set disagrees with the build manifest` +
      `${missing.length > 0 ? `; missing: ${missing.join(", ")}` : ""}` +
      `${foreign.length > 0 ? `; foreign: ${foreign.join(", ")}` : ""}.`,
  );
}

function validateReleaseMetadata(release, checkpointTag, localAssets) {
  if (!isRecord(release)) fail("Release metadata must be a JSON object.");
  if (release.tagName !== checkpointTag) {
    fail(`Release tag mismatch: expected ${checkpointTag}, found ${String(release.tagName)}.`);
  }
  if (release.isDraft !== false) fail("Existing exact-tag release must not be a draft.");
  if (release.isPrerelease !== true) fail("Existing exact-tag release must be a prerelease.");
  if (!Array.isArray(release.assets)) fail("Release metadata must include its assets.");

  const localByName = new Map(localAssets.map((asset) => [asset.name, asset]));
  const releaseNames = [];
  for (const rawAsset of release.assets) {
    if (!isRecord(rawAsset)) fail("Release metadata contains an invalid asset entry.");
    assertPlainAssetName(rawAsset.name, { allowMetadata: true });
    if (releaseNames.includes(rawAsset.name)) {
      fail(`Release metadata lists duplicate asset ${rawAsset.name}.`);
    }
    releaseNames.push(rawAsset.name);
    const local = localByName.get(rawAsset.name);
    if (!local) continue;
    if (rawAsset.state !== "uploaded") fail(`Release asset ${rawAsset.name} is not uploaded.`);
    if (rawAsset.size !== local.bytes) {
      fail(`Release asset ${rawAsset.name} size disagrees with the downloaded file.`);
    }
    if (rawAsset.digest !== `sha256:${local.sha256}`) {
      fail(`Release asset ${rawAsset.name} digest disagrees with the downloaded file.`);
    }
  }
  assertExactNames(
    releaseNames,
    localAssets.map((asset) => asset.name),
    "GitHub Release",
  );
}

export function validateIntelReleaseDirectory(input) {
  if (!SHA1_PATTERN.test(input.lastCodeCommit)) {
    fail("Expected LastCode commit must be a full lowercase SHA-1.");
  }
  const artifacts = parseManifest(input.directory, input.checkpointTag, input.lastCodeCommit);
  const checksums = parseChecksums(input.directory);
  assertExactNames(
    checksums.keys(),
    artifacts.map((artifact) => artifact.path),
    CHECKSUMS_NAME,
  );

  const localAssets = artifacts.map((artifact) => {
    const path = NodePath.join(input.directory, artifact.path);
    let stats;
    try {
      stats = NodeFS.statSync(path);
    } catch (error) {
      fail(
        `Could not inspect artifact ${artifact.path}: ${error instanceof Error ? error.message : error}`,
      );
    }
    if (!stats.isFile()) fail(`Artifact ${artifact.path} is not a regular file.`);
    if (stats.size !== artifact.bytes) {
      fail(`Artifact ${artifact.path} byte count disagrees with the build manifest.`);
    }
    const sha256 = hashFile(path);
    if (sha256 !== artifact.sha256) {
      fail(`Artifact ${artifact.path} hash disagrees with the build manifest.`);
    }
    if (checksums.get(artifact.path) !== sha256) {
      fail(`Artifact ${artifact.path} hash disagrees with ${CHECKSUMS_NAME}.`);
    }
    return { name: artifact.path, bytes: stats.size, sha256 };
  });

  for (const name of [MANIFEST_NAME, CHECKSUMS_NAME]) {
    const path = NodePath.join(input.directory, name);
    localAssets.push({ name, bytes: NodeFS.statSync(path).size, sha256: hashFile(path) });
  }
  assertExactNames(
    directoryFiles(input.directory),
    localAssets.map((asset) => asset.name),
    "Directory",
  );

  if (input.releaseJsonPath) {
    validateReleaseMetadata(
      readJson(input.releaseJsonPath, "GitHub Release metadata"),
      input.checkpointTag,
      localAssets,
    );
  }
  return {
    assetNames: localAssets.map((asset) => asset.name).toSorted(),
    dmgName: artifacts.find((artifact) => artifact.path.endsWith(".dmg")).path,
  };
}

export function parseIntelReleaseOptions(argv) {
  if (argv[0] !== "validate") fail("Expected 'validate'.");
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!["--directory", "--tag", "--commit", "--release-json"].includes(arg)) {
      fail(`Unknown argument '${arg}'.`);
    }
    const value = argv[index + 1];
    if (!value) fail(`Missing value for ${arg}.`);
    if (arg === "--directory") options.directory = NodePath.resolve(value);
    else if (arg === "--tag") options.checkpointTag = value;
    else if (arg === "--commit") options.lastCodeCommit = value;
    else options.releaseJsonPath = NodePath.resolve(value);
    index += 1;
  }
  if (!options.directory) fail("Missing --directory.");
  if (!options.checkpointTag) fail("Missing --tag.");
  if (!options.lastCodeCommit) fail("Missing --commit.");
  return options;
}

function main(argv) {
  const result = validateIntelReleaseDirectory(parseIntelReleaseOptions(argv));
  process.stdout.write(
    `Validated immutable Intel release assets: ${result.assetNames.join(", ")}\n`,
  );
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `[lastcode:intel-release] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
