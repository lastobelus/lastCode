#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off -- Bounded host-side GitHub reads.
import * as NodeChildProcess from "node:child_process";

import { type GithubCiEvidence, type RunGithubJson, readGithubCi } from "./lastcode-github-ci.ts";

const LASTCODE_GITHUB_REPOSITORY = process.env.LASTCODE_GITHUB_REPOSITORY ?? "lastobelus/lastCode";
const LASTCODE_BASE_BRANCH = "lastcode/main";
const CODEX_BOT_LOGIN = "chatgpt-codex-connector[bot]";
const TRUSTED_AUTHOR_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const GH_TIMEOUT_MS = 30_000;

type GithubRepository = {
  readonly nameWithOwner?: string;
};

export type PullRequestState = {
  readonly number: number;
  readonly url: string;
  readonly state: string;
  readonly isDraft: boolean;
  readonly headRefName?: string;
  readonly headRefOid: string;
  readonly headRepository?: GithubRepository | null;
  readonly isCrossRepository?: boolean;
  readonly baseRefOid: string;
  readonly baseRefName: string;
  readonly mergeable: string;
  readonly mergeStateStatus: string;
  readonly potentialMergeCommit?: { readonly oid?: string } | null;
};

type GitHubActor = {
  readonly login?: string;
};

type FormalReview = {
  readonly id: number;
  readonly user?: GitHubActor;
  readonly body?: string;
  readonly state?: string;
  readonly commit_id?: string | null;
  readonly submitted_at?: string | null;
};

type IssueComment = {
  readonly id: number;
  readonly user?: GitHubActor;
  readonly author_association?: string;
  readonly body?: string;
  readonly created_at?: string;
};

type ReviewComment = {
  readonly id: number;
  readonly user?: GitHubActor;
  readonly commit_id?: string | null;
  readonly created_at?: string;
};

type CommentReaction = {
  readonly id: number;
  readonly user?: GitHubActor;
  readonly content?: string;
  readonly created_at?: string;
};

export interface ReviewArtifact {
  readonly key: string;
  readonly observedAt: string;
}

export interface ReviewState {
  readonly terminalArtifacts: ReadonlyArray<ReviewArtifact>;
  readonly requestPresent: boolean;
  readonly pending: boolean;
  readonly ready: boolean;
  readonly latestTriggerId: number | null;
}

export interface GateObservation {
  readonly pullRequest: PullRequestState;
  readonly ci: GithubCiEvidence;
  readonly review: ReviewState;
  readonly unresolvedReviewThreads: number;
  readonly local: LocalState | null;
}

export interface PinnedPullRequestIdentity {
  readonly number: number;
  readonly url: string;
  readonly state: "OPEN";
  readonly isDraft: boolean;
  readonly headRepository: string;
  readonly headRefName: string;
  readonly headRefOid: string;
  readonly baseRepository: string;
  readonly baseRefName: string;
  readonly baseRefOid: string;
}

export interface PullRequestTarget {
  readonly repository: string;
  readonly pullRequest: PinnedPullRequestIdentity;
  readonly parents: ReadonlyArray<PinnedPullRequestIdentity>;
}

export interface LocalState {
  readonly branch: string;
  readonly head: string;
  readonly clean: boolean;
}

const pullRequestJsonFields =
  "number,url,state,isDraft,headRefName,headRefOid,headRepository,isCrossRepository,baseRefOid,baseRefName,mergeable,mergeStateStatus,potentialMergeCommit";

export function pullRequestViewArgs(
  repository: string,
  target: string | number,
): ReadonlyArray<string> {
  if (String(target).length === 0) {
    throw new Error("PR gates require a pull request number or checked-out branch.");
  }
  return ["pr", "view", String(target), "--repo", repository, "--json", pullRequestJsonFields];
}

export function pullRequestListArgs(repository: string, headBranch: string): ReadonlyArray<string> {
  return [
    "pr",
    "list",
    "--repo",
    repository,
    "--state",
    "open",
    "--head",
    headBranch,
    "--limit",
    "100",
    "--json",
    pullRequestJsonFields,
  ];
}

