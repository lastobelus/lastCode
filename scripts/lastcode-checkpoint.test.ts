// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, expect, it } from "@effect/vitest";

import {
  checkpointRecoveryFingerprint,
  checkpointFailureDisposition,
  checkpointMessage,
  checkpointPromotionPushArgs,
  checkpointSmokeEnvironment,
  checkpointSmokeTypecheckCommands,
  checkpointSmokeFormatAndLintCommand,
  checkpointSourceCommit,
  checkpointTagPushArgs,
  checkpointVpPaths,
  openPullRequestListArgs,
  promotionNeeded,
  rerereRebaseMadeProgress,
  rebaseStateFiles,
  runCarrySetShadowAfterPublication,
  runPromotionThenShadow,
  resolveCheckpointPlan,
  resolveRevisionPlan,
  resolveUpstreamMainMirror,
  revisionMessage,
  shouldContinueRerereRebase,
  recoverySupersessionMode,
  supersededRecoveryNightly,
  unpublishedCheckpointTags,
  upstreamMainMirrorPushArgs,
  worktreeAddArgs,
  worktreeVp,
} from "./lastcode-checkpoint.ts";
import type { CarrySetShadowRecord } from "./lastcode-checkpoint-history.ts";
import { parseNightlyTag } from "./lastcode-nightly.ts";

it("scopes checkpoint PR queries to the configured LastCode repository", () => {
  expect(openPullRequestListArgs("example/fork")).toEqual([
    "pr",
    "list",
    "--repo",
    "example/fork",
    "--base",
    "lastcode/main",
    "--state",
    "open",
    "--json",
    "number",
    "--jq",
    "length",
  ]);
});

function nightly(tag: string) {
  const value = parseNightlyTag(tag);
  assert.ok(value);
  return value;
}

it("uses Git's supported short option when creating the recovery branch", () => {
  assert.deepStrictEqual(worktreeAddArgs("sync/nightly/v1", "/tmp/sync", "checkpoint"), [
    "worktree",
    "add",
    "-b",
    "sync/nightly/v1",
    "/tmp/sync",
    "checkpoint",
  ]);
});

it("continues a rebase when rerere staged every remembered conflict", () => {
  assert.equal(shouldContinueRerereRebase({ rebaseInProgress: true, unmergedPaths: [] }), true);
  assert.equal(
    shouldContinueRerereRebase({
      rebaseInProgress: true,
      unmergedPaths: ["still-conflicted.ts"],
    }),
    false,
  );
  assert.equal(shouldContinueRerereRebase({ rebaseInProgress: false, unmergedPaths: [] }), false);
});

it("stops automatic rebase continuation when Git makes no progress", () => {
  assert.equal(rerereRebaseMadeProgress("head-a\0step:1", "head-b\0step:2"), true);
  assert.equal(rerereRebaseMadeProgress("head-a\0step:1", "head-a\0step:1"), false);
});

it("records a successful carry-set shadow check for a produced installable", () => {
  const records: Array<CarrySetShadowRecord> = [];
  const logs: Array<string> = [];
  const times = [1_000, 1_250];
  const record = runCarrySetShadowAfterPublication("/repo", "lastcode/checkpoint/v1", {
    append: (value) => (records.push(value), true),
    check: () => ({
      checkpointTag: "lastcode/checkpoint/v1",
      baseCommit: "upstream",
      sourceCommit: "lastcode",
      groups: [],
      tree: "tree",
    }),
    error: (message) => logs.push(message),
    log: (message) => logs.push(message),
    now: () => times.shift() ?? 0,
  });

  assert.deepStrictEqual(record, records[0]);
  assert.deepStrictEqual(record, {
    schemaVersion: 1,
    status: "shadow",
    outcome: "success",
    checkpointTag: "lastcode/checkpoint/v1",
    baseCommit: "upstream",
    sourceCommit: "lastcode",
    tree: "tree",
    startedAt: "1970-01-01T00:00:01.000Z",
    finishedAt: "1970-01-01T00:00:01.250Z",
    durationMs: 250,
  });
  assert.match(logs[0] ?? "", /shadow check passed/);
});

it("records carry-set shadow failures without changing the checkpoint result", () => {
  const records: Array<CarrySetShadowRecord> = [];
  const errors: Array<string> = [];
  const times = [1_000, 1_500];

  assert.doesNotThrow(() =>
    runCarrySetShadowAfterPublication("/repo", "lastcode/checkpoint/v1", {
      append: (value) => (records.push(value), true),
      check: () => {
        throw new Error("tree mismatch");
      },
      error: (message) => errors.push(message),
      log: () => undefined,
      now: () => times.shift() ?? 0,
    }),
  );
  assert.deepStrictEqual(records[0], {
    schemaVersion: 1,
    status: "shadow",
    outcome: "failed",
    checkpointTag: "lastcode/checkpoint/v1",
    startedAt: "1970-01-01T00:00:01.000Z",
    finishedAt: "1970-01-01T00:00:01.500Z",
    durationMs: 500,
    error: "tree mismatch",
  });
  assert.match(errors[0] ?? "", /tree mismatch/);
});

