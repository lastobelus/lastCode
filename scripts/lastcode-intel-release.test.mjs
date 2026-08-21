import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  parseIntelReleaseOptions,
  validateIntelReleaseDirectory,
} from "./lastcode-intel-release.mjs";

const checkpointTag = "lastcode/revision/v1.2.3-nightly.20260821.7.2";
const commit = "a".repeat(40);
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { force: true, recursive: true });
  }
});

function sha256(path) {
  return NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex");
}

function writeJson(path, value) {
  NodeFS.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function createFixture() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-intel-release-"));
  temporaryDirectories.push(directory);
  const artifactContents = new Map([
    ["LastCode-1.2.3-x64.dmg", "dmg payload"],
    ["LastCode-1.2.3-x64.dmg.blockmap", "blockmap payload"],
  ]);
  const artifacts = [];
  for (const [name, contents] of artifactContents) {
    const path = NodePath.join(directory, name);
    NodeFS.writeFileSync(path, contents);
    artifacts.push({ path: name, bytes: NodeFS.statSync(path).size, sha256: sha256(path) });
  }
  const manifestPath = NodePath.join(directory, "build-manifest.json");
  writeJson(manifestPath, {
    schemaVersion: 1,
    arch: "x64",
    artifacts,
    buildTag: "lastcode/build/v1.2.3-nightly.20260821.7.2.1",
    builtAt: "2026-08-21T20:00:00.000Z",
    checkpointTag,
    lastCodeCommit: commit,
    platform: "mac",
    upstreamCommit: "b".repeat(40),
    upstreamTag: "v1.2.3-nightly.20260821.7",
  });
  NodeFS.writeFileSync(
    NodePath.join(directory, "SHA256SUMS"),
    `${artifacts.map((artifact) => `${artifact.sha256}  ${artifact.path}`).join("\n")}\n`,
  );
  const assetNames = [
    ...artifacts.map((artifact) => artifact.path),
    "build-manifest.json",
    "SHA256SUMS",
  ];
  const releaseJsonPath = NodePath.join(
    NodeOS.tmpdir(),
    `lastcode-release-${NodeCrypto.randomUUID()}.json`,
  );
  temporaryDirectories.push(releaseJsonPath);
  writeJson(releaseJsonPath, {
    tagName: checkpointTag,
    isDraft: false,
    isPrerelease: true,
    assets: assetNames.map((name) => {
      const path = NodePath.join(directory, name);
      return {
        name,
        size: NodeFS.statSync(path).size,
        digest: `sha256:${sha256(path)}`,
        state: "uploaded",
      };
    }),
  });
  return { artifacts, directory, manifestPath, releaseJsonPath };
}

const validate = (fixture, overrides = {}) =>
  validateIntelReleaseDirectory({
    directory: fixture.directory,
    checkpointTag,
    lastCodeCommit: commit,
    ...overrides,
  });

describe("immutable Intel release validation", () => {
  it("accepts a complete local build and matching prerelease", () => {
    const fixture = createFixture();
    expect(validate(fixture)).toEqual({
      assetNames: [
        "LastCode-1.2.3-x64.dmg",
        "LastCode-1.2.3-x64.dmg.blockmap",
        "SHA256SUMS",
        "build-manifest.json",
      ],
      dmgName: "LastCode-1.2.3-x64.dmg",
    });
    expect(validate(fixture, { releaseJsonPath: fixture.releaseJsonPath })).toBeDefined();
  });

  it("requires the exact x64 macOS tag and commit identity", () => {
    const fixture = createFixture();
    const manifest = JSON.parse(NodeFS.readFileSync(fixture.manifestPath, "utf8"));
    for (const [field, value, message] of [
      ["schemaVersion", 2, "schemaVersion"],
      ["arch", "arm64", "architecture"],
      ["platform", "linux", "platform"],
      ["checkpointTag", `${checkpointTag}.wrong`, "tag mismatch"],
      ["lastCodeCommit", "b".repeat(40), "commit mismatch"],
    ]) {
      writeJson(fixture.manifestPath, { ...manifest, [field]: value });
      expect(() => validate(fixture)).toThrow(message);
    }
  });

  it("rejects missing and foreign files instead of accepting a partial asset set", () => {
    const missing = createFixture();
    NodeFS.rmSync(NodePath.join(missing.directory, missing.artifacts[1].path));
    expect(() => validate(missing)).toThrow(/Could not inspect artifact|missing/);

    const foreign = createFixture();
    NodeFS.writeFileSync(NodePath.join(foreign.directory, "foreign.txt"), "foreign");
    expect(() => validate(foreign)).toThrow("foreign: foreign.txt");
  });

  it("rejects hidden manifest assets that a release upload glob would omit", () => {
    const fixture = createFixture();
    const manifest = JSON.parse(NodeFS.readFileSync(fixture.manifestPath, "utf8"));
    manifest.artifacts[0].path = ".hidden.dmg";
    writeJson(fixture.manifestPath, manifest);
    expect(() => validate(fixture)).toThrow("unsafe asset path");
  });

  it("rejects artifact and checksum disagreement", () => {
    const tamperedArtifact = createFixture();
    NodeFS.appendFileSync(
      NodePath.join(tamperedArtifact.directory, tamperedArtifact.artifacts[0].path),
      "changed",
    );
    expect(() => validate(tamperedArtifact)).toThrow("byte count disagrees");

    const tamperedChecksums = createFixture();
    NodeFS.writeFileSync(
      NodePath.join(tamperedChecksums.directory, "SHA256SUMS"),
      `${"c".repeat(64)}  ${tamperedChecksums.artifacts[0].path}\n`,
    );
    expect(() => validate(tamperedChecksums)).toThrow(/missing:.*blockmap/);
  });

  it("fails closed on release identity, policy, asset, and digest disagreement", () => {
    for (const mutate of [
      (release) => ({ ...release, tagName: `${checkpointTag}.wrong` }),
      (release) => ({ ...release, isDraft: true }),
      (release) => ({ ...release, isPrerelease: false }),
      (release) => ({ ...release, assets: release.assets.slice(1) }),
      (release) => ({
        ...release,
        assets: [
          ...release.assets,
          { name: "foreign.txt", size: 7, digest: `sha256:${"e".repeat(64)}`, state: "uploaded" },
        ],
      }),
      (release) => ({
        ...release,
        assets: release.assets.map((asset, index) =>
          index === 0 ? { ...asset, digest: null } : asset,
        ),
      }),
      (release) => ({
        ...release,
        assets: release.assets.map((asset, index) =>
          index === 0 ? { ...asset, digest: `sha256:${"d".repeat(64)}` } : asset,
        ),
      }),
    ]) {
      const fixture = createFixture();
      const release = JSON.parse(NodeFS.readFileSync(fixture.releaseJsonPath, "utf8"));
      writeJson(fixture.releaseJsonPath, mutate(release));
      expect(() => validate(fixture, { releaseJsonPath: fixture.releaseJsonPath })).toThrow();
    }
  });

  it("parses only the narrow validation command", () => {
    expect(
      parseIntelReleaseOptions([
        "validate",
        "--directory",
        "/tmp/release",
        "--tag",
        checkpointTag,
        "--commit",
        commit,
        "--release-json",
        "/tmp/release.json",
      ]),
    ).toEqual({
      directory: "/tmp/release",
      checkpointTag,
      lastCodeCommit: commit,
      releaseJsonPath: "/tmp/release.json",
    });
    expect(() => parseIntelReleaseOptions(["publish"])).toThrow("Expected 'validate'");
  });
});
