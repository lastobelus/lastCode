import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  MessageId,
  RunAttemptId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ActionResumeOwner } from "./actionResume.ts";
import {
  PullRequestActor,
  PullRequestChecksState,
  PullRequestMergeability,
  PullRequestReviewDecision,
  PullRequestState,
} from "./pullRequest.ts";

export const ThreadLinkedPullRequest = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  url: TrimmedNonEmptyString,
});
export type ThreadLinkedPullRequest = typeof ThreadLinkedPullRequest.Type;

/** stack-dismissed hides an unlinked native member and prevents sync from re-adding it. */
export const ThreadPullRequestLinkSource = Schema.Literals([
  "manual",
  "created",
  "agent",
  "stack",
  "stack-dismissed",
]);
export type ThreadPullRequestLinkSource = typeof ThreadPullRequestLinkSource.Type;

export const ThreadPullRequestSnapshot = Schema.Struct({
  state: PullRequestState,
  title: TrimmedNonEmptyString,
  headBranch: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  isDraft: Schema.Boolean,
  updatedAt: Schema.NullOr(IsoDateTime),
  syncedAt: IsoDateTime,
  closedAt: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(PullRequestActor)),
  additions: Schema.optional(NonNegativeInt),
  deletions: Schema.optional(NonNegativeInt),
  changedFiles: Schema.optional(NonNegativeInt),
  reviewDecision: Schema.optional(Schema.NullOr(PullRequestReviewDecision)),
  checksState: Schema.optional(Schema.NullOr(PullRequestChecksState)),
  mergeability: Schema.optional(PullRequestMergeability),
});
export type ThreadPullRequestSnapshot = typeof ThreadPullRequestSnapshot.Type;

export const ThreadPullRequestStackLayer = Schema.Struct({
  number: PositiveInt,
  headBranch: TrimmedNonEmptyString,
  state: PullRequestState,
});
export type ThreadPullRequestStackLayer = typeof ThreadPullRequestStackLayer.Type;

/** Layers run bottom to top. */
export const ThreadPullRequestStack = Schema.Struct({
  kind: Schema.Literal("native"),
  id: TrimmedNonEmptyString,
  number: PositiveInt,
  url: TrimmedNonEmptyString,
  base: TrimmedNonEmptyString,
  layers: Schema.Array(ThreadPullRequestStackLayer),
});
export type ThreadPullRequestStack = typeof ThreadPullRequestStack.Type;

