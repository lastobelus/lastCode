import * as Schema from "effect/Schema";
import {
  CommandId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { SavedWorkspace } from "./worktreeSuspensionRpc.ts";
import {
  AuthEnvironmentMaintainScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthSourceControlWriteScope,
  AuthOrchestrationOperateScope,
} from "./auth.ts";

export const SAVED_WORKSPACE_DISCARD_SCOPES = [
  AuthEnvironmentMaintainScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthSourceControlWriteScope,
  AuthOrchestrationOperateScope,
] as const;

export const SavedWorkspaceDisposition = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("retain") }),
  Schema.Struct({ mode: Schema.Literal("discard"), previewToken: TrimmedNonEmptyString }),
]);
export type SavedWorkspaceDisposition = typeof SavedWorkspaceDisposition.Type;

export const WorkspaceLifecycleTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("threads"),
    threadIds: Schema.Array(ThreadId).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  }),
  Schema.Struct({ kind: Schema.Literal("project"), projectId: ProjectId }),
]);
export type WorkspaceLifecycleTarget = typeof WorkspaceLifecycleTarget.Type;

export const WorkspaceLifecyclePreviewInput = Schema.Struct({
  operation: Schema.Literals(["archive", "delete"]),
  target: WorkspaceLifecycleTarget,
});
export type WorkspaceLifecyclePreviewInput = typeof WorkspaceLifecyclePreviewInput.Type;

export const WorkspaceLifecyclePreview = Schema.Struct({
  token: TrimmedNonEmptyString,
  snapshots: Schema.Array(SavedWorkspace).check(Schema.isMaxLength(100)),
  retainedSnapshots: Schema.Array(SavedWorkspace).check(Schema.isMaxLength(100)),
  bytes: NonNegativeInt,
  threadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(1000)),
  projectIds: Schema.Array(ProjectId).check(Schema.isMaxLength(100)),
  message: Schema.String,
});
export type WorkspaceLifecyclePreview = typeof WorkspaceLifecyclePreview.Type;

export const WorkspaceLifecycleRunInput = Schema.Struct({
  ...WorkspaceLifecyclePreviewInput.fields,
  commandId: CommandId,
  savedWorkspace: Schema.optionalKey(SavedWorkspaceDisposition),
  deleteReceipts: Schema.optionalKey(
    Schema.Array(Schema.Struct({ threadId: ThreadId, commandId: CommandId })).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(100),
    ),
  ),
});
export type WorkspaceLifecycleRunInput = typeof WorkspaceLifecycleRunInput.Type;

export const DeleteThreadsInput = Schema.Struct({
  commandId: CommandId,
  threads: Schema.Array(
    Schema.Struct({ threadId: ThreadId, deleteWorktree: Schema.optionalKey(Schema.Boolean) }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  savedWorkspace: Schema.optionalKey(SavedWorkspaceDisposition),
});
export type DeleteThreadsInput = typeof DeleteThreadsInput.Type;
export const DeleteThreadsResult = Schema.Struct({
  failureMessage: Schema.optionalKey(Schema.String),
  deletedThreadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(1000)),
});
export type DeleteThreadsResult = typeof DeleteThreadsResult.Type;
