// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "vite-plus/test";
import {
  deriveReviewState,
  latestCodexReviewTrigger,
  evaluatePullRequestGates,
  resolvePullRequestTarget,
  validateReviewForMerge,
  parsePrGatesOptions,
  reviewThreadsArgs,
  samePullRequestRevision,
  type ReviewState,
  type PullRequestState,
  type GateObservation,
} from "./lastcode-pr-gates.ts";
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

const pendingCi: GateObservation["ci"] = { state: "pending", reason: "run-in-progress" };
const satisfiedCi: GateObservation["ci"] = { state: "satisfied", reason: "exact-run" };
const failedCi: GateObservation["ci"] = {
  state: "failure",
  reason: "terminal-run",
  detail: "CI failed.",
};

function observation(
  input: {
    readonly ci?: GateObservation["ci"];
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
): GateObservation {
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
            branch: input.localBranch ?? "lastcode/pr-gates",
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

describe("lastcode-pr-gates", () => {
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
      resolvePullRequestTarget(
        "lastobelus/lastCode",
        215,
        () => child,
        () => [],
      ),
    ).toThrow("expected exactly one");
    expect(() =>
      resolvePullRequestTarget(
        "lastobelus/lastCode",
        215,
        () => child,
        () => [parent, parent],
      ),
    ).toThrow("expected exactly one");
    expect(() =>
      resolvePullRequestTarget(
        "lastobelus/lastCode",
        215,
        () => ({ ...child, baseRefName: "main" }),
        () => [],
      ),
    ).toThrow("upstream main");
    expect(() =>
      resolvePullRequestTarget(
        "lastobelus/lastCode",
        215,
        () => ({ ...child, isCrossRepository: true }),
        () => [],
      ),
    ).toThrow("not a same-repository");
    expect(() =>
      resolvePullRequestTarget(
        "lastobelus/lastCode",
        215,
        () => child,
        () => [{ ...child, headRefName: "parent", headRefOid: "2".repeat(40) }],
      ),
    ).toThrow("cycle");
  });

  it("reports pending gates without waiting or losing actionable failures", () => {
    expect(evaluatePullRequestGates(observation({ ci: satisfiedCi }))).toMatchObject({
      status: "pending",
      reason: "review-pending",
    });
    expect(evaluatePullRequestGates(observation({ review: handledReview }))).toMatchObject({
      status: "pending",
      reason: "ci-pending",
    });
    expect(evaluatePullRequestGates(observation({ ci: failedCi }))).toMatchObject({
      status: "attention",
      reason: "ci-failed",
    });
    expect(evaluatePullRequestGates(observation({ unresolvedReviewThreads: 1 }))).toMatchObject({
      status: "attention",
      reason: "review-unresolved",
    });
    expect(
      evaluatePullRequestGates(observation({ ci: satisfiedCi, review: handledReview })),
    ).toMatchObject({ status: "ready" });
  });
  it("waits for an unregistered CI run only while a review reply can wake the watch", () => {
    const unregisteredCi: GateObservation["ci"] = { state: "pending", reason: "run-registration" };
    expect(evaluatePullRequestGates(observation({ ci: unregisteredCi }))).toMatchObject({
      status: "pending",
      reason: "ci-registration",
    });
    expect(
      evaluatePullRequestGates(observation({ ci: unregisteredCi, review: handledReview })),
    ).toMatchObject({
      status: "attention",
      reason: "ci-not-registered",
      detail: expect.stringContaining(`head ${HEAD} and base ${BASE}`),
    });
  });
  it("reports unknown mergeability as attention once no wake source remains", () => {
    const unregisteredCi: GateObservation["ci"] = { state: "pending", reason: "run-registration" };
    for (const unknown of [{ mergeable: "UNKNOWN" }, { mergeStateStatus: "UNKNOWN" }]) {
      expect(
        evaluatePullRequestGates(
          observation({ ci: satisfiedCi, review: handledReview, ...unknown }),
        ),
      ).toMatchObject({ status: "attention", reason: "mergeability-unknown" });
      expect(evaluatePullRequestGates(observation({ ...unknown }))).toMatchObject({
        status: "pending",
        reason: "review-pending",
      });
      expect(
        evaluatePullRequestGates(observation({ review: handledReview, ...unknown })),
      ).toMatchObject({ status: "pending", reason: "ci-pending" });
      expect(
        evaluatePullRequestGates(
          observation({ ci: unregisteredCi, review: handledReview, ...unknown }),
        ),
      ).toMatchObject({ status: "attention", reason: "ci-not-registered" });
    }
  });
  it("returns pending only while a review reply or running CI can wake the watch", () => {
    const ciStates: ReadonlyArray<GateObservation["ci"]> = [
      pendingCi,
      { state: "pending", reason: "run-registration" },
      satisfiedCi,
    ];
    for (const ci of ciStates)
      for (const review of [pendingReview, handledReview])
        for (const mergeable of ["MERGEABLE", "UNKNOWN"])
          for (const mergeStateStatus of ["CLEAN", "BLOCKED", "UNKNOWN"]) {
            const decision = evaluatePullRequestGates(
              observation({ ci, review, mergeable, mergeStateStatus }),
            );
            if (decision.status === "pending")
              expect(
                review.pending || (ci.state === "pending" && ci.reason === "run-in-progress"),
                JSON.stringify({ ci, review: review.pending, mergeable, mergeStateStatus }),
              ).toBe(true);
          }
  });
  it("rejects disabled CI, missing reviews, dirty checkout, and blocked mergeability", () => {
    expect(
      evaluatePullRequestGates(
        observation({ ci: { state: "satisfied", reason: "not-expected" }, review: handledReview }),
      ),
    ).toMatchObject({ status: "attention", reason: "ci-configuration" });
    expect(evaluatePullRequestGates(observation({ clean: false }))).toMatchObject({
      status: "attention",
      reason: "worktree-changed",
    });
    expect(evaluatePullRequestGates(observation({ localHead: BASE }))).toMatchObject({
      status: "attention",
      reason: "local-head-changed",
    });
    expect(
      evaluatePullRequestGates(
        observation({ ci: satisfiedCi, review: handledReview, mergeStateStatus: "BLOCKED" }),
      ),
    ).toMatchObject({ status: "attention", reason: "merge-blocked" });
    expect(
      evaluatePullRequestGates(
        observation({ review: { ...pendingReview, requestPresent: false } }),
      ),
    ).toMatchObject({ status: "attention", reason: "review-not-requested" });
  });
  it("distinguishes parent-relative readiness from readiness for main", () => {
    const stacked = observation({
      ci: satisfiedCi,
      review: handledReview,
      baseRefName: "lastcode/parent",
      local: null,
    });
    expect(evaluatePullRequestGates(stacked)).toMatchObject({
      status: "attention",
      reason: "unexpected-base",
    });
    expect(evaluatePullRequestGates(stacked, "lastcode/parent")).toMatchObject({
      status: "stacked-ready",
    });
  });
  it("enforces review readiness at merge time", () => {
    expect(() =>
      validateReviewForMerge({ review: handledReview, unresolvedReviewThreads: 0 }),
    ).not.toThrow();
    for (const review of [
      pendingReview,
      { ...handledReview, ready: false },
      { ...handledReview, requestPresent: false },
    ]) {
      expect(() => validateReviewForMerge({ review, unresolvedReviewThreads: 0 })).toThrow(
        "not merge-ready",
      );
    }
    expect(() =>
      validateReviewForMerge({ review: handledReview, unresolvedReviewThreads: 1 }),
    ).toThrow("not merge-ready");
  });
  it("accepts only an optional explicit PR number", () => {
    expect(parsePrGatesOptions([])).toEqual({ pullRequestNumber: null });
    expect(parsePrGatesOptions(["--pr", "302"])).toEqual({ pullRequestNumber: 302 });
    for (const args of [
      ["--target", "302"],
      ["--clear-target"],
      ["--pr", "0"],
      ["--pr", "1.5"],
      ["--pr", "9007199254740992"],
    ])
      expect(() => parsePrGatesOptions(args)).toThrow("Usage:");
  });
  it("paginates all review threads and pins the exact revision", () => {
    expect(reviewThreadsArgs("example/project", 12)).toContain("--paginate");
    expect(reviewThreadsArgs("example/project", 12)).toContain("number=12");
    expect(
      samePullRequestRevision(
        pullRequest({ number: 12, headRefName: "lastcode/topic", baseRefName: "lastcode/main" }),
        {
          ...pullRequest({
            number: 12,
            headRefName: "lastcode/topic",
            baseRefName: "lastcode/main",
          }),
          headRefOid: BASE,
        },
      ),
    ).toBe(false);
    expect(
      samePullRequestRevision(
        pullRequest({ number: 12, headRefName: "lastcode/topic", baseRefName: "lastcode/main" }),
        {
          ...pullRequest({
            number: 12,
            headRefName: "lastcode/topic",
            baseRefName: "lastcode/main",
          }),
          baseRefName: "lastcode/other",
        },
      ),
    ).toBe(false);
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

  describe("versioned Codex review receipts", () => {
    const marker = "<!-- codex-review-receipt:v1 -->";
    const cleanBody = (head = HEAD): string =>
      `Codex Review: Didn't find any major issues. :rocket:\n\n**Reviewed commit:** \`${head}\``;
    const request = {
      id: 50,
      user: { login: "maintainer" },
      author_association: "OWNER",
      body: reviewRequest(),
      created_at: "2026-08-24T10:00:00Z",
    };
    const receipt = {
      id: 51,
      user: { login: "chatgpt-codex-connector[bot]" },
      created_at: "2026-08-24T10:03:00Z",
      body: `${marker}\n\n${cleanBody()}`,
    };
    const derive = (comment = receipt, extraComments: (typeof request)[] = []) =>
      deriveReviewState({
        headSha: HEAD,
        formalReviews: [],
        issueComments: [request, comment, ...extraComments],
        reviewComments: [],
        latestTriggerReactions: [],
      });

    it.each(["\n", "\n\n", "\r\n\r\n"])(
      "accepts a current-head clean receipt with %j line endings",
      (lineEnding) => {
        for (const head of [HEAD, HEAD.slice(0, 10)]) {
          const review = derive({ ...receipt, body: `${marker}${lineEnding}${cleanBody(head)}` });
          expect(review).toMatchObject({ requestPresent: true, pending: false, ready: true });
          expect(review.terminalArtifacts).toEqual([
            { key: "comment:51", observedAt: receipt.created_at },
          ]);
        }
      },
    );

    it("ignores receipts for another head or from another author", () => {
      for (const comment of [
        { ...receipt, body: `${marker}\n\n${cleanBody(BASE)}` },
        { ...receipt, user: { login: "outsider" } },
        { ...receipt, user: { login: "another-reviewer[bot]" } },
      ]) {
        const review = derive(comment);
        expect(review).toMatchObject({ requestPresent: true, pending: true, ready: false });
        expect(review.terminalArtifacts).toEqual([]);
      }
    });

    it("rejects arbitrary, unknown-version, repeated, and malformed prefixes", () => {
      for (const prefix of [
        "Review complete:\n\n",
        "<!-- codex-review-receipt:v2 -->\n\n",
        `${marker}\n\n${marker}\n\n`,
        marker,
        ` ${marker}\n\n`,
      ]) {
        const review = derive({ ...receipt, body: `${prefix}${cleanBody()}` });
        expect(review).toMatchObject({ pending: true, ready: false });
        expect(review.terminalArtifacts).toEqual([]);
      }
    });

    it("keeps a receipt pending when a newer review was requested", () => {
      expect(
        derive(receipt, [{ ...request, id: 52, created_at: "2026-08-24T10:04:00Z" }]),
      ).toMatchObject({ pending: true });
    });

    it("requires a maintainer to handle a receipt containing a finding", () => {
      const finding = {
        ...receipt,
        body: `${marker}\n\nCodex Review: The retry can report success before completion.\n\n**Reviewed commit:** \`${HEAD}\``,
      };
      const review = derive(finding);
      expect(review).toMatchObject({ requestPresent: true, pending: false, ready: false });
      expect(review.terminalArtifacts).toEqual([
        { key: "comment:51", observedAt: receipt.created_at },
      ]);
      const handled = derive(finding, [
        {
          ...request,
          id: 52,
          body: `<!-- lastcode-review-handled: comment:51 head: ${HEAD} -->`,
          created_at: "2026-08-24T10:04:00Z",
        },
      ]);
      expect(handled).toMatchObject({ pending: false, ready: true });
      expect(
        evaluatePullRequestGates(
          observation({ ci: satisfiedCi, review: handled, unresolvedReviewThreads: 1 }),
        ),
      ).toMatchObject({ status: "attention", reason: "review-unresolved" });
    });
  });
});
