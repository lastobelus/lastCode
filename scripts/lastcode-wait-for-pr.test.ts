// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "vite-plus/test";

import {
  assertWaitStart,
  CI_REGISTRATION_TIMEOUT_MS,
  compareWaitTarget,
  decideWaitForPr,
  decideWaitTimeout,
  deriveReviewState,
  formatWaitForPrFailureSummary,
  formatWaitForPrSummary,
  latestCodexReviewTrigger,
  MERGE_RECOMPUTE_TIMEOUT_MS,
  parseWaitCommand,
  parseWaitTarget,
  pullRequestListArgs,
  pullRequestViewArgs,
  requireExactGithubCi,
  resolveWaitTarget,
  REVIEW_TIMEOUT_MS,
  requiresReadyConfirmation,
  reviewThreadsArgs,
  samePullRequestRevision,
  waitProgressKey,
  waitTimeoutClass,
  type ReviewState,
  type PullRequestState,
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
    readonly local?: null;
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
    local:
      input.local === null
        ? null
        : {
            branch: input.localBranch ?? "lastcode/wait-for-pr",
            head: input.localHead ?? HEAD,
            clean: input.clean ?? true,
          },
  };
}

const pullRequest = (
  input: Omit<Partial<PullRequestState>, "number" | "headRefName" | "baseRefName"> &
    Required<Pick<PullRequestState, "number" | "headRefName" | "baseRefName">>,
): PullRequestState => ({
  number: input.number,
  url: input.url ?? `https://github.com/lastobelus/lastCode/pull/${input.number}`,
  state: input.state ?? "OPEN",
  isDraft: input.isDraft ?? false,
  headRefName: input.headRefName,
  headRefOid: input.headRefOid ?? HEAD,
  headRepository: input.headRepository ?? { nameWithOwner: "lastobelus/lastCode" },
  isCrossRepository: input.isCrossRepository ?? false,
  baseRefName: input.baseRefName,
  baseRefOid: input.baseRefOid ?? BASE,
  mergeable: input.mergeable ?? "MERGEABLE",
  mergeStateStatus: input.mergeStateStatus ?? "CLEAN",
  potentialMergeCommit: input.potentialMergeCommit ?? { oid: MERGE },
});

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
      "number,url,state,isDraft,headRefName,headRefOid,headRepository,isCrossRepository,baseRefOid,baseRefName,mergeable,mergeStateStatus,potentialMergeCommit",
    ]);
    expect(() => pullRequestViewArgs("lastobelus/lastCode", "")).toThrow(
      "requires a pull request number or checked-out branch",
    );
    expect(pullRequestListArgs("lastobelus/lastCode", "lastcode/parent")).toContain(
      "lastcode/parent",
    );
  });

  it("accepts only the bounded target-selection commands", () => {
    expect(parseWaitCommand([])).toEqual({ kind: "wait" });
    expect(parseWaitCommand(["--target", "215"])).toEqual({
      kind: "target",
      pullRequestNumber: 215,
    });
    expect(parseWaitCommand(["--clear-target"])).toEqual({ kind: "clear-target" });
    for (const args of [
      ["--target"],
      ["--target", "0"],
      ["--target", "2.5"],
      ["--clear-target", "215"],
    ]) {
      expect(() => parseWaitCommand(args)).toThrow("Usage:");
    }
  });

  it("resolves and pins one same-repository parent chain to lastcode/main", () => {
    const parentHead = "2".repeat(40);
    const target = pullRequest({
      number: 215,
      headRefName: "lastcode/stack-child",
      baseRefName: "lastcode/stack-parent",
      headRefOid: "1".repeat(40),
      baseRefOid: parentHead,
    });
    const parent = pullRequest({
      number: 214,
      headRefName: "lastcode/stack-parent",
      baseRefName: "lastcode/main",
      headRefOid: parentHead,
      baseRefOid: "3".repeat(40),
    });
    const selection = resolveWaitTarget(
      "lastobelus/lastCode",
      215,
      () => target,
      (_repository, head) => (head === "lastcode/stack-parent" ? [parent] : []),
    );

    expect(selection).toMatchObject({
      schemaVersion: 1,
      repository: "lastobelus/lastCode",
      pullRequest: { number: 215, baseRefName: "lastcode/stack-parent" },
      parents: [{ number: 214, baseRefName: "lastcode/main" }],
    });
    expect(parseWaitTarget(JSON.stringify(selection))).toEqual(selection);
    expect(
      compareWaitTarget(selection, [target, { ...parent, baseRefName: "lastcode/renamed-main" }]),
    ).toMatchObject({ reason: "parent-drift", detail: expect.stringContaining("baseRefName") });
    expect(compareWaitTarget(selection, [target, { ...parent, isDraft: true }])).toMatchObject({
      reason: "parent-drift",
      detail: expect.stringContaining("isDraft"),
    });
  });

  it("rejects open-chain ambiguity, upstream main, cross-repository heads, and cycles", () => {
    const child = pullRequest({
      number: 215,
      headRefName: "child",
      baseRefName: "parent",
      baseRefOid: "2".repeat(40),
    });
    const parent = pullRequest({
      number: 214,
      headRefName: "parent",
      baseRefName: "lastcode/main",
      headRefOid: "2".repeat(40),
    });
    expect(() =>
      resolveWaitTarget(
        "lastobelus/lastCode",
        215,
        () => child,
        () => [],
      ),
    ).toThrow("expected exactly one");
    expect(() =>
      resolveWaitTarget(
        "lastobelus/lastCode",
        215,
        () => child,
        () => [parent, parent],
      ),
    ).toThrow("expected exactly one");
    expect(() =>
      resolveWaitTarget(
        "lastobelus/lastCode",
        215,
        () => ({ ...child, baseRefName: "main" }),
        () => [],
      ),
    ).toThrow("upstream main");
    expect(() =>
      resolveWaitTarget(
        "lastobelus/lastCode",
        215,
        () => ({ ...child, isCrossRepository: true }),
        () => [],
      ),
    ).toThrow("not a same-repository");
    expect(() =>
      resolveWaitTarget(
        "lastobelus/lastCode",
        215,
        () => child,
        () => [{ ...child, headRefName: "parent", headRefOid: "2".repeat(40) }],
      ),
    ).toThrow("cycle");
  });

  it("fails closed for malformed target state and detects ref-name drift even at the same SHA", () => {
    expect(() => parseWaitTarget("not json")).toThrow("not valid JSON");
    expect(() => parseWaitTarget(JSON.stringify({ schemaVersion: 1 }))).toThrow("malformed");

    const current = pullRequest({
      number: 215,
      headRefName: "lastcode/feature",
      baseRefName: "lastcode/main",
    });
    const selection = resolveWaitTarget(
      "lastobelus/lastCode",
      215,
      () => current,
      () => [],
    );
    expect(compareWaitTarget(selection, [current])).toBeNull();
    expect(
      compareWaitTarget(selection, [{ ...current, baseRefName: "lastcode/renamed-main" }]),
    ).toMatchObject({ reason: "target-drift", detail: expect.stringContaining("baseRefName") });
    expect(
      compareWaitTarget(selection, [{ ...current, headRefOid: "4".repeat(40) }]),
    ).toMatchObject({ reason: "target-drift", detail: expect.stringContaining("headRefOid") });
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

  it("reports stacked validation separately and requires an exact CI run for explicit targets", () => {
    const baseline = observation({
      review: handledReview,
      baseRefName: "lastcode/stack-parent",
      local: null,
    });
    expect(
      decideWaitForPr(
        baseline,
        observation({
          ci: satisfiedCi,
          review: handledReview,
          baseRefName: "lastcode/stack-parent",
          local: null,
        }),
        { expectedBase: "lastcode/stack-parent", readiness: "stacked" },
      ),
    ).toMatchObject({ kind: "wake", reason: "stacked-ready" });
    expect(requireExactGithubCi({ state: "satisfied", reason: "not-expected" })).toMatchObject({
      state: "failure",
      reason: "configuration",
    });
    expect(requireExactGithubCi(satisfiedCi)).toEqual(satisfiedCi);
    expect(() => assertWaitStart(baseline)).not.toThrow();
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

  it("treats a changed wait reason as new progress even when the observation is unchanged", () => {
    const unchangedObservation = "PR #87 head 1234567, CI pending, review pending";
    expect(waitProgressKey("mergeability-pending", unchangedObservation)).not.toBe(
      waitProgressKey("review-pending", unchangedObservation),
    );
    expect(waitProgressKey("review-pending", unchangedObservation)).toBe(
      waitProgressKey("review-pending", unchangedObservation),
    );
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
