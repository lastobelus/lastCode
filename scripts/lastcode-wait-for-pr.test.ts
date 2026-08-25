// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "vite-plus/test";

import {
  classifyStatusChecks,
  decideWaitForPr,
  deriveReviewState,
  latestCodexReviewTrigger,
  pullRequestViewArgs,
  requiresReadyConfirmation,
  reviewThreadsArgs,
  samePullRequestRevision,
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
  ready: false,
  latestTriggerId: 10,
};

const handledReview: ReviewState = {
  terminalArtifacts: [{ key: "comment:20", observedAt: "2026-08-24T10:05:00Z" }],
  requestPresent: true,
  pending: false,
  ready: true,
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
    readonly unresolvedReviewThreads?: number;
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
      mergeStateStatus: input.mergeStateStatus ?? "CLEAN",
      statusCheckRollup: [],
    },
    ci: input.ci ?? "pending",
    review: input.review ?? pendingReview,
    unresolvedReviewThreads: input.unresolvedReviewThreads ?? 0,
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

  it("discards review observations when the head or base changes during collection", () => {
    const initial = observation().pullRequest;
    expect(samePullRequestRevision(initial, observation().pullRequest)).toBe(true);
    expect(
      samePullRequestRevision(initial, observation({ head: "2".repeat(40) }).pullRequest),
    ).toBe(false);
    expect(
      samePullRequestRevision(initial, observation({ base: "3".repeat(40) }).pullRequest),
    ).toBe(false);
  });

  it("requires a matching second review snapshot before returning ready", () => {
    expect(
      requiresReadyConfirmation(
        observation({ ci: "success", review: handledReview, unresolvedReviewThreads: 0 }),
      ),
    ).toBe(true);
    expect(requiresReadyConfirmation(observation({ review: handledReview }))).toBe(false);
    expect(
      requiresReadyConfirmation(
        observation({ ci: "success", review: handledReview, unresolvedReviewThreads: 1 }),
      ),
    ).toBe(false);
  });

  it("paginates review threads for the exact pull request", () => {
    const args = reviewThreadsArgs("lastobelus/lastCode", 88);
    expect(args).toContain("--paginate");
    expect(args).toContain("owner=lastobelus");
    expect(args).toContain("name=lastCode");
    expect(args).toContain("number=88");
    expect(args.at(-1)).toContain("reviewThreads(first:100,after:$endCursor)");
    expect(() => reviewThreadsArgs("invalid", 88)).toThrow("Invalid GitHub repository");
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

  it("wakes for an existing unresolved review thread even while CI is pending", () => {
    const handled = observation({ review: handledReview });
    expect(
      decideWaitForPr(handled, observation({ review: handledReview, unresolvedReviewThreads: 2 })),
    ).toMatchObject({ kind: "wake", reason: "review-unresolved" });
  });

  it("returns ready after CI succeeds with a previously handled review", () => {
    const baseline = observation({ review: handledReview });
    expect(
      decideWaitForPr(baseline, observation({ ci: "success", review: handledReview })),
    ).toMatchObject({ kind: "wake", reason: "ready" });
  });

  it("waits for definitive mergeability before reporting ready", () => {
    const baseline = observation({ review: handledReview });
    expect(
      decideWaitForPr(
        baseline,
        observation({ ci: "success", review: handledReview, mergeable: "UNKNOWN" }),
      ),
    ).toEqual({ kind: "wait", reason: "mergeability-pending" });
    expect(
      decideWaitForPr(
        baseline,
        observation({ ci: "success", review: handledReview, mergeStateStatus: "UNKNOWN" }),
      ),
    ).toEqual({ kind: "wait", reason: "mergeability-pending" });
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
    const baseline = observation({ mergeStateStatus: "BLOCKED" });
    expect(decideWaitForPr(baseline, observation({ mergeStateStatus: "BLOCKED" }))).toEqual({
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
    expect(
      decideWaitForPr(
        observation({ review: handledReview, mergeStateStatus: "BLOCKED" }),
        observation({
          ci: "success",
          review: handledReview,
          mergeStateStatus: "BLOCKED",
        }),
      ),
    ).toMatchObject({ kind: "wake", reason: "merge-blocked" });
  });

  it("keeps eyes pending and accepts thumbs-up on an exact-head request", () => {
    const issueComments = [
      {
        id: 10,
        user: { login: "lastobelus" },
        author_association: "OWNER",
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
    expect(thumbsUp).toMatchObject({ requestPresent: true, pending: false, ready: true });
    expect(thumbsUp.terminalArtifacts).toEqual([
      { key: "reaction:12", observedAt: "2026-08-24T10:00:00Z" },
    ]);

    const restarted = deriveReviewState({
      headSha: HEAD,
      formalReviews: [],
      issueComments,
      reviewComments: [],
      latestTriggerReactions: [
        {
          id: 12,
          user: { login: "chatgpt-codex-connector[bot]" },
          content: "+1",
          created_at: "2026-08-24T10:01:00Z",
        },
        {
          id: 13,
          user: { login: "chatgpt-codex-connector[bot]" },
          content: "eyes",
          created_at: "2026-08-24T10:01:00Z",
        },
      ],
    });
    expect(restarted).toMatchObject({ requestPresent: true, pending: true });
  });

  it("selects the newer exact-head request when GitHub timestamps tie", () => {
    const latest = latestCodexReviewTrigger(
      [
        {
          id: 10,
          user: { login: "lastobelus" },
          author_association: "OWNER",
          body: reviewRequest(),
          created_at: "2026-08-24T10:00:00Z",
        },
        {
          id: 11,
          user: { login: "lastobelus" },
          author_association: "OWNER",
          body: reviewRequest(),
          created_at: "2026-08-24T10:00:00Z",
        },
      ],
      HEAD,
    );
    expect(latest?.id).toBe(11);
  });

  it("ignores exact-head review triggers from untrusted commenters", () => {
    const latest = latestCodexReviewTrigger(
      [
        {
          id: 10,
          user: { login: "lastobelus" },
          author_association: "OWNER",
          body: reviewRequest(),
          created_at: "2026-08-24T10:00:00Z",
        },
        {
          id: 11,
          user: { login: "outsider" },
          author_association: "CONTRIBUTOR",
          body: reviewRequest(),
          created_at: "2026-08-24T10:05:00Z",
        },
      ],
      HEAD,
    );
    expect(latest?.id).toBe(10);
  });

  it("keeps same-timestamp terminal evidence pending unless it is a matched reaction", () => {
    const review = deriveReviewState({
      headSha: HEAD,
      formalReviews: [
        {
          id: 20,
          user: { login: "chatgpt-codex-connector[bot]" },
          state: "APPROVED",
          commit_id: HEAD,
          submitted_at: "2026-08-24T10:00:00Z",
        },
      ],
      issueComments: [
        {
          id: 21,
          user: { login: "lastobelus" },
          author_association: "OWNER",
          body: reviewRequest(),
          created_at: "2026-08-24T10:00:00Z",
        },
      ],
      reviewComments: [],
      latestTriggerReactions: [],
    });
    expect(review).toMatchObject({ requestPresent: true, pending: true });
  });

  it("does not treat a generic formal review wrapper as clean", () => {
    const review = deriveReviewState({
      headSha: HEAD,
      formalReviews: [
        {
          id: 23,
          user: { login: "chatgpt-codex-connector[bot]" },
          state: "COMMENTED",
          commit_id: HEAD,
          submitted_at: "2026-08-24T10:03:00Z",
          body: `### 💡 Codex Review\n\nHere are some automated review suggestions for this pull request.\n\n**Reviewed commit:** \`${HEAD.slice(0, 10)}\``,
        },
      ],
      issueComments: [
        {
          id: 24,
          user: { login: "lastobelus" },
          author_association: "OWNER",
          body: reviewRequest(),
          created_at: "2026-08-24T10:00:00Z",
        },
      ],
      reviewComments: [],
      latestTriggerReactions: [],
    });
    expect(review).toMatchObject({ requestPresent: true, pending: true });
    expect(review.terminalArtifacts).toEqual([]);
  });

  it("records a body-only formal finding until a maintainer handles it", () => {
    const formalReviews = [
      {
        id: 25,
        user: { login: "chatgpt-codex-connector[bot]" },
        state: "COMMENTED",
        commit_id: HEAD,
        submitted_at: "2026-08-24T10:03:00Z",
        body: "The retry path can report success before the replacement run finishes.",
      },
    ];
    const issueComments = [
      {
        id: 26,
        user: { login: "lastobelus" },
        author_association: "OWNER",
        body: reviewRequest(),
        created_at: "2026-08-24T10:00:00Z",
      },
    ];
    const finding = deriveReviewState({
      headSha: HEAD,
      formalReviews,
      issueComments,
      reviewComments: [],
      latestTriggerReactions: [],
    });
    expect(finding).toMatchObject({ pending: false, ready: false });
    expect(finding.terminalArtifacts).toEqual([
      { key: "review:25", observedAt: "2026-08-24T10:03:00Z" },
    ]);

    const handled = deriveReviewState({
      headSha: HEAD,
      formalReviews,
      issueComments: [
        ...issueComments,
        {
          id: 27,
          user: { login: "lastobelus" },
          author_association: "OWNER",
          body: `<!-- lastcode-review-handled: review:25 head: ${HEAD} -->`,
          created_at: "2026-08-24T10:04:00Z",
        },
      ],
      reviewComments: [],
      latestTriggerReactions: [],
    });
    expect(handled).toMatchObject({ pending: false, ready: true });
  });

  it("accepts exact-head formal, inline, and typographic clean-comment artifacts", () => {
    const review = deriveReviewState({
      headSha: HEAD,
      formalReviews: [
        {
          id: 20,
          user: { login: "chatgpt-codex-connector[bot]" },
          state: "APPROVED",
          commit_id: HEAD,
          submitted_at: "2026-08-24T10:03:00Z",
        },
      ],
      issueComments: [
        {
          id: 21,
          user: { login: "chatgpt-codex-connector[bot]" },
          body: `Codex Review: Didn’t find any major issues. Surprise wording! **Reviewed commit:** \`${HEAD.slice(0, 10)}\``,
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
    expect(review).toMatchObject({ pending: false, ready: true });
    expect(review.terminalArtifacts.map(({ key }) => key)).toEqual([
      "review:20",
      "review-comment:22",
      "comment:21",
    ]);
  });

  it("wakes for a current-head top-level finding without treating it as prehandled", () => {
    const issueComments = [
      {
        id: 30,
        user: { login: "lastobelus" },
        author_association: "OWNER",
        body: reviewRequest(),
        created_at: "2026-08-24T10:00:00Z",
      },
      {
        id: 31,
        user: { login: "chatgpt-codex-connector[bot]" },
        body: `Codex Review: I found something worth addressing. **Reviewed commit:** \`${HEAD.slice(0, 10)}\``,
        created_at: "2026-08-24T10:05:00Z",
      },
    ];
    const review = deriveReviewState({
      headSha: HEAD,
      formalReviews: [],
      issueComments,
      reviewComments: [],
      latestTriggerReactions: [],
    });
    expect(review).toMatchObject({ requestPresent: true, pending: false, ready: false });
    expect(review.terminalArtifacts).toEqual([
      { key: "comment:31", observedAt: "2026-08-24T10:05:00Z" },
    ]);

    const baseline = observation();
    expect(decideWaitForPr(baseline, observation({ ci: "success", review }))).toMatchObject({
      kind: "wake",
      reason: "review-completed",
    });

    expect(decideWaitForPr(observation({ review }), observation({ review }))).toMatchObject({
      kind: "wake",
      reason: "review-unhandled",
    });

    const handled = deriveReviewState({
      headSha: HEAD,
      formalReviews: [],
      issueComments: [
        ...issueComments,
        {
          id: 32,
          user: { login: "lastobelus" },
          author_association: "OWNER",
          body: `<!-- lastcode-review-handled: comment:31 head: ${HEAD} -->`,
          created_at: "2026-08-24T10:06:00Z",
        },
      ],
      reviewComments: [],
      latestTriggerReactions: [],
    });
    expect(handled).toMatchObject({ pending: false, ready: true });
    expect(
      decideWaitForPr(
        observation({ review: handled }),
        observation({ ci: "success", review: handled }),
      ),
    ).toMatchObject({ kind: "wake", reason: "ready" });

    const partlyHandled = deriveReviewState({
      headSha: HEAD,
      formalReviews: [],
      issueComments: [
        ...issueComments,
        {
          id: 32,
          user: { login: "lastobelus" },
          author_association: "OWNER",
          body: `<!-- lastcode-review-handled: comment:31 head: ${HEAD} -->`,
          created_at: "2026-08-24T10:06:00Z",
        },
        {
          id: 33,
          user: { login: "chatgpt-codex-connector[bot]" },
          body: `Codex Review: Another finding. **Reviewed commit:** \`${HEAD.slice(0, 10)}\``,
          created_at: "2026-08-24T10:07:00Z",
        },
      ],
      reviewComments: [],
      latestTriggerReactions: [],
    });
    expect(partlyHandled).toMatchObject({ pending: false, ready: false });

    const outsiderMarker = deriveReviewState({
      headSha: HEAD,
      formalReviews: [],
      issueComments: [
        ...issueComments,
        {
          id: 32,
          user: { login: "untrusted-contributor" },
          author_association: "CONTRIBUTOR",
          body: `<!-- lastcode-review-handled: comment:31 head: ${HEAD} -->`,
          created_at: "2026-08-24T10:06:00Z",
        },
      ],
      reviewComments: [],
      latestTriggerReactions: [],
    });
    expect(outsiderMarker).toMatchObject({ pending: false, ready: false });
  });

  it("does not treat a plain or older-head review request as current", () => {
    const review = deriveReviewState({
      headSha: HEAD,
      formalReviews: [],
      issueComments: [
        {
          id: 40,
          user: { login: "lastobelus" },
          author_association: "OWNER",
          body: "@codex review",
          created_at: "2026-08-24T10:00:00Z",
        },
        {
          id: 41,
          user: { login: "lastobelus" },
          author_association: "OWNER",
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

  it("classifies only the newest run when a failed check is rerun", () => {
    expect(
      classifyStatusChecks([
        {
          name: "build",
          workflowName: "CI",
          status: "COMPLETED",
          conclusion: "FAILURE",
          startedAt: "2026-08-24T10:00:00Z",
          completedAt: "2026-08-24T10:01:00Z",
        },
        {
          name: "build",
          workflowName: "CI",
          status: "IN_PROGRESS",
          conclusion: null,
          startedAt: "2026-08-24T10:02:00Z",
          completedAt: "0001-01-01T00:00:00Z",
        },
      ]),
    ).toBe("pending");
  });

  it("keeps same-named checks from distinct kinds and providers", () => {
    expect(
      classifyStatusChecks([
        {
          __typename: "StatusContext",
          context: "build",
          state: "FAILURE",
        },
        {
          __typename: "CheckRun",
          name: "build",
          status: "COMPLETED",
          conclusion: "SUCCESS",
          startedAt: "2026-08-24T10:00:00Z",
        },
      ]),
    ).toBe("failure");
    expect(
      classifyStatusChecks([
        {
          __typename: "CheckRun",
          name: "verify",
          detailsUrl: "https://checks.example-a.com/runs/1",
          status: "COMPLETED",
          conclusion: "FAILURE",
        },
        {
          __typename: "CheckRun",
          name: "verify",
          detailsUrl: "https://checks.example-b.com/runs/2",
          status: "COMPLETED",
          conclusion: "SUCCESS",
        },
      ]),
    ).toBe("failure");
  });
});
