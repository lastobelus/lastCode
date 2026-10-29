import { DeleteThreadsInput, SAVED_WORKSPACE_DISCARD_SCOPES } from "./workspaceLifecycle.ts";
import { SetKeepWorkspaceInput } from "./worktreeSuspensionRpc.ts";
import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput, GitRunStackedActionInput } from "./git.ts";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthSettingsWriteScope,
  AuthEnvironmentMaintainScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { WS_METHODS } from "./rpc.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [WS_METHODS.previewClose]: AuthPreviewOperateScope,
  // Stopping a server signals its processes, as closing a terminal does.
  [WS_METHODS.previewStopLocalServer]: AuthTerminalOperateScope,
  [WS_METHODS.previewHostingActivity]: AuthPreviewOperateScope,
  [WS_METHODS.serverRunStorageCleanup]: AuthSettingsWriteScope,
  [WS_METHODS.serverListSavedWorkspaces]: AuthFilesystemReadScope,
  [WS_METHODS.serverPreviewWorkspaceLifecycle]: AuthFilesystemReadScope,
  [WS_METHODS.serverDeleteThreads]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverPreviewWorktreeSuspension]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverSuspendWorktree]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverRestoreWorktree]: AuthFilesystemWriteScope,
  [WS_METHODS.serverPreviewWorktreeDiscard]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverDiscardWorktreeSnapshots]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverSetKeepWorkspace]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverCreateFreshWorktree]: AuthFilesystemWriteScope,
  [WS_METHODS.serverGetBuildReviewTargets]: AuthSettingsWriteScope,
  [WS_METHODS.serverPreviewBuildReview]: AuthSettingsWriteScope,
  [WS_METHODS.serverSelectBuildReview]: AuthSettingsWriteScope,
  [WS_METHODS.serverCheckOtlpEndpoint]: AuthSettingsWriteScope,
  [ORCHESTRATION_V2_WS_METHODS.getThreadArchiveFamily]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverPauseEnvironment]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverRetryEnvironmentPause]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverResumeEnvironment]: AuthOrchestrationOperateScope,
  [WS_METHODS.pullRequestsRunAction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdateComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSubmitReview]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsReplyToThread]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetThreadResolution]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetReaction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetFilesViewed]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsRequestReviewers]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetLabels]: AuthSourceControlWriteScope,
  // Writing a guide runs a model on this environment's providers, which reading one does not.
  [WS_METHODS.pullRequestsGenerateReviewGuide]: AuthOrchestrationOperateScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  // Signing in replaces the server's GitHub credential, as saving a token in Settings does.
  [WS_METHODS.sourceControlSignInStart]: AuthSettingsWriteScope,
  [WS_METHODS.sourceControlSignInWait]: AuthSettingsWriteScope,
  [WS_METHODS.sourceControlSignInCancel]: AuthSettingsWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,

  // Starts an agent session on this environment that can read its logs and database.
  [WS_METHODS.serverPrepareTriage]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: AuthOrchestrationOperateScope,
  // A guest link hands thread access to someone outside, like a pairing link.
  [WS_METHODS.guestShareCreate]: AuthAccessWriteScope,
  [WS_METHODS.peerLinksLink]: AuthAccessWriteScope,
  [WS_METHODS.peerLinksUnlink]: AuthAccessWriteScope,
  // A link lets every agent here reach the other environment: Settings' bar.
  [WS_METHODS.peerLinksAnswerRequest]: AuthAccessWriteScope,
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

const decodeDeleteThreads = Schema.decodeUnknownSync(DeleteThreadsInput);
const decodePrepareThread = Schema.decodeUnknownSync(GitPreparePullRequestThreadInput);
const decodeStackedAction = Schema.decodeUnknownSync(GitRunStackedActionInput);
const decodeSetKeepWorkspace = Schema.decodeUnknownSync(SetKeepWorkspaceInput);

export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  if (
    method === WS_METHODS.serverSetKeepWorkspace &&
    input !== undefined &&
    "checkoutId" in decodeSetKeepWorkspace(input)
  )
    return [AuthOrchestrationOperateScope, AuthEnvironmentMaintainScope];
  if (method === WS_METHODS.serverDeleteThreads && input !== undefined) {
    const payload = decodeDeleteThreads(input);
    return [
      ...(payload.savedWorkspace?.mode === "discard"
        ? SAVED_WORKSPACE_DISCARD_SCOPES
        : [AuthOrchestrationOperateScope]),
      ...(payload.savedWorkspace?.mode !== "discard" &&
      payload.threads.some((thread) => thread.deleteWorktree === true)
        ? [AuthSourceControlWriteScope]
        : []),
    ];
  }
  if (
    (method === ORCHESTRATION_V2_WS_METHODS.dispatchCommand ||
      method === WS_METHODS.projectsMutate ||
      method === WS_METHODS.serverDeleteThreads) &&
    typeof input === "object" &&
    input !== null &&
    "savedWorkspace" in input &&
    typeof input.savedWorkspace === "object" &&
    input.savedWorkspace !== null &&
    "mode" in input.savedWorkspace &&
    input.savedWorkspace.mode === "discard"
  ) {
    return SAVED_WORKSPACE_DISCARD_SCOPES;
  }
  switch (method) {
    case WS_METHODS.serverListSavedWorkspaces:
    case WS_METHODS.serverPreviewWorkspaceLifecycle:
      return [AuthFilesystemReadScope, AuthOrchestrationReadScope];
    case WS_METHODS.serverPreviewWorktreeSuspension:
    case WS_METHODS.serverSuspendWorktree:
    case WS_METHODS.serverPreviewWorktreeDiscard:
    case WS_METHODS.serverDiscardWorktreeSnapshots:
      return [
        AuthEnvironmentMaintainScope,
        AuthFilesystemReadScope,
        AuthFilesystemWriteScope,
        AuthSourceControlWriteScope,
        AuthOrchestrationOperateScope,
      ];
    case WS_METHODS.serverRestoreWorktree:
    case WS_METHODS.serverCreateFreshWorktree:
      return [
        AuthFilesystemReadScope,
        AuthFilesystemWriteScope,
        AuthSourceControlWriteScope,
        AuthOrchestrationOperateScope,
      ];
  }
  if (method === WS_METHODS.gitPreparePullRequestThread && input !== undefined) {
    const payload = decodePrepareThread(input);
    if (payload.mode === "worktree" && payload.threadId !== undefined)
      return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  }
  if (method === WS_METHODS.gitRunStackedAction && input !== undefined) {
    const payload = decodeStackedAction(input);
    if (
      payload.threadId !== undefined &&
      (payload.action === "create_pr" || payload.action === "commit_push_pr")
    )
      return [AuthSourceControlWriteScope, AuthOrchestrationReadScope];
  }
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as ClientGuardedRpcTag]]
    : [];
}