export function samePullRequestRevision(
  initial: Pick<
    PullRequestState,
    "number" | "headRefName" | "headRefOid" | "baseRefName" | "baseRefOid"
  >,
  final: Pick<
    PullRequestState,
    "number" | "headRefName" | "headRefOid" | "baseRefName" | "baseRefOid"
  >,
): boolean {
  return (
    initial.number === final.number &&
    initial.headRefName === final.headRefName &&
    initial.headRefOid === final.headRefOid &&
    initial.baseRefName === final.baseRefName &&
    initial.baseRefOid === final.baseRefOid
  );
}

const reviewThreadsQuery = `query($owner:String!,$name:String!,$number:Int!,$endCursor:String){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviewThreads(first:100,after:$endCursor){
        nodes{id isResolved}
        pageInfo{hasNextPage endCursor}
      }
    }
  }
}`;

export function reviewThreadsArgs(
  repository: string,
  pullRequestNumber: number,
): ReadonlyArray<string> {
  const [owner, name, ...rest] = repository.split("/");
  if (!owner || !name || rest.length > 0)
    throw new Error(`Invalid GitHub repository: ${repository}`);
  return [
    "api",
    "graphql",
    "--paginate",
    "--slurp",
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`,
    "-F",
    `number=${pullRequestNumber}`,
    "-f",
    `query=${reviewThreadsQuery}`,
  ];
}

const timestamp = (value: string | null | undefined): number => {
  const parsed = value === null || value === undefined ? Number.NaN : Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const currentHeadMatches = (candidate: string | null | undefined, headSha: string): boolean =>
  typeof candidate === "string" && candidate.length >= 7 && headSha.startsWith(candidate);

const normalizedCodexReviewBody = (body: string | undefined): string =>
  (body ?? "").replace(/^<!-- codex-review-receipt:v1 -->(?:\r?\n)+/u, "");

const reviewedCommitFromBody = (body: string | undefined): string | null => {
  const normalizedBody = normalizedCodexReviewBody(body);
  if (!normalizedBody.startsWith("Codex Review:")) return null;
  return /\*\*Reviewed commit:\*\*\s*`([0-9a-f]{7,40})`/iu.exec(normalizedBody)?.[1] ?? null;
};

const cleanReviewedCommitFromBody = (body: string | undefined): string | null => {
  if (!/^Codex Review: Didn['’]t find any major issues\./u.test(normalizedCodexReviewBody(body)))
    return null;
  return reviewedCommitFromBody(body);
};

const isGenericFormalReviewWrapper = (body: string | undefined): boolean =>
  (body ?? "").includes("### 💡 Codex Review") &&
  (body ?? "").includes("Here are some automated review suggestions for this pull request.");

const requestedHeadFromBody = (body: string | undefined): string | null =>
  /^@codex review\s*\n<!-- lastcode-review-head: ([0-9a-f]{40}) -->\s*$/iu.exec(body ?? "")?.[1] ??
  null;

const handledArtifactFromBody = (body: string | undefined, headSha: string): string | null => {
  const match =
    /^<!-- lastcode-review-handled: ((?:comment|review):\d+) head: ([0-9a-f]{40}) -->$/iu.exec(
      body ?? "",
    );
  return match?.[2] === headSha ? (match[1] ?? null) : null;
};

export function latestCodexReviewTrigger(
  comments: ReadonlyArray<IssueComment>,
  headSha: string,
): IssueComment | null {
  return (
    comments
      .filter(
        (comment) =>
          comment.user?.login !== CODEX_BOT_LOGIN &&
          TRUSTED_AUTHOR_ASSOCIATIONS.has(comment.author_association ?? "") &&
          currentHeadMatches(requestedHeadFromBody(comment.body), headSha),
      )
      .sort(
        (left, right) =>
          timestamp(right.created_at) - timestamp(left.created_at) || right.id - left.id,
      )[0] ?? null
  );
}

export function deriveReviewState(input: {
  readonly headSha: string;
  readonly formalReviews: ReadonlyArray<FormalReview>;
  readonly issueComments: ReadonlyArray<IssueComment>;
  readonly reviewComments: ReadonlyArray<ReviewComment>;
  readonly latestTriggerReactions: ReadonlyArray<CommentReaction>;
}): ReviewState {
  const artifacts: ReviewArtifact[] = [];
  const readyArtifacts = new Set<string>();

  for (const review of input.formalReviews) {
    const machineReadableCleanCommit = cleanReviewedCommitFromBody(review.body);
    const isClean =
      review.state === "APPROVED" || currentHeadMatches(machineReadableCleanCommit, input.headSha);
    const isFindingVerdict = review.state === "CHANGES_REQUESTED";
    if (
      review.user?.login === CODEX_BOT_LOGIN &&
      review.state !== "PENDING" &&
      currentHeadMatches(review.commit_id, input.headSha) &&
      (isClean ||
        isFindingVerdict ||
        (Boolean(review.body?.trim()) && !isGenericFormalReviewWrapper(review.body)))
    ) {
      const key = `review:${review.id}`;
      artifacts.push({
        key,
        observedAt: review.submitted_at ?? "",
      });
      if (isClean) readyArtifacts.add(key);
    }
  }

  for (const comment of input.reviewComments) {
    if (
      comment.user?.login === CODEX_BOT_LOGIN &&
      currentHeadMatches(comment.commit_id, input.headSha)
    ) {
      const key = `review-comment:${comment.id}`;
      artifacts.push({
        key,
        observedAt: comment.created_at ?? "",
      });
      readyArtifacts.add(key);
    }
  }

  for (const comment of input.issueComments) {
    const reviewedCommit = reviewedCommitFromBody(comment.body);
    if (
      comment.user?.login === CODEX_BOT_LOGIN &&
      currentHeadMatches(reviewedCommit, input.headSha)
    ) {
      const key = `comment:${comment.id}`;
      artifacts.push({
        key,
        observedAt: comment.created_at ?? "",
      });
      if (currentHeadMatches(cleanReviewedCommitFromBody(comment.body), input.headSha)) {
        readyArtifacts.add(key);
      }
    }
  }

  const latestTrigger = latestCodexReviewTrigger(input.issueComments, input.headSha);
  const relevantReactions = latestTrigger
    ? input.latestTriggerReactions.filter((reaction) => reaction.user?.login === CODEX_BOT_LOGIN)
    : [];

  for (const reaction of relevantReactions) {
    if (reaction.content === "+1") {
      const key = `reaction:${reaction.id}`;
      artifacts.push({
        key,
        observedAt: reaction.created_at ?? "",
      });
      readyArtifacts.add(key);
    }
  }

  const artifactKeys = new Set(artifacts.map(({ key }) => key));
  for (const comment of input.issueComments) {
    if (!TRUSTED_AUTHOR_ASSOCIATIONS.has(comment.author_association ?? "")) continue;
    const handledArtifact = handledArtifactFromBody(comment.body, input.headSha);
    if (handledArtifact && artifactKeys.has(handledArtifact)) readyArtifacts.add(handledArtifact);
  }

  const newestReaction = (content: string): CommentReaction | null =>
    relevantReactions
      .filter((reaction) => reaction.content === content)
      .sort(
        (left, right) =>
          timestamp(right.created_at) - timestamp(left.created_at) || right.id - left.id,
      )[0] ?? null;
  const latestCleanReaction = newestReaction("+1");
  const latestEyesReaction = newestReaction("eyes");
  const matchedCleanReaction =
    latestCleanReaction !== null &&
    (latestEyesReaction === null ||
      timestamp(latestCleanReaction.created_at) > timestamp(latestEyesReaction.created_at) ||
      (timestamp(latestCleanReaction.created_at) === timestamp(latestEyesReaction.created_at) &&
        latestCleanReaction.id >= latestEyesReaction.id));
  const latestTerminalAt = Math.max(0, ...artifacts.map(({ observedAt }) => timestamp(observedAt)));
  const latestPendingAt = Math.max(
    timestamp(latestTrigger?.created_at),
    ...relevantReactions
      .filter(({ content }) => content === "eyes")
      .map(({ created_at }) => timestamp(created_at)),
  );
  const requestPresent = latestTrigger !== null || artifacts.length > 0;

  return {
    terminalArtifacts: artifacts,
    requestPresent,
    pending: requestPresent && !matchedCleanReaction && latestTerminalAt <= latestPendingAt,
    ready: artifacts.length > 0 && artifacts.every(({ key }) => readyArtifacts.has(key)),
    latestTriggerId: latestTrigger?.id ?? null,
  };
}

function runGhJson<T>(args: ReadonlyArray<string>): T {
  const result = NodeChildProcess.spawnSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GH_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `gh ${args.join(" ")} failed.`);
  }
  return JSON.parse(result.stdout) as T;
}

type ReadPullRequestByNumber = (repository: string, pullRequestNumber: number) => PullRequestState;
type ListPullRequestsByHead = (
  repository: string,
  headBranch: string,
) => ReadonlyArray<PullRequestState>;

const sameRepository = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

function pinnedPullRequest(
  repository: string,
  pullRequest: PullRequestState,
): PinnedPullRequestIdentity {
  if (pullRequest.state !== "OPEN") {
    throw new Error(
      `Pull request #${pullRequest.number} is ${pullRequest.state.toLowerCase()}, not open.`,
    );
  }
  const headRepository = pullRequest.headRepository?.nameWithOwner;
  if (!headRepository || !pullRequest.headRefName || pullRequest.isCrossRepository === undefined) {
    throw new Error(`Pull request #${pullRequest.number} is missing repository or ref identity.`);
  }
  if (pullRequest.isCrossRepository || !sameRepository(headRepository, repository)) {
    throw new Error(`Pull request #${pullRequest.number} is not a same-repository pull request.`);
  }
  if (
    !Number.isSafeInteger(pullRequest.number) ||
    pullRequest.number <= 0 ||
    !pullRequest.url.startsWith("https://") ||
    !/^[0-9a-f]{40}$/u.test(pullRequest.headRefOid) ||
    !/^[0-9a-f]{40}$/u.test(pullRequest.baseRefOid) ||
    pullRequest.headRefName.length === 0 ||
    pullRequest.baseRefName.length === 0
  ) {
    throw new Error(`Pull request #${pullRequest.number} has malformed identity fields.`);
  }
  return {
    number: pullRequest.number,
    url: pullRequest.url,
    state: "OPEN",
    isDraft: pullRequest.isDraft,
    headRepository,
    headRefName: pullRequest.headRefName,
    headRefOid: pullRequest.headRefOid,
    baseRepository: repository,
    baseRefName: pullRequest.baseRefName,
    baseRefOid: pullRequest.baseRefOid,
  };
}

