// @effect-diagnostics nodeBuiltinImport:off - exercises the dependency-free Node helper against real files and Git worktrees.
import { assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

import {
  acquireBuildLock,
  compareNightlyVersions,
  isReusableCheckpointCiStamp,
  parseNightlyVersion,
  parseOptions,
  prepareBuildWorktree,
  quarantineIncompleteBuild,
  resolveDeterministicBuildEnvironment,
  resolveExistingBuild,
  resolveLatestInstallableTag,
  resolveLocalBuildEnvironment,
} from "./lastcode-local-update.mjs";

// oxlint-disable-next-line t3code/no-global-process-runtime -- This integration test exercises a macOS-only kernel lock.
const itMacOnly = process.platform === "darwin" ? it : it.skip;

function runGit(cwd: string, args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commitFile(repo: string, path: string, contents: string, subject: string): string {
  NodeFS.writeFileSync(NodePath.join(repo, path), contents);
  runGit(repo, ["add", path]);
  runGit(repo, ["commit", "-m", subject]);
  return runGit(repo, ["rev-parse", "HEAD"]);
}

function tagInstallable(repo: string, tag: string, sourceCommit: string): void {
  runGit(repo, [
    "tag",
    "--annotate",
    tag,
    "--message",
    `LastCode test installable\n\nSource-Commit: ${sourceCommit}`,
  ]);
}

function inspectRepository(
  repo: string,
  root: string,
  currentVersion: string,
  grouped: boolean,
): unknown {
  const output = NodeChildProcess.execFileSync(
    process.execPath,
    [
      NodePath.join(import.meta.dirname, "lastcode-local-update.mjs"),
      "inspect",
      "--repo",
      repo,
      "--home",
      root,
      "--current-version",
      currentVersion,
      ...(grouped ? ["--release-notes-format", "grouped-v1"] : []),
    ],
    { encoding: "utf8" },
  );
  const resultLine = output
    .split(/\r?\n/)
    .find((line) => line.startsWith("LASTCODE_LOCAL_UPDATE_RESULT="));
  assert.ok(resultLine);
  return JSON.parse(resultLine.slice("LASTCODE_LOCAL_UPDATE_RESULT=".length));
}

describe("lastcode-local-update", () => {
  itMacOnly("serializes manual and in-app builds and releases the kernel lock", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-build-lock-"));
    try {
      const release = acquireBuildLock(root);
      assert.throws(() => acquireBuildLock(root), /already running/);
      release();

      const lockPath = NodePath.join(root, "build.lock");
      assert.strictEqual(NodeFS.readFileSync(lockPath, "utf8"), "");
      const releaseAgain = acquireBuildLock(root);
      releaseAgain();
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses a deterministic locale for checkpoint validation and packaging", () => {
    assert.deepInclude(resolveDeterministicBuildEnvironment({ PATH: "/bin" }), {
      PATH: "/bin",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
    });
    assert.match(
      resolveLocalBuildEnvironment("/tmp/build tree", { PATH: "/bin" }).PATH ?? "",
      /^\/tmp\/build tree\/node_modules\/\.bin:/,
    );
  });

  it("only reuses a full CI stamp for the exact checkpoint context", () => {
    const stamp = {
      schemaVersion: 2,
      commit: "checkpoint-commit",
      context: {
        kind: "checkpoint",
        checkpointTag: "lastcode/checkpoint/v0.0.34-nightly.20260814.1090",
        upstreamCommit: "upstream-commit",
      },
    };
    assert.isTrue(
      isReusableCheckpointCiStamp(
        stamp,
        "lastcode/checkpoint/v0.0.34-nightly.20260814.1090",
        "checkpoint-commit",
        "upstream-commit",
      ),
    );
    assert.isFalse(
      isReusableCheckpointCiStamp(
        stamp,
        "lastcode/checkpoint/v0.0.34-nightly.20260814.1091",
        "checkpoint-commit",
        "upstream-commit",
      ),
    );
  });

  it("orders checkpoints and LastCode revisions", () => {
    assert.deepEqual(
      parseNightlyVersion("0.0.34-nightly.20260814.1089")?.parts,
      [0, 0, 34, 20260814, 1089, 0],
    );
    assert.isAbove(
      compareNightlyVersions("0.0.34-nightly.20260814.1089", "0.0.34-nightly.20260813.1088"),
      0,
    );
    assert.equal(
      resolveLatestInstallableTag([
        "unrelated",
        "lastcode/checkpoint/v0.0.34-nightly.20260813.1088",
        "lastcode/checkpoint/v0.0.34-nightly.20260814.1089",
        "lastcode/revision/v0.0.34-nightly.20260814.1089.2",
      ]),
      "lastcode/revision/v0.0.34-nightly.20260814.1089.2",
    );
    assert.isAbove(
      compareNightlyVersions("0.0.34-nightly.20260814.1089.2", "0.0.34-nightly.20260814.1089"),
      0,
    );
    assert.isAbove(
      compareNightlyVersions("0.0.34-nightly.20260814.1090", "0.0.34-nightly.20260814.1089.99"),
      0,
    );
  });

  it("reports a revision after the installed checkpoint as available", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-inspect-revision-"));
    try {
      const repo = NodePath.join(root, "repo");
      NodeFS.mkdirSync(repo);
      NodeChildProcess.execFileSync("git", ["init"], { cwd: repo });
      NodeChildProcess.execFileSync("git", ["config", "user.name", "LastCode Test"], {
        cwd: repo,
      });
      NodeChildProcess.execFileSync("git", ["config", "user.email", "test@lastcode.invalid"], {
        cwd: repo,
      });
      NodeFS.writeFileSync(NodePath.join(repo, "tracked.txt"), "checkpoint\n");
      NodeChildProcess.execFileSync("git", ["add", "tracked.txt"], { cwd: repo });
      NodeChildProcess.execFileSync("git", ["commit", "-m", "checkpoint"], { cwd: repo });
      const nightly = "v0.0.34-nightly.20260816.1105";
      NodeChildProcess.execFileSync("git", ["tag", nightly], { cwd: repo });
      NodeChildProcess.execFileSync("git", ["tag", `lastcode/checkpoint/${nightly}`], {
        cwd: repo,
      });
      NodeFS.writeFileSync(NodePath.join(repo, "tracked.txt"), "revision\n");
      NodeChildProcess.execFileSync("git", ["commit", "-am", "ship local revision"], { cwd: repo });
      NodeChildProcess.execFileSync("git", ["tag", `lastcode/revision/${nightly}.1`], {
        cwd: repo,
      });

      const output = NodeChildProcess.execFileSync(
        process.execPath,
        [
          NodePath.join(import.meta.dirname, "lastcode-local-update.mjs"),
          "inspect",
          "--repo",
          repo,
          "--home",
          root,
          "--current-version",
          nightly.slice(1),
        ],
        { encoding: "utf8" },
      );
      const resultLine = output
        .split(/\r?\n/)
        .find((line) => line.startsWith("LASTCODE_LOCAL_UPDATE_RESULT="));
      assert.ok(resultLine);
      assert.deepInclude(JSON.parse(resultLine.slice("LASTCODE_LOCAL_UPDATE_RESULT=".length)), {
        status: "available",
        checkpointTag: `lastcode/revision/${nightly}.1`,
        availableVersion: `${nightly.slice(1)}.1`,
        releaseNotes: ["ship local revision"],
      });
      assert.deepEqual(inspectRepository(repo, root, nightly.slice(1), true), {
        schemaVersion: 2,
        status: "available",
        checkpointTag: `lastcode/revision/${nightly}.1`,
        availableVersion: `${nightly.slice(1)}.1`,
        releaseNotes: {
          lastCode: { status: "unavailable" },
          upstream: { groups: [], omittedGroups: 0 },
        },
      });
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("groups missed upstream nightlies and excludes replayed or upstreamed LastCode patches", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-grouped-notes-"));
    const repo = NodePath.join(root, "repo");
    try {
      NodeFS.mkdirSync(repo);
      runGit(repo, ["init"]);
      runGit(repo, ["config", "user.name", "LastCode Test"]);
      runGit(repo, ["config", "user.email", "test@lastcode.invalid"]);

      const nightly1 = "v0.0.34-nightly.20260816.1105";
      const nightly2 = "v0.0.34-nightly.20260816.1106";
      const nightly3 = "v0.0.34-nightly.20260816.1107";
      const upstream1 = commitFile(repo, "base.txt", "base\n", "upstream one");
      runGit(repo, ["tag", nightly1, upstream1]);

      runGit(repo, ["switch", "-c", "lastcode-one", upstream1]);
      const checkpoint1 = commitFile(repo, "old.txt", "old\n", "lastcode old");
      tagInstallable(repo, `lastcode/checkpoint/${nightly1}`, checkpoint1);

      runGit(repo, ["switch", "-c", "upstream-two", upstream1]);
      const upstream2 = commitFile(repo, "upstream-two.txt", "two\n", "upstream two");
      runGit(repo, ["tag", nightly2, upstream2]);

      runGit(repo, ["switch", "-c", "lastcode-two", checkpoint1]);
      runGit(repo, ["rebase", "--onto", upstream2, upstream1]);
      const checkpoint2 = runGit(repo, ["rev-parse", "HEAD"]);
      tagInstallable(repo, `lastcode/checkpoint/${nightly2}`, checkpoint1);

      const adoptedSource = commitFile(repo, "adopted.txt", "adopted\n", "lastcode adopted");
      const source3 = commitFile(repo, "new.txt", "new\n", "lastcode new");

      runGit(repo, ["switch", "-c", "upstream-three", upstream2]);
      commitFile(repo, "adopted.txt", "adopted\n", "upstream adopts patch");
      const upstream3 = runGit(repo, ["rev-parse", "HEAD"]);
      runGit(repo, ["tag", nightly3, upstream3]);

      runGit(repo, ["switch", "-c", "lastcode-three", source3]);
      runGit(repo, ["rebase", "--onto", upstream3, upstream2]);
      tagInstallable(repo, `lastcode/checkpoint/${nightly3}`, source3);

      assert.notEqual(checkpoint1, checkpoint2);
      assert.equal(
        runGit(repo, ["cherry", nightly3, source3, checkpoint2]),
        [`- ${adoptedSource}`, `+ ${source3}`].join("\n"),
      );
      assert.deepEqual(inspectRepository(repo, root, nightly1.slice(1), true), {
        schemaVersion: 2,
        status: "available",
        checkpointTag: `lastcode/checkpoint/${nightly3}`,
        availableVersion: nightly3.slice(1),
        releaseNotes: {
          lastCode: {
            status: "known",
            items: ["lastcode new"],
            omittedItems: 0,
          },
          upstream: {
            groups: [
              {
                version: nightly3.slice(1),
                isTarget: true,
                items: ["upstream adopts patch"],
                omittedItems: 0,
              },
              {
                version: nightly2.slice(1),
                isTarget: false,
                items: ["upstream two"],
                omittedItems: 0,
              },
            ],
            omittedGroups: 0,
          },
        },
      });
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps upstream groups when installed provenance is missing, invalid, or unrelated", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-unavailable-notes-"));
    const repo = NodePath.join(root, "repo");
    try {
      NodeFS.mkdirSync(repo);
      runGit(repo, ["init"]);
      runGit(repo, ["config", "user.name", "LastCode Test"]);
      runGit(repo, ["config", "user.email", "test@lastcode.invalid"]);
      const nightly1 = "v0.0.34-nightly.20260816.1105";
      const nightly2 = "v0.0.34-nightly.20260816.1106";
      const upstream1 = commitFile(repo, "base.txt", "base\n", "upstream one");
      runGit(repo, ["tag", nightly1, upstream1]);
      const upstream2 = commitFile(repo, "upstream-two.txt", "two\n", "upstream two");
      runGit(repo, ["tag", nightly2, upstream2]);
      tagInstallable(repo, `lastcode/checkpoint/${nightly2}`, upstream2);

      const expectedUpstream = {
        groups: [
          {
            version: nightly2.slice(1),
            isTarget: true,
            items: ["upstream two"],
            omittedItems: 0,
          },
        ],
        omittedGroups: 0,
      };
      assert.deepInclude(inspectRepository(repo, root, nightly1.slice(1), true), {
        releaseNotes: {
          lastCode: { status: "unavailable" },
          upstream: expectedUpstream,
        },
      });

      runGit(repo, ["switch", "--detach", upstream1]);
      tagInstallable(repo, `lastcode/checkpoint/${nightly1}`, "0".repeat(40));
      assert.deepInclude(inspectRepository(repo, root, nightly1.slice(1), true), {
        releaseNotes: {
          lastCode: { status: "unavailable" },
          upstream: expectedUpstream,
        },
      });
      runGit(repo, ["tag", "--delete", `lastcode/checkpoint/${nightly1}`]);

      runGit(repo, ["switch", "--orphan", "unrelated"]);
      const unrelatedSource = commitFile(repo, "unrelated.txt", "unrelated\n", "unrelated source");
      tagInstallable(repo, `lastcode/checkpoint/${nightly1}`, unrelatedSource);
      assert.deepInclude(inspectRepository(repo, root, nightly1.slice(1), true), {
        releaseNotes: {
          lastCode: { status: "unavailable" },
          upstream: expectedUpstream,
        },
      });
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("bounds same-nightly LastCode revision subjects with an explicit omitted count", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-revision-notes-"));
    const repo = NodePath.join(root, "repo");
    try {
      NodeFS.mkdirSync(repo);
      runGit(repo, ["init"]);
      runGit(repo, ["config", "user.name", "LastCode Test"]);
      runGit(repo, ["config", "user.email", "test@lastcode.invalid"]);
      const nightly = "v0.0.34-nightly.20260816.1105";
      const checkpoint = commitFile(repo, "base.txt", "base\n", "upstream base");
      runGit(repo, ["tag", nightly, checkpoint]);
      tagInstallable(repo, `lastcode/checkpoint/${nightly}`, checkpoint);

      for (let index = 1; index <= 10; index += 1) {
        commitFile(repo, `lastcode-${index}.txt`, `${index}\n`, `lastcode change ${index}`);
      }
      const sourceCommit = runGit(repo, ["rev-parse", "HEAD"]);
      tagInstallable(repo, `lastcode/revision/${nightly}.1`, sourceCommit);

      assert.deepEqual(inspectRepository(repo, root, nightly.slice(1), true), {
        schemaVersion: 2,
        status: "available",
        checkpointTag: `lastcode/revision/${nightly}.1`,
        availableVersion: `${nightly.slice(1)}.1`,
        releaseNotes: {
          lastCode: {
            status: "known",
            items: Array.from({ length: 8 }, (_, index) => `lastcode change ${10 - index}`),
            omittedItems: 2,
          },
          upstream: { groups: [], omittedGroups: 0 },
        },
      });
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("omits empty nightly groups before bounding upstream history", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-upstream-notes-"));
    const repo = NodePath.join(root, "repo");
    try {
      NodeFS.mkdirSync(repo);
      runGit(repo, ["init"]);
      runGit(repo, ["config", "user.name", "LastCode Test"]);
      runGit(repo, ["config", "user.email", "test@lastcode.invalid"]);
      const nightlies = Array.from(
        { length: 9 },
        (_, index) => `v0.0.34-nightly.20260816.${1105 + index}`,
      );
      const sourceCommit = commitFile(repo, "base.txt", "base\n", "upstream base");
      runGit(repo, ["tag", nightlies[0]!, sourceCommit]);
      tagInstallable(repo, `lastcode/checkpoint/${nightlies[0]}`, sourceCommit);

      runGit(repo, ["tag", nightlies[1]!, sourceCommit]);
      tagInstallable(repo, `lastcode/checkpoint/${nightlies[1]}`, sourceCommit);
      for (let nightlyIndex = 2; nightlyIndex < nightlies.length; nightlyIndex += 1) {
        const commitCount = nightlyIndex === nightlies.length - 1 ? 10 : 1;
        for (let commitIndex = 1; commitIndex <= commitCount; commitIndex += 1) {
          commitFile(
            repo,
            `upstream-${nightlyIndex}-${commitIndex}.txt`,
            `${nightlyIndex}-${commitIndex}\n`,
            `upstream ${nightlyIndex} change ${commitIndex}`,
          );
        }
        runGit(repo, ["tag", nightlies[nightlyIndex]!]);
        tagInstallable(repo, `lastcode/checkpoint/${nightlies[nightlyIndex]}`, sourceCommit);
      }

      const result = inspectRepository(repo, root, nightlies[0]!.slice(1), true) as {
        releaseNotes: {
          lastCode: unknown;
          upstream: {
            groups: ReadonlyArray<{
              version: string;
              items: ReadonlyArray<string>;
              omittedItems: number;
            }>;
            omittedGroups: number;
          };
        };
      };
      assert.deepEqual(result.releaseNotes.lastCode, {
        status: "known",
        items: [],
        omittedItems: 0,
      });
      assert.lengthOf(result.releaseNotes.upstream.groups, 6);
      assert.equal(result.releaseNotes.upstream.omittedGroups, 1);
      assert.equal(result.releaseNotes.upstream.groups[0]?.items.length, 8);
      assert.equal(result.releaseNotes.upstream.groups[0]?.omittedItems, 2);
      assert.notInclude(
        result.releaseNotes.upstream.groups.map(({ version }) => version),
        nightlies[1]!.slice(1),
      );
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("parses explicit inspect and build inputs", () => {
    assert.deepInclude(
      parseOptions(["inspect", "--repo", "/repo", "--current-version", "1.2.3-nightly.20260814.1"]),
      { command: "inspect", repoRoot: "/repo", currentVersion: "1.2.3-nightly.20260814.1" },
    );
    assert.deepInclude(
      parseOptions([
        "build",
        "--repo",
        "/repo",
        "--checkpoint",
        "lastcode/checkpoint/v1.2.3-nightly.20260814.1",
      ]),
      {
        command: "build",
        repoRoot: "/repo",
        checkpointTag: "lastcode/checkpoint/v1.2.3-nightly.20260814.1",
      },
    );
    assert.deepInclude(
      parseOptions([
        "inspect",
        "--repo",
        "/repo",
        "--current-version",
        "1.2.3-nightly.20260814.1",
        "--release-notes-format",
        "grouped-v1",
      ]),
      { releaseNotesFormat: "grouped-v1" },
    );
    assert.throws(
      () =>
        parseOptions([
          "build",
          "--repo",
          "/repo",
          "--checkpoint",
          "lastcode/checkpoint/v1.2.3-nightly.20260814.1",
          "--release-notes-format",
          "grouped-v1",
        ]),
      /only valid for inspect/,
    );
  });

  it("only reuses complete matching build outputs", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-local-update-"));
    try {
      const checkpoint = "lastcode/checkpoint/v0.0.34-nightly.20260814.1089";
      const repo = NodePath.join(root, "repo");
      NodeFS.mkdirSync(repo);
      NodeChildProcess.execFileSync("git", ["init"], { cwd: repo });
      NodeChildProcess.execFileSync("git", ["config", "user.name", "LastCode Test"], { cwd: repo });
      NodeChildProcess.execFileSync("git", ["config", "user.email", "test@lastcode.invalid"], {
        cwd: repo,
      });
      NodeFS.writeFileSync(NodePath.join(repo, "tracked.txt"), "complete\n");
      NodeChildProcess.execFileSync("git", ["add", "tracked.txt"], { cwd: repo });
      NodeChildProcess.execFileSync("git", ["commit", "-m", "complete build"], { cwd: repo });
      const commit = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repo,
        encoding: "utf8",
      }).trim();
      const output = NodePath.join(root, "v0.0.34-nightly.20260814.1089", commit.slice(0, 10));
      const buildTag = "lastcode/build/v0.0.34-nightly.20260814.1089.1";
      NodeChildProcess.execFileSync("git", ["tag", "--annotate", buildTag, "-m", "complete"], {
        cwd: repo,
      });
      NodeFS.mkdirSync(output, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(output, "build-manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          checkpointTag: checkpoint,
          lastCodeCommit: commit,
          buildTag,
          artifacts: [{ path: "LastCode.dmg", sha256: "a".repeat(64) }],
        }),
      );
      NodeFS.writeFileSync(NodePath.join(output, "nightly-mac.yml"), "version: test\n");
      NodeFS.writeFileSync(NodePath.join(output, "SHA256SUMS"), "test\n");
      NodeFS.writeFileSync(NodePath.join(output, "LastCode.dmg"), "dmg");
      NodeFS.writeFileSync(NodePath.join(output, "LastCode.zip"), "zip");

      const buildOptions = {
        repoRoot: repo,
        outputRoot: root,
        checkpointTag: checkpoint,
        checkpointCommit: commit,
      };
      assert.deepInclude(resolveExistingBuild(buildOptions), {
        outputDir: output,
        dmgPath: NodePath.join(output, "LastCode.dmg"),
        dmgSha256: "a".repeat(64),
      });
      NodeFS.unlinkSync(NodePath.join(output, "LastCode.zip"));
      assert.throws(() => resolveExistingBuild(buildOptions), /missing \.zip/);
      NodeFS.writeFileSync(NodePath.join(output, "LastCode.zip"), "zip");
      NodeFS.unlinkSync(NodePath.join(output, "SHA256SUMS"));
      assert.throws(() => resolveExistingBuild(buildOptions), /missing SHA256SUMS/);
      NodeFS.writeFileSync(NodePath.join(output, "SHA256SUMS"), "test\n");
      NodeChildProcess.execFileSync("git", ["tag", "--delete", buildTag], { cwd: repo });
      assert.throws(() => resolveExistingBuild(buildOptions));
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("quarantines incomplete output so a local build can be retried", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-local-update-"));
    try {
      const checkpoint = "lastcode/checkpoint/v0.0.34-nightly.20260814.1089";
      const commit = "0123456789abcdef";
      const output = NodePath.join(root, "v0.0.34-nightly.20260814.1089", "0123456789");
      NodeFS.mkdirSync(output, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(output, "partial.dmg"), "partial");

      const quarantine = quarantineIncompleteBuild(root, checkpoint, commit, "test");

      assert.equal(quarantine, `${output}.incomplete-test`);
      assert.isFalse(NodeFS.existsSync(output));
      assert.equal(
        NodeFS.readFileSync(NodePath.join(quarantine!, "partial.dmg"), "utf8"),
        "partial",
      );
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to discard changes in the dedicated build worktree", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-update-worktree-"));
    const repo = NodePath.join(root, "repo");
    const worktree = NodePath.join(root, "build-worktree");
    const runGit = (cwd: string, args: ReadonlyArray<string>) =>
      NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    try {
      NodeFS.mkdirSync(repo);
      runGit(repo, ["init"]);
      runGit(repo, ["config", "user.name", "LastCode Test"]);
      runGit(repo, ["config", "user.email", "test@lastcode.invalid"]);
      NodeFS.writeFileSync(NodePath.join(repo, "tracked.txt"), "original\n");
      runGit(repo, ["add", "tracked.txt"]);
      runGit(repo, ["commit", "-m", "initial"]);
      runGit(repo, ["tag", "lastcode/checkpoint/v0.0.1-nightly.20260814.1"]);
      runGit(repo, [
        "worktree",
        "add",
        "--detach",
        worktree,
        "lastcode/checkpoint/v0.0.1-nightly.20260814.1",
      ]);
      NodeFS.writeFileSync(NodePath.join(worktree, "tracked.txt"), "do not discard\n");

      assert.throws(
        () =>
          prepareBuildWorktree(
            repo,
            worktree,
            "lastcode/checkpoint/v0.0.1-nightly.20260814.1",
            undefined,
          ),
        /is not clean/,
      );
      assert.equal(
        NodeFS.readFileSync(NodePath.join(worktree, "tracked.txt"), "utf8"),
        "do not discard\n",
      );
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
