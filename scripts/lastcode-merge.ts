#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- Host-side merge orchestration runs subprocesses directly.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  assertCleanWorktree,
  cleanGitEnvironment,
  assertSupportedNodeVersion,
  LASTCODE_BASE_BRANCH,
  LASTCODE_ORIGIN_REMOTE,
  resolveRepoRoot,
  runGit,
} from "./lib/lastcode-git.ts";
import { type GithubCiEvidence, LASTCODE_CI_WORKFLOW, readGithubCi } from "./lastcode-github-ci.ts";
import { readReviewData, validateReviewForMerge } from "./lastcode-pr-gates.ts";
import { acquireMainWriteLock } from "./lastcode-main-write-lock.ts";
import { carrySquashBody, preserveCarrySource } from "./lastcode-carry-delivery.ts";

import { validateCarryPullRequest } from "./lastcode-carry-ci.ts";

const LASTCODE_GITHUB_REPOSITORY = process.env.LASTCODE_GITHUB_REPOSITORY ?? "lastobelus/lastCode";

export interface PullRequestForMerge {
  readonly number: number;
  readonly body: string;
  readonly url: string;
  readonly state: string;
  readonly isDraft: boolean;
  readonly headRefOid: string;
  readonly baseRefName: string;
  readonly baseRefOid: string;
  readonly mergeable: string;
  readonly mergeStateStatus: string;
}

function writeSquashBody(body: string): { readonly cleanup: () => void; readonly path: string } {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lastcode-merge-body-"));
  const path = NodePath.join(directory, `${NodeCrypto.randomUUID()}.md`);
  NodeFS.writeFileSync(path, body, { encoding: "utf8", mode: 0o600 });
  return { cleanup: () => NodeFS.rmSync(directory, { force: true, recursive: true }), path };
}

// With strict status checks off, GitHub reports a PR that is behind its base as CLEAN, so
// CLEAN is the only state that can merge. BEHIND means the up-to-date rule is back on.
export function validatePullRequestForMerge(
  pullRequest: PullRequestForMerge,
  expectedHead: string,
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
    `GitHub CI is not merge-ready (${evidence.state}/${evidence.reason}); check again with pnpm --config.verify-deps-before-run=false lastcode:pr-gates once CI settles.`,
  );
}