export function resolvePullRequestTarget(
  repository: string,
  pullRequestNumber: number,
  readPullRequest: ReadPullRequestByNumber,
  listPullRequests: ListPullRequestsByHead,
): PullRequestTarget {
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber <= 0) {
    throw new Error("--pr requires a positive pull request number.");
  }
  const pullRequest = pinnedPullRequest(repository, readPullRequest(repository, pullRequestNumber));
  const parents: PinnedPullRequestIdentity[] = [];
  const seenNumbers = new Set([pullRequest.number]);
  let child = pullRequest;
  while (child.baseRefName !== LASTCODE_BASE_BRANCH) {
    if (child.baseRefName === "main") {
      throw new Error(
        `Pull request #${child.number} targets upstream main; the chain must end at ${LASTCODE_BASE_BRANCH}.`,
      );
    }
    const candidates = listPullRequests(repository, child.baseRefName).filter(
      (candidate) =>
        candidate.state === "OPEN" &&
        candidate.headRefName === child.baseRefName &&
        sameRepository(candidate.headRepository?.nameWithOwner ?? "", repository),
    );
    if (candidates.length !== 1) {
      throw new Error(
        `Base branch ${child.baseRefName} for pull request #${child.number} resolves to ${candidates.length} open same-repository parent pull requests; expected exactly one.`,
      );
    }
    const parent = pinnedPullRequest(repository, candidates[0]!);
    if (seenNumbers.has(parent.number)) {
      throw new Error(`Pull request chain contains a cycle at #${parent.number}.`);
    }
    if (child.baseRefOid !== parent.headRefOid) {
      throw new Error(
        `Pull request #${child.number} pins ${child.baseRefName}@${child.baseRefOid}, but parent #${parent.number} is at ${parent.headRefOid}.`,
      );
    }
    seenNumbers.add(parent.number);
    parents.push(parent);
    child = parent;
  }
  return { repository, pullRequest, parents };
}

