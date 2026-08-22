import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  compareInstallables,
  listIntelReleases,
  parseInstallableTag,
  parseStageOptions,
  readPending,
  stageIntelUpdate,
} from "./lastcode-intel-stage.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-intel-stage-"));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(path) {
  return NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex");
}

function writeJson(path, value) {
  NodeFS.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function fakeRelease(tag, commit) {
  return async ({ directory, releaseJsonPath }) => {
    const version = tag.replace(/^lastcode\/(?:checkpoint|revision)\/v/u, "");
    const dmgName = `LastCode-${version}-x64.dmg`;
    const dmgPath = NodePath.join(directory, dmgName);
    NodeFS.writeFileSync(dmgPath, `DMG ${tag}`);
    const artifact = {
      bytes: NodeFS.statSync(dmgPath).size,
      path: dmgName,
      sha256: sha256(dmgPath),
    };
    writeJson(NodePath.join(directory, "build-manifest.json"), {
      schemaVersion: 1,
      arch: "x64",
      artifacts: [artifact],
      buildTag: `lastcode/build/v${version}.1`,
      builtAt: "2026-08-21T20:00:00.000Z",
      checkpointTag: tag,
      lastCodeCommit: commit,
      platform: "mac",
      upstreamCommit: "c".repeat(40),
      upstreamTag: "v1.2.3-nightly.20260821.2",
    });
    NodeFS.writeFileSync(
      NodePath.join(directory, "SHA256SUMS"),
      `${artifact.sha256}  ${dmgName}\n`,
    );
    const names = [dmgName, "build-manifest.json", "SHA256SUMS"];
    writeJson(releaseJsonPath, {
      tagName: tag,
      isDraft: false,
      isImmutable: true,
      isPrerelease: true,
      assets: names.map((name) => {
        const path = NodePath.join(directory, name);
        return {
          name,
          size: NodeFS.statSync(path).size,
          digest: `sha256:${sha256(path)}`,
          state: "uploaded",
        };
      }),
    });
  };
}

const inspectDmg = async (_path, options) => ({
  sha256: options.expectedSha256,
  version: options.expectedVersion,
});

function dependencies(tag, commit, overrides = {}) {
  return {
    acquireLock: () => () => undefined,
    downloadRelease: fakeRelease(tag, commit),
    inspectDmg,
    listReleases: async () => [
      { tagName: tag, isDraft: false, isImmutable: true, isPrerelease: true },
    ],
    resolveCommit: async () => commit,
    ...overrides,
  };
}

describe("LastCode Intel staging", () => {
  it("orders immutable checkpoints and revisions and rejects lookalikes", () => {
    const checkpoint = parseInstallableTag("lastcode/checkpoint/v1.2.3-nightly.20260821.7");
    const revision = parseInstallableTag("lastcode/revision/v1.2.3-nightly.20260821.7.2");
    expect(compareInstallables(revision, checkpoint)).toBeGreaterThan(0);
    expect(parseInstallableTag("lastcode/checkpoint/v1.2.3-nightly.20260821.7.2")).toBeUndefined();
    expect(parseInstallableTag("lastcode/revision/v1.2.3-nightly.20260821.7")).toBeUndefined();
  });

  it("ignores mutable release listings before download", async () => {
    const root = temporaryDirectory();
    const tag = "lastcode/revision/v1.2.3-nightly.20260821.7.2";
    const commit = "a".repeat(40);
    const result = await stageIntelUpdate(
      { currentVersion: "1.2.3-nightly.20260820.1", homeDirectory: root },
      dependencies(tag, commit, {
        downloadRelease: async () => {
          throw new Error("mutable release must not download");
        },
        listReleases: async () => [
          { tagName: tag, isDraft: false, isImmutable: false, isPrerelease: true },
        ],
      }),
    );
    expect(result).toMatchObject({ status: "up-to-date", pending: undefined });
  });

  it("discovers eligible releases beyond the first GitHub API page", () => {
    const tag = "lastcode/revision/v1.2.3-nightly.20260821.7.2";
    let invocation;
    const releases = listIntelReleases("lastobelus/lastCode", {
      runCommand: (command, args) => {
        invocation = { args, command };
        return JSON.stringify([
          Array.from({ length: 100 }, (_, index) => ({
            tag_name: `unrelated-${index}`,
            draft: false,
            immutable: true,
            prerelease: true,
          })),
          [{ tag_name: tag, draft: false, immutable: true, prerelease: true }],
        ]);
      },
    });

    expect(invocation).toEqual({
      command: "gh",
      args: ["api", "--paginate", "--slurp", "repos/lastobelus/lastCode/releases?per_page=100"],
    });
    expect(releases.at(-1)).toEqual({
      tagName: tag,
      isDraft: false,
      isImmutable: true,
      isPrerelease: true,
    });
  });

  it("stages one exact validated candidate with a safe inspection contract", async () => {
    const root = temporaryDirectory();
    const tag = "lastcode/revision/v1.2.3-nightly.20260821.7.2";
    const commit = "a".repeat(40);
    const result = await stageIntelUpdate(
      { currentVersion: "1.2.3-nightly.20260820.1", homeDirectory: root },
      dependencies(tag, commit),
    );

    expect(result.status).toBe("staged");
    expect(result.pending).toMatchObject({ commit, tag, version: "1.2.3-nightly.20260821.7.2" });
    expect(NodeFS.existsSync(result.pending.dmgPath)).toBe(true);
    expect(readPending(root)).toMatchObject({ commit, tag });
    expect(NodeFS.readdirSync(NodePath.join(root, "candidates"))).toHaveLength(1);
  });

  it("preserves the old pending candidate when a newer release mismatches", async () => {
    const root = temporaryDirectory();
    const oldTag = "lastcode/checkpoint/v1.2.3-nightly.20260821.7";
    const oldCommit = "a".repeat(40);
    await stageIntelUpdate(
      { currentVersion: "1.2.3-nightly.20260820.1", homeDirectory: root },
      dependencies(oldTag, oldCommit),
    );
    const oldPending = readPending(root);
    const newerTag = "lastcode/revision/v1.2.3-nightly.20260821.7.2";
    await expect(
      stageIntelUpdate(
        { currentVersion: "1.2.3-nightly.20260820.1", homeDirectory: root },
        dependencies(newerTag, "b".repeat(40), {
          downloadRelease: fakeRelease(newerTag, "c".repeat(40)),
        }),
      ),
    ).rejects.toThrow("commit mismatch");

    expect(readPending(root)).toMatchObject({ candidateId: oldPending.candidateId, tag: oldTag });
    expect(NodeFS.readdirSync(NodePath.join(root, "candidates"))).toEqual([oldPending.candidateId]);
  });

  it("commits supersession only after validation and retains one candidate", async () => {
    const root = temporaryDirectory();
    const oldTag = "lastcode/checkpoint/v1.2.3-nightly.20260821.7";
    await stageIntelUpdate(
      { currentVersion: "1.2.3-nightly.20260820.1", homeDirectory: root },
      dependencies(oldTag, "a".repeat(40)),
    );
    const oldPending = readPending(root);
    const newerTag = "lastcode/revision/v1.2.3-nightly.20260821.7.2";
    const newerCommit = "b".repeat(40);
    await expect(
      stageIntelUpdate(
        { currentVersion: "1.2.3-nightly.20260820.1", homeDirectory: root },
        dependencies(newerTag, newerCommit, {
          beforeCommit: async () => {
            throw new Error("injected pointer failure");
          },
        }),
      ),
    ).rejects.toThrow("injected pointer failure");
    expect(readPending(root)).toMatchObject({ candidateId: oldPending.candidateId });

    await stageIntelUpdate(
      { currentVersion: "1.2.3-nightly.20260820.1", homeDirectory: root },
      dependencies(newerTag, newerCommit),
    );
    expect(readPending(root)).toMatchObject({ commit: newerCommit, tag: newerTag });
    expect(NodeFS.readdirSync(NodePath.join(root, "candidates"))).toHaveLength(1);
  });

  it("keeps status coherent when supersession removes the prior candidate", async () => {
    const root = temporaryDirectory();
    const replacementRoot = temporaryDirectory();
    const oldTag = "lastcode/checkpoint/v1.2.3-nightly.20260821.7";
    const newTag = "lastcode/revision/v1.2.3-nightly.20260821.7.2";
    await stageIntelUpdate(
      { currentVersion: "1.2.3-nightly.20260820.1", homeDirectory: root },
      dependencies(oldTag, "a".repeat(40)),
    );
    await stageIntelUpdate(
      { currentVersion: "1.2.3-nightly.20260820.1", homeDirectory: replacementRoot },
      dependencies(newTag, "b".repeat(40)),
    );
    const oldPending = readPending(root);
    const newPending = readPending(replacementRoot);
    NodeFS.cpSync(
      newPending.candidateDirectory,
      NodePath.join(root, "candidates", newPending.candidateId),
      { recursive: true },
    );
    const newPointer = NodeFS.readFileSync(NodePath.join(replacementRoot, "pending.json"), "utf8");
    let superseded = false;

    const observed = readPending(root, {
      afterPointerRead: ({ attempt }) => {
        if (attempt !== 0 || superseded) return;
        superseded = true;
        NodeFS.writeFileSync(NodePath.join(root, "pending.json"), newPointer);
        NodeFS.rmSync(oldPending.candidateDirectory, { force: true, recursive: true });
      },
    });

    expect(observed).toMatchObject({ candidateId: newPending.candidateId, tag: newTag });
  });

  it("does not publish a candidate whose parent directory could not be synced", async () => {
    const root = temporaryDirectory();
    const oldTag = "lastcode/checkpoint/v1.2.3-nightly.20260821.7";
    await stageIntelUpdate(
      { currentVersion: "1.2.3-nightly.20260820.1", homeDirectory: root },
      dependencies(oldTag, "a".repeat(40)),
    );
    const oldPending = readPending(root);
    const newTag = "lastcode/revision/v1.2.3-nightly.20260821.7.2";

    await expect(
      stageIntelUpdate(
        { currentVersion: "1.2.3-nightly.20260820.1", homeDirectory: root },
        dependencies(newTag, "b".repeat(40), {
          syncDirectory: () => {
            throw new Error("injected directory sync failure");
          },
        }),
      ),
    ).rejects.toThrow("injected directory sync failure");
    expect(readPending(root)).toMatchObject({ candidateId: oldPending.candidateId, tag: oldTag });
    expect(NodeFS.readdirSync(NodePath.join(root, "candidates"))).toEqual([oldPending.candidateId]);
  });

  it("preserves a published candidate when the pointer directory sync fails", async () => {
    const root = temporaryDirectory();
    const oldTag = "lastcode/checkpoint/v1.2.3-nightly.20260821.7";
    await stageIntelUpdate(
      { currentVersion: "1.2.3-nightly.20260820.1", homeDirectory: root },
      dependencies(oldTag, "a".repeat(40)),
    );
    const newTag = "lastcode/revision/v1.2.3-nightly.20260821.7.2";
    const newCommit = "b".repeat(40);

    await expect(
      stageIntelUpdate(
        { currentVersion: "1.2.3-nightly.20260820.1", homeDirectory: root },
        dependencies(newTag, newCommit, {
          syncPendingDirectory: () => {
            throw new Error("injected pending directory sync failure");
          },
        }),
      ),
    ).rejects.toThrow("injected pending directory sync failure");
    expect(readPending(root)).toMatchObject({ commit: newCommit, tag: newTag });

    const result = await stageIntelUpdate(
      { currentVersion: "1.2.3-nightly.20260820.1", homeDirectory: root },
      dependencies(newTag, newCommit),
    );
    expect(result.status).toBe("pending");
    expect(NodeFS.readdirSync(NodePath.join(root, "candidates"))).toHaveLength(1);
  });

  it("does not publish a candidate whose downloaded asset tree could not be synced", async () => {
    const root = temporaryDirectory();
    const oldTag = "lastcode/checkpoint/v1.2.3-nightly.20260821.7";
    await stageIntelUpdate(
      { currentVersion: "1.2.3-nightly.20260820.1", homeDirectory: root },
      dependencies(oldTag, "a".repeat(40)),
    );
    const oldPending = readPending(root);
    const newTag = "lastcode/revision/v1.2.3-nightly.20260821.7.2";

    await expect(
      stageIntelUpdate(
        { currentVersion: "1.2.3-nightly.20260820.1", homeDirectory: root },
        dependencies(newTag, "b".repeat(40), {
          syncCandidateTree: () => {
            throw new Error("injected asset tree sync failure");
          },
        }),
      ),
    ).rejects.toThrow("injected asset tree sync failure");
    expect(readPending(root)).toMatchObject({ candidateId: oldPending.candidateId, tag: oldTag });
    expect(NodeFS.readdirSync(NodePath.join(root, "candidates"))).toEqual([oldPending.candidateId]);
  });

  it("removes stale incomplete downloads while holding the staging lock", async () => {
    const root = temporaryDirectory();
    const incomplete = NodePath.join(root, ".incomplete-interrupted", "assets");
    NodeFS.mkdirSync(incomplete, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(incomplete, "partial.dmg"), "partial download");
    let locked = false;
    const tag = "lastcode/checkpoint/v1.2.3-nightly.20260821.7";

    const result = await stageIntelUpdate(
      { currentVersion: "1.2.3-nightly.20260821.7", homeDirectory: root },
      dependencies(tag, "a".repeat(40), {
        acquireLock: () => {
          locked = true;
          return () => {
            locked = false;
          };
        },
        listReleases: async () => {
          expect(locked).toBe(true);
          expect(NodeFS.existsSync(NodePath.dirname(incomplete))).toBe(false);
          return [];
        },
      }),
    );

    expect(result.status).toBe("up-to-date");
    expect(locked).toBe(false);
  });

  it("removes an unreferenced candidate left before pointer publication", async () => {
    const root = temporaryDirectory();
    const orphan = NodePath.join(root, "candidates", "orphaned-after-rename", "assets");
    NodeFS.mkdirSync(orphan, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(orphan, "complete-but-unpublished.dmg"), "orphan");
    const tag = "lastcode/checkpoint/v1.2.3-nightly.20260821.7";

    const result = await stageIntelUpdate(
      { currentVersion: "1.2.3-nightly.20260821.7", homeDirectory: root },
      dependencies(tag, "a".repeat(40), { listReleases: async () => [] }),
    );

    expect(result.status).toBe("up-to-date");
    expect(NodeFS.readdirSync(NodePath.join(root, "candidates"))).toEqual([]);
  });

  it("clears a pending candidate after the installed app catches up", async () => {
    const root = temporaryDirectory();
    const tag = "lastcode/checkpoint/v1.2.3-nightly.20260821.7";
    const commit = "a".repeat(40);
    await stageIntelUpdate(
      { currentVersion: "1.2.3-nightly.20260820.1", homeDirectory: root },
      dependencies(tag, commit),
    );

    const result = await stageIntelUpdate(
      { currentVersion: "1.2.3-nightly.20260821.7", homeDirectory: root },
      dependencies(tag, commit),
    );
    expect(result).toMatchObject({ status: "up-to-date", pending: undefined });
    expect(readPending(root)).toBeUndefined();
    expect(NodeFS.readdirSync(NodePath.join(root, "candidates"))).toEqual([]);
  });

  it("holds one cross-process lock through staging and releases it on failure", async () => {
    const root = temporaryDirectory();
    const tag = "lastcode/revision/v1.2.3-nightly.20260821.7.2";
    const commit = "a".repeat(40);
    let locked = false;
    let released = false;
    const acquireLock = () => {
      expect(locked).toBe(false);
      locked = true;
      return () => {
        released = true;
        locked = false;
      };
    };
    await expect(
      stageIntelUpdate(
        { currentVersion: "1.2.3-nightly.20260820.1", homeDirectory: root },
        dependencies(tag, commit, {
          acquireLock,
          beforeCommit: async () => {
            expect(locked).toBe(true);
            throw new Error("injected failure while locked");
          },
        }),
      ),
    ).rejects.toThrow("injected failure while locked");
    expect(released).toBe(true);

    await expect(
      stageIntelUpdate(
        { currentVersion: "1.2.3-nightly.20260820.1", homeDirectory: root },
        dependencies(tag, commit, {
          acquireLock: () => {
            throw new Error("another staging run owns the lock");
          },
        }),
      ),
    ).rejects.toThrow("another staging run owns the lock");
    expect(readPending(root)).toBeUndefined();
  });

  it("parses only status and staging options", () => {
    expect(
      parseStageOptions([
        "stage",
        "--current-version",
        "1.2.3-nightly.20260820.1",
        "--repository",
        "lastobelus/lastCode",
      ]),
    ).toMatchObject({ command: "stage", repository: "lastobelus/lastCode" });
    expect(parseStageOptions(["status", "--home-dir", "/tmp/intel"])).toMatchObject({
      command: "status",
      homeDirectory: "/tmp/intel",
    });
    expect(() => parseStageOptions(["install"])).toThrow("Expected 'stage' or 'status'");
  });
});
