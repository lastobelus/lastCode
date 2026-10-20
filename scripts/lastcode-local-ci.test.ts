// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_LASTCODE_LOCAL_CI_SETTINGS } from "@t3tools/contracts/settings";

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
  QUICK_CI_GATE_VERSION,
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

function createIntegrityRepository(): string {
  const repository = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "lastcode-integrity-branch-test-"),
  );
  NodeChildProcess.execFileSync("git", ["init", "--quiet", "--initial-branch", "main"], {
    cwd: repository,
  });
  NodeChildProcess.execFileSync(
    "git",
    [
      "-c",
      "user.name=Integrity Test",
      "-c",
      "user.email=integrity-test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "initial commit",
    ],
    { cwd: repository },
  );
  return repository;
}

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
    expect(parseLocalCiOptions(["--quick", "--require-local"])).toEqual({
      mode: "quick",
      dryRun: false,
      prePush: false,
      requireLocal: true,
    });
    expect(() => parseLocalCiOptions(["--require-local"])).toThrow("only supported with --quick");
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

  describe("local CI option parsing", () => {
    it("uses the last mode and tolerates repeated booleans and separators", () => {
      expect(parseLocalCiOptions(["--quick", "--dry-run", "--full", "--", "--dry-run"])).toEqual({
        mode: "full",
        dryRun: true,
        prePush: false,
      });
      expect(
        parseLocalCiOptions(["--pre-push", "--require-local", "--quick", "--pre-push"]),
      ).toEqual({ mode: "quick", dryRun: false, prePush: true, requireLocal: true });
    });

    it("consumes exactly one checkpoint token, including flag-shaped values", () => {
      expect(parseLocalCiOptions(["--checkpoint", "--quick"])).toEqual({
        mode: "full",
        dryRun: false,
        prePush: false,
        checkpointTag: "--quick",
      });
      expect(
        parseLocalCiOptions(["--checkpoint", "--", "--quick", "--checkpoint", "final"]),
      ).toEqual({ mode: "quick", dryRun: false, prePush: false, checkpointTag: "final" });
      expect(() => parseLocalCiOptions(["--checkpoint", "tag", "extra"])).toThrow(
        "Unknown argument 'extra'.",
      );
    });

    it("reports scan errors before final mode restrictions", () => {
      expect(() => parseLocalCiOptions(["--pre-push", "--require-local"])).toThrow(
        "--pre-push is only supported with --quick.",
      );
      expect(() => parseLocalCiOptions(["--pre-push", "--checkpoint"])).toThrow(
        "Missing value for --checkpoint.",
      );
      expect(() => parseLocalCiOptions(["--pre-push", "--checkpoint", ""])).toThrow(
        "Missing value for --checkpoint.",
      );
      expect(() => parseLocalCiOptions(["--pre-push", "unknown", "--checkpoint"])).toThrow(
        "Unknown argument 'unknown'.",
      );
      expect(() => parseLocalCiOptions(["--checkpoint", "--pre-push", "--require-local"])).toThrow(
        "--require-local is only supported with --quick.",
      );
    });

    it("keeps optional keys omitted and returned keys in contract order", () => {
      expect(Object.keys(parseLocalCiOptions(Object.freeze([])))).toEqual([
        "mode",
        "dryRun",
        "prePush",
      ]);
      expect(
        Object.keys(
          parseLocalCiOptions(Object.freeze(["--require-local", "--checkpoint", "tag", "--quick"])),
        ),
      ).toEqual(["mode", "dryRun", "prePush", "checkpointTag", "requireLocal"]);
      for (const token of ["constructor", "__proto__", "toString", ""]) {
        expect(() => parseLocalCiOptions([token])).toThrow(`Unknown argument '${token}'.`);
      }
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

  it("plans scoped checks with existing paths and ordered duplicate package filters", () => {
    const repoRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ci-planner-test-"));
    try {
      NodeFS.mkdirSync(NodePath.join(repoRoot, "src"));
      NodeFS.writeFileSync(NodePath.join(repoRoot, "src/file.ts"), "fixture");
      NodeFS.writeFileSync(NodePath.join(repoRoot, "--flag.ts"), "fixture");
      const steps = resolveLocalCiSteps(
        "quick",
        {
          kind: "affected",
          reason: "fixture",
          changedFiles: ["src/file.ts", "missing.ts", "--flag.ts", "src/file.ts"],
          packages: ["@example/b", "@example/a", "@example/b"],
        },
        { ...DEFAULT_LASTCODE_LOCAL_CI_SETTINGS, packageConcurrency: 3 },
        repoRoot,
      );
      expect(steps).toEqual([
        { kind: "diff-whitespace", label: "Diff whitespace" },
        {
          kind: "command",
          label: "Format and lint",
          command: "vp",
          args: [
            "check",
            "--no-error-on-unmatched-pattern",
            "./src/file.ts",
            "./--flag.ts",
            "./src/file.ts",
          ],
        },
        {
          kind: "command",
          label: "Workspace typecheck",
          command: "vp",
          args: [
            "run",
            "--concurrency-limit",
            "3",
            "--filter",
            "@example/b",
            "--filter",
            "@example/a",
            "--filter",
            "@example/b",
            "typecheck",
          ],
        },
      ]);
      const none = resolveLocalCiSteps(
        "quick",
        {
          kind: "none",
          reason: "fixture",
          changedFiles: ["src/file.ts"],
          packages: [],
        },
        DEFAULT_LASTCODE_LOCAL_CI_SETTINGS,
        repoRoot,
      );
      expect(none.map(({ label }) => label)).toEqual(["Diff whitespace", "Format and lint"]);
    } finally {
      NodeFS.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("plans recursive typecheck for empty affected package filters", () => {
    const empty = resolveLocalCiSteps(
      "quick",
      {
        kind: "affected",
        reason: "fixture",
        changedFiles: [],
        packages: [],
      },
      DEFAULT_LASTCODE_LOCAL_CI_SETTINGS,
      process.cwd(),
    );
    expect(empty.map(({ label }) => label)).toEqual(["Diff whitespace", "Workspace typecheck"]);
    expect(empty[1]).toMatchObject({
      args: ["run", "--recursive", "--concurrency-limit", "1", "typecheck"],
    });
  });

  it("plans full and unscoped checks without reading unused scope fields", () => {
    const scope = {
      get kind(): "none" {
        throw new Error("unused scope");
      },
      get changedFiles(): string[] {
        throw new Error("unused paths");
      },
      get packages(): string[] {
        throw new Error("unused packages");
      },
      reason: "fixture",
    };
    const original = resolveLocalCiSteps("full");
    const scoped = resolveLocalCiSteps("full", scope);
    expect(scoped).toEqual(original);
    for (let index = 0; index < original.length; index++) {
      if (original[index]?.label !== "Workspace typecheck")
        expect(scoped[index]).toBe(original[index]);
    }
    const quick = resolveLocalCiSteps("quick");
    expect(quick[0]).toBe(resolveLocalCiSteps("quick")[0]);
    expect(quick[1]).toBe(resolveLocalCiSteps("quick")[1]);
  });

  it("plans no typecheck for none scope without reading concurrency and propagates failures", () => {
    const failure = new Error("policy unavailable");
    const policy = {
      ...DEFAULT_LASTCODE_LOCAL_CI_SETTINGS,
      get packageConcurrency(): number {
        throw failure;
      },
    };
    expect(
      resolveLocalCiSteps(
        "quick",
        {
          kind: "none",
          reason: "fixture",
          changedFiles: [],
          packages: [],
        },
        policy,
      ).map(({ label }) => label),
    ).toEqual(["Diff whitespace"]);
    expect(() => resolveLocalCiSteps("quick", undefined, policy)).toThrow(failure);
    expect(() =>
      resolveLocalCiSteps(
        "full",
        {
          kind: "none",
          reason: "fixture",
          changedFiles: [],
          packages: [],
        },
        policy,
      ),
    ).toThrow(failure);
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
      gateVersion: QUICK_CI_GATE_VERSION,
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
    expect(readQuickCiReceipt(commonGitDir, receipt.commit)).toBeUndefined();
    NodeFS.writeFileSync(
      resolveQuickCiReceiptPath(commonGitDir, receipt.commit),
      JSON.stringify({
        schemaVersion: 1,
        gateVersion: QUICK_CI_GATE_VERSION,
        ...receipt,
        baseCommit: null,
      }),
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

  it("rejects bare repositories and protected shared config changes during CI", async () => {
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
    await expect(assertRepositoryIntegrity(repository, snapshot)).resolves.toBeUndefined();
    NodeChildProcess.execFileSync("git", ["config", "test.integrity", "changed"], {
      cwd: repository,
    });
    await expect(assertRepositoryIntegrity(repository, snapshot)).rejects.toThrow(
      "Shared repository integrity",
    );
    expect(() => captureRepositoryIntegrity(bareRepository)).toThrow("core.bare=true");
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  it("allows concurrent branch bookkeeping in the shared config", async () => {
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

    await expect(assertRepositoryIntegrity(repository, snapshot)).resolves.toBeUndefined();
    NodeFS.rmSync(repository, { recursive: true, force: true });
  });

  it("rejects changes to branch settings that existed when CI started", async () => {
    const repository = createIntegrityRepository();
    NodeChildProcess.execFileSync("git", ["branch", "lastcode/userland-build"], {
      cwd: repository,
    });
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

    await expect(assertRepositoryIntegrity(repository, snapshot)).rejects.toThrow(
      "existing branch setting branch.lastcode/userland-build.remote",
    );
    NodeFS.rmSync(repository, { recursive: true, force: true });
  });

  it.each(["rename", "delete"] as const)(
    "allows sibling branch config removal after a real branch %s",
    async (operation) => {
      const repository = createIntegrityRepository();
      const branch = "feature/sibling.v1";
      NodeChildProcess.execFileSync("git", ["branch", branch], { cwd: repository });
      NodeChildProcess.execFileSync("git", ["config", `branch.${branch}.gh-merge-base`, "main"], {
        cwd: repository,
      });
      NodeChildProcess.execFileSync("git", ["config", `branch.${branch}.remote`, "origin"], {
        cwd: repository,
      });
      const snapshot = captureRepositoryIntegrity(repository);

      NodeChildProcess.execFileSync(
        "git",
        operation === "rename"
          ? ["branch", "-m", branch, "feature/renamed.v1"]
          : ["branch", "-D", branch],
        { cwd: repository },
      );

      await expect(assertRepositoryIntegrity(repository, snapshot)).resolves.toBeUndefined();
      NodeFS.rmSync(repository, { recursive: true, force: true });
    },
  );

  it.each(["existing", "orphan"] as const)(
    "rejects removal of an %s branch config key",
    async (kind) => {
      const repository = createIntegrityRepository();
      const branch = "feature/protected.v1";
      if (kind === "existing") {
        NodeChildProcess.execFileSync("git", ["branch", branch], { cwd: repository });
      }
      const key = `branch.${branch}.gh-merge-base`;
      NodeChildProcess.execFileSync("git", ["config", key, "main"], { cwd: repository });
      const snapshot = captureRepositoryIntegrity(repository);

      NodeChildProcess.execFileSync("git", ["config", "--unset", key], { cwd: repository });

      await expect(assertRepositoryIntegrity(repository, snapshot)).rejects.toThrow(
        `existing branch setting ${key}`,
      );
      NodeFS.rmSync(repository, { recursive: true, force: true });
    },
  );

  it("rejects changed config values even after their local branch disappears", async () => {
    const repository = createIntegrityRepository();
    const branch = "feature/removed.v1";
    const key = `branch.${branch}.gh-merge-base`;
    NodeChildProcess.execFileSync("git", ["branch", branch], { cwd: repository });
    NodeChildProcess.execFileSync("git", ["config", key, "main"], { cwd: repository });
    const snapshot = captureRepositoryIntegrity(repository);

    NodeChildProcess.execFileSync("git", ["update-ref", "-d", `refs/heads/${branch}`], {
      cwd: repository,
    });
    await expect(assertRepositoryIntegrity(repository, snapshot)).resolves.toBeUndefined();
    NodeChildProcess.execFileSync("git", ["config", key, "other-base"], { cwd: repository });

    await expect(assertRepositoryIntegrity(repository, snapshot)).rejects.toThrow(
      `existing branch setting ${key}`,
    );
    NodeFS.rmSync(repository, { recursive: true, force: true });
  });

  it("rejects reordering protected multivalue settings", async () => {
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

    await expect(assertRepositoryIntegrity(repository, snapshot)).rejects.toThrow(
      "protected settings",
    );
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

  it("does not write a success stamp after shared config mutation", async () => {
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

    await expect(writeVerifiedFullCiStamp(repository, snapshot, stamp)).rejects.toThrow(
      "Shared repository integrity",
    );
    await expect(
      writeVerifiedQuickCiReceipt(repository, snapshot, {
        commit: stamp.commit,
        baseCommit: stamp.context.baseCommit,
        baseRef: "refs/remotes/origin/lastcode/main",
        completedAt: stamp.completedAt,
      }),
    ).rejects.toThrow("Shared repository integrity");
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

describe("Quick CI receipt reader", () => {
  const roots: string[] = [];
  function fixture(raw?: string) {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "receipt-reader-test-"));
    roots.push(root);
    const path = resolveQuickCiReceiptPath(root, "head");
    if (raw !== undefined) {
      NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
      NodeFS.writeFileSync(path, raw);
    }
    return { root, path };
  }
  const valid = {
    schemaVersion: 1,
    gateVersion: QUICK_CI_GATE_VERSION,
    commit: "head",
    baseCommit: "",
    baseRef: "",
    completedAt: "",
    extra: { retained: true },
  };
  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
  });
  it("returns a miss for an absent file", () => {
    expect(readQuickCiReceipt(fixture().root, "head")).toBeUndefined();
  });
  it("keeps extra keys and accepts empty string fields", () => {
    expect(readQuickCiReceipt(fixture(JSON.stringify(valid)).root, "head")).toEqual(valid);
  });
  it.each([undefined, null, 0, "2"])(
    "treats obsolete gate %s as a miss before malformed fields",
    (gateVersion) => {
      const { root } = fixture(JSON.stringify({ schemaVersion: 1, gateVersion, baseCommit: null }));
      expect(readQuickCiReceipt(root, "head")).toBeUndefined();
    },
  );
  it.each(["schemaVersion", "commit", "baseCommit", "baseRef", "completedAt"] as const)(
    "rejects malformed current %s with the exact path",
    (field) => {
      const { root, path } = fixture(JSON.stringify({ ...valid, [field]: null }));
      expect(() => readQuickCiReceipt(root, "head")).toThrow(
        new Error(`Invalid Quick CI receipt at ${path}.`),
      );
    },
  );
  it.each(["null", "true", "0", '"text"', "[]", "{}"])(
    "preserves native property access or validation failure for %s",
    (raw) => {
      const { root, path } = fixture(raw);
      if (raw === "null") expect(() => readQuickCiReceipt(root, "head")).toThrow(TypeError);
      else
        expect(() => readQuickCiReceipt(root, "head")).toThrow(
          `Invalid Quick CI receipt at ${path}.`,
        );
    },
  );
  it.each(["{", "", "\ufeff{}"])("propagates the native JSON error for %s", (raw) => {
    const { root } = fixture(raw);
    let expected: unknown;
    try {
      JSON.parse(raw);
    } catch (error) {
      expected = error;
    }
    expect(() => readQuickCiReceipt(root, "head")).toThrow(expected as Error);
  });
  it("propagates a native file read error", () => {
    const { root, path } = fixture("{}");
    NodeFS.unlinkSync(path);
    NodeFS.mkdirSync(path);
    expect(() => readQuickCiReceipt(root, "head")).toThrow(/EISDIR/);
  });
  it("retains parsed identity and exact lazy field read order with injected getters", () => {
    const { root } = fixture("{}");
    const reads: PropertyKey[] = [];
    const parsed = new Proxy(valid, {
      get(target, key) {
        reads.push(key);
        return Reflect.get(target, key);
      },
    });
    vi.spyOn(JSON, "parse").mockReturnValueOnce(parsed);
    expect(readQuickCiReceipt(root, "head")).toBe(parsed);
    expect(reads).toEqual([
      "schemaVersion",
      "gateVersion",
      "schemaVersion",
      "gateVersion",
      "commit",
      "baseCommit",
      "baseRef",
      "completedAt",
    ]);
  });
  it("does not read remaining fields after an obsolete gate with injected getters", () => {
    const { root } = fixture("{}");
    const reads: PropertyKey[] = [];
    const parsed = new Proxy(
      { schemaVersion: 1, gateVersion: 0 },
      {
        get(target, key) {
          reads.push(key);
          if (key === "commit") throw new Error("must stay lazy");
          return Reflect.get(target, key);
        },
      },
    );
    vi.spyOn(JSON, "parse").mockReturnValueOnce(parsed);
    expect(readQuickCiReceipt(root, "head")).toBeUndefined();
    expect(reads).toEqual(["schemaVersion", "gateVersion"]);
  });
  it("does not read fields after the first invalid current field with injected getters", () => {
    const { root, path } = fixture("{}");
    const sentinel = new Error("baseRef must stay lazy");
    vi.spyOn(JSON, "parse").mockReturnValueOnce({
      ...valid,
      baseCommit: null,
      get baseRef() {
        throw sentinel;
      },
    });
    expect(() => readQuickCiReceipt(root, "head")).toThrow(`Invalid Quick CI receipt at ${path}.`);
  });
  it("propagates the same thrown property error object", () => {
    const { root } = fixture("{}");
    const sentinel = new Error("injected property error");
    vi.spyOn(JSON, "parse").mockReturnValueOnce({
      ...valid,
      get completedAt() {
        throw sentinel;
      },
    });
    let caught: unknown;
    try {
      readQuickCiReceipt(root, "head");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(sentinel);
  });
  it("rereads gateVersion rather than caching a getter result", () => {
    const { root, path } = fixture("{}");
    let reads = 0;
    vi.spyOn(JSON, "parse").mockReturnValueOnce({
      ...valid,
      get gateVersion() {
        return ++reads === 1 ? QUICK_CI_GATE_VERSION : 0;
      },
    });
    expect(() => readQuickCiReceipt(root, "head")).toThrow(`Invalid Quick CI receipt at ${path}.`);
    expect(reads).toBe(2);
  });
});
