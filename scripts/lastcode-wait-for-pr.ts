#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalTimers:off -- Read-only host-side GitHub polling.
import * as NodeChildProcess from "node:child_process";

const LASTCODE_GITHUB_REPOSITORY = process.env.LASTCODE_GITHUB_REPOSITORY ?? "lastobelus/lastCode";
const LASTCODE_BASE_BRANCH = "lastcode/main";
const CODEX_BOT_LOGIN = "chatgpt-codex-connector[bot]";
const POLL_INTERVAL_MS = 60_000;
const GH_TIMEOUT_MS = 30_000;

type PullRequestState = {
  readonly number: number;
  readonly url: string;
  readonly state: string;
  readonly isDraft: boolean;
  readonly headRefOid: string;
  readonly baseRefOid: string;
  readonly baseRefName: string;
  readonly mergeable: string;
  readonly mergeStateStatus: string;
  readonly statusCheckRollup: ReadonlyArray<StatusCheck> | null;
};

type StatusCheck = {
  readonly __typename?: string;
  readonly name?: string;
  readonly context?: string;
  readonly workflowName?: string | null;
  readonly detailsUrl?: string | null;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly state?: string;
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

export type CiState = "pending" | "success" | "failure";

export interface ReviewArtifact {
  readonly key: string;
  readonly observedAt: string;
}

export interface ReviewState {
  readonly terminalArtifacts: ReadonlyArray<ReviewArtifact>;
  readonly requestPresent: boolean;
  readonly pending: boolean;
  readonly latestTriggerId: number | null;
}

export interface WaitObservation {
  readonly pullRequest: PullRequestState;
  readonly ci: CiState;
  readonly review: ReviewState;
  readonly unresolvedReviewThreads: number;
}

export type WaitDecision =
  | { readonly kind: "wait"; readonly reason: "ci-pending" | "review-pending" }
  | {
      readonly kind: "wake";
      readonly reason:
        | "base-changed"
        | "ci-failed"
        | "head-changed"
        | "merge-blocked"
        | "pr-closed"
        | "pr-draft"
        | "ready"
        | "review-completed"
        | "review-not-requested"
        | "review-unresolved"
        | "unexpected-base";
      readonly detail: string;
    };

const successfulCheckConclusions = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

const checkProvider = (detailsUrl: string | null | undefined): string | null => {
  if (!detailsUrl) return null;
  try {
    const url = new URL(detailsUrl);
    const pathIdentity = url.pathname.split("/").filter(Boolean).slice(0, 2).join("/");
    return `${url.origin}/${pathIdentity}`;
  } catch {
    return null;
  }
};

const checkIdentity = (check: StatusCheck, index: number): string => {
  const kind = check.__typename ?? (check.context ? "StatusContext" : "CheckRun");
  const name = check.name ?? check.context;
  if (!name) return `nameless\u0000${index}`;
  if (kind === "StatusContext") return `${kind}\u0000${name}`;
  if (check.workflowName) return `${kind}\u0000${check.workflowName}\u0000${name}`;
  const provider = checkProvider(check.detailsUrl);
  return provider ? `${kind}\u0000${provider}\u0000${name}` : `${kind}\u0000${name}\u0000${index}`;
};

const checkTimestamp = (check: StatusCheck): number | null => {
  for (const value of [check.completedAt, check.startedAt]) {
    if (value) {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed) && parsed > 0) return parsed;
    }
  }
  return null;
};

const latestStatusChecks = (checks: ReadonlyArray<StatusCheck>): ReadonlyArray<StatusCheck> => {
  const newestByIdentity = new Map<
    string,
    { readonly check: StatusCheck; readonly at: number | null }
  >();
  for (const [index, check] of checks.entries()) {
    const identity = checkIdentity(check, index);
    const candidate = { check, at: checkTimestamp(check) };
    const kept = newestByIdentity.get(identity);
    if (
      kept === undefined ||
      (candidate.at === null ? kept.at === null : kept.at === null || candidate.at >= kept.at)
    ) {
      newestByIdentity.set(identity, candidate);
    }
  }
  return [...newestByIdentity.values()].map(({ check }) => check);
};