function paginatedGhApi<T>(endpoint: string, execute: RunGithubJson): ReadonlyArray<T> {
  const pages = execute<ReadonlyArray<ReadonlyArray<T>>>([
    "api",
    "--paginate",
    "--slurp",
    endpoint,
  ]);
  return pages.flat();
}

type ReviewThreadsPage = {
  readonly data?: {
    readonly repository?: {
      readonly pullRequest?: {
        readonly reviewThreads?: {
          readonly nodes?: ReadonlyArray<{ readonly id?: string; readonly isResolved?: boolean }>;
        };
      };
    };
  };
};

function reviewThreadsSnapshot(
  repository: string,
  pullRequestNumber: number,
  execute: RunGithubJson,
): { readonly unresolvedCount: number; readonly fingerprint: string } {
  const pages = execute<ReadonlyArray<ReviewThreadsPage>>(
    reviewThreadsArgs(repository, pullRequestNumber),
  );
  return {
    unresolvedCount: pages.reduce(
      (count, page) =>
        count +
        (page.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []).filter(
          ({ isResolved }) => isResolved === false,
        ).length,
      0,
    ),
    fingerprint: JSON.stringify(pages),
  };
}

function runGitText(args: ReadonlyArray<string>, cwd = process.cwd()): string {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GH_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed.`);
  }
  return result.stdout.trim();
}

function currentBranch(): string {
  const branch = runGitText(["branch", "--show-current"]);
  if (branch.length === 0) throw new Error("PR gates require a checked-out branch.");
  return branch;
}

function readLocalState(): LocalState {
  return {
    branch: currentBranch(),
    head: runGitText(["rev-parse", "HEAD"]),
    clean: runGitText(["status", "--porcelain=v1", "--untracked-files=all"]).length === 0,
  };
}

export type ReviewDataSnapshot = {
  readonly review: ReviewState;
  readonly unresolvedReviewThreads: number;
  readonly fingerprint: string;
};

export function readReviewData(
  repository: string,
  pullRequest: Pick<PullRequestState, "number" | "headRefOid">,
  execute: RunGithubJson = runGhJson,
): ReviewDataSnapshot {
  const issueComments = paginatedGhApi<IssueComment>(
    `repos/${repository}/issues/${pullRequest.number}/comments?per_page=100`,
    execute,
  );
  const latestTrigger = latestCodexReviewTrigger(issueComments, pullRequest.headRefOid);
  const latestTriggerReactions = latestTrigger
    ? paginatedGhApi<CommentReaction>(
        `repos/${repository}/issues/comments/${latestTrigger.id}/reactions?per_page=100`,
        execute,
      )
    : [];
  const formalReviews = paginatedGhApi<FormalReview>(
    `repos/${repository}/pulls/${pullRequest.number}/reviews?per_page=100`,
    execute,
  );
  const reviewComments = paginatedGhApi<ReviewComment>(
    `repos/${repository}/pulls/${pullRequest.number}/comments?per_page=100`,
    execute,
  );
  const reviewThreads = reviewThreadsSnapshot(repository, pullRequest.number, execute);
  return {
    review: deriveReviewState({
      headSha: pullRequest.headRefOid,
      formalReviews,
      issueComments,
      reviewComments,
      latestTriggerReactions,
    }),
    unresolvedReviewThreads: reviewThreads.unresolvedCount,
    fingerprint: JSON.stringify({
      issueComments,
      latestTriggerReactions,
      formalReviews,
      reviewComments,
      reviewThreads: reviewThreads.fingerprint,
    }),
  };
}

export type GateDecision = {
  readonly status: "ready" | "stacked-ready" | "pending" | "attention";
  readonly reason: string;
  readonly detail: string;
};

export function evaluatePullRequestGates(
  current: GateObservation,
  expectedBase = LASTCODE_BASE_BRANCH,
): GateDecision {
  const pr = current.pullRequest;
  const attention = (reason: string, detail: string): GateDecision => ({
    status: "attention",
    reason,
    detail,
  });
  const pending = (reason: string): GateDecision => ({ status: "pending", reason, detail: reason });
  if (current.local && !current.local.clean)
    return attention("worktree-changed", "The worktree is dirty.");
  if (current.local && current.local.head !== pr.headRefOid)
    return attention("local-head-changed", "Local HEAD does not match the PR head.");
  if (pr.state !== "OPEN")
    return attention("pr-closed", `Pull request #${pr.number} is ${pr.state.toLowerCase()}.`);
  if (pr.isDraft) return attention("pr-draft", `Pull request #${pr.number} is still a draft.`);
  if (pr.baseRefName !== expectedBase)
    return attention(
      "unexpected-base",
      `Pull request #${pr.number} targets ${pr.baseRefName}, not ${expectedBase}.`,
    );
  if (
    pr.mergeable === "CONFLICTING" ||
    pr.mergeStateStatus === "BEHIND" ||
    pr.mergeStateStatus === "DIRTY"
  )
    return attention(
      "merge-blocked",
      `Pull request #${pr.number} needs attention (${pr.mergeStateStatus}).`,
    );
  if (current.ci.state === "failure")
    return attention(
      current.ci.reason === "configuration" ? "ci-configuration" : "ci-failed",
      current.ci.detail,
    );
  if (current.ci.state === "satisfied" && current.ci.reason !== "exact-run")
    return attention("ci-configuration", "An exact successful GitHub CI run is required.");
  if (!current.review.requestPresent)
    return attention(
      "review-not-requested",
      "No current-head Codex review request or terminal result was found.",
    );
  if (current.unresolvedReviewThreads > 0)
    return attention(
      "review-unresolved",
      `Pull request #${pr.number} has ${current.unresolvedReviewThreads} unresolved review threads.`,
    );
  if (!current.review.pending && !current.review.ready)
    return attention("review-unhandled", "The current-head Codex review has an unhandled finding.");
  if (current.ci.state === "satisfied" && !current.review.pending && current.review.ready) {
    // The native watch does not wake when GitHub finishes computing mergeability, so unknown
    // mergeability cannot be pending once CI and review are complete.
    if (pr.mergeable === "UNKNOWN" || pr.mergeStateStatus === "UNKNOWN")
      return attention(
        "mergeability-unknown",
        `GitHub has not computed mergeability for pull request #${pr.number}; CI and review are complete. Rerun the check once, then report the blocker if it persists.`,
      );
    if (pr.mergeStateStatus === "BLOCKED")
      return attention("merge-blocked", "A repository merge requirement remains unsatisfied.");
    const status = expectedBase === LASTCODE_BASE_BRANCH ? "ready" : "stacked-ready";
    return {
      status,
      reason: status,
      detail: "Exact GitHub CI and the handled current-head Codex review are complete.",
    };
  }
  if (current.ci.state === "pending" && current.ci.reason === "run-registration") {
    // The native watch wakes for finished checks and new remarks, never for a run that does not
    // exist. Waiting is safe only while Codex's reply to a pending review forces another check.
    if (current.review.pending) return pending("ci-registration");
    return attention(
      "ci-not-registered",
      `No exact GitHub CI run has registered for head ${pr.headRefOid} and base ${pr.baseRefOid}. A base change without a push starts no run; otherwise check the workflow trigger and Actions configuration.`,
    );
  }
  return pending(current.review.pending ? "review-pending" : "ci-pending");
}

