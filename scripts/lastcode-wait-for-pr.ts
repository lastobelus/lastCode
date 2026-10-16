#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off -- Read-only host-side GitHub polling.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { type GithubCiEvidence, readGithubCi } from "./lastcode-github-ci.ts";
import { lastCodeAction } from "./lib/lastcode-action-kit.ts";

const LASTCODE_GITHUB_REPOSITORY = process.env.LASTCODE_GITHUB_REPOSITORY ?? "lastobelus/lastCode";
const LASTCODE_BASE_BRANCH = "lastcode/main";
const CODEX_BOT_LOGIN = "chatgpt-codex-connector[bot]";
const TRUSTED_AUTHOR_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const POLL_INTERVAL_MS = 60_000;
const GH_TIMEOUT_MS = 30_000;
const TARGET_STATE_VERSION = 1;
const TARGET_STATE_GIT_PATH = "lastcode/wait-for-pr-target.json";
export const CI_REGISTRATION_TIMEOUT_MS = 10 * 60_000;
export const MERGE_RECOMPUTE_TIMEOUT_MS = 10 * 60_000;
export const REVIEW_TIMEOUT_MS = 30 * 60_000;

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

export interface WaitObservation {
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

export interface WaitTargetSnapshot {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly pullRequest: PinnedPullRequestIdentity;
  readonly parents: ReadonlyArray<PinnedPullRequestIdentity>;
}

export interface TargetDrift {
  readonly reason: "target-drift" | "parent-drift";
  readonly detail: string;
}

export interface LocalState {
  readonly branch: string;
  readonly head: string;
  readonly clean: boolean;
}

export type WaitDecision =
  | {
      readonly kind: "wait";
      readonly reason: "ci-pending" | "ci-registration" | "mergeability-pending" | "review-pending";
    }
  | {
      readonly kind: "wake";
      readonly reason:
        | "base-changed"
        | "ci-configuration"
        | "ci-failed"
        | "ci-registration-timeout"
        | "head-changed"
        | "local-head-changed"
        | "merge-blocked"
        | "merge-recompute-timeout"
        | "pr-changed"
        | "pr-closed"
        | "pr-draft"
        | "ready"
        | "review-not-requested"
        | "review-timeout"
        | "review-unhandled"
        | "review-unresolved"
        | "stacked-ready"
        | "target-drift"
        | "parent-drift"
        | "unexpected-base"
        | "worktree-changed";
      readonly detail: string;
    };

const pullRequestJsonFields =
  "number,url,state,isDraft,headRefName,headRefOid,headRepository,isCrossRepository,baseRefOid,baseRefName,mergeable,mergeStateStatus,potentialMergeCommit";

export function pullRequestViewArgs(
  repository: string,
  target: string | number,
): ReadonlyArray<string> {
  if (String(target).length === 0) {
    throw new Error("Wait for PR requires a pull request number or checked-out branch.");
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

const reviewedCommitFromBody = (body: string | undefined): string | null => {
  if (!body?.startsWith("Codex Review:")) return null;
  return /\*\*Reviewed commit:\*\*\s*`([0-9a-f]{7,40})`/iu.exec(body)?.[1] ?? null;
};

const cleanReviewedCommitFromBody = (body: string | undefined): string | null => {
  if (!/^Codex Review: Didn['’]t find any major issues\./u.test(body ?? "")) return null;
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

export function decideWaitForPr(
  baseline: WaitObservation,
  current: WaitObservation,
  options: {
    readonly expectedBase?: string;
    readonly readiness?: "canonical" | "stacked";
  } = {},
): WaitDecision {
  const pullRequest = current.pullRequest;
  if (current.local && !current.local.clean) {
    return {
      kind: "wake",
      reason: "worktree-changed",
      detail: "The worktree became dirty while waiting for pull request gates.",
    };
  }
  if (
    current.local &&
    baseline.local &&
    (current.local.branch !== baseline.local.branch || current.local.head !== baseline.local.head)
  ) {
    return {
      kind: "wake",
      reason: "local-head-changed",
      detail: `Local revision changed from ${baseline.local?.branch}@${baseline.local?.head} to ${current.local?.branch}@${current.local?.head}.`,
    };
  }
  if (pullRequest.number !== baseline.pullRequest.number) {
    return {
      kind: "wake",
      reason: "pr-changed",
      detail: `Checked-out branch now resolves to pull request #${pullRequest.number}, not #${baseline.pullRequest.number}.`,
    };
  }
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
  const expectedBase = options.expectedBase ?? LASTCODE_BASE_BRANCH;
  if (pullRequest.baseRefName !== expectedBase) {
    return {
      kind: "wake",
      reason: "unexpected-base",
      detail: `Pull request #${pullRequest.number} targets ${pullRequest.baseRefName}, not ${expectedBase}.`,
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

  if (current.ci.state === "failure") {
    return {
      kind: "wake",
      reason: current.ci.reason === "configuration" ? "ci-configuration" : "ci-failed",
      detail: current.ci.detail,
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
  if (!current.review.pending && !current.review.ready) {
    return {
      kind: "wake",
      reason: "review-unhandled",
      detail: `Pull request #${pullRequest.number} has an unhandled top-level Codex finding.`,
    };
  }
  if (pullRequest.mergeable === "UNKNOWN" || pullRequest.mergeStateStatus === "UNKNOWN") {
    return { kind: "wait", reason: "mergeability-pending" };
  }
  if (
    current.ci.state === "satisfied" &&
    !current.review.pending &&
    current.review.ready &&
    pullRequest.mergeStateStatus === "BLOCKED"
  ) {
    return {
      kind: "wake",
      reason: "merge-blocked",
      detail: `Pull request #${pullRequest.number} is blocked by a repository merge requirement.`,
    };
  }
  if (current.ci.state === "satisfied" && !current.review.pending && current.review.ready) {
    if (options.readiness === "stacked") {
      return {
        kind: "wake",
        reason: "stacked-ready",
        detail: `Exact GitHub CI and the handled Codex review are complete for stacked pull request #${pullRequest.number}; its pinned parent chain is unchanged.`,
      };
    }
    return {
      kind: "wake",
      reason: "ready",
      detail: `GitHub CI and the handled Codex review are complete for pull request #${pullRequest.number}.`,
    };
  }
  if (current.ci.state === "pending" && current.ci.reason === "run-registration") {
    return { kind: "wait", reason: "ci-registration" };
  }
  if (current.review.pending) return { kind: "wait", reason: "review-pending" };
  return { kind: "wait", reason: "ci-pending" };
}

export function decideWaitTimeout(
  reason: Extract<WaitDecision, { readonly kind: "wait" }>["reason"],
  elapsedMs: number,
): WaitDecision | null {
  if (reason === "ci-registration" && elapsedMs >= CI_REGISTRATION_TIMEOUT_MS) {
    return {
      kind: "wake",
      reason: "ci-registration-timeout",
      detail: `Expected GitHub CI did not register within ${CI_REGISTRATION_TIMEOUT_MS / 60_000} minutes.`,
    };
  }
  if (reason === "mergeability-pending" && elapsedMs >= MERGE_RECOMPUTE_TIMEOUT_MS) {
    return {
      kind: "wake",
      reason: "merge-recompute-timeout",
      detail: `GitHub did not establish the PR merge revision within ${MERGE_RECOMPUTE_TIMEOUT_MS / 60_000} minutes.`,
    };
  }
  if (reason === "review-pending" && elapsedMs >= REVIEW_TIMEOUT_MS) {
    return {
      kind: "wake",
      reason: "review-timeout",
      detail: `Codex review remained pending for ${REVIEW_TIMEOUT_MS / 60_000} minutes.`,
    };
  }
  return null;
}

export function waitTimeoutClass(
  reason: Extract<WaitDecision, { readonly kind: "wait" }>["reason"],
): "ci-registration" | "merge-recompute" | "review" | null {
  if (reason === "ci-registration") return "ci-registration";
  if (reason === "mergeability-pending") {
    return "merge-recompute";
  }
  if (reason === "review-pending") return "review";
  return null;
}

export function waitProgressKey(
  reason: Extract<WaitDecision, { readonly kind: "wait" }>["reason"],
  observationSummary: string,
): string {
  return `${reason}\u0000${observationSummary}`;
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

export function resolveWaitTarget(
  repository: string,
  pullRequestNumber: number,
  readPullRequest: ReadPullRequestByNumber,
  listPullRequests: ListPullRequestsByHead,
): WaitTargetSnapshot {
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber <= 0) {
    throw new Error("--target requires a positive pull request number.");
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
  return { schemaVersion: TARGET_STATE_VERSION, repository, pullRequest, parents };
}

const identityFields = [
  "number",
  "url",
  "state",
  "isDraft",
  "headRepository",
  "headRefName",
  "headRefOid",
  "baseRepository",
  "baseRefName",
  "baseRefOid",
] as const;

function isPinnedPullRequest(value: unknown): value is PinnedPullRequestIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(record.number) &&
    Number(record.number) > 0 &&
    record.state === "OPEN" &&
    typeof record.isDraft === "boolean" &&
    identityFields
      .filter((field) => field !== "number" && field !== "state" && field !== "isDraft")
      .every((field) => typeof record[field] === "string" && record[field].length > 0) &&
    /^[0-9a-f]{40}$/u.test(String(record.headRefOid)) &&
    /^[0-9a-f]{40}$/u.test(String(record.baseRefOid))
  );
}

export function parseWaitTarget(contents: string): WaitTargetSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error("Wait for PR target file is not valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Wait for PR target file is malformed.");
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== TARGET_STATE_VERSION ||
    typeof record.repository !== "string" ||
    !/^[^/]+\/[^/]+$/u.test(record.repository) ||
    !isPinnedPullRequest(record.pullRequest) ||
    !Array.isArray(record.parents) ||
    !record.parents.every(isPinnedPullRequest)
  ) {
    throw new Error("Wait for PR target file is malformed.");
  }
  const target = value as WaitTargetSnapshot;
  const chain = [target.pullRequest, ...target.parents];
  const numbers = new Set<number>();
  const repositoriesMatch = chain.every(
    (pullRequest) =>
      sameRepository(pullRequest.headRepository, target.repository) &&
      sameRepository(pullRequest.baseRepository, target.repository),
  );
  const chainMatches = chain.every((pullRequest, index) => {
    if (numbers.has(pullRequest.number)) return false;
    numbers.add(pullRequest.number);
    const parent = chain[index + 1];
    return parent
      ? pullRequest.baseRefName === parent.headRefName &&
          pullRequest.baseRefOid === parent.headRefOid
      : pullRequest.baseRefName === LASTCODE_BASE_BRANCH;
  });
  if (!repositoriesMatch || !chainMatches) {
    throw new Error("Wait for PR target file has an invalid pull request chain.");
  }
  return target;
}

function waitTargetPath(cwd = process.cwd()): string {
  const path = runGitText(["rev-parse", "--git-path", TARGET_STATE_GIT_PATH], cwd);
  return NodePath.isAbsolute(path) ? path : NodePath.resolve(cwd, path);
}

export function loadWaitTarget(cwd = process.cwd()): WaitTargetSnapshot | null {
  const path = waitTargetPath(cwd);
  try {
    return parseWaitTarget(NodeFS.readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function writeWaitTarget(target: WaitTargetSnapshot, cwd = process.cwd()): string {
  const path = waitTargetPath(cwd);
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  try {
    NodeFS.writeFileSync(temporaryPath, `${JSON.stringify(target, null, 2)}\n`, { mode: 0o600 });
    NodeFS.renameSync(temporaryPath, path);
  } finally {
    NodeFS.rmSync(temporaryPath, { force: true });
  }
  return path;
}

export function clearWaitTarget(cwd = process.cwd()): string {
  const path = waitTargetPath(cwd);
  NodeFS.rmSync(path, { force: true });
  return path;
}

const differingIdentityField = (
  pinned: PinnedPullRequestIdentity,
  current: PinnedPullRequestIdentity,
): (typeof identityFields)[number] | null =>
  identityFields.find((field) => pinned[field] !== current[field]) ?? null;

export function compareWaitTarget(
  target: WaitTargetSnapshot,
  currentPullRequests: ReadonlyArray<PullRequestState>,
): TargetDrift | null {
  const pinned = [target.pullRequest, ...target.parents];
  if (currentPullRequests.length !== pinned.length) {
    throw new Error("Wait for PR target comparison received the wrong chain length.");
  }
  for (const [index, expected] of pinned.entries()) {
    let current: PinnedPullRequestIdentity;
    try {
      current = pinnedPullRequest(target.repository, currentPullRequests[index]!);
    } catch (error) {
      return {
        reason: index === 0 ? "target-drift" : "parent-drift",
        detail: `Pinned pull request #${expected.number} is stale: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const field = differingIdentityField(expected, current);
    if (field) {
      return {
        reason: index === 0 ? "target-drift" : "parent-drift",
        detail: `Pinned pull request #${expected.number} changed ${field} from ${expected[field]} to ${current[field]}.`,
      };
    }
  }
  return null;
}

function prepareWaitTarget(repository: string, pullRequestNumber: number): WaitTargetSnapshot {
  return resolveWaitTarget(
    repository,
    pullRequestNumber,
    (targetRepository, number) =>
      runGhJson<PullRequestState>(pullRequestViewArgs(targetRepository, number)),
    (targetRepository, headBranch) =>
      runGhJson<ReadonlyArray<PullRequestState>>(pullRequestListArgs(targetRepository, headBranch)),
  );
}

function readTargetDrift(target: WaitTargetSnapshot): TargetDrift | null {
  return compareWaitTarget(
    target,
    [target.pullRequest, ...target.parents].map(({ number }) =>
      runGhJson<PullRequestState>(pullRequestViewArgs(target.repository, number)),
    ),
  );
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
          readonly nodes?: ReadonlyArray<{ readonly id?: string; readonly isResolved?: boolean }>;
        };
      };
    };
  };
};

function reviewThreadsSnapshot(
  repository: string,
  pullRequestNumber: number,
): { readonly unresolvedCount: number; readonly fingerprint: string } {
  const pages = runGhJson<ReadonlyArray<ReviewThreadsPage>>(
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
  if (branch.length === 0) throw new Error("Wait for PR requires a checked-out branch.");
  return branch;
}

function readLocalState(): LocalState {
  return {
    branch: currentBranch(),
    head: runGitText(["rev-parse", "HEAD"]),
    clean: runGitText(["status", "--porcelain=v1", "--untracked-files=all"]).length === 0,
  };
}

const sameLocalState = (left: LocalState, right: LocalState): boolean =>
  left.branch === right.branch && left.head === right.head && left.clean === right.clean;

export function assertWaitStart(observation: WaitObservation): void {
  if (!observation.local) return;
  if (!observation.local.clean) throw new Error("Wait for PR requires a clean worktree.");
  if (observation.local.head !== observation.pullRequest.headRefOid) {
    throw new Error(
      `Local HEAD ${observation.local.head} does not match PR head ${observation.pullRequest.headRefOid}.`,
    );
  }
}

type ReviewDataSnapshot = {
  readonly review: ReviewState;
  readonly unresolvedReviewThreads: number;
  readonly fingerprint: string;
};

function readReviewData(repository: string, pullRequest: PullRequestState): ReviewDataSnapshot {
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
  const reviewThreads = reviewThreadsSnapshot(repository, pullRequest.number);
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

export function requiresReadyConfirmation(observation: WaitObservation): boolean {
  return (
    observation.ci.state === "satisfied" &&
    !observation.review.pending &&
    observation.review.ready &&
    observation.unresolvedReviewThreads === 0
  );
}

const observationFrom = (
  pullRequest: PullRequestState,
  reviewData: ReviewDataSnapshot,
  ci: GithubCiEvidence,
  local: LocalState | null,
): WaitObservation => ({
  pullRequest,
  ci,
  review: reviewData.review,
  unresolvedReviewThreads: reviewData.unresolvedReviewThreads,
  local,
});

export function requireExactGithubCi(ci: GithubCiEvidence): GithubCiEvidence {
  return ci.state === "satisfied" && ci.reason === "not-expected"
    ? {
        state: "failure",
        reason: "configuration",
        detail:
          "An explicit Wait for PR target requires an exact successful GitHub CI run; the workflow is disabled.",
      }
    : ci;
}

function readObservation(
  repository: string,
  target: string | number,
  trackLocalState: boolean,
  requireExactCi: boolean,
): WaitObservation {
  while (true) {
    const initialLocal = trackLocalState ? readLocalState() : null;
    const initialPullRequest = runGhJson<PullRequestState>(pullRequestViewArgs(repository, target));
    const initialReviewData = readReviewData(repository, initialPullRequest);
    const observedCi = readGithubCi(repository, initialPullRequest, runGhJson);
    const ci = requireExactCi ? requireExactGithubCi(observedCi) : observedCi;
    const pullRequest = runGhJson<PullRequestState>(pullRequestViewArgs(repository, target));
    const local = trackLocalState ? readLocalState() : null;
    if (
      !samePullRequestRevision(initialPullRequest, pullRequest) ||
      (initialLocal !== null && local !== null && !sameLocalState(initialLocal, local))
    ) {
      continue;
    }

    const observation = observationFrom(pullRequest, initialReviewData, ci, local);
    if (!requiresReadyConfirmation(observation)) return observation;

    const confirmedReviewData = readReviewData(repository, pullRequest);
    const observedConfirmedCi = readGithubCi(repository, pullRequest, runGhJson);
    const confirmedCi = requireExactCi
      ? requireExactGithubCi(observedConfirmedCi)
      : observedConfirmedCi;
    const confirmedPullRequest = runGhJson<PullRequestState>(
      pullRequestViewArgs(repository, target),
    );
    const confirmedLocal = trackLocalState ? readLocalState() : null;
    if (
      !samePullRequestRevision(pullRequest, confirmedPullRequest) ||
      (local !== null && confirmedLocal !== null && !sameLocalState(local, confirmedLocal)) ||
      initialReviewData.fingerprint !== confirmedReviewData.fingerprint
    ) {
      continue;
    }
    return observationFrom(confirmedPullRequest, confirmedReviewData, confirmedCi, confirmedLocal);
  }
}

const summary = (observation: WaitObservation): string =>
  JSON.stringify({
    pr: observation.pullRequest.number,
    head: observation.pullRequest.headRefOid,
    base: observation.pullRequest.baseRefOid,
    merge: observation.pullRequest.potentialMergeCommit?.oid ?? null,
    ci: observation.ci.state,
    ciReason: observation.ci.reason,
    review: observation.review.pending
      ? "pending"
      : observation.review.ready
        ? "completed"
        : observation.review.terminalArtifacts.length > 0
          ? "unhandled"
          : "missing",
    unresolvedReviewThreads: observation.unresolvedReviewThreads,
  });

export function formatWaitForPrSummary(
  decision: Extract<WaitDecision, { readonly kind: "wake" }>,
  observation: WaitObservation,
): string {
  return `[wait-for-pr] Summary: ${JSON.stringify({
    reason: decision.reason,
    detail: decision.detail,
    pr: observation.pullRequest.number,
    url: observation.pullRequest.url,
    head: observation.pullRequest.headRefOid,
    base: observation.pullRequest.baseRefOid,
    ci: observation.ci,
    reviewPending: observation.review.pending,
    reviewReady: observation.review.ready,
    reviewArtifacts: observation.review.terminalArtifacts.map(({ key }) => key),
  })}`;
}

export function formatWaitForPrFailureSummary(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .trim();
  return `[wait-for-pr] Summary: failed: ${message || "Unknown error."}`;
}

const sleep = (durationMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

const waitProgressSummary = {
  "ci-pending": "Waiting for CI",
  "ci-registration": "Waiting for CI registration",
  "mergeability-pending": "Waiting for GitHub mergeability",
  "review-pending": "Waiting for review",
} as const;

type WaitCommand =
  | { readonly kind: "wait" }
  | { readonly kind: "target"; readonly pullRequestNumber: number }
  | { readonly kind: "clear-target" };

export function parseWaitCommand(args: ReadonlyArray<string>): WaitCommand {
  if (args.length === 0) return { kind: "wait" };
  if (args.length === 1 && args[0] === "--clear-target") return { kind: "clear-target" };
  if (args.length === 2 && args[0] === "--target" && /^[1-9][0-9]*$/u.test(args[1] ?? "")) {
    const pullRequestNumber = Number(args[1]);
    if (Number.isSafeInteger(pullRequestNumber)) return { kind: "target", pullRequestNumber };
  }
  throw new Error("Usage: lastcode-wait-for-pr.ts [--target PR_NUMBER | --clear-target]");
}

function completeWait(
  decision: Extract<WaitDecision, { readonly kind: "wake" }>,
  observation: WaitObservation,
  target: WaitTargetSnapshot | null,
): void {
  console.log(formatWaitForPrSummary(decision, observation));
  lastCodeAction.result({
    outcome:
      decision.reason === "ready" || decision.reason === "stacked-ready" ? "success" : "attention",
    reason: decision.reason,
    summary: decision.detail,
    subject: {
      type: "pull-request",
      id: String(observation.pullRequest.number),
      revision: observation.pullRequest.headRefOid,
      url: observation.pullRequest.url,
    },
    facts: {
      base: observation.pullRequest.baseRefOid,
      ci: observation.ci.state,
      review: observation.review.pending
        ? "pending"
        : observation.review.ready
          ? "completed"
          : "attention",
      validation: target?.parents.length ? "stacked" : "canonical",
    },
    artifacts: [{ label: "Pull request", url: observation.pullRequest.url }],
  });
}

async function main(): Promise<void> {
  const command = parseWaitCommand(process.argv.slice(2));
  if (command.kind === "clear-target") {
    const path = clearWaitTarget();
    console.log(`[wait-for-pr] Cleared explicit target ${path}`);
    return;
  }
  if (command.kind === "target") {
    const target = prepareWaitTarget(LASTCODE_GITHUB_REPOSITORY, command.pullRequestNumber);
    const path = writeWaitTarget(target);
    console.log(
      `[wait-for-pr] Target: ${JSON.stringify({
        repository: target.repository,
        pr: target.pullRequest.number,
        head: { name: target.pullRequest.headRefName, sha: target.pullRequest.headRefOid },
        base: { name: target.pullRequest.baseRefName, sha: target.pullRequest.baseRefOid },
        parents: target.parents.map((parent) => ({
          pr: parent.number,
          head: { name: parent.headRefName, sha: parent.headRefOid },
          base: { name: parent.baseRefName, sha: parent.baseRefOid },
        })),
        path,
      })}`,
    );
    return;
  }

  const selectedTarget = loadWaitTarget();
  if (selectedTarget) {
    const drift = readTargetDrift(selectedTarget);
    if (drift) throw new Error(`Wait for PR target is stale: ${drift.detail}`);
  }
  const repository = selectedTarget?.repository ?? LASTCODE_GITHUB_REPOSITORY;
  const target = selectedTarget?.pullRequest.number ?? currentBranch();
  const trackLocalState = selectedTarget === null;
  let baseline = readObservation(repository, target, trackLocalState, selectedTarget !== null);
  assertWaitStart(baseline);
  console.log(`[wait-for-pr] Baseline ${summary(baseline)}`);

  let previousProgressKey = "";
  let current = baseline;
  let pendingClass: ReturnType<typeof waitTimeoutClass> = null;
  let pendingSince = Date.now();
  while (true) {
    if (selectedTarget) {
      const drift = readTargetDrift(selectedTarget);
      if (drift) {
        completeWait({ kind: "wake", ...drift }, current, selectedTarget);
        return;
      }
    }
    let decision = decideWaitForPr(baseline, current, {
      ...(selectedTarget ? { expectedBase: selectedTarget.pullRequest.baseRefName } : {}),
      readiness: selectedTarget?.parents.length ? "stacked" : "canonical",
    });
    if (decision.kind === "wait") {
      const timeoutClass = waitTimeoutClass(decision.reason);
      if (pendingClass !== timeoutClass) {
        pendingClass = timeoutClass;
        pendingSince = Date.now();
      }
      decision = decideWaitTimeout(decision.reason, Date.now() - pendingSince) ?? decision;
    }
    if (decision.kind === "wake") {
      completeWait(decision, current, selectedTarget);
      return;
    }

    const currentSummary = summary(current);
    const currentProgressKey = waitProgressKey(decision.reason, currentSummary);
    if (currentProgressKey !== previousProgressKey) {
      console.log(`[wait-for-pr] Waiting (${decision.reason}) ${currentSummary}`);
      lastCodeAction.progress({
        state: "waiting",
        phase: decision.reason,
        summary: waitProgressSummary[decision.reason],
        detail: currentSummary,
      });
      previousProgressKey = currentProgressKey;
    }
    await sleep(POLL_INTERVAL_MS);
    current = readObservation(repository, target, trackLocalState, selectedTarget !== null);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(formatWaitForPrFailureSummary(error));
    process.exitCode = 1;
  });
}