// The PR may be behind main. Its CI tested a merge onto `baseRefOid`, which must still be in main
// (a checkpoint rewrite removes it), and its head must still merge cleanly onto the current tip.
function assertMergesOntoBase(
  repoRoot: string,
  pullRequest: Pick<PullRequestForMerge, "number" | "baseRefOid">,
  baseCommit: string,
  head: string,
): void {
  const ancestor = NodeChildProcess.spawnSync(
    "git",
    ["merge-base", "--is-ancestor", pullRequest.baseRefOid, baseCommit],
    { cwd: repoRoot, env: cleanGitEnvironment(process.env), stdio: "ignore" },
  );
  if (ancestor.error) throw ancestor.error;
  if (ancestor.status !== 0) {
    throw new Error(
      `Pull request #${pullRequest.number} was tested against ${pullRequest.baseRefOid}, which is no longer in ${LASTCODE_BASE_BRANCH}. Rebase onto ${LASTCODE_ORIGIN_REMOTE}/${LASTCODE_BASE_BRANCH} and push.`,
    );
  }
  const merge = NodeChildProcess.spawnSync(
    "git",
    ["merge-tree", "--write-tree", "--name-only", baseCommit, head],
    { cwd: repoRoot, encoding: "utf8", env: cleanGitEnvironment(process.env) },
  );
  if (merge.error) throw merge.error;
  if (merge.status !== 0) {
    throw new Error(
      [
        `Pull request #${pullRequest.number} conflicts with ${LASTCODE_ORIGIN_REMOTE}/${LASTCODE_BASE_BRANCH} at ${baseCommit}. Rebase onto it and push.`,
        merge.stdout.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

function postMergeCiInstructions(mergeCommit: string): string {
  return [
    `[lastcode:merge] Merged as ${mergeCommit}. Main CI now runs on it; confirm it passes:`,
    `  gh run list --repo ${LASTCODE_GITHUB_REPOSITORY} --workflow ${LASTCODE_CI_WORKFLOW} --event push --commit ${mergeCommit} --json databaseId,status,conclusion,url`,
  ].join("\n");
}

export function postMergeCheckpointArguments(skipCheckpoint = true): ReadonlyArray<string> | null {
  if (skipCheckpoint) return null;
  return ["scripts/lastcode-nightly-service.ts", "run-now", "--if-installed"];
}

export function parseMergeOptions(argv: ReadonlyArray<string>) {
  if (
    argv.some(
      (argument) => !["--dry-run", "--skip-checkpoint", "--checkpoint"].includes(argument),
    ) ||
    (argv.includes("--skip-checkpoint") && argv.includes("--checkpoint"))
  ) {
    throw new Error(
      "Usage: pnpm --config.verify-deps-before-run=false lastcode:merge [--dry-run] [--skip-checkpoint | --checkpoint]",
    );
  }
  return { dryRun: argv.includes("--dry-run"), skipCheckpoint: !argv.includes("--checkpoint") };
}

export function squashMergeArguments(
  pullRequestNumber: number,
  commit: string,
  bodyFile: string,
): ReadonlyArray<string> {
  return [
    "pr",
    "merge",
    String(pullRequestNumber),
    "--repo",
    LASTCODE_GITHUB_REPOSITORY,
    "--squash",
    "--delete-branch",
    "--match-head-commit",
    commit,
    "--body-file",
    bodyFile,
  ];
}

export function assertMergeBaseUnchanged(
  repoRoot: string,
  expectedBase: string,
  phase = "while checking the base",
): void {
  const currentBase = runGit(repoRoot, [
    "rev-parse",
    `refs/remotes/${LASTCODE_ORIGIN_REMOTE}/${LASTCODE_BASE_BRANCH}`,
  ]);
  if (currentBase !== expectedBase) {
    throw new Error(
      `${LASTCODE_ORIGIN_REMOTE}/${LASTCODE_BASE_BRANCH} moved from ${expectedBase} to ${currentBase} ${phase}. Run lastcode:merge again; a PR behind main needs no rebase or new CI unless the rerun reports a conflict.`,
    );
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
    "number,body,url,state,isDraft,headRefOid,baseRefName,baseRefOid,mergeable,mergeStateStatus",
  ]);
}

function main(argv: ReadonlyArray<string>): void {
  assertSupportedNodeVersion();
  const { dryRun, skipCheckpoint } = parseMergeOptions(argv);

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

  const pullRequest = readPullRequest(repoRoot, branch);
  validatePullRequestForMerge(pullRequest, commit);
  assertMergesOntoBase(repoRoot, pullRequest, baseCommit, commit);
  const githubCi = readGithubCi(
    LASTCODE_GITHUB_REPOSITORY,
    pullRequest,
    <T>(args: ReadonlyArray<string>): T => runGhJson<T>(repoRoot, args),
  );
  const validatedGithubCi = validateGithubCiForMerge(githubCi);
  validateReviewForMerge(
    readReviewData(LASTCODE_GITHUB_REPOSITORY, pullRequest, <T>(args: ReadonlyArray<string>): T =>
      runGhJson<T>(repoRoot, args),
    ),
  );

  runCommand(repoRoot, "git", ["fetch", LASTCODE_ORIGIN_REMOTE, LASTCODE_BASE_BRANCH]);
  assertMergeBaseUnchanged(repoRoot, baseCommit, "while validating GitHub CI");
  const confirmedPullRequest = readPullRequest(repoRoot, branch);
  if (confirmedPullRequest.number !== pullRequest.number) {
    throw new Error(
      `Checked-out branch now resolves to pull request #${confirmedPullRequest.number}, not #${pullRequest.number}.`,
    );
  }
  validatePullRequestForMerge(confirmedPullRequest, commit);
  assertMergesOntoBase(repoRoot, confirmedPullRequest, baseCommit, commit);
  runCommand(repoRoot, "git", [
    "fetch",
    "--no-tags",
    LASTCODE_ORIGIN_REMOTE,
    "refs/lastcode/carry-sources/*:refs/lastcode/carry-sources/*",
  ]);
  const carrySource = validateCarryPullRequest(repoRoot, {
    number: pullRequest.number,
    base: baseCommit,
    head: commit,
  }).source;

  if (dryRun) {
    console.log(
      `[lastcode:merge] Would squash ${pullRequest.url} at ${commit} into ${LASTCODE_BASE_BRANCH} after GitHub CI run ${validatedGithubCi.runId} tested merge ${validatedGithubCi.testedMergeSha}.`,
    );
    return;
  }

  const lock = acquireMainWriteLock(repoRoot, LASTCODE_ORIGIN_REMOTE, baseCommit, "merge");
  try {
    // Check again after acquiring the cross-machine main-write lock. No CI or
    // review wait holds it; a checkpoint that won the race invalidates this run.
    runCommand(repoRoot, "git", ["fetch", LASTCODE_ORIGIN_REMOTE, LASTCODE_BASE_BRANCH]);
    assertMergeBaseUnchanged(repoRoot, baseCommit, "before acquiring the main-write lock");
    const lockedPullRequest = readPullRequest(repoRoot, branch);
    if (lockedPullRequest.number !== pullRequest.number) {
      throw new Error("The current branch resolves to a different pull request.");
    }
    validatePullRequestForMerge(lockedPullRequest, commit);
    assertMergesOntoBase(repoRoot, lockedPullRequest, baseCommit, commit);
    validateGithubCiForMerge(
      readGithubCi(
        LASTCODE_GITHUB_REPOSITORY,
        lockedPullRequest,
        <T>(args: ReadonlyArray<string>): T => runGhJson<T>(repoRoot, args),
      ),
    );
    validateReviewForMerge(
      readReviewData(
        LASTCODE_GITHUB_REPOSITORY,
        lockedPullRequest,
        <T>(args: ReadonlyArray<string>): T => runGhJson<T>(repoRoot, args),
      ),
    );
    if (carrySource) preserveCarrySource(repoRoot, carrySource);
    const squashBody = writeSquashBody(
      carrySource ? carrySquashBody(lockedPullRequest.body, carrySource) : lockedPullRequest.body,
    );
    try {
      lock.merge(squashMergeArguments(pullRequest.number, commit, squashBody.path));
    } finally {
      squashBody.cleanup();
    }
  } catch (error) {
    try {
      lock.release();
    } catch (cleanupError) {
      const failures = [error, cleanupError];
      // oxlint-disable-next-line preserve-caught-error -- AggregateError takes its cause in the third argument.
      throw new AggregateError(
        failures,
        failures
          .map((failure) => (failure instanceof Error ? failure.message : String(failure)))
          .join("\n"),
        { cause: error },
      );
    }
    throw error;
  }
  lock.release();
  let merged: string | undefined;
  try {
    merged = runGhJson<{ readonly mergeCommit?: { readonly oid?: string } | null }>(repoRoot, [
      "pr",
      "view",
      String(pullRequest.number),
      "--repo",
      LASTCODE_GITHUB_REPOSITORY,
      "--json",
      "mergeCommit",
    ]).mergeCommit?.oid;
  } catch {
    merged = undefined;
  }
  console.log(
    merged
      ? postMergeCiInstructions(merged)
      : "[lastcode:merge] Merged, but GitHub did not report the merge commit; confirm main CI for the new lastcode/main tip.",
  );
  const checkpointArguments = postMergeCheckpointArguments(skipCheckpoint);
  if (checkpointArguments === null) {
    console.log("[lastcode:merge] Merge complete. No checkpoint requested.");
    return;
  }
  try {
    runCommand(repoRoot, process.execPath, checkpointArguments);
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
