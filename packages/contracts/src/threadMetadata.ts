import * as Schema from "effect/Schema";

import { IsoDateTime, MessageId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const THREAD_ANNOTATION_MAX_BODY_CHARS = 20_000;

/** A note keeps its message anchor until the user changes or resolves it. */
export const ThreadAnnotation = Schema.Struct({
  body: Schema.String.check(
    Schema.isMaxLength(THREAD_ANNOTATION_MAX_BODY_CHARS),
    Schema.makeFilter((value) => value.trim().length > 0 || "annotation body cannot be empty"),
  ),
  anchorMessageId: MessageId,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type ThreadAnnotation = typeof ThreadAnnotation.Type;

export const ThreadAttention = Schema.Struct({
  kind: Schema.Literal("question"),
  raisedAt: IsoDateTime,
});
export type ThreadAttention = typeof ThreadAttention.Type;

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

export class ThreadAttentionToolError extends Schema.TaggedError<ThreadAttentionToolError>()(
  "ThreadAttentionToolError",
  { message: Schema.String },
) {}
