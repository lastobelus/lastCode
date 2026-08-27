#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- Host-side merge orchestration runs subprocesses directly.
import * as NodeChildProcess from "node:child_process";

import {
  assertBaseIsAncestor,
  assertCleanWorktree,
  assertSupportedNodeVersion,
  LASTCODE_BASE_BRANCH,
  LASTCODE_ORIGIN_REMOTE,
  resolveRepoRoot,
  runGit,
} from "./lastcode-local-ci.ts";
import { type GithubCiEvidence, readGithubCi } from "./lastcode-github-ci.ts";

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
  readonly mergeStateStatus: string;
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
  if (pullRequest.mergeable !== "MERGEABLE" || pullRequest.mergeStateStatus !== "CLEAN") {
    throw new Error(
      `Pull request #${pullRequest.number} is not cleanly mergeable (${pullRequest.mergeable}/${pullRequest.mergeStateStatus}).`,
    );
  }
}

export function validateGithubCiForMerge(evidence: GithubCiEvidence): {
  readonly runId: number;
  readonly testedMergeSha: string;
} {
  if (evidence.state === "satisfied" && evidence.reason === "exact-run") {
    const { runId, testedMergeSha } = evidence;
    if (runId === undefined || !testedMergeSha || !/^[0-9a-f]{40}$/u.test(testedMergeSha)) {
      throw new Error("GitHub CI exact-run evidence is missing its immutable run identity.");
    }
    return { runId, testedMergeSha };
  }
  if (evidence.state === "failure") {
    throw new Error(`GitHub CI is not merge-ready: ${evidence.detail}`);
  }
  throw new Error(
    `GitHub CI is not merge-ready (${evidence.state}/${evidence.reason}); run Wait for PR again.`,
  );
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

function runGhJson<T>(repoRoot: string, args: ReadonlyArray<string>): T {
  return JSON.parse(runCommand(repoRoot, "gh", args, true)) as T;
}

function readPullRequest(repoRoot: string, branch: string): PullRequestForMerge {
  return runGhJson<PullRequestForMerge>(repoRoot, [
    "pr",
    "view",
    branch,
    "--repo",
    LASTCODE_GITHUB_REPOSITORY,
    "--json",
    "number,url,state,isDraft,headRefOid,baseRefName,baseRefOid,mergeable,mergeStateStatus",
  ]);
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

  const pullRequest = readPullRequest(repoRoot, branch);
  validatePullRequestForMerge(pullRequest, commit, baseCommit);
  const githubCi = readGithubCi(
    LASTCODE_GITHUB_REPOSITORY,
    pullRequest,
    <T>(args: ReadonlyArray<string>): T => runGhJson<T>(repoRoot, args),
  );
  const validatedGithubCi = validateGithubCiForMerge(githubCi);

  runCommand(repoRoot, "git", ["fetch", LASTCODE_ORIGIN_REMOTE, LASTCODE_BASE_BRANCH]);
  const confirmedBaseCommit = runGit(repoRoot, [
    "rev-parse",
    `refs/remotes/${LASTCODE_ORIGIN_REMOTE}/${LASTCODE_BASE_BRANCH}`,
  ]);
  if (confirmedBaseCommit !== baseCommit) {
    throw new Error(
      `${LASTCODE_ORIGIN_REMOTE}/${LASTCODE_BASE_BRANCH} moved from ${baseCommit} to ${confirmedBaseCommit} while validating GitHub CI.`,
    );
  }
  const confirmedPullRequest = readPullRequest(repoRoot, branch);
  if (confirmedPullRequest.number !== pullRequest.number) {
    throw new Error(
      `Checked-out branch now resolves to pull request #${confirmedPullRequest.number}, not #${pullRequest.number}.`,
    );
  }
  validatePullRequestForMerge(confirmedPullRequest, commit, baseCommit);

  if (dryRun) {
    console.log(
      `[lastcode:merge] Would squash ${pullRequest.url} at ${commit} into ${LASTCODE_BASE_BRANCH} after GitHub CI run ${validatedGithubCi.runId} tested merge ${validatedGithubCi.testedMergeSha}.`,
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
  try {
    runCommand(repoRoot, process.execPath, ["scripts/lastcode-nightly-service.ts", "run-now"]);
    console.log("[lastcode:merge] Requested an immediate installable-revision check.");
  } catch (error) {
    console.warn(
      `[lastcode:merge] Merge succeeded, but the checkpoint service could not be started: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`[lastcode:merge] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
