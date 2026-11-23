import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const THREAD_ANNOTATION_MAX_BODY_CHARS = 20_000;

export const ThreadAnnotationBodyInput = Schema.String.check(
  Schema.isMaxLength(THREAD_ANNOTATION_MAX_BODY_CHARS),
);

const CheckpointTrigger = {
  kind: Schema.Literal("checkpoints"),
  count: PositiveInt,
};
const ArchiveTrigger = {
  kind: Schema.Literal("thread-archived"),
  threadId: ThreadId,
};
const PullRequestTrigger = {
  kind: Schema.Literal("pull-request-merged"),
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  host: TrimmedNonEmptyString,
};
const DateTrigger = {
  kind: Schema.Literal("date"),
  at: IsoDateTime,
};

export const AnnotationHideTriggerInput = Schema.Union([
  Schema.Struct(CheckpointTrigger),
  Schema.Struct(ArchiveTrigger),
  Schema.Struct(PullRequestTrigger),
  Schema.Struct(DateTrigger),
]);
export type AnnotationHideTriggerInput = typeof AnnotationHideTriggerInput.Type;

const StoredTrigger = { id: CommandId, hiddenAt: IsoDateTime };
export const AnnotationHideTrigger = Schema.Union([
  Schema.Struct({
    ...StoredTrigger,
    ...CheckpointTrigger,
    baselineVersion: TrimmedNonEmptyString,
    seenBuilds: Schema.Array(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    ...StoredTrigger,
    ...ArchiveTrigger,
    afterTargetSequence: NonNegativeInt,
    targetTitle: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  Schema.Struct({ ...StoredTrigger, ...PullRequestTrigger }),
  Schema.Struct({ ...StoredTrigger, ...DateTrigger }),
]);
export type AnnotationHideTrigger = typeof AnnotationHideTrigger.Type;

export const AnnotationRevealOutcome = Schema.Literals([
  "merged",
  "closed-unmerged",
  "archived",
  "deleted",
  "installed",
  "due",
]);
export type AnnotationRevealOutcome = typeof AnnotationRevealOutcome.Type;

export const AnnotationReveal = Schema.Struct({
  at: IsoDateTime,
  by: Schema.Literals(["trigger", "manual"]),
  trigger: AnnotationHideTrigger,
  outcome: Schema.optionalKey(AnnotationRevealOutcome),
  installedVersion: Schema.optionalKey(TrimmedNonEmptyString),
});
export type AnnotationReveal = typeof AnnotationReveal.Type;

const AnnotationTriggerCommand = {
  commandId: CommandId,
  threadId: ThreadId,
  annotationId: TrimmedNonEmptyString,
  triggerId: CommandId,
};
export const ThreadAnnotationRevealCommand = Schema.Struct({
  type: Schema.Literal("thread.annotation.reveal"),
  ...AnnotationTriggerCommand,
  outcome: AnnotationRevealOutcome,
});
export const ThreadAnnotationHideProgressCommand = Schema.Struct({
  type: Schema.Literal("thread.annotation.hide-progress"),
  ...AnnotationTriggerCommand,
});

/** A note keeps its message anchor until the user resolves it. */
const ThreadAnnotationEntry = Schema.Struct({
  id: Schema.optional(TrimmedNonEmptyString),
  body: Schema.String.check(
    Schema.isMaxLength(THREAD_ANNOTATION_MAX_BODY_CHARS),
    Schema.makeFilter((value) => value.trim().length > 0 || "annotation body cannot be empty"),
  ),
  anchorMessageId: MessageId,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
  hideUntil: Schema.optionalKey(AnnotationHideTrigger),
  reveal: Schema.optionalKey(AnnotationReveal),
  bodyGenerated: Schema.optionalKey(Schema.Literal(true)),
});
export const ThreadAnnotation = Schema.Struct({
  ...ThreadAnnotationEntry.fields,
  otherAnnotations: Schema.optional(Schema.Array(ThreadAnnotationEntry)),
});
export type ThreadAnnotation = typeof ThreadAnnotation.Type;

const ThreadWorktreeCleanupBase = {
  repositoryRoot: TrimmedNonEmptyString,
  repositoryKey: Schema.optional(TrimmedNonEmptyString),
  worktreePath: TrimmedNonEmptyString,
} as const;

export const ThreadWorktreeCleanup = Schema.Union([
  Schema.Struct({
    ...ThreadWorktreeCleanupBase,
    status: Schema.Literal("deleting"),
    startedAt: IsoDateTime,
  }),
  Schema.Struct({
    ...ThreadWorktreeCleanupBase,
    status: Schema.Literal("queued"),
    queuedAt: IsoDateTime,
    blockedByThreadId: ThreadId,
  }),
  Schema.Struct({
    ...ThreadWorktreeCleanupBase,
    status: Schema.Literal("failed"),
    startedAt: IsoDateTime,
    failedAt: IsoDateTime,
    error: Schema.String,
  }),
]);
export type ThreadWorktreeCleanup = typeof ThreadWorktreeCleanup.Type;