it("does not run a carry-set shadow check when no immutable was produced", () => {
  let checked = false;
  const result = runCarrySetShadowAfterPublication("/repo", undefined, {
    append: () => true,
    check: () => {
      checked = true;
      throw new Error("should not run");
    },
    error: () => undefined,
    log: () => undefined,
    now: () => 0,
  });

  assert.equal(result, undefined);
  assert.equal(checked, false);
});

it("runs the carry-set shadow check even when promotion fails", () => {
  const calls: Array<string> = [];

  expect(() =>
    runPromotionThenShadow(
      () => {
        calls.push("promotion");
        throw new Error("promotion failed");
      },
      () => calls.push("shadow"),
    ),
  ).toThrow("promotion failed");
  expect(calls).toEqual(["promotion", "shadow"]);
});

it("fingerprints retained recovery content so human edits prevent automatic cleanup", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-recovery-"));
  const git = (args: ReadonlyArray<string>) => {
    const result = NodeChildProcess.spawnSync("git", args, { cwd: directory, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  git(["init", "--quiet", "--initial-branch=sync/nightly/v0.0.1-nightly.20260812.1"]);
  git(["config", "user.email", "checkpoint@example.com"]);
  git(["config", "user.name", "Checkpoint Test"]);
  NodeFS.writeFileSync(NodePath.join(directory, "tracked.txt"), "original\n");
  git(["add", "tracked.txt"]);
  git(["commit", "--quiet", "--message", "base"]);
  const branch = "sync/nightly/v0.0.1-nightly.20260812.1";
  const original = checkpointRecoveryFingerprint(directory, branch);
  NodeFS.writeFileSync(NodePath.join(directory, "tracked.txt"), "edited\n");

  expect(checkpointRecoveryFingerprint(directory, branch)).not.toBe(original);
  git(["checkout", "--", "tracked.txt"]);
  const beforeBranchSwitch = checkpointRecoveryFingerprint(directory, branch);
  git(["switch", "--quiet", "--create", "operator-review"]);
  expect(checkpointRecoveryFingerprint(directory, branch)).not.toBe(beforeBranchSwitch);
  NodeFS.rmSync(directory, { recursive: true, force: true });
});

it("fingerprints tracked modes even when Git ignores filemode changes", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-recovery-"));
  const git = (args: ReadonlyArray<string>) => {
    const result = NodeChildProcess.spawnSync("git", args, { cwd: directory, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  git(["init", "--quiet", "--initial-branch=sync/nightly/v0.0.1-nightly.20260812.1"]);
  git(["config", "user.email", "checkpoint@example.com"]);
  git(["config", "user.name", "Checkpoint Test"]);
  NodeFS.writeFileSync(NodePath.join(directory, "tracked.txt"), "tracked\n");
  git(["add", "tracked.txt"]);
  git(["commit", "--quiet", "--message", "base"]);
  git(["config", "core.filemode", "false"]);
  const branch = "sync/nightly/v0.0.1-nightly.20260812.1";
  const original = checkpointRecoveryFingerprint(directory, branch);
  NodeFS.chmodSync(NodePath.join(directory, "tracked.txt"), 0o755);

  expect(checkpointRecoveryFingerprint(directory, branch)).not.toBe(original);
  NodeFS.rmSync(directory, { recursive: true, force: true });
});

it("fingerprints tracked parent directory modes", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-recovery-"));
  const git = (args: ReadonlyArray<string>) => {
    const result = NodeChildProcess.spawnSync("git", args, { cwd: directory, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  git(["init", "--quiet", "--initial-branch=sync/nightly/v0.0.1-nightly.20260812.1"]);
  git(["config", "user.email", "checkpoint@example.com"]);
  git(["config", "user.name", "Checkpoint Test"]);
  const trackedDirectory = NodePath.join(directory, "nested");
  NodeFS.mkdirSync(trackedDirectory);
  NodeFS.writeFileSync(NodePath.join(trackedDirectory, "tracked.txt"), "tracked\n");
  git(["add", "nested/tracked.txt"]);
  git(["commit", "--quiet", "--message", "base"]);
  const branch = "sync/nightly/v0.0.1-nightly.20260812.1";
  const original = checkpointRecoveryFingerprint(directory, branch);
  NodeFS.chmodSync(trackedDirectory, 0o700);

  expect(checkpointRecoveryFingerprint(directory, branch)).not.toBe(original);
  NodeFS.rmSync(directory, { recursive: true, force: true });
});

it("fingerprints tracked content independently of Git's stat cache", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-recovery-"));
  const git = (args: ReadonlyArray<string>) => {
    const result = NodeChildProcess.spawnSync("git", args, { cwd: directory, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  git(["init", "--quiet", "--initial-branch=sync/nightly/v0.0.1-nightly.20260812.1"]);
  git(["config", "user.email", "checkpoint@example.com"]);
  git(["config", "user.name", "Checkpoint Test"]);
  const trackedPath = NodePath.join(directory, "tracked.txt");
  NodeFS.writeFileSync(trackedPath, "before\n");
  git(["add", "tracked.txt"]);
  git(["commit", "--quiet", "--message", "base"]);
  git(["config", "core.trustctime", "false"]);
  const branch = "sync/nightly/v0.0.1-nightly.20260812.1";
  const original = checkpointRecoveryFingerprint(directory, branch);
  const originalTimes = NodeFS.statSync(trackedPath);
  NodeFS.writeFileSync(trackedPath, "edited\n");
  NodeFS.utimesSync(trackedPath, originalTimes.atime, originalTimes.mtime);

  expect(checkpointRecoveryFingerprint(directory, branch)).not.toBe(original);
  NodeFS.rmSync(directory, { recursive: true, force: true });
});

it("refuses to fingerprint recoveries with initialized submodules", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-recovery-"));
  const submodule = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-submodule-"));
  const git = (cwd: string, args: ReadonlyArray<string>) => {
    const result = NodeChildProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  git(submodule, ["init", "--quiet", "--initial-branch=main"]);
  git(submodule, ["config", "user.email", "checkpoint@example.com"]);
  git(submodule, ["config", "user.name", "Checkpoint Test"]);
  NodeFS.writeFileSync(NodePath.join(submodule, "tracked.txt"), "tracked\n");
  git(submodule, ["add", "tracked.txt"]);
  git(submodule, ["commit", "--quiet", "--message", "base"]);
  git(directory, ["init", "--quiet", "--initial-branch=sync/nightly/v0.0.1-nightly.20260812.1"]);
  git(directory, ["config", "user.email", "checkpoint@example.com"]);
  git(directory, ["config", "user.name", "Checkpoint Test"]);
  git(directory, ["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", submodule]);
  git(directory, ["commit", "--quiet", "--message", "base"]);

  expect(() =>
    checkpointRecoveryFingerprint(directory, "sync/nightly/v0.0.1-nightly.20260812.1"),
  ).toThrow("Initialized recovery submodules");
  NodeFS.rmSync(directory, { recursive: true, force: true });
  NodeFS.rmSync(submodule, { recursive: true, force: true });
});

it("refuses nonempty deinitialized gitlinks", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-recovery-"));
  const submodule = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-submodule-"));
  const git = (cwd: string, args: ReadonlyArray<string>) => {
    const result = NodeChildProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  git(submodule, ["init", "--quiet", "--initial-branch=main"]);
  git(submodule, ["config", "user.email", "checkpoint@example.com"]);
  git(submodule, ["config", "user.name", "Checkpoint Test"]);
  NodeFS.writeFileSync(NodePath.join(submodule, "tracked.txt"), "tracked\n");
  git(submodule, ["add", "tracked.txt"]);
  git(submodule, ["commit", "--quiet", "--message", "base"]);
  git(directory, ["init", "--quiet", "--initial-branch=sync/nightly/v0.0.1-nightly.20260812.1"]);
  git(directory, ["config", "user.email", "checkpoint@example.com"]);
  git(directory, ["config", "user.name", "Checkpoint Test"]);
  git(directory, ["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", submodule]);
  git(directory, ["commit", "--quiet", "--message", "base"]);
  git(directory, ["submodule", "deinit", "--force", "--all"]);
  NodeFS.writeFileSync(
    NodePath.join(directory, NodePath.basename(submodule), "operator.txt"),
    "keep\n",
  );

  expect(() =>
    checkpointRecoveryFingerprint(directory, "sync/nightly/v0.0.1-nightly.20260812.1"),
  ).toThrow("Nonempty deinitialized gitlink");
  NodeFS.rmSync(directory, { recursive: true, force: true });
  NodeFS.rmSync(submodule, { recursive: true, force: true });
});

it("refuses to fingerprint a locked recovery worktree", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-recovery-"));
  const repository = NodePath.join(root, "repository");
  const recovery = NodePath.join(root, "recovery");
  NodeFS.mkdirSync(repository);
  const git = (cwd: string, args: ReadonlyArray<string>) => {
    const result = NodeChildProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  git(repository, ["init", "--quiet", "--initial-branch=main"]);
  git(repository, ["config", "user.email", "checkpoint@example.com"]);
  git(repository, ["config", "user.name", "Checkpoint Test"]);
  NodeFS.writeFileSync(NodePath.join(repository, "tracked.txt"), "tracked\n");
  git(repository, ["add", "tracked.txt"]);
  git(repository, ["commit", "--quiet", "--message", "base"]);
  const branch = "sync/nightly/v0.0.1-nightly.20260812.1";
  git(repository, ["worktree", "add", "--quiet", "-b", branch, recovery]);
  git(repository, ["worktree", "lock", recovery]);

  expect(() => checkpointRecoveryFingerprint(recovery, branch)).toThrow("locked recovery worktree");
  NodeFS.rmSync(root, { recursive: true, force: true });
});

it("fingerprints per-worktree Git configuration", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-recovery-"));
  const git = (args: ReadonlyArray<string>) => {
    const result = NodeChildProcess.spawnSync("git", args, { cwd: directory, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  git(["init", "--quiet", "--initial-branch=sync/nightly/v0.0.1-nightly.20260812.1"]);
  git(["config", "user.email", "checkpoint@example.com"]);
  git(["config", "user.name", "Checkpoint Test"]);
  NodeFS.writeFileSync(NodePath.join(directory, "tracked.txt"), "tracked\n");
  git(["add", "tracked.txt"]);
  git(["commit", "--quiet", "--message", "base"]);
  const branch = "sync/nightly/v0.0.1-nightly.20260812.1";
  const original = checkpointRecoveryFingerprint(directory, branch);
  git(["config", "extensions.worktreeConfig", "true"]);
  git(["config", "--worktree", "commit.gpgsign", "false"]);

  expect(checkpointRecoveryFingerprint(directory, branch)).not.toBe(original);
  NodeFS.rmSync(directory, { recursive: true, force: true });
});

it("refuses to fingerprint unexpected ignored recovery directories", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-recovery-"));
  const git = (args: ReadonlyArray<string>) => {
    const result = NodeChildProcess.spawnSync("git", args, { cwd: directory, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  git(["init", "--quiet", "--initial-branch=sync/nightly/v0.0.1-nightly.20260812.1"]);
  git(["config", "user.email", "checkpoint@example.com"]);
  git(["config", "user.name", "Checkpoint Test"]);
  NodeFS.writeFileSync(NodePath.join(directory, ".gitignore"), ".private/\n");
  git(["add", ".gitignore"]);
  git(["commit", "--quiet", "--message", "base"]);
  NodeFS.mkdirSync(NodePath.join(directory, ".private"));
  NodeFS.writeFileSync(NodePath.join(directory, ".private", "notes.txt"), "operator notes\n");

  expect(() =>
    checkpointRecoveryFingerprint(directory, "sync/nightly/v0.0.1-nightly.20260812.1"),
  ).toThrow("prevents automatic retirement");
  NodeFS.rmSync(directory, { recursive: true, force: true });
});

it("refuses to fingerprint unexpected ignored recovery files", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-recovery-"));
  const git = (args: ReadonlyArray<string>) => {
    const result = NodeChildProcess.spawnSync("git", args, { cwd: directory, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  git(["init", "--quiet", "--initial-branch=sync/nightly/v0.0.1-nightly.20260812.1"]);
  git(["config", "user.email", "checkpoint@example.com"]);
  git(["config", "user.name", "Checkpoint Test"]);
  NodeFS.writeFileSync(NodePath.join(directory, ".gitignore"), ".env.local\n");
  git(["add", ".gitignore"]);
  git(["commit", "--quiet", "--message", "base"]);
  NodeFS.writeFileSync(NodePath.join(directory, ".env.local"), "operator setting\n");

  expect(() =>
    checkpointRecoveryFingerprint(directory, "sync/nightly/v0.0.1-nightly.20260812.1"),
  ).toThrow("Ignored recovery path '.env.local'");
  NodeFS.rmSync(directory, { recursive: true, force: true });
});

it("refuses to fingerprint recoveries with untracked artifacts", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-recovery-"));
  const git = (args: ReadonlyArray<string>) => {
    const result = NodeChildProcess.spawnSync("git", args, { cwd: directory, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  git(["init", "--quiet", "--initial-branch=sync/nightly/v0.0.1-nightly.20260812.1"]);
  git(["config", "user.email", "checkpoint@example.com"]);
  git(["config", "user.name", "Checkpoint Test"]);
  NodeFS.writeFileSync(NodePath.join(directory, "tracked.txt"), "tracked\n");
  git(["add", "tracked.txt"]);
  git(["commit", "--quiet", "--message", "base"]);
  NodeFS.writeFileSync(NodePath.join(directory, "hook-output.txt"), "generated\n");

  expect(() =>
    checkpointRecoveryFingerprint(directory, "sync/nightly/v0.0.1-nightly.20260812.1"),
  ).toThrow("prevents automatic retirement");
  NodeFS.rmSync(directory, { recursive: true, force: true });
});

it("refuses tracked paths hidden by index flags", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-recovery-"));
  const git = (args: ReadonlyArray<string>) => {
    const result = NodeChildProcess.spawnSync("git", args, { cwd: directory, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  git(["init", "--quiet", "--initial-branch=sync/nightly/v0.0.1-nightly.20260812.1"]);
  git(["config", "user.email", "checkpoint@example.com"]);
  git(["config", "user.name", "Checkpoint Test"]);
  NodeFS.writeFileSync(NodePath.join(directory, "tracked.txt"), "tracked\n");
  git(["add", "tracked.txt"]);
  git(["commit", "--quiet", "--message", "base"]);
  const branch = "sync/nightly/v0.0.1-nightly.20260812.1";
  git(["update-index", "--assume-unchanged", "tracked.txt"]);
  expect(() => checkpointRecoveryFingerprint(directory, branch)).toThrow("Hidden index flag");
  git(["update-index", "--no-assume-unchanged", "tracked.txt"]);
  git(["update-index", "--skip-worktree", "tracked.txt"]);
  expect(() => checkpointRecoveryFingerprint(directory, branch)).toThrow("Hidden index flag");
  NodeFS.rmSync(directory, { recursive: true, force: true });
});

it("captures every file in active rebase metadata", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-recovery-"));
  const git = (args: ReadonlyArray<string>) => {
    const result = NodeChildProcess.spawnSync("git", args, { cwd: directory, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git(["init", "--quiet"]);
  const rebaseDirectory = NodePath.join(git(["rev-parse", "--absolute-git-dir"]), "rebase-merge");
  NodeFS.mkdirSync(rebaseDirectory);
  const messagePath = NodePath.join(rebaseDirectory, "message");
  NodeFS.writeFileSync(messagePath, "before\n");
  const before = rebaseStateFiles(directory);
  NodeFS.writeFileSync(messagePath, "after\n");

  expect(rebaseStateFiles(directory)).not.toEqual(before);
  const beforeModeChange = rebaseStateFiles(directory);
  NodeFS.chmodSync(messagePath, 0o700);
  expect(rebaseStateFiles(directory)).not.toEqual(beforeModeChange);
  const beforeRootModeChange = rebaseStateFiles(directory);
  NodeFS.chmodSync(rebaseDirectory, 0o700);
  expect(rebaseStateFiles(directory)).not.toEqual(beforeRootModeChange);
  NodeFS.rmSync(directory, { recursive: true, force: true });
});

it("supersedes only an unchanged automation-owned rebase or smoke recovery", () => {
  const failedTag = "v0.0.1-nightly.20260812.1";
  const latestNightly = nightly("v0.0.1-nightly.20260812.3");
  const run = {
    schemaVersion: 1 as const,
    status: "failed" as const,
    upstreamTag: failedTag,
    startedAt: "2026-08-12T00:00:00.000Z",
    finishedAt: "2026-08-12T00:00:01.000Z",
    durationMs: 1_000,
    commitsRebased: 3,
    failurePhase: "rebase" as const,
    recoveryBranch: `sync/nightly/${failedTag}`,
    recoveryFingerprint: "same",
  };

  expect(
    supersededRecoveryNightly({
      latestNightly,
      recoveryFingerprint: "same",
      recoveryWorktreeExists: true,
      run,
    })?.tag,
  ).toBe(failedTag);
  expect(
    supersededRecoveryNightly({
      latestNightly,
      recoveryFingerprint: "changed",
      recoveryWorktreeExists: true,
      run,
    }),
  ).toBeUndefined();
  expect(
    supersededRecoveryNightly({
      latestNightly: nightly(failedTag),
      recoveryFingerprint: "same",
      recoveryWorktreeExists: true,
      run,
    }),
  ).toBeUndefined();
  expect(
    supersededRecoveryNightly({
      latestNightly,
      recoveryFingerprint: "same",
      recoveryWorktreeExists: true,
      run: { ...run, failurePhase: "publication" },
    }),
  ).toBeUndefined();
});

it("keeps dry-run checkpoint previews non-destructive", () => {
  expect(recoverySupersessionMode({ dryRun: true, enabled: true })).toBe("preview");
  expect(recoverySupersessionMode({ dryRun: false, enabled: true })).toBe("retire");
  expect(recoverySupersessionMode({ dryRun: false, enabled: false })).toBe("disabled");
});

it("runs smoke checks with the isolated worktree's Vite+ binary", () => {
  assert.equal(worktreeVp("/tmp/sync"), "/tmp/sync/node_modules/.bin/vp");
});

it("removes the Electron host mode from checkpoint smoke subprocesses", () => {
  assert.deepStrictEqual(
    checkpointSmokeEnvironment({ ELECTRON_RUN_AS_NODE: "1", KEEP_ME: "yes" }),
    { KEEP_ME: "yes" },
  );
});

it("typechecks every workspace before publishing", () => {
  assert.deepStrictEqual(checkpointSmokeTypecheckCommands(), [
    ["run", "-r", "--concurrency-limit", "2", "typecheck"],
  ]);
});

it("runs the repository format and lint gate before publishing", () => {
  assert.deepStrictEqual(checkpointSmokeFormatAndLintCommand(), ["check"]);
});

it("bootstraps dependencies with the invoking worktree runner before using the isolated runner", () => {
  assert.deepStrictEqual(checkpointVpPaths("/tmp/automation", "/tmp/sync"), {
    bootstrap: "/tmp/automation/node_modules/.bin/vp",
    isolated: "/tmp/sync/node_modules/.bin/vp",
  });
});

it("publishes smoke-validated checkpoint tags without rerunning the generic pre-push gate", () => {
  assert.deepStrictEqual(
    checkpointTagPushArgs("origin", "lastcode/checkpoint/v1.2.3-nightly.20260812.8", {
      kind: "smoke",
    }),
    ["push", "--no-verify", "origin", "lastcode/checkpoint/v1.2.3-nightly.20260812.8"],
  );
});

it("retains the generic pre-push gate when it will validate the checkpoint commit", () => {
  assert.deepStrictEqual(
    checkpointTagPushArgs("origin", "lastcode/checkpoint/v1.2.3-nightly.20260812.8", {
      kind: "pre-push",
      candidateCommit: "checkpoint",
      checkoutHead: "checkpoint",
    }),
    ["push", "origin", "lastcode/checkpoint/v1.2.3-nightly.20260812.8"],
  );
});

it("refuses fallback publication when the pre-push hook would validate another commit", () => {
  expect(() =>
    checkpointTagPushArgs("origin", "lastcode/checkpoint/v1.2.3-nightly.20260812.8", {
      kind: "pre-push",
      candidateCommit: "checkpoint",
      checkoutHead: "invoking-worktree",
    }),
  ).toThrow(/would validate invoking-worktree, not checkpoint commit checkpoint/);
});

it("records dashboard metadata in annotated checkpoint tags", () => {
  const message = checkpointMessage({
    upstreamTag: "v1.2.3-nightly.20260812.8",
    upstreamCommit: "upstream-sha",
    commit: "lastcode-sha",
    sourceRef: "origin/lastcode/main",
    sourceCommit: "source-sha",
    timing: {
      commitsRebased: 8,
      startedAt: "2026-08-12T18:00:00.000Z",
      finishedAt: "2026-08-12T18:03:08.000Z",
      durationMs: 188_000,
    },
  });

  expect(message).toContain("Source-Commit: source-sha");
  expect(message).toContain(
    "Fork-Commits-Rebased: 8\nStarted-At: 2026-08-12T18:00:00.000Z\nFinished-At: 2026-08-12T18:03:08.000Z\nDuration-Ms: 188000",
  );
});

it("reads the source commit from checkpoint metadata", () => {
  assert.equal(
    checkpointSourceCommit("LastCode checkpoint\n\nSource-Commit: abc123\nDuration-Ms: 10"),
    "abc123",
  );
  assert.equal(checkpointSourceCommit("LastCode checkpoint without source metadata"), undefined);
});

it("records source and upstream provenance in revision tags", () => {
  const message = revisionMessage({
    commit: "revision-sha",
    createdAt: "2026-08-16T03:00:00.000Z",
    revision: 2,
    sourceCommit: "main-sha",
    sourceRef: "origin/lastcode/main",
    upstreamCommit: "upstream-sha",
    upstreamTag: "v0.0.34-nightly.20260816.1105",
  });
  expect(message).toContain("LastCode revision 2");
  expect(message).toContain("Source-Commit: main-sha");
  expect(message).toContain("Revision: 2");
});

it("creates the next revision by replaying main changes onto the latest checkpoint", () => {
  const old = nightly("v0.0.34-nightly.20260815.1104");
  const latest = nightly("v0.0.34-nightly.20260816.1105");
  const plan = resolveRevisionPlan({
    installableRefs: [
      {
        tag: `lastcode/checkpoint/${old.tag}`,
        commit: "old-main",
        nightly: old,
        revision: 0,
        sourceCommit: "old-main",
      },
      {
        tag: `lastcode/checkpoint/${latest.tag}`,
        commit: "latest-checkpoint",
        nightly: latest,
        revision: 0,
        sourceCommit: "old-main",
      },
    ],
    sourceCommit: "main-with-feature",
    isAncestor: (ancestor, descendant) =>
      ancestor === "old-main" && descendant === "main-with-feature",
  });
  assert.deepStrictEqual(plan, {
    kind: "create",
    installableTag: `lastcode/revision/${latest.tag}.1`,
    nightly: latest,
    ontoRef: `lastcode/checkpoint/${latest.tag}`,
    replayBase: "old-main",
    revision: 1,
  });
});

it("increments revisions already based on the latest installable", () => {
  const latest = nightly("v0.0.34-nightly.20260816.1105");
  const plan = resolveRevisionPlan({
    installableRefs: [
      {
        tag: `lastcode/checkpoint/${latest.tag}`,
        commit: "checkpoint",
        nightly: latest,
        revision: 0,
      },
      {
        tag: `lastcode/revision/${latest.tag}.1`,
        commit: "revision-one",
        nightly: latest,
        revision: 1,
        sourceCommit: "pre-rebase-main",
      },
    ],
    sourceCommit: "main-with-another-feature",
    isAncestor: (ancestor, descendant) =>
      ancestor === "revision-one" && descendant === "main-with-another-feature",
  });
  expect(plan).toMatchObject({
    kind: "create",
    installableTag: `lastcode/revision/${latest.tag}.2`,
    revision: 2,
  });
  if (plan.kind === "create") assert.equal(plan.replayBase, undefined);
});

it("replays the next merge when an open PR kept the previous revision off main", () => {
  const latest = nightly("v0.0.34-nightly.20260816.1105");
  const plan = resolveRevisionPlan({
    installableRefs: [
      {
        tag: `lastcode/revision/${latest.tag}.1`,
        commit: "rebased-revision-one",
        nightly: latest,
        revision: 1,
        sourceCommit: "main-after-first-merge",
      },
    ],
    sourceCommit: "main-after-second-merge",
    isAncestor: (ancestor, descendant) =>
      ancestor === "main-after-first-merge" && descendant === "main-after-second-merge",
  });
  expect(plan).toMatchObject({
    kind: "create",
    installableTag: `lastcode/revision/${latest.tag}.2`,
    replayBase: "main-after-first-merge",
    revision: 2,
  });
});

it("reuses an existing revision that already represents main", () => {
  const latest = nightly("v0.0.34-nightly.20260816.1105");
  const installable = {
    tag: `lastcode/revision/${latest.tag}.1`,
    commit: "rebased-revision",
    nightly: latest,
    revision: 1,
    sourceCommit: "main-with-feature",
  };
  assert.deepStrictEqual(
    resolveRevisionPlan({
      installableRefs: [installable],
      sourceCommit: "main-with-feature",
      isAncestor: () => false,
    }),
    { kind: "represented", installable },
  );
});

it("skips promotion when main already points at the checkpoint", () => {
  assert.equal(promotionNeeded("same", "same"), false);
  assert.equal(promotionNeeded("main", "checkpoint"), true);
});

it("promotes a validated checkpoint without rerunning CI in the automation checkout", () => {
  assert.deepStrictEqual(
    checkpointPromotionPushArgs("origin", "old-main", "checkpoint", { kind: "validated" }),
    [
      "push",
      "--no-verify",
      "--force-with-lease=refs/heads/lastcode/main:old-main",
      "origin",
      "checkpoint:refs/heads/lastcode/main",
    ],
  );
});

it("retains pre-push validation when promotion has no smoke or published tag", () => {
  assert.deepStrictEqual(
    checkpointPromotionPushArgs("origin", "old-main", "checkpoint", {
      kind: "pre-push",
      checkoutHead: "checkpoint",
    }),
    [
      "push",
      "--force-with-lease=refs/heads/lastcode/main:old-main",
      "origin",
      "checkpoint:refs/heads/lastcode/main",
    ],
  );
  expect(() =>
    checkpointPromotionPushArgs("origin", "old-main", "checkpoint", {
      kind: "pre-push",
      checkoutHead: "automation-checkout",
    }),
  ).toThrow(/pre-push hook would validate automation-checkout/);
});

it("mirrors upstream main with an exact lease on the fork branch", () => {
  const pushArgs = [
    "push",
    "--no-verify",
    "--force-with-lease=refs/heads/main:old-main",
    "origin",
    "upstream-main:refs/heads/main",
  ];
  assert.deepStrictEqual(
    upstreamMainMirrorPushArgs("origin", "old-main", "upstream-main"),
    pushArgs,
  );
  assert.deepStrictEqual(
    resolveUpstreamMainMirror("origin", "old-main", "upstream-main", true),
    pushArgs,
  );
  assert.equal(resolveUpstreamMainMirror("origin", "same", "same", true), undefined);
  expect(() => resolveUpstreamMainMirror("origin", "fork-main", "upstream-main", false)).toThrow(
    /origin\/main has diverged/,
  );
});

it("cleans up publication failures but retains recovery state for earlier failures", () => {
  assert.deepStrictEqual(
    checkpointFailureDisposition("lastcode/checkpoint/v1", "sync/nightly/v1"),
    { cleanup: true },
  );
  assert.deepStrictEqual(checkpointFailureDisposition(undefined, "sync/nightly/v1"), {
    cleanup: false,
    recoveryBranch: "sync/nightly/v1",
  });
  assert.deepStrictEqual(
    checkpointFailureDisposition("lastcode/checkpoint/v1", "sync/nightly/v1", false),
    { cleanup: false, recoveryBranch: "sync/nightly/v1" },
  );
});

it("retries checkpoint tags that are local but not published", () => {
  assert.deepStrictEqual(
    unpublishedCheckpointTags(
      ["lastcode/checkpoint/v1", "lastcode/checkpoint/v2"],
      "abc\trefs/tags/lastcode/checkpoint/v1\ndef\trefs/tags/lastcode/checkpoint/v1^{}\n",
    ),
    ["lastcode/checkpoint/v2"],
  );
});

it("bootstraps at the source nightly and checkpoints every later nightly", () => {
  const plan = resolveCheckpointPlan({
    checkpointRefs: [],
    nightlyTags: [
      "v0.0.2-nightly.20260103.3",
      "v0.0.1-nightly.20260101.1",
      "v0.0.1-nightly.20260102.2",
    ],
    sourceCommit: "source",
    sourceNightlyTags: ["v0.0.1-nightly.20260101.1"],
    sourceRef: "origin/lastcode/main",
  });

  assert.equal(plan.bootstrapCheckpoint, true);
  assert.equal(plan.baseNightly.tag, "v0.0.1-nightly.20260101.1");
  assert.deepStrictEqual(
    plan.missingNightlies.map(({ tag }) => tag),
    ["v0.0.1-nightly.20260102.2", "v0.0.2-nightly.20260103.3"],
  );
});

it("skips only the failed nightly when a newer upstream nightly supersedes it", () => {
  const old = nightly("v0.0.1-nightly.20260101.1");
  const plan = resolveCheckpointPlan({
    checkpointRefs: [
      {
        checkpointTag: `lastcode/checkpoint/${old.tag}`,
        commit: "last-checkpoint",
        nightly: old,
        sourceCommit: "main",
      },
    ],
    nightlyTags: [
      old.tag,
      "v0.0.1-nightly.20260102.2",
      "v0.0.1-nightly.20260103.3",
      "v0.0.1-nightly.20260104.4",
    ],
    sourceCommit: "main",
    sourceCheckpointTag: `lastcode/checkpoint/${old.tag}`,
    sourceNightlyTags: [old.tag],
    sourceRef: "origin/lastcode/main",
    supersedeThroughNightlyTag: "v0.0.1-nightly.20260102.2",
  });

  expect(plan.missingNightlies.map(({ tag }) => tag)).toEqual([
    "v0.0.1-nightly.20260103.3",
    "v0.0.1-nightly.20260104.4",
  ]);
});

it("continues from a newer unpromoted checkpoint when main has not changed", () => {
  const old = nightly("v0.0.1-nightly.20260101.1");
  const newer = nightly("v0.0.1-nightly.20260102.2");
  const plan = resolveCheckpointPlan({
    checkpointRefs: [
      { checkpointTag: `lastcode/checkpoint/${old.tag}`, commit: "main", nightly: old },
      { checkpointTag: `lastcode/checkpoint/${newer.tag}`, commit: "checkpoint", nightly: newer },
    ],
    nightlyTags: [old.tag, newer.tag, "v0.0.2-nightly.20260103.3"],
    sourceCommit: "main",
    sourceCheckpointTag: `lastcode/checkpoint/${old.tag}`,
    sourceNightlyTags: [old.tag],
    sourceRef: "origin/lastcode/main",
  });

  assert.equal(plan.candidateRef, `lastcode/checkpoint/${newer.tag}`);
  assert.equal(plan.baseNightly.tag, newer.tag);
  assert.deepStrictEqual(
    plan.missingNightlies.map(({ tag }) => tag),
    ["v0.0.2-nightly.20260103.3"],
  );
});

it("retries promotion of a published checkpoint created from the current main", () => {
  const old = nightly("v0.0.1-nightly.20260101.1");
  const newer = nightly("v0.0.1-nightly.20260102.2");
  const plan = resolveCheckpointPlan({
    checkpointRefs: [
      { checkpointTag: `lastcode/checkpoint/${old.tag}`, commit: "old-main", nightly: old },
      {
        checkpointTag: `lastcode/checkpoint/${newer.tag}`,
        commit: "checkpoint",
        nightly: newer,
        sourceCommit: "main-with-feature",
      },
    ],
    nightlyTags: [old.tag, newer.tag],
    sourceCommit: "main-with-feature",
    sourceCheckpointTag: `lastcode/checkpoint/${old.tag}`,
    sourceNightlyTags: [old.tag],
    sourceRef: "origin/lastcode/main",
  });

  assert.equal(plan.candidateRef, `lastcode/checkpoint/${newer.tag}`);
  assert.equal(plan.baseNightly.tag, newer.tag);
  assert.deepStrictEqual(plan.missingNightlies, []);
});

it("carries new main commits directly to the next missing nightly", () => {
  const old = nightly("v0.0.1-nightly.20260101.1");
  const checkpointed = nightly("v0.0.1-nightly.20260102.2");
  const plan = resolveCheckpointPlan({
    checkpointRefs: [
      { checkpointTag: `lastcode/checkpoint/${old.tag}`, commit: "old-main", nightly: old },
      {
        checkpointTag: `lastcode/checkpoint/${checkpointed.tag}`,
        commit: "checkpoint",
        nightly: checkpointed,
      },
    ],
    nightlyTags: [old.tag, checkpointed.tag, "v0.0.2-nightly.20260103.3"],
    sourceCommit: "main-with-new-feature",
    sourceCheckpointTag: `lastcode/checkpoint/${old.tag}`,
    sourceNightlyTags: [old.tag],
    sourceRef: "origin/lastcode/main",
  });

  assert.equal(plan.candidateRef, "origin/lastcode/main");
  assert.equal(plan.baseNightly.tag, old.tag);
  assert.deepStrictEqual(
    plan.missingNightlies.map(({ tag }) => tag),
    ["v0.0.2-nightly.20260103.3"],
  );
});