export function validateReviewForMerge(
  snapshot: Pick<ReviewDataSnapshot, "review" | "unresolvedReviewThreads">,
): void {
  if (
    !snapshot.review.requestPresent ||
    snapshot.review.pending ||
    !snapshot.review.ready ||
    snapshot.unresolvedReviewThreads !== 0
  ) {
    throw new Error(
      "Codex review is not merge-ready: require a terminal handled current-head review and zero unresolved threads.",
    );
  }
}

export function requireExactGithubCi(ci: GithubCiEvidence): GithubCiEvidence {
  return ci.state === "satisfied" && ci.reason === "not-expected"
    ? {
        state: "failure",
        reason: "configuration",
        detail: "An exact successful GitHub CI run is required; the workflow is disabled.",
      }
    : ci;
}

const terminalReady = (observation: GateObservation) =>
  observation.ci.state === "satisfied" &&
  !observation.review.pending &&
  observation.review.ready &&
  observation.unresolvedReviewThreads === 0;

export function readPullRequestGates(
  repository: string,
  target: string | number,
  trackLocalState: boolean,
  execute: RunGithubJson = runGhJson,
) {
  const read = () => execute<PullRequestState>(pullRequestViewArgs(repository, target));
  const chain = (pr: PullRequestState) =>
    resolvePullRequestTarget(
      repository,
      pr.number,
      (_repository, number) =>
        number === pr.number
          ? pr
          : execute<PullRequestState>(pullRequestViewArgs(repository, number)),
      (_repository, branch) =>
        execute<ReadonlyArray<PullRequestState>>(pullRequestListArgs(repository, branch)),
    );
  const local = trackLocalState ? readLocalState() : null;
  const initial = read();
  const selected = chain(initial);
  const reviewData = readReviewData(repository, initial, execute);
  const ci = requireExactGithubCi(readGithubCi(repository, initial, execute));
  const confirmed = read();
  const confirmedChain = chain(confirmed);
  const confirmedLocal = trackLocalState ? readLocalState() : null;
  const assertStable = (
    left: PullRequestState,
    right: PullRequestState,
    leftChain: PullRequestTarget,
    rightChain: PullRequestTarget,
    leftLocal: LocalState | null,
    rightLocal: LocalState | null,
  ) => {
    if (
      !samePullRequestRevision(left, right) ||
      JSON.stringify(leftChain) !== JSON.stringify(rightChain) ||
      JSON.stringify(leftLocal) !== JSON.stringify(rightLocal)
    ) {
      throw new Error("The PR, parent chain, or checkout changed during the gate check.");
    }
  };
  assertStable(initial, confirmed, selected, confirmedChain, local, confirmedLocal);
  let observation: GateObservation = {
    pullRequest: confirmed,
    ci,
    review: reviewData.review,
    unresolvedReviewThreads: reviewData.unresolvedReviewThreads,
    local: confirmedLocal,
  };
  if (terminalReady(observation)) {
    const finalReview = readReviewData(repository, confirmed, execute);
    const finalCi = requireExactGithubCi(readGithubCi(repository, confirmed, execute));
    const final = read();
    const finalChain = chain(final);
    const finalLocal = trackLocalState ? readLocalState() : null;
    assertStable(confirmed, final, confirmedChain, finalChain, confirmedLocal, finalLocal);
    if (reviewData.fingerprint !== finalReview.fingerprint)
      throw new Error("Review evidence changed during the gate check.");
    observation = {
      pullRequest: final,
      ci: finalCi,
      review: finalReview.review,
      unresolvedReviewThreads: finalReview.unresolvedReviewThreads,
      local: finalLocal,
    };
  }
  const decision = evaluatePullRequestGates(observation, selected.pullRequest.baseRefName);
  return {
    ...decision,
    repository,
    pr: observation.pullRequest.number,
    url: observation.pullRequest.url,
    head: observation.pullRequest.headRefOid,
    base: { name: observation.pullRequest.baseRefName, sha: observation.pullRequest.baseRefOid },
    ci: observation.ci,
    reviewPending: observation.review.pending,
    reviewReady: observation.review.ready,
    reviewArtifacts: observation.review.terminalArtifacts.map(({ key }) => key),
    unresolvedReviewThreads: observation.unresolvedReviewThreads,
    parents: selected.parents,
  };
}

export function parsePrGatesOptions(args: ReadonlyArray<string>): {
  readonly pullRequestNumber: number | null;
} {
  if (args.length === 0) return { pullRequestNumber: null };
  if (
    args.length === 2 &&
    args[0] === "--pr" &&
    /^[1-9][0-9]*$/u.test(args[1] ?? "") &&
    Number.isSafeInteger(Number(args[1]))
  )
    return { pullRequestNumber: Number(args[1]) };
  throw new Error("Usage: pnpm lastcode:pr-gates [--pr PR_NUMBER]");
}

if (import.meta.main) {
  try {
    const { pullRequestNumber } = parsePrGatesOptions(process.argv.slice(2));
    const result = readPullRequestGates(
      LASTCODE_GITHUB_REPOSITORY,
      pullRequestNumber ?? currentBranch(),
      pullRequestNumber === null,
    );
    console.log(JSON.stringify(result));
    if (result.status === "attention") process.exitCode = 1;
  } catch (error) {
    console.log(
      JSON.stringify({
        status: "attention",
        reason: "observation-failed",
        detail: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  }
}
