// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  assertCheckpointCiStamp,
  assertFullCiStamp,
  assertRepositoryIntegrity,
  assertSupportedNodeVersion,
  captureRepositoryIntegrity,
  parseLocalCiOptions,
  prepareLocalCiRepository,
  readFullCiStamp,
  resolveFullCiStampPath,
  resolveLocalCiSteps,
  verifyPreloadBundle,
  writeFullCiStamp,
  writeVerifiedFullCiStamp,
} from "./lastcode-local-ci.ts";

describe("lastcode-local-ci", () => {
  it("clears Git-local hook variables before starting the pre-push gate", () => {
    const hook = NodeFS.readFileSync(
      NodePath.resolve(import.meta.dirname, "../.vite-hooks/pre-push"),
      "utf8",
    );
    expect(hook).toContain("git_local_env=$(git rev-parse --local-env-vars) || exit 1");
    expect(hook).toContain("unset $git_local_env");
    expect(hook.indexOf("unset $git_local_env")).toBeLessThan(hook.indexOf("lastcode:ci:quick"));
  });

  it("requires the repository's supported Node release line", () => {
    expect(() => assertSupportedNodeVersion("24.13.1")).not.toThrow();
    expect(() => assertSupportedNodeVersion("24.99.0")).not.toThrow();
    expect(() => assertSupportedNodeVersion("24.13.0")).toThrow("Node ^24.13.1");
    expect(() => assertSupportedNodeVersion("26.7.0")).toThrow("Node ^24.13.1");
  });

  it("defaults to the full gate and supports the quick pre-push gate", () => {
    expect(parseLocalCiOptions([])).toEqual({ mode: "full", dryRun: false });
    expect(parseLocalCiOptions(["--quick", "--", "--dry-run"])).toEqual({
      mode: "quick",
      dryRun: true,
    });
    expect(
      parseLocalCiOptions(["--checkpoint", "lastcode/checkpoint/v1.2.3-nightly.20260811.1"]),
    ).toEqual({
      mode: "full",
      dryRun: false,
      checkpointTag: "lastcode/checkpoint/v1.2.3-nightly.20260811.1",
    });
  });

  it("keeps release, native, Rust, and preload checks in the full gate", () => {
    const quickLabels = resolveLocalCiSteps("quick").map(({ label }) => label);
    const fullLabels = resolveLocalCiSteps("full").map(({ label }) => label);

    expect(quickLabels).toEqual([
      "Ensure Electron runtime",
      "Format and lint",
      "Workspace typecheck",
      "Workspace tests",
    ]);
    expect(fullLabels).toEqual(
      expect.arrayContaining([
        "Resource monitor formatting",
        "Desktop build",
        "Desktop preload bundle assertions",
        "Resource monitor tests",
        "Mobile native static analysis",
        "Release smoke",
      ]),
    );
  });

  it("checks the built preload bridge contract", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-preload-test-"));
    const preloadPath = NodePath.join(root, "apps/desktop/dist-electron/preload.cjs");
    NodeFS.mkdirSync(NodePath.dirname(preloadPath), { recursive: true });
    NodeFS.writeFileSync(
      preloadPath,
      "desktopBridge getLocalEnvironmentBootstraps PICK_FOLDER_CHANNEL __clerk_internal_electron_passkeys",
    );

    expect(() => verifyPreloadBundle(root)).not.toThrow();
    NodeFS.writeFileSync(preloadPath, "desktopBridge");
    expect(() => verifyPreloadBundle(root)).toThrow("getLocalEnvironmentBootstraps");
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  it("rejects bare repositories and protected shared config changes during CI", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-integrity-test-"));
    const repository = NodePath.join(root, "repository");
    const bareRepository = NodePath.join(root, "bare.git");
    NodeFS.mkdirSync(repository);
    NodeFS.mkdirSync(bareRepository);
    NodeChildProcess.execFileSync("git", ["init", "--quiet"], { cwd: repository });
    NodeChildProcess.execFileSync("git", ["init", "--quiet", "--bare"], {
      cwd: bareRepository,
    });

    const snapshot = captureRepositoryIntegrity(repository);
    expect(() => assertRepositoryIntegrity(repository, snapshot)).not.toThrow();
    NodeChildProcess.execFileSync("git", ["config", "test.integrity", "changed"], {
      cwd: repository,
    });
    expect(() => assertRepositoryIntegrity(repository, snapshot)).toThrow(
      "Shared repository integrity",
    );
    expect(() => captureRepositoryIntegrity(bareRepository)).toThrow("core.bare=true");
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  it("allows concurrent branch bookkeeping in the shared config", () => {
    const repository = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "lastcode-integrity-branch-test-"),
    );
    NodeChildProcess.execFileSync("git", ["init", "--quiet"], { cwd: repository });
    const snapshot = captureRepositoryIntegrity(repository);

    NodeChildProcess.execFileSync(
      "git",
      ["config", "branch.concurrent-worktree.gh-merge-base", "lastcode/main"],
      { cwd: repository },
    );

    expect(() => assertRepositoryIntegrity(repository, snapshot)).not.toThrow();
    NodeFS.rmSync(repository, { recursive: true, force: true });
  });

  it("diagnoses a damaged shared config before resolving the worktree root", () => {
    const repository = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "lastcode-integrity-entry-test-"),
    );
    NodeChildProcess.execFileSync("git", ["init", "--quiet"], { cwd: repository });
    NodeChildProcess.execFileSync("git", ["config", "core.bare", "true"], { cwd: repository });

    expect(() => prepareLocalCiRepository(repository)).toThrow(
      /core\.bare=true[\s\S]*\.git\/config/,
    );
    NodeFS.rmSync(repository, { recursive: true, force: true });
  });

  it("does not write a success stamp after shared config mutation", () => {
    const repository = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "lastcode-integrity-stamp-test-"),
    );
    NodeChildProcess.execFileSync("git", ["init", "--quiet"], { cwd: repository });
    const snapshot = captureRepositoryIntegrity(repository);
    const stamp = {
      commit: "head-sha",
      completedAt: "2026-08-11T00:00:00.000Z",
      context: {
        kind: "pull-request" as const,
        baseCommit: "base-sha",
        baseRef: "lastcode/main" as const,
      },
    };
    NodeChildProcess.execFileSync("git", ["config", "test.integrity", "changed"], {
      cwd: repository,
    });

    expect(() => writeVerifiedFullCiStamp(repository, snapshot, stamp)).toThrow(
      "Shared repository integrity",
    );
    expect(NodeFS.existsSync(resolveFullCiStampPath(snapshot.commonGitDir, stamp.commit))).toBe(
      false,
    );
    NodeFS.rmSync(repository, { recursive: true, force: true });
  });

  it("binds a PR full-CI stamp to both the head and tested base commits", () => {
    const commonGitDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-stamp-test-"));
    const stamp = {
      commit: "head-sha",
      completedAt: "2026-08-11T00:00:00.000Z",
      context: {
        kind: "pull-request" as const,
        baseCommit: "base-sha",
        baseRef: "lastcode/main" as const,
      },
    } as const;

    writeFullCiStamp(commonGitDir, stamp);
    expect(readFullCiStamp(commonGitDir, stamp.commit)).toEqual({ schemaVersion: 2, ...stamp });
    expect(assertFullCiStamp(commonGitDir, stamp.commit, stamp.context.baseCommit)).toEqual({
      schemaVersion: 2,
      ...stamp,
    });
    expect(() => assertFullCiStamp(commonGitDir, stamp.commit, "new-base-sha")).toThrow(
      "Rebase and rerun",
    );
    NodeFS.rmSync(commonGitDir, { recursive: true, force: true });
  });

  it("binds a checkpoint full-CI stamp to its immutable tag and upstream commit", () => {
    const commonGitDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-stamp-test-"));
    const checkpointTag = "lastcode/checkpoint/v1.2.3-nightly.20260811.1";
    const stamp = {
      commit: "checkpoint-sha",
      completedAt: "2026-08-11T00:00:00.000Z",
      context: {
        kind: "checkpoint" as const,
        checkpointTag,
        upstreamCommit: "upstream-sha",
        upstreamTag: "v1.2.3-nightly.20260811.1",
      },
    };

    writeFullCiStamp(commonGitDir, stamp);
    expect(
      assertCheckpointCiStamp(commonGitDir, stamp.commit, checkpointTag, "upstream-sha"),
    ).toEqual({ schemaVersion: 2, ...stamp });
    expect(() =>
      assertCheckpointCiStamp(commonGitDir, stamp.commit, checkpointTag, "new-upstream-sha"),
    ).toThrow("does not match checkpoint");
    NodeFS.rmSync(commonGitDir, { recursive: true, force: true });
  });
});