export function classifyStatusChecks(checks: PullRequestState["statusCheckRollup"]): CiState {
  if (!checks || checks.length === 0) return "pending";

  let pending = false;
  for (const check of latestStatusChecks(checks)) {
    if (check.status !== undefined) {
      if (check.status !== "COMPLETED") {
        pending = true;
        continue;
      }
      if (!check.conclusion || !successfulCheckConclusions.has(check.conclusion)) {
        return "failure";
      }
      continue;
    }

    if (check.state === "SUCCESS") continue;
    if (check.state === "PENDING" || check.state === "EXPECTED" || check.state === undefined) {
      pending = true;
      continue;
    }
    return "failure";
  }
  return pending ? "pending" : "success";
}

export function pullRequestViewArgs(repository: string, branch: string): ReadonlyArray<string> {
  if (branch.length === 0) {
    throw new Error("Wait for PR requires a checked-out branch.");
  }
  return [
    "pr",
    "view",
    branch,
    "--repo",
    repository,
    "--json",
    "number,url,state,isDraft,headRefOid,baseRefOid,baseRefName,mergeable,mergeStateStatus,statusCheckRollup",
  ];
}

const reviewThreadsQuery = `query($owner:String!,$name:String!,$number:Int!,$endCursor:String){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviewThreads(first:100,after:$endCursor){
        nodes{isResolved}
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

const reviewedCommitFromBody = (body: string | undefined): string | null => {
  if (!body?.startsWith("Codex Review:")) return null;
  return /\*\*Reviewed commit:\*\*\s*`([0-9a-f]{7,40})`/iu.exec(body)?.[1] ?? null;
};

const cleanReviewedCommitFromBody = (body: string | undefined): string | null => {
  if (!/^Codex Review: Didn['’]t find any major issues\./u.test(body ?? "")) return null;
  return reviewedCommitFromBody(body);
};

const requestedHeadFromBody = (body: string | undefined): string | null =>
  /^@codex review\s*\n<!-- lastcode-review-head: ([0-9a-f]{40}) -->\s*$/iu.exec(body ?? "")?.[1] ??
  null;

export function latestCodexReviewTrigger(
  comments: ReadonlyArray<IssueComment>,
  headSha: string,
): IssueComment | null {
  return (
    comments
      .filter(
        (comment) =>
          comment.user?.login !== CODEX_BOT_LOGIN &&
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

  for (const review of input.formalReviews) {
    const machineReadableCleanCommit = cleanReviewedCommitFromBody(review.body);
    if (
      review.user?.login === CODEX_BOT_LOGIN &&
      review.state !== "PENDING" &&
      currentHeadMatches(review.commit_id, input.headSha) &&
      (review.state === "APPROVED" || currentHeadMatches(machineReadableCleanCommit, input.headSha))
    ) {
      artifacts.push({
        key: `review:${review.id}`,
        observedAt: review.submitted_at ?? "",
      });
    }
  }

  for (const comment of input.reviewComments) {
    if (
      comment.user?.login === CODEX_BOT_LOGIN &&
      currentHeadMatches(comment.commit_id, input.headSha)
    ) {
      artifacts.push({
        key: `review-comment:${comment.id}`,
        observedAt: comment.created_at ?? "",
      });
    }
  }

  for (const comment of input.issueComments) {
    const reviewedCommit = reviewedCommitFromBody(comment.body);
    if (
      comment.user?.login === CODEX_BOT_LOGIN &&
      currentHeadMatches(reviewedCommit, input.headSha)
    ) {
      artifacts.push({
        key: `comment:${comment.id}`,
        observedAt: comment.created_at ?? "",
      });
    }
  }

  const latestTrigger = latestCodexReviewTrigger(input.issueComments, input.headSha);
  const relevantReactions = latestTrigger
    ? input.latestTriggerReactions.filter((reaction) => reaction.user?.login === CODEX_BOT_LOGIN)
    : [];

  for (const reaction of relevantReactions) {
    if (reaction.content === "+1") {
      artifacts.push({
        key: `reaction:${reaction.id}`,
        observedAt: reaction.created_at ?? "",
      });
    }
  }

  const matchedCleanReaction = relevantReactions.some(({ content }) => content === "+1");
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
    latestTriggerId: latestTrigger?.id ?? null,
  };
}

export function decideWaitForPr(baseline: WaitObservation, current: WaitObservation): WaitDecision {
  const pullRequest = current.pullRequest;
  if (pullRequest.state !== "OPEN") {
    return {
      kind: "wake",
      reason: "pr-closed",
      detail: `Pull request #${pullRequest.number} is ${pullRequest.state.toLowerCase()}.`,
    };
  }
  if (pullRequest.isDraft) {
    return {
      kind: "wake",
      reason: "pr-draft",
      detail: `Pull request #${pullRequest.number} is still a draft.`,
    };
  }
  if (pullRequest.baseRefName !== LASTCODE_BASE_BRANCH) {
    return {
      kind: "wake",
      reason: "unexpected-base",
      detail: `Pull request #${pullRequest.number} targets ${pullRequest.baseRefName}, not ${LASTCODE_BASE_BRANCH}.`,
    };
  }
  if (pullRequest.headRefOid !== baseline.pullRequest.headRefOid) {
    return {
      kind: "wake",
      reason: "head-changed",
      detail: `PR head changed from ${baseline.pullRequest.headRefOid} to ${pullRequest.headRefOid}.`,
    };
  }
  if (pullRequest.baseRefOid !== baseline.pullRequest.baseRefOid) {
    return {
      kind: "wake",
      reason: "base-changed",
      detail: `PR base changed from ${baseline.pullRequest.baseRefOid} to ${pullRequest.baseRefOid}.`,
    };
  }
  if (
    pullRequest.mergeable === "CONFLICTING" ||
    pullRequest.mergeStateStatus === "BEHIND" ||
    pullRequest.mergeStateStatus === "DIRTY"
  ) {
    return {
      kind: "wake",
      reason: "merge-blocked",
      detail: `Pull request #${pullRequest.number} needs attention (${pullRequest.mergeStateStatus}).`,
    };
  }

  const baselineArtifacts = new Set(baseline.review.terminalArtifacts.map(({ key }) => key));
  const newArtifacts = current.review.terminalArtifacts.filter(
    ({ key }) => !baselineArtifacts.has(key),
  );
  if (newArtifacts.length > 0) {
    return {
      kind: "wake",
      reason: "review-completed",
      detail: `Codex delivered ${newArtifacts.length} new current-head review artifact${newArtifacts.length === 1 ? "" : "s"}.`,
    };
  }
  if (current.ci === "failure") {
    return {
      kind: "wake",
      reason: "ci-failed",
      detail: `Current-head CI for pull request #${pullRequest.number} needs attention.`,
    };
  }
  if (!current.review.requestPresent) {
    return {
      kind: "wake",
      reason: "review-not-requested",
      detail: `No current-head Codex review request or terminal result was found for pull request #${pullRequest.number}.`,
    };
  }
  if (current.unresolvedReviewThreads > 0) {
    return {
      kind: "wake",
      reason: "review-unresolved",
      detail: `Pull request #${pullRequest.number} has ${current.unresolvedReviewThreads} unresolved review thread${current.unresolvedReviewThreads === 1 ? "" : "s"}.`,
    };
  }
  if (
    current.ci === "success" &&
    !current.review.pending &&
    baseline.review.terminalArtifacts.length > 0
  ) {
    return {
      kind: "wake",
      reason: "ready",
      detail: `GitHub CI and the handled Codex review are complete for pull request #${pullRequest.number}.`,
    };
  }
  return current.review.pending
    ? { kind: "wait", reason: "review-pending" }
    : { kind: "wait", reason: "ci-pending" };
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

