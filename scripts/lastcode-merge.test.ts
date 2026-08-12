import { describe, expect, it } from "vite-plus/test";

import { validatePullRequestForMerge } from "./lastcode-merge.ts";

const mergeablePullRequest = {
  number: 12,
  url: "https://github.com/lastobelus/lastCode/pull/12",
  state: "OPEN",
  isDraft: false,
  headRefOid: "head-sha",
  baseRefName: "lastcode/main",
  baseRefOid: "base-sha",
  mergeable: "MERGEABLE",
} as const;

describe("lastcode-merge", () => {
  it("accepts an open LastCode PR at the stamped head", () => {
    expect(() =>
      validatePullRequestForMerge(mergeablePullRequest, "head-sha", "base-sha"),
    ).not.toThrow();
  });

  it("rejects drafts, stale heads, conflicts, and other base branches", () => {
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
    ).toThrow("merge conflicts");
    expect(() =>
      validatePullRequestForMerge(
        { ...mergeablePullRequest, baseRefName: "main" },
        "head-sha",
        "base-sha",
      ),
    ).toThrow("not 'lastcode/main'");
  });
});
