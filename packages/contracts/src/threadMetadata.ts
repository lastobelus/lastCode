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

export const THREAD_DASHBOARD_MAX_ITEMS = 32;

const ThreadDashboardItemId = TrimmedNonEmptyString.check(Schema.isMaxLength(80));

export const ThreadDashboardItemInput = Schema.Struct({
  id: ThreadDashboardItemId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  body: Schema.String.check(Schema.isMaxLength(4_000)),
  kind: Schema.Literals(["question", "review", "qa", "metric", "progress", "summary"]),
  status: Schema.Literals(["open", "resolved"]),
  priority: Schema.Literals(["normal", "high"]),
  effort: Schema.Literals(["quick", "focused", "unspecified"]),
  requiresComputer: Schema.Boolean,
});
export type ThreadDashboardItemInput = typeof ThreadDashboardItemInput.Type;

export const ThreadDashboardItem = Schema.Struct({
  ...ThreadDashboardItemInput.fields,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadDashboardItem = typeof ThreadDashboardItem.Type;

export const ThreadDashboardItems = Schema.Array(ThreadDashboardItem).check(
  Schema.isMaxLength(THREAD_DASHBOARD_MAX_ITEMS),
  Schema.makeFilter(
    (items) =>
      new Set(items.map((item) => item.id)).size === items.length ||
      "dashboard item ids must be unique within the thread",
  ),
);

export function isActionableDashboardItem(
  item: Pick<ThreadDashboardItem, "kind" | "status">,
): boolean {
  return (
    item.status === "open" &&
    (item.kind === "question" || item.kind === "review" || item.kind === "qa")
  );
}

export function hasOpenActionableDashboardItems(
  items: ReadonlyArray<ThreadDashboardItem> | undefined,
): boolean {
  return items?.some(isActionableDashboardItem) ?? false;
}

export class ThreadDashboardToolError extends Schema.TaggedError<ThreadDashboardToolError>()(
  "ThreadDashboardToolError",
  { message: Schema.String },
) {}

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
