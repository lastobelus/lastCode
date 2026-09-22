// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  assertCheckpointCiStamp,
  assertFullCiStamp,
  assertPrePushTargetsHead,
  assertRepositoryIntegrity,
  assertSupportedNodeVersion,
  captureRepositoryIntegrity,
  formatLocalCiFailureSummary,
  formatLocalCiSummary,
  hasPrePushBranchCommit,
  hasMatchingQuickCiReceipt,
  parsePrePushUpdates,
  parseLocalCiOptions,
  prepareLocalCiRepository,
  readFullCiStamp,
  readQuickCiReceipt,
  resolveFullCiStampPath,
  resolveLocalCiSteps,
  resolveQuickCiBase,
  resolveQuickCiReceiptPath,
  verifyPreloadBundle,
  writeFullCiStamp,
  writeQuickCiReceipt,
  writeVerifiedFullCiStamp,
  writeVerifiedQuickCiReceipt,
} from "./lastcode-local-ci.ts";

describe("lastcode-local-ci", () => {
  it("formats concise final summaries for resumable output", () => {
    expect(formatLocalCiSummary("full", "abc123")).toBe(
      "[lastcode:ci] Summary: Full local CI passed for abc123.",
    );
    expect(formatLocalCiSummary("quick", "head-sha", "base-sha")).toBe(
      "[lastcode:ci] Summary: Quick local CI passed for head-sha against base-sha.",
    );
    expect(formatLocalCiFailureSummary(new Error("command failed\ndirty file"))).toBe(
      "[lastcode:ci] Summary: failed: command failed dirty file",
    );
  });

  it("clears Git-local hook variables before starting the pre-push gate", () => {
    const hook = NodeFS.readFileSync(
      NodePath.resolve(import.meta.dirname, "../.vite-hooks/pre-push"),
      "utf8",
    );
    expect(hook).toContain("git_local_env=$(git rev-parse --local-env-vars) || exit 1");
    expect(hook).toContain("unset $git_local_env");
    expect(hook.indexOf("unset $git_local_env")).toBeLessThan(hook.indexOf("lastcode:ci:quick"));
    expect(hook).toContain("lastcode:ci:quick -- --pre-push");
  });

  it("requires the repository's supported Node release line", () => {
    expect(() => assertSupportedNodeVersion("24.13.1")).not.toThrow();
    expect(() => assertSupportedNodeVersion("24.99.0")).not.toThrow();
    expect(() => assertSupportedNodeVersion("24.13.0")).toThrow("Node ^24.13.1");
    expect(() => assertSupportedNodeVersion("26.7.0")).toThrow("Node ^24.13.1");
  });

  it("defaults to the full gate and supports the quick pre-push gate", () => {
    expect(parseLocalCiOptions([])).toEqual({ mode: "full", dryRun: false, prePush: false });
    expect(parseLocalCiOptions(["--quick", "--", "--dry-run"])).toEqual({
      mode: "quick",
      dryRun: true,
      prePush: false,
    });
    expect(parseLocalCiOptions(["--quick", "--pre-push"])).toEqual({
      mode: "quick",
      dryRun: false,
      prePush: true,
    });
    expect(() => parseLocalCiOptions(["--full", "--pre-push"])).toThrow(
      "only supported with --quick",
    );
    expect(
      parseLocalCiOptions(["--checkpoint", "lastcode/checkpoint/v1.2.3-nightly.20260811.1"]),
    ).toEqual({
      mode: "full",
      dryRun: false,
      prePush: false,
      checkpointTag: "lastcode/checkpoint/v1.2.3-nightly.20260811.1",
    });
  });

  it("keeps Quick cheap without removing comprehensive checks from the full gate", () => {
    const quickSteps = resolveLocalCiSteps("quick");
    const quickLabels = quickSteps.map(({ label }) => label);
    const fullLabels = resolveLocalCiSteps("full").map(({ label }) => label);

    expect(quickLabels).toEqual(["Diff whitespace", "Format and lint", "Workspace typecheck"]);
    expect(fullLabels).toEqual(
      expect.arrayContaining([
        "Ensure Electron runtime",
        "Workspace tests",
        "Resource monitor formatting",
        "Desktop build",
        "Desktop preload bundle assertions",
        "Resource monitor tests",
        "Mobile native static analysis",
        "Release smoke",
      ]),
    );
    expect(
      resolveLocalCiSteps("full").find(({ label }) => label === "Workspace tests"),
    ).toMatchObject({
      kind: "command",
      args: [
        "run",
        "--recursive",
        "--concurrency-limit",
        "1",
        "test",
        "--",
        "--maxWorkers=1",
        "--maxConcurrency=1",
      ],
    });
    expect(quickSteps.find(({ label }) => label === "Diff whitespace")).toMatchObject({
      kind: "diff-whitespace",
    });
    expect(fullLabels.slice(0, 4)).toEqual([
      "Ensure Electron runtime",
      "Format and lint",
      "Workspace typecheck",
      "Workspace tests",
    ]);
  });

  it("selects the validation base from the documented workstream", () => {
    expect(resolveQuickCiBase("fix/upstream-bug")).toEqual({
      branch: "main",
      remote: "upstream",
      remoteRef: "refs/remotes/upstream/main",
    });
    expect(resolveQuickCiBase("feat/upstream-feature")).toEqual(
      resolveQuickCiBase("fix/upstream-bug"),
    );
    expect(resolveQuickCiBase("main")).toEqual(resolveQuickCiBase("fix/upstream-bug"));
    expect(resolveQuickCiBase("lastcode/local-workflow")).toEqual({
      branch: "lastcode/main",
      remote: "origin",
      remoteRef: "refs/remotes/origin/lastcode/main",
    });
    expect(resolveQuickCiBase("port/upstream/upstream-bug")).toEqual(
      resolveQuickCiBase("lastcode/local-workflow"),
    );
  });

  it("binds pre-push validation to the exact checked-out head", () => {
    const head = "a".repeat(40);
    const updates = parsePrePushUpdates(
      `refs/heads/topic ${head} refs/heads/topic ${"b".repeat(40)}\n`,
    );
    expect(assertPrePushTargetsHead(updates, head)).toBe(true);
    expect(() =>
      assertPrePushTargetsHead(
        parsePrePushUpdates(
          `refs/heads/other ${"c".repeat(40)} refs/heads/other ${"b".repeat(40)}\n`,
        ),
        head,
      ),
    ).toThrow("Push refs separately");
    expect(
      assertPrePushTargetsHead(
        parsePrePushUpdates(
          `refs/heads/topic ${"0".repeat(40)} refs/heads/topic ${"b".repeat(40)}\n`,
        ),
        head,
      ),
    ).toBe(false);
    const annotatedTag = parsePrePushUpdates(
      `refs/tags/snapshot ${"d".repeat(40)} refs/tags/snapshot ${"0".repeat(40)}\n`,
    );
    expect(hasPrePushBranchCommit(annotatedTag)).toBe(false);
    expect(assertPrePushTargetsHead(annotatedTag, head)).toBe(false);
    expect(
      assertPrePushTargetsHead(
        parsePrePushUpdates(
          [
            `refs/heads/topic ${head} refs/heads/topic ${"b".repeat(40)}`,
            `refs/tags/snapshot ${"d".repeat(40)} refs/tags/snapshot ${"0".repeat(40)}`,
          ].join("\n"),
        ),
        head,
      ),
    ).toBe(true);
    expect(() => parsePrePushUpdates("incomplete update")).toThrow("Invalid pre-push update");
  });

  it("allows deletion-only pushes before inspecting the unrelated worktree", () => {
    const repository = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "lastcode-pre-push-delete-test-"),
    );
    NodeChildProcess.execFileSync("git", ["init", "--quiet"], { cwd: repository });
    NodeFS.writeFileSync(NodePath.join(repository, "dirty.txt"), "untracked\n");

    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [NodePath.resolve(import.meta.dirname, "lastcode-local-ci.ts"), "--quick", "--pre-push"],
      {
        cwd: repository,
        encoding: "utf8",
        input: `(delete) ${"0".repeat(40)} refs/heads/old ${"a".repeat(40)}\n`,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No pushed branch commit requires Quick CI");
    expect(result.stderr).toBe("");
    NodeFS.rmSync(repository, { recursive: true, force: true });
  });

  it("reuses Quick CI only for the exact head, base, and gate version", () => {
    const commonGitDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "lastcode-quick-receipt-test-"),
    );
    const receipt = {
      commit: "head-sha",
      baseCommit: "base-sha",
      baseRef: "refs/remotes/origin/lastcode/main",
      completedAt: "2026-08-27T00:00:00.000Z",
    } as const;

    writeQuickCiReceipt(commonGitDir, receipt);
    expect(readQuickCiReceipt(commonGitDir, receipt.commit)).toEqual({
      schemaVersion: 1,
      gateVersion: 1,
      ...receipt,
    });
    expect(
      hasMatchingQuickCiReceipt(commonGitDir, receipt.commit, receipt.baseCommit, receipt.baseRef),
    ).toBe(true);
    expect(
      hasMatchingQuickCiReceipt(commonGitDir, receipt.commit, "new-base-sha", receipt.baseRef),
    ).toBe(false);
    expect(
      hasMatchingQuickCiReceipt(commonGitDir, "new-head-sha", receipt.baseCommit, receipt.baseRef),
    ).toBe(false);
    expect(
      hasMatchingQuickCiReceipt(
        commonGitDir,
        receipt.commit,
        receipt.baseCommit,
        "refs/remotes/upstream/main",
      ),
    ).toBe(false);

    NodeFS.writeFileSync(
      resolveQuickCiReceiptPath(commonGitDir, receipt.commit),
      `${JSON.stringify({ schemaVersion: 1, gateVersion: 0, ...receipt })}\n`,
    );
    expect(() => readQuickCiReceipt(commonGitDir, receipt.commit)).toThrow(
      "Invalid Quick CI receipt",
    );
    NodeFS.rmSync(commonGitDir, { recursive: true, force: true });
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

  it("rejects changes to branch settings that existed when CI started", () => {
    const repository = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "lastcode-integrity-existing-branch-test-"),
    );
    NodeChildProcess.execFileSync(
      "git",
      ["init", "--quiet", "--initial-branch", "lastcode/userland-build"],
      { cwd: repository },
    );
    NodeChildProcess.execFileSync(
      "git",
      ["config", "branch.lastcode/userland-build.remote", "origin"],
      { cwd: repository },
    );
    const snapshot = captureRepositoryIntegrity(repository);

    NodeChildProcess.execFileSync(
      "git",
      ["config", "branch.lastcode/userland-build.remote", "upstream"],
      { cwd: repository },
    );

    expect(() => assertRepositoryIntegrity(repository, snapshot)).toThrow(
      "existing branch setting branch.lastcode/userland-build.remote",
    );
    NodeFS.rmSync(repository, { recursive: true, force: true });
  });

  it("rejects reordering protected multivalue settings", () => {
    const repository = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "lastcode-integrity-config-order-test-"),
    );
    NodeChildProcess.execFileSync("git", ["init", "--quiet"], { cwd: repository });
    NodeChildProcess.execFileSync("git", ["config", "--add", "include.path", "first.inc"], {
      cwd: repository,
    });
    NodeChildProcess.execFileSync("git", ["config", "--add", "include.path", "second.inc"], {
      cwd: repository,
    });
    const snapshot = captureRepositoryIntegrity(repository);

    NodeChildProcess.execFileSync("git", ["config", "--unset-all", "include.path"], {
      cwd: repository,
    });
    NodeChildProcess.execFileSync("git", ["config", "--add", "include.path", "second.inc"], {
      cwd: repository,
    });
    NodeChildProcess.execFileSync("git", ["config", "--add", "include.path", "first.inc"], {
      cwd: repository,
    });

    expect(() => assertRepositoryIntegrity(repository, snapshot)).toThrow("protected settings");
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
    expect(() =>
      writeVerifiedQuickCiReceipt(repository, snapshot, {
        commit: stamp.commit,
        baseCommit: stamp.context.baseCommit,
        baseRef: "refs/remotes/origin/lastcode/main",
        completedAt: stamp.completedAt,
      }),
    ).toThrow("Shared repository integrity");
    expect(NodeFS.existsSync(resolveFullCiStampPath(snapshot.commonGitDir, stamp.commit))).toBe(
      false,
    );
    expect(NodeFS.existsSync(resolveQuickCiReceiptPath(snapshot.commonGitDir, stamp.commit))).toBe(
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
    ).toThrow("does not match installable");
    NodeFS.rmSync(commonGitDir, { recursive: true, force: true });
  });
});
