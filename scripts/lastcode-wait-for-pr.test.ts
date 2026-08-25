// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "vite-plus/test";

import {
  assertWaitStart,
  CI_REGISTRATION_TIMEOUT_MS,
  decideWaitForPr,
  decideWaitTimeout,
  deriveReviewState,
  formatWaitForPrFailureSummary,
  formatWaitForPrSummary,
  latestCodexReviewTrigger,
  MERGE_RECOMPUTE_TIMEOUT_MS,
  pullRequestViewArgs,
  REVIEW_TIMEOUT_MS,
  requiresReadyConfirmation,
  reviewThreadsArgs,
  samePullRequestRevision,
  waitTimeoutClass,
  type ReviewState,
  type WaitObservation,
} from "./lastcode-wait-for-pr.ts";

const HEAD = "1234567890abcdef1234567890abcdef12345678";
const BASE = "abcdef1234567890abcdef1234567890abcdef12";
const MERGE = "fedcba0987654321fedcba0987654321fedcba09";
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

const pendingCi: WaitObservation["ci"] = { state: "pending", reason: "run-in-progress" };
const satisfiedCi: WaitObservation["ci"] = { state: "satisfied", reason: "exact-run" };
const failedCi: WaitObservation["ci"] = {
  state: "failure",
  reason: "terminal-run",
  detail: "CI failed.",
};

function observation(
  input: {
    readonly ci?: WaitObservation["ci"];
    readonly number?: number;
    readonly review?: ReviewState;
    readonly head?: string;
    readonly base?: string;
    readonly state?: string;
    readonly isDraft?: boolean;
    readonly mergeable?: string;
    readonly mergeStateStatus?: string;
    readonly baseRefName?: string;
    readonly unresolvedReviewThreads?: number;
    readonly merge?: string | null;
    readonly localHead?: string;
    readonly localBranch?: string;
    readonly clean?: boolean;
  } = {},
): WaitObservation {
  return {
    pullRequest: {
      number: input.number ?? 87,
      url: "https://github.com/lastobelus/lastCode/pull/88",
      state: input.state ?? "OPEN",
      isDraft: input.isDraft ?? false,
      headRefOid: input.head ?? HEAD,
      baseRefOid: input.base ?? BASE,
      baseRefName: input.baseRefName ?? "lastcode/main",
      mergeable: input.mergeable ?? "MERGEABLE",
      mergeStateStatus: input.mergeStateStatus ?? "CLEAN",
      potentialMergeCommit:
        input.merge === null ? null : { oid: input.merge === undefined ? MERGE : input.merge },
    },
    ci: input.ci ?? pendingCi,
    review: input.review ?? pendingReview,
    unresolvedReviewThreads: input.unresolvedReviewThreads ?? 0,
    local: {
      branch: input.localBranch ?? "lastcode/wait-for-pr",
      head: input.localHead ?? HEAD,
      clean: input.clean ?? true,
    },
  };
}