function paginatedGhApi<T>(endpoint: string): ReadonlyArray<T> {
  const pages = runGhJson<ReadonlyArray<ReadonlyArray<T>>>([
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
          readonly nodes?: ReadonlyArray<{ readonly isResolved?: boolean }>;
        };
      };
    };
  };
};

function unresolvedReviewThreadCount(repository: string, pullRequestNumber: number): number {
  const pages = runGhJson<ReadonlyArray<ReviewThreadsPage>>(
    reviewThreadsArgs(repository, pullRequestNumber),
  );
  return pages.reduce(
    (count, page) =>
      count +
      (page.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []).filter(
        ({ isResolved }) => isResolved === false,
      ).length,
    0,
  );
}

function currentBranch(): string {
  const result = NodeChildProcess.spawnSync("git", ["branch", "--show-current"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GH_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Failed to resolve the current Git branch.");
  }
  const branch = result.stdout.trim();
  if (branch.length === 0) throw new Error("Wait for PR requires a checked-out branch.");
  return branch;
}

function readObservation(repository: string, branch: string): WaitObservation {
  const pullRequest = runGhJson<PullRequestState>(pullRequestViewArgs(repository, branch));
  const issueComments = paginatedGhApi<IssueComment>(
    `repos/${repository}/issues/${pullRequest.number}/comments?per_page=100`,
  );
  const latestTrigger = latestCodexReviewTrigger(issueComments, pullRequest.headRefOid);
  const latestTriggerReactions = latestTrigger
    ? paginatedGhApi<CommentReaction>(
        `repos/${repository}/issues/comments/${latestTrigger.id}/reactions?per_page=100`,
      )
    : [];
  const formalReviews = paginatedGhApi<FormalReview>(
    `repos/${repository}/pulls/${pullRequest.number}/reviews?per_page=100`,
  );
  const reviewComments = paginatedGhApi<ReviewComment>(
    `repos/${repository}/pulls/${pullRequest.number}/comments?per_page=100`,
  );
  return {
    pullRequest,
    ci: classifyStatusChecks(pullRequest.statusCheckRollup),
    unresolvedReviewThreads: unresolvedReviewThreadCount(repository, pullRequest.number),
    review: deriveReviewState({
      headSha: pullRequest.headRefOid,
      formalReviews,
      issueComments,
      reviewComments,
      latestTriggerReactions,
    }),
  };
}

const summary = (observation: WaitObservation): string =>
  JSON.stringify({
    pr: observation.pullRequest.number,
    head: observation.pullRequest.headRefOid,
    base: observation.pullRequest.baseRefOid,
    ci: observation.ci,
    review: observation.review.pending
      ? "pending"
      : observation.review.terminalArtifacts.length > 0
        ? "completed"
        : "missing",
    unresolvedReviewThreads: observation.unresolvedReviewThreads,
  });

const sleep = (durationMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

async function main(): Promise<void> {
  const branch = currentBranch();
  const baseline = readObservation(LASTCODE_GITHUB_REPOSITORY, branch);
  console.log(`[wait-for-pr] Baseline ${summary(baseline)}`);

  let previousSummary = "";
  let current = baseline;
  while (true) {
    const decision = decideWaitForPr(baseline, current);
    if (decision.kind === "wake") {
      console.log(
        `[wait-for-pr] Result ${JSON.stringify({
          reason: decision.reason,
          detail: decision.detail,
          pr: current.pullRequest.number,
          url: current.pullRequest.url,
          head: current.pullRequest.headRefOid,
          base: current.pullRequest.baseRefOid,
          ci: current.ci,
          reviewPending: current.review.pending,
          reviewArtifacts: current.review.terminalArtifacts.map(({ key }) => key),
        })}`,
      );
      return;
    }

    const currentSummary = summary(current);
    if (currentSummary !== previousSummary) {
      console.log(`[wait-for-pr] Waiting (${decision.reason}) ${currentSummary}`);
      previousSummary = currentSummary;
    }
    await sleep(POLL_INTERVAL_MS);
    current = readObservation(LASTCODE_GITHUB_REPOSITORY, branch);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`[wait-for-pr] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
