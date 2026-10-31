import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { WorktreeSuspensionState } from "./worktreeSuspension.ts";

export const SavedWorkspace = Schema.Struct({
  snapshotId: TrimmedNonEmptyString,
  checkoutId: TrimmedNonEmptyString,
  title: Schema.String,
  path: Schema.String,
  projectIds: Schema.Array(ProjectId),
  ownerThreadIds: Schema.Array(ThreadId),
  savedAt: IsoDateTime,
  head: Schema.String,
  branch: Schema.NullOr(Schema.String),
  bytes: NonNegativeInt,
  fileCount: NonNegativeInt,
  current: Schema.Boolean,
  orphaned: Schema.Boolean,
  state: WorktreeSuspensionState,
  keepWorkspace: Schema.Boolean,
  blockedReason: Schema.optionalKey(Schema.String),
});
export type SavedWorkspace = typeof SavedWorkspace.Type;

export const ListSavedWorkspacesInput = Schema.Struct({
  projectId: Schema.optionalKey(ProjectId),
  cursor: Schema.optionalKey(NonNegativeInt),
});
export const SavedWorkspacesPage = Schema.Struct({
  entries: Schema.Array(SavedWorkspace).check(Schema.isMaxLength(100)),
  nextCursor: Schema.NullOr(NonNegativeInt),
});
export type SavedWorkspacesPage = typeof SavedWorkspacesPage.Type;

export const PreviewWorktreeSuspensionInput = Schema.Struct({ threadId: ThreadId });
export const WorktreeSuspensionPreview = Schema.Struct({
  token: TrimmedNonEmptyString,
  checkoutId: TrimmedNonEmptyString,
  path: Schema.String,
  ownerThreadIds: Schema.Array(ThreadId),
  message: Schema.String,
});
export type WorktreeSuspensionPreview = typeof WorktreeSuspensionPreview.Type;
export const SuspendWorktreeInput = Schema.Struct({
  threadId: ThreadId,
  previewToken: TrimmedNonEmptyString,
});
export const RestoreWorktreeInput = Schema.Struct({
  checkoutId: TrimmedNonEmptyString,
  snapshotId: TrimmedNonEmptyString,
  projectId: Schema.optionalKey(ProjectId),
  destinationPath: Schema.optionalKey(TrimmedNonEmptyString),
});
export const SetKeepWorkspaceInput = Schema.Union([
  Schema.Struct({ threadId: ThreadId, keep: Schema.Boolean }),
  Schema.Struct({ checkoutId: TrimmedNonEmptyString, keep: Schema.Literal(false) }),
]);
export const PreviewWorktreeDiscardInput = Schema.Struct({
  checkoutId: TrimmedNonEmptyString,
  snapshotIds: Schema.Array(TrimmedNonEmptyString).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
  ),
});
export const WorktreeDiscardPreview = Schema.Struct({
  token: TrimmedNonEmptyString,
  checkoutId: TrimmedNonEmptyString,
  snapshots: Schema.Array(SavedWorkspace).check(Schema.isMaxLength(100)),
  bytes: NonNegativeInt,
  retainedCount: NonNegativeInt,
  message: Schema.String,
});
export type WorktreeDiscardPreview = typeof WorktreeDiscardPreview.Type;
export const DiscardWorktreeSnapshotsInput = Schema.Struct({
  previewToken: TrimmedNonEmptyString,
});
export const WorkspaceOperation = Schema.Struct({
  operationId: TrimmedNonEmptyString,
  checkoutId: TrimmedNonEmptyString,
  state: Schema.Literals(["queued", "complete"]),
  message: Schema.String,
});
export type WorkspaceOperation = typeof WorkspaceOperation.Type;

export class WorktreeSuspensionRequestError extends Schema.TaggedError<WorktreeSuspensionRequestError>()(
  "WorktreeSuspensionRequestError",
  {
    reason: Schema.Literals([
      "unavailable",
      "busy",
      "protected",
      "changed",
      "invalid-preview",
      "permission-denied",
    ]),
    message: Schema.String,
  },
) {}