describe("lastcode-wait-for-pr", () => {
  it("formats a concise final summary for resumable output", () => {
    const current = observation({ ci: satisfiedCi, review: handledReview });
    const decision = decideWaitForPr(observation(), current);
    expect(decision.kind).toBe("wake");
    if (decision.kind !== "wake") return;

    expect(formatWaitForPrSummary(decision, current)).toContain(
      '[wait-for-pr] Summary: {"reason":"ready"',
    );
    expect(formatWaitForPrFailureSummary(new Error("gh failed\nrequest timed out"))).toBe(
      "[wait-for-pr] Summary: failed: gh failed request timed out",
    );
  });

  it("passes the checked-out branch explicitly when resolving its pull request", () => {
    expect(pullRequestViewArgs("lastobelus/lastCode", "lastcode/wait-for-pr")).toEqual([
      "pr",
      "view",
      "lastcode/wait-for-pr",
      "--repo",
      "lastobelus/lastCode",
      "--json",
      "number,url,state,isDraft,headRefOid,baseRefOid,baseRefName,mergeable,mergeStateStatus,potentialMergeCommit",
    ]);
    expect(() => pullRequestViewArgs("lastobelus/lastCode", "")).toThrow(
      "requires a checked-out branch",
    );
  });

  it("discards observations when the exact PR revision changes during collection", () => {
    const initial = observation().pullRequest;
    expect(samePullRequestRevision(initial, observation().pullRequest)).toBe(true);
    expect(
      samePullRequestRevision(initial, observation({ head: "2".repeat(40) }).pullRequest),
    ).toBe(false);
    expect(
      samePullRequestRevision(initial, observation({ base: "3".repeat(40) }).pullRequest),
    ).toBe(false);
    expect(
      samePullRequestRevision(initial, observation({ merge: "4".repeat(40) }).pullRequest),
    ).toBe(true);
    expect(samePullRequestRevision(initial, observation({ number: 88 }).pullRequest)).toBe(false);
  });

  it("requires a matching second review snapshot before returning ready", () => {
    expect(
      requiresReadyConfirmation(
        observation({ ci: satisfiedCi, review: handledReview, unresolvedReviewThreads: 0 }),
      ),
    ).toBe(true);
    expect(requiresReadyConfirmation(observation({ review: handledReview }))).toBe(false);
    expect(
      requiresReadyConfirmation(
        observation({ ci: satisfiedCi, review: handledReview, unresolvedReviewThreads: 1 }),
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
    expect(decideWaitForPr(baseline, observation({ ci: satisfiedCi }))).toEqual({
      kind: "wait",
      reason: "review-pending",
    });
  });

  it("keeps a new clean review asleep while CI is pending", () => {
    const baseline = observation();
    const currentReview = {
      ...handledReview,
      terminalArtifacts: [
        ...handledReview.terminalArtifacts,
        { key: "review:21", observedAt: "2026-08-24T10:06:00Z" },
      ],
    };
    expect(decideWaitForPr(baseline, observation({ review: currentReview }))).toEqual({
      kind: "wait",
      reason: "ci-pending",
    });
  });

  it("wakes for current-head CI failure even while review is pending", () => {
    const baseline = observation();
    expect(decideWaitForPr(baseline, observation({ ci: failedCi }))).toMatchObject({
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
      decideWaitForPr(baseline, observation({ ci: satisfiedCi, review: handledReview })),
    ).toMatchObject({ kind: "wake", reason: "ready" });
  });

  it("waits for definitive mergeability before reporting ready", () => {
    const baseline = observation({ review: handledReview });
    expect(
      decideWaitForPr(
        baseline,
        observation({ ci: satisfiedCi, review: handledReview, mergeable: "UNKNOWN" }),
      ),
    ).toEqual({ kind: "wait", reason: "mergeability-pending" });
    expect(
      decideWaitForPr(
        baseline,
        observation({ ci: satisfiedCi, review: handledReview, mergeStateStatus: "UNKNOWN" }),
      ),
    ).toEqual({ kind: "wait", reason: "mergeability-pending" });
  });

  it("wakes when the exact head or base drifts without treating regenerated merge SHAs as drift", () => {
    const baseline = observation();
    expect(decideWaitForPr(baseline, observation({ head: "2".repeat(40) }))).toMatchObject({
      kind: "wake",
      reason: "head-changed",
    });
    expect(decideWaitForPr(baseline, observation({ base: "3".repeat(40) }))).toMatchObject({
      kind: "wake",
      reason: "base-changed",
    });
    expect(decideWaitForPr(baseline, observation({ merge: "4".repeat(40) }))).toEqual({
      kind: "wait",
      reason: "review-pending",
    });
  });

  it("wakes when the checked-out branch resolves to a different pull request", () => {
    expect(decideWaitForPr(observation(), observation({ number: 88 }))).toMatchObject({
      kind: "wake",
      reason: "pr-changed",
    });
  });

  it("rejects dirty or mismatched local state at launch and wakes for later drift", () => {
    expect(() => assertWaitStart(observation())).not.toThrow();
    expect(() => assertWaitStart(observation({ clean: false }))).toThrow("clean worktree");
    expect(() => assertWaitStart(observation({ localHead: "5".repeat(40) }))).toThrow(
      "does not match PR head",
    );

    const baseline = observation();
    expect(decideWaitForPr(baseline, observation({ clean: false }))).toMatchObject({
      kind: "wake",
      reason: "worktree-changed",
    });
    expect(decideWaitForPr(baseline, observation({ localHead: "5".repeat(40) }))).toMatchObject({
      kind: "wake",
      reason: "local-head-changed",
    });
  });

  it("bounds only registration, merge recomputation, and review pending waits", () => {
    expect(waitTimeoutClass("mergeability-pending")).toBe("merge-recompute");
    expect(waitTimeoutClass("ci-registration")).toBe("ci-registration");
    expect(waitTimeoutClass("review-pending")).toBe("review");
    expect(waitTimeoutClass("ci-pending")).toBeNull();
    expect(decideWaitTimeout("ci-registration", CI_REGISTRATION_TIMEOUT_MS - 1)).toBeNull();
    expect(decideWaitTimeout("ci-registration", CI_REGISTRATION_TIMEOUT_MS)).toMatchObject({
      kind: "wake",
      reason: "ci-registration-timeout",
    });
    expect(decideWaitTimeout("mergeability-pending", MERGE_RECOMPUTE_TIMEOUT_MS)).toMatchObject({
      kind: "wake",
      reason: "merge-recompute-timeout",
    });
    expect(decideWaitTimeout("review-pending", REVIEW_TIMEOUT_MS)).toMatchObject({
      kind: "wake",
      reason: "review-timeout",
    });
    expect(decideWaitTimeout("ci-pending", REVIEW_TIMEOUT_MS * 10)).toBeNull();
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
          ci: satisfiedCi,
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

  it("records a bodyless changes-requested verdict as an unhandled artifact", () => {
    const review = deriveReviewState({
      headSha: HEAD,
      formalReviews: [
        {
          id: 28,
          user: { login: "chatgpt-codex-connector[bot]" },
          state: "CHANGES_REQUESTED",
          commit_id: HEAD,
          submitted_at: "2026-08-24T10:03:00Z",
          body: "",
        },
      ],
      issueComments: [
        {
          id: 29,
          user: { login: "lastobelus" },
          author_association: "OWNER",
          body: reviewRequest(),
          created_at: "2026-08-24T10:00:00Z",
        },
      ],
      reviewComments: [],
      latestTriggerReactions: [],
    });
    expect(review).toMatchObject({ requestPresent: true, pending: false, ready: false });
    expect(review.terminalArtifacts).toEqual([
      { key: "review:28", observedAt: "2026-08-24T10:03:00Z" },
    ]);
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
    expect(decideWaitForPr(baseline, observation({ ci: satisfiedCi, review }))).toMatchObject({
      kind: "wake",
      reason: "review-unhandled",
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
        observation({ ci: satisfiedCi, review: handled }),
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

  it("distinguishes GitHub registration, execution, and configuration states", () => {
    const baseline = observation({ review: handledReview });
    expect(
      decideWaitForPr(
        baseline,
        observation({
          review: handledReview,
          ci: { state: "pending", reason: "run-registration" },
        }),
      ),
    ).toEqual({ kind: "wait", reason: "ci-registration" });
    expect(
      decideWaitForPr(
        baseline,
        observation({
          review: handledReview,
          ci: { state: "pending", reason: "run-in-progress" },
        }),
      ),
    ).toEqual({ kind: "wait", reason: "ci-pending" });
    expect(
      decideWaitForPr(
        baseline,
        observation({
          review: handledReview,
          ci: { state: "failure", reason: "configuration", detail: "CI is disabled." },
        }),
      ),
    ).toMatchObject({ kind: "wake", reason: "ci-configuration" });
  });
});
