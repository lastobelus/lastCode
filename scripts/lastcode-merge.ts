#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- Host-side merge orchestration runs subprocesses directly.
import * as NodeChildProcess from "node:child_process";

import {
  assertBaseIsAncestor,
  assertCleanWorktree,
  assertFullCiStamp,
  assertSupportedNodeVersion,
  LASTCODE_BASE_BRANCH,
  LASTCODE_ORIGIN_REMOTE,
  resolveCommonGitDir,
  resolveRepoRoot,
  runGit,
} from "./lastcode-local-ci.ts";

const LASTCODE_GITHUB_REPOSITORY = process.env.LASTCODE_GITHUB_REPOSITORY ?? "lastobelus/lastCode";

export interface PullRequestForMerge {
  readonly number: number;
  readonly url: string;
  readonly state: string;
  readonly isDraft: boolean;
  readonly headRefOid: string;
  readonly baseRefName: string;
  readonly baseRefOid: string;
  readonly mergeable: string;
}

export function validatePullRequestForMerge(
  pullRequest: PullRequestForMerge,
  expectedHead: string,
  expectedBase: string,
): void {
  if (pullRequest.state !== "OPEN") {
    throw new Error(`Pull request #${pullRequest.number} is not open.`);
  }
  if (pullRequest.isDraft) {
    throw new Error(`Pull request #${pullRequest.number} is still a draft.`);
  }
  if (pullRequest.baseRefName !== LASTCODE_BASE_BRANCH) {
    throw new Error(
      `Pull request #${pullRequest.number} targets '${pullRequest.baseRefName}', not '${LASTCODE_BASE_BRANCH}'.`,
    );
  }
  if (pullRequest.headRefOid !== expectedHead) {
    throw new Error(
      `Pull request #${pullRequest.number} points to ${pullRequest.headRefOid}, not local HEAD ${expectedHead}.`,
    );
  }
  if (pullRequest.baseRefOid !== expectedBase) {
    throw new Error(
      `Pull request #${pullRequest.number} is based on ${pullRequest.baseRefOid}, not the locally tested base ${expectedBase}.`,
    );
  }
  if (pullRequest.mergeable === "CONFLICTING") {
    throw new Error(`Pull request #${pullRequest.number} has merge conflicts.`);
  }
}

function runCommand(
  repoRoot: string,
  command: string,
  args: ReadonlyArray<string>,
  capture = false,
): string {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = capture ? result.stderr.trim() : "";
    throw new Error(
      [`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.`, stderr]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return capture ? result.stdout.trim() : "";
}

function main(argv: ReadonlyArray<string>): void {
  assertSupportedNodeVersion();
  const dryRun = argv.length === 1 && argv[0] === "--dry-run";
  if (argv.length > (dryRun ? 1 : 0)) {
    throw new Error("Usage: pnpm lastcode:merge [--dry-run]");
  }

  const repoRoot = resolveRepoRoot();
  assertCleanWorktree(repoRoot);
  const branch = runGit(repoRoot, ["branch", "--show-current"]);
  if (!branch || branch === LASTCODE_BASE_BRANCH) {
    throw new Error(
      `Run lastcode:merge from a feature branch, not '${branch || "detached HEAD"}'.`,
    );
  }

  runCommand(repoRoot, "git", ["fetch", LASTCODE_ORIGIN_REMOTE, LASTCODE_BASE_BRANCH]);
  const commit = runGit(repoRoot, ["rev-parse", "HEAD"]);
  const baseCommit = runGit(repoRoot, [
    "rev-parse",
    `refs/remotes/${LASTCODE_ORIGIN_REMOTE}/${LASTCODE_BASE_BRANCH}`,
  ]);
  assertBaseIsAncestor(repoRoot, baseCommit, commit);
  assertFullCiStamp(resolveCommonGitDir(repoRoot), commit, baseCommit);

  const pullRequest = JSON.parse(
    runCommand(
      repoRoot,
      "gh",
      [
        "pr",
        "view",
        branch,
        "--repo",
        LASTCODE_GITHUB_REPOSITORY,
        "--json",
        "number,url,state,isDraft,headRefOid,baseRefName,baseRefOid,mergeable",
      ],
      true,
    ),
  ) as PullRequestForMerge;
  validatePullRequestForMerge(pullRequest, commit, baseCommit);

  if (dryRun) {
    console.log(
      `[lastcode:merge] Would squash ${pullRequest.url} at ${commit} into ${LASTCODE_BASE_BRANCH}.`,
    );
    return;
  }

  runCommand(repoRoot, "gh", [
    "pr",
    "merge",
    String(pullRequest.number),
    "--repo",
    LASTCODE_GITHUB_REPOSITORY,
    "--squash",
    "--delete-branch",
    "--match-head-commit",
    commit,
  ]);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`[lastcode:merge] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
