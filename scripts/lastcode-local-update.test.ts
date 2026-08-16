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
  resolveLatestCheckpointTag,
  resolveLocalBuildEnvironment,
} from "./lastcode-local-update.mjs";

describe("lastcode-local-update", () => {
  it("serializes manual and in-app builds and releases the kernel lock", () => {
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

  it("orders and selects immutable checkpoint tags", () => {
    assert.deepEqual(
      parseNightlyVersion("0.0.34-nightly.20260814.1089")?.parts,
      [0, 0, 34, 20260814, 1089],
    );
    assert.isAbove(
      compareNightlyVersions("0.0.34-nightly.20260814.1089", "0.0.34-nightly.20260813.1088"),
      0,
    );
    assert.equal(
      resolveLatestCheckpointTag([
        "unrelated",
        "lastcode/checkpoint/v0.0.34-nightly.20260813.1088",
        "lastcode/checkpoint/v0.0.34-nightly.20260814.1089",
      ]),
      "lastcode/checkpoint/v0.0.34-nightly.20260814.1089",
    );
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
      assert.equal(resolveExistingBuild(buildOptions)?.outputDir, output);
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
