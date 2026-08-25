// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "vite-plus/test";

import {
  classifyStatusChecks,
  decideWaitForPr,
  deriveReviewState,
  latestCodexReviewTrigger,
  pullRequestViewArgs,
  type ReviewState,
  type WaitObservation,
} from "./lastcode-wait-for-pr.ts";

const HEAD = "1234567890abcdef1234567890abcdef12345678";
const BASE = "abcdef1234567890abcdef1234567890abcdef12";
const reviewRequest = (head = HEAD): string =>
  `@codex review\n<!-- lastcode-review-head: ${head} -->`;

const pendingReview: ReviewState = {
  terminalArtifacts: [],
  requestPresent: true,
  pending: true,
  latestTriggerId: 10,
};

const handledReview: ReviewState = {
  terminalArtifacts: [{ key: "comment:20", observedAt: "2026-08-24T10:05:00Z" }],
  requestPresent: true,
  pending: false,
  latestTriggerId: 10,
};

function observation(
  input: {
    readonly ci?: WaitObservation["ci"];
    readonly review?: ReviewState;
    readonly head?: string;
    readonly base?: string;
    readonly state?: string;
    readonly isDraft?: boolean;
    readonly mergeable?: string;
    readonly mergeStateStatus?: string;
    readonly baseRefName?: string;
  } = {},
): WaitObservation {
  return {
    pullRequest: {
      number: 87,
      url: "https://github.com/lastobelus/lastCode/pull/88",
      state: input.state ?? "OPEN",
      isDraft: input.isDraft ?? false,
      headRefOid: input.head ?? HEAD,
      baseRefOid: input.base ?? BASE,
      baseRefName: input.baseRefName ?? "lastcode/main",
      mergeable: input.mergeable ?? "MERGEABLE",
      mergeStateStatus: input.mergeStateStatus ?? "BLOCKED",
      statusCheckRollup: [],
    },
    ci: input.ci ?? "pending",
    review: input.review ?? pendingReview,
  };
}