export const ThreadPullRequestKey = Schema.Struct({
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type ThreadPullRequestKey = typeof ThreadPullRequestKey.Type;

export const PullRequestWatchQuietTimeoutMinutes = PositiveInt.check(
  Schema.isLessThanOrEqualTo(10080),
);

export const ThreadPullRequestWatchQuietDeadline = Schema.Struct({
  timeoutMinutes: PullRequestWatchQuietTimeoutMinutes,
  dueAt: Schema.NullOr(IsoDateTime),
});

export const PullRequestWatchContinuation = Schema.Struct({
  generation: TrimmedNonEmptyString,
  owner: ActionResumeOwner,
  messageId: MessageId,
});
export type PullRequestWatchContinuation = typeof PullRequestWatchContinuation.Type;

const PullRequestWatchEvent = Schema.Struct({
  messageId: MessageId,
  text: Schema.String.check(Schema.isMaxLength(64_000)),
  notification: Schema.Struct({
    source: Schema.Struct({ kind: Schema.Literal("monitor") }),
    outcome: Schema.Literals(["completed", "failed", "cancelled", "updated", "unknown"]),
    summary: TrimmedNonEmptyString,
    detail: Schema.optional(Schema.String),
  }),
});

export const PullRequestWatchObligation = Schema.Struct({
  generation: TrimmedNonEmptyString,
  key: ThreadPullRequestKey,
  owner: ActionResumeOwner,
  sourceAttemptId: RunAttemptId,
  state: Schema.Literals(["active", "terminal-pending", "ended", "disposed"]),
  disposalReason: Schema.optional(
    Schema.Literals(["owner_unwatch", "lifecycle", "ownership_released"]),
  ),
  pending: Schema.optional(PullRequestWatchEvent),
  terminalEvent: Schema.optional(PullRequestWatchEvent),
});
export type PullRequestWatchObligation = typeof PullRequestWatchObligation.Type;

export const ThreadPullRequestWatch = Schema.Struct({
  startedAt: IsoDateTime,
  generation: Schema.optional(TrimmedNonEmptyString),
  /** Null dueAt records a delivered quiet wake until progress or an explicit rearm. */
  quietDeadline: Schema.optional(ThreadPullRequestWatchQuietDeadline),
  headSha: Schema.NullOr(TrimmedNonEmptyString),
  failedChecks: Schema.Array(TrimmedNonEmptyString),
  passed: Schema.Boolean,
  passedChecks: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Checks still pending when required ones passed early, owed one wake once all settle. */
  owedChecks: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  /** Approval holds keyed by workflow run URL, or check name when no run URL is known. */
  awaitingApproval: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  /** The agent was told checks await approval on this head, so later ones stay quiet. */
  approvalAnnounced: Schema.optional(Schema.Boolean),
  remarksThrough: IsoDateTime,
  /** Reported remarks at remarksThrough, so late arrivals at that timestamp still count. */
  remarkIds: Schema.Array(TrimmedNonEmptyString),
  /** Named reactions on the own account's comments already reported, keyed by comment/content/actor. */
  reactionKeys: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /**
   * The highest reaction total reported on an own comment whose reactors the host named only in
   * part, keyed by comment/content, so people past the named page still count once.
   */
  reactionCounts: Schema.Record(TrimmedNonEmptyString, NonNegativeInt).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  conflicting: Schema.Boolean,
  /** Last removal seen; null after an empty read, absent before the first read. */
  mergeQueueRemovalId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  /** Consecutive comment-only wakes; limited to prevent bot loops. */
  wakes: NonNegativeInt,
  /**
   * What is already on the pull request is recorded, not reported: conflicts on the first read, and
   * checks on the first read that can be trusted to show them (one with a head and a full check read).
   */
  awaitingBaseline: Schema.optional(Schema.Literals(["all", "checks"])),
  /**
   * When the head was first read without any check, until a check shows up or the agent is told
   * none did. Null once either happened; absent on watches saved before it existed.
   */
  checksAwaitedSince: Schema.optional(Schema.NullOr(IsoDateTime)),
  /**
   * Whether the host was still running checks on the head at the last read. Only then does the
   * watch keep its thread waiting; absent on watches not read since it existed.
   */
  checksPending: Schema.optional(Schema.Boolean),
  /** Set on an ended watch that T3 stopped because it could not read the PR. */
  unreadable: Schema.optional(Schema.Literal(true)),
});
export type ThreadPullRequestWatch = typeof ThreadPullRequestWatch.Type;

export const ThreadPullRequestLink = Schema.Struct({
  ...ThreadPullRequestKey.fields,
  url: TrimmedNonEmptyString,
  /** An actual browser or clone URL; older agent display URLs may be synthesized. */
  repositoryWebUrl: Schema.optional(TrimmedNonEmptyString),
  source: ThreadPullRequestLinkSource,
  linkedAt: IsoDateTime,
  snapshot: Schema.NullOr(ThreadPullRequestSnapshot),
  stack: Schema.NullOr(ThreadPullRequestStack),
  watch: Schema.optional(ThreadPullRequestWatch),
  /** Resume from the ended watch to avoid duplicate notifications. */
  endedWatch: Schema.optional(ThreadPullRequestWatch),
});
export type ThreadPullRequestLink = typeof ThreadPullRequestLink.Type;
