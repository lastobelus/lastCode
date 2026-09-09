import { describe, expect, it } from "vite-plus/test";

import {
  postMergeCheckpointArguments,
  squashMergeArguments,
  validateGithubCiForMerge,
  validatePullRequestForMerge,
} from "./lastcode-merge.ts";

const mergeablePullRequest = {
  number: 12,
  body: "Fixes the problem.\n\nBuilt with Codex.",
  url: "https://github.com/lastobelus/lastCode/pull/12",
  state: "OPEN",
  isDraft: false,
  headRefOid: "head-sha",
  baseRefName: "lastcode/main",
  baseRefOid: "base-sha",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
} as const;

describe("lastcode-merge", () => {
  it("silently skips the optional checkpoint request on hosts without the service", () => {
    expect(postMergeCheckpointArguments()).toEqual([
      "scripts/lastcode-nightly-service.ts",
      "run-now",
      "--if-installed",
    ]);
  });

  it("uses an exact temporary body file with the existing squash guards", () => {
    expect(squashMergeArguments(12, "head-sha", "/tmp/merge-body.md")).toEqual([
      "pr",
      "merge",
      "12",
      "--repo",
      "lastobelus/lastCode",
      "--squash",
      "--delete-branch",
      "--match-head-commit",
      "head-sha",
      "--body-file",
      "/tmp/merge-body.md",
    ]);
  });

  it("accepts an open, clean LastCode PR at the exact head and base", () => {
    expect(() =>
      validatePullRequestForMerge(mergeablePullRequest, "head-sha", "base-sha"),
    ).not.toThrow();
  });

  it("rejects drafts, stale heads, non-clean merge state, and other base branches", () => {
    expect(() =>
      validatePullRequestForMerge(
        { ...mergeablePullRequest, isDraft: true },
        "head-sha",
        "base-sha",
      ),
    ).toThrow("still a draft");
    expect(() =>
      validatePullRequestForMerge(mergeablePullRequest, "other-sha", "base-sha"),
    ).toThrow("not local HEAD");
    expect(() =>
      validatePullRequestForMerge(mergeablePullRequest, "head-sha", "other-base-sha"),
    ).toThrow("not the locally tested base");
    expect(() =>
      validatePullRequestForMerge(
        { ...mergeablePullRequest, mergeable: "CONFLICTING" },
        "head-sha",
        "base-sha",
      ),
    ).toThrow("not cleanly mergeable");
    expect(() =>
      validatePullRequestForMerge(
        { ...mergeablePullRequest, mergeStateStatus: "BEHIND" },
        "head-sha",
        "base-sha",
      ),
    ).toThrow("not cleanly mergeable");
    expect(() =>
      validatePullRequestForMerge(
        { ...mergeablePullRequest, baseRefName: "main" },
        "head-sha",
        "base-sha",
      ),
    ).toThrow("not 'lastcode/main'");
  });

  it("accepts only a successful exact GitHub CI run", () => {
    expect(() =>
      validateGithubCiForMerge({
        state: "satisfied",
        reason: "exact-run",
        runId: 456,
        testedMergeSha: "a".repeat(40),
      }),
    ).not.toThrow();
    expect(() => validateGithubCiForMerge({ state: "satisfied", reason: "not-expected" })).toThrow(
      "not merge-ready",
    );
    expect(() =>
      validateGithubCiForMerge({ state: "pending", reason: "run-in-progress", runId: 456 }),
    ).toThrow("run Wait for PR again");
    expect(() =>
      validateGithubCiForMerge({
        state: "failure",
        reason: "terminal-run",
        detail: "Workflow failed.",
      }),
    ).toThrow("Workflow failed");
  });
});