describe("lastcode-wait-for-pr", () => {
  it("passes the checked-out branch explicitly when resolving its pull request", () => {
    expect(pullRequestViewArgs("lastobelus/lastCode", "lastcode/wait-for-pr")).toEqual([
      "pr",
      "view",
      "lastcode/wait-for-pr",
      "--repo",
      "lastobelus/lastCode",
      "--json",
      "number,url,state,isDraft,headRefOid,baseRefOid,baseRefName,mergeable,mergeStateStatus,statusCheckRollup",
    ]);
    expect(() => pullRequestViewArgs("lastobelus/lastCode", "")).toThrow(
      "requires a checked-out branch",
    );
  });

  it("keeps waiting when CI succeeds while the current-head review is pending", () => {
    const baseline = observation();
    expect(decideWaitForPr(baseline, observation({ ci: "success" }))).toEqual({
      kind: "wait",
      reason: "review-pending",
    });
  });

  it("wakes for a new clean or finding-bearing review even while CI is pending", () => {
    const baseline = observation();
    const currentReview = {
      ...handledReview,
      terminalArtifacts: [
        ...handledReview.terminalArtifacts,
        { key: "review:21", observedAt: "2026-08-24T10:06:00Z" },
      ],
    };
    expect(decideWaitForPr(baseline, observation({ review: currentReview }))).toMatchObject({
      kind: "wake",
      reason: "review-completed",
    });
  });

  it("wakes for current-head CI failure even while review is pending", () => {
    const baseline = observation();
    expect(decideWaitForPr(baseline, observation({ ci: "failure" }))).toMatchObject({
      kind: "wake",
      reason: "ci-failed",
    });
  });

  it("returns ready after CI succeeds with a previously handled review", () => {
    const baseline = observation({ review: handledReview });
    expect(
      decideWaitForPr(baseline, observation({ ci: "success", review: handledReview })),
    ).toMatchObject({ kind: "wake", reason: "ready" });
  });

  it("wakes when the exact head or base drifts", () => {
    const baseline = observation();
    expect(decideWaitForPr(baseline, observation({ head: "2".repeat(40) }))).toMatchObject({
      kind: "wake",
      reason: "head-changed",
    });
    expect(decideWaitForPr(baseline, observation({ base: "3".repeat(40) }))).toMatchObject({
      kind: "wake",
      reason: "base-changed",
    });
  });

  it("wakes for blocked mergeability without treating ordinary BLOCKED status as a conflict", () => {
    const baseline = observation();
    expect(decideWaitForPr(baseline, observation())).toEqual({
      kind: "wait",
      reason: "review-pending",
    });
    expect(decideWaitForPr(baseline, observation({ mergeable: "CONFLICTING" }))).toMatchObject({
      kind: "wake",
      reason: "merge-blocked",
    });
    expect(decideWaitForPr(baseline, observation({ mergeStateStatus: "BEHIND" }))).toMatchObject({
      kind: "wake",
      reason: "merge-blocked",
    });
  });

  it("keeps eyes pending and accepts thumbs-up on an exact-head request", () => {
    const issueComments = [
      {
        id: 10,
        user: { login: "lastobelus" },
        body: reviewRequest(),
        created_at: "2026-08-24T10:00:00Z",
      },
    ];
    const pending = deriveReviewState({
      headSha: HEAD,
      formalReviews: [],
      issueComments,
      reviewComments: [],
      latestTriggerReactions: [
        {
          id: 11,
          user: { login: "chatgpt-codex-connector[bot]" },
          content: "eyes",
          created_at: "2026-08-24T10:01:00Z",
        },
      ],
    });
    expect(pending).toMatchObject({ requestPresent: true, pending: true });

    const thumbsUp = deriveReviewState({
      headSha: HEAD,
      formalReviews: [],
      issueComments,
      reviewComments: [],
      latestTriggerReactions: [
        {
          id: 12,
          user: { login: "chatgpt-codex-connector[bot]" },
          content: "+1",
          created_at: "2026-08-24T10:00:00Z",
        },
      ],
    });
    expect(thumbsUp).toMatchObject({ requestPresent: true, pending: false });
    expect(thumbsUp.terminalArtifacts).toEqual([
      { key: "reaction:12", observedAt: "2026-08-24T10:00:00Z" },
    ]);
  });

  it("selects the newer exact-head request when GitHub timestamps tie", () => {
    const latest = latestCodexReviewTrigger(
      [
        {
          id: 10,
          user: { login: "lastobelus" },
          body: reviewRequest(),
          created_at: "2026-08-24T10:00:00Z",
        },
        {
          id: 11,
          user: { login: "lastobelus" },
          body: reviewRequest(),
          created_at: "2026-08-24T10:00:00Z",
        },
      ],
      HEAD,
    );
    expect(latest?.id).toBe(11);
  });

  it("keeps same-timestamp terminal evidence pending unless it is a matched reaction", () => {
    const review = deriveReviewState({
      headSha: HEAD,
      formalReviews: [
        {
          id: 20,
          user: { login: "chatgpt-codex-connector[bot]" },
          state: "COMMENTED",
          commit_id: HEAD,
          submitted_at: "2026-08-24T10:00:00Z",
        },
      ],
      issueComments: [
        {
          id: 21,
          user: { login: "lastobelus" },
          body: reviewRequest(),
          created_at: "2026-08-24T10:00:00Z",
        },
      ],
      reviewComments: [],
      latestTriggerReactions: [],
    });
    expect(review).toMatchObject({ requestPresent: true, pending: true });
  });

  it("accepts exact-head formal, inline, and clean-comment review artifacts", () => {
    const review = deriveReviewState({
      headSha: HEAD,
      formalReviews: [
        {
          id: 20,
          user: { login: "chatgpt-codex-connector[bot]" },
          state: "COMMENTED",
          commit_id: HEAD,
          submitted_at: "2026-08-24T10:03:00Z",
        },
      ],
      issueComments: [
        {
          id: 21,
          user: { login: "chatgpt-codex-connector[bot]" },
          body: `Codex Review: Didn't find any major issues. Surprise wording! **Reviewed commit:** \`${HEAD.slice(0, 10)}\``,
          created_at: "2026-08-24T10:04:00Z",
        },
      ],
      reviewComments: [
        {
          id: 22,
          user: { login: "chatgpt-codex-connector[bot]" },
          commit_id: HEAD,
          created_at: "2026-08-24T10:03:30Z",
        },
      ],
      latestTriggerReactions: [],
    });
    expect(review.pending).toBe(false);
    expect(review.terminalArtifacts.map(({ key }) => key)).toEqual([
      "review:20",
      "review-comment:22",
      "comment:21",
    ]);
  });

  it("leaves ambiguous Codex prose pending instead of guessing", () => {
    const review = deriveReviewState({
      headSha: HEAD,
      formalReviews: [],
      issueComments: [
        {
          id: 30,
          user: { login: "lastobelus" },
          body: reviewRequest(),
          created_at: "2026-08-24T10:00:00Z",
        },
        {
          id: 31,
          user: { login: "chatgpt-codex-connector[bot]" },
          body: "No more suggestions from me today.",
          created_at: "2026-08-24T10:05:00Z",
        },
      ],
      reviewComments: [],
      latestTriggerReactions: [],
    });
    expect(review).toMatchObject({ requestPresent: true, pending: true });
    expect(review.terminalArtifacts).toEqual([]);
  });

  it("does not treat a plain or older-head review request as current", () => {
    const review = deriveReviewState({
      headSha: HEAD,
      formalReviews: [],
      issueComments: [
        {
          id: 40,
          user: { login: "lastobelus" },
          body: "@codex review",
          created_at: "2026-08-24T10:00:00Z",
        },
        {
          id: 41,
          user: { login: "lastobelus" },
          body: reviewRequest("abcdef1234567890abcdef1234567890abcdef12"),
          created_at: "2026-08-24T10:02:00Z",
        },
      ],
      reviewComments: [],
      latestTriggerReactions: [
        {
          id: 42,
          user: { login: "chatgpt-codex-connector[bot]" },
          content: "+1",
          created_at: "2026-08-24T10:03:00Z",
        },
      ],
    });
    expect(review).toMatchObject({ requestPresent: false, pending: false });
    expect(review.latestTriggerId).toBeNull();
    expect(review.terminalArtifacts).toEqual([]);
  });

  it("classifies check runs and status contexts without accepting cancellations", () => {
    expect(classifyStatusChecks([])).toBe("pending");
    expect(
      classifyStatusChecks([{ status: "COMPLETED", conclusion: "SUCCESS" }, { state: "SUCCESS" }]),
    ).toBe("success");
    expect(
      classifyStatusChecks([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "IN_PROGRESS", conclusion: null },
      ]),
    ).toBe("pending");
    expect(
      classifyStatusChecks([
        { status: "COMPLETED", conclusion: "CANCELLED" },
        { status: "IN_PROGRESS", conclusion: null },
      ]),
    ).toBe("failure");
  });
});
