import { ThreadRecoveryInput, ThreadRecoveryResult, ThreadRepairResult } from "@t3tools/contracts";
import * as ThreadRecovery from "../../../orchestration-v2/ThreadRecoveryService.ts";
import * as ThreadRecoveryRepair from "../../../orchestration-v2/ThreadRecoveryRepairService.ts";
import {
  OrchestratorMcpEnvironmentTarget,
  ScheduledTaskId,
  ScheduledTask,
  OrchestrationSearchThreadsInput,
  OrchestrationThreadSearchMatch,
  OrchestrationV2ThreadForkSourcePoint,
  OrchestrationV2ContextTransfer,
  OrchestrationV2SubagentPromotion,
  CommandId,
  TrimmedNonEmptyString,
  ModelSelection,
  RuntimeMode,
  ProviderInteractionMode,
  RuntimeRequestId,
  ProviderUserInputAnswers,
  IsoDateTime,
  ThreadArchiveChildDisposition,
  OrchestratorMcpFailure,
  OrchestrationV2DispatchCommandResult,
  OrchestrationV2ThreadArchiveFamily,
  ThreadId,
  RunId,
  NonNegativeInt,
  ProjectId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ThreadOrganizeTool = Tool.make("t3_thread_organize", {
  description:
    "Pin, snooze, settle, archive, restore, or mark a thread unread. Omit threadId for this thread. snooze requires snoozedUntil. Settling this thread takes effect when your turn completes, returning settlesWhenTurnEnds=true; a turn that fails or is interrupted, or a queued message, leaves it active. Before archiving, use t3_thread_archive_family to inspect grouped interactive children and subagents, with active/unread status. Archiving a thread with children requires an explicit childDisposition and its returned childThreadIds as expectedChildThreadIds. A childless active or unread thread also needs stop_and_archive or archive_after_review, respectively. archive_if_idle refuses active or unread family members; archive_after_review confirms unread replies but refuses newly active work; stop_and_archive confirms stopping active family members and archiving the whole family. Promotion is a separate explicit operation before archiving. archive with expectedArchiveCommandId retries only that exact failed attempt. unarchive restores an archived thread; with expectedArchiveCommandId it instead dismisses that exact failed archive on an active family, without stopping or restarting work. Failed participants resolve to the original owner and archive retries retain the observed failed attempt. This does not schedule a future action.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    action: Schema.Literals([
      "pin",
      "unpin",
      "snooze",
      "unsnooze",
      "settle",
      "unsettle",
      "archive",
      "unarchive",
      "mark_unread",
    ]),
    snoozedUntil: Schema.optional(IsoDateTime),
    childDisposition: Schema.optional(ThreadArchiveChildDisposition),
    expectedChildThreadIds: Schema.optional(Schema.Array(ThreadId)),
    expectedArchiveCommandId: Schema.optional(CommandId),
  }),
  success: Schema.Union([
    OrchestrationV2DispatchCommandResult,
    Schema.Struct({ settlesWhenTurnEnds: Schema.Literal(true) }),
  ]),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Crypto.Crypto,
  ],
})
  .annotate(Tool.Title, "Organize a thread")
  .annotate(Tool.Strict, true)
  .annotate(Tool.Destructive, true);

const commandTool = {
  success: OrchestrationV2DispatchCommandResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Crypto.Crypto,
  ],
};
const queueEntry = Schema.Struct({
  queuedRunId: RunId,
  text: Schema.String,
  truncated: Schema.Boolean,
});
const QUEUE_READ_ACTIONS = ["list", "read"] as const;
const QueueTool = Tool.make("t3_queue", {
  ...commandTool,
  description:
    "Manage a thread's queued messages. Omit `threadId` for this thread. list: send order, paged by `cursor` and `limit`. read: up to 16,000 chars of one. edit: replace its `text`; attachments stay. cancel. reorder: before `beforeRunId`, or to the end with null. promote_to_steer: send it now as steering to active `targetRunId`. Writes fail once the run is no longer queued.",
  parameters: Schema.Struct({
    action: Schema.Literals([
      ...QUEUE_READ_ACTIONS,
      "edit",
      "cancel",
      "reorder",
      "promote_to_steer",
    ]),
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    queuedRunId: Schema.optional(RunId),
    text: Schema.optional(Schema.String.check(Schema.isMaxLength(100000))),
    beforeRunId: Schema.optional(Schema.NullOr(RunId)),
    targetRunId: Schema.optional(RunId),
    cursor: Schema.optional(NonNegativeInt),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  }),
  success: Schema.Union([
    Schema.Struct({ items: Schema.Array(queueEntry), nextCursor: Schema.NullOr(NonNegativeInt) }),
    queueEntry,
    OrchestrationV2DispatchCommandResult,
  ]),
}).annotate(Tool.Destructive, true);

const question = Schema.Struct({
  id: Schema.String,
  header: Schema.String,
  question: Schema.String,
  options: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      description: Schema.String,
      value: Schema.optional(Schema.String),
    }),
  ),
  multiSelect: Schema.optional(Schema.Boolean),
  allowCustomAnswer: Schema.optional(Schema.Boolean),
  initialAnswer: Schema.optional(Schema.String),
  required: Schema.optional(Schema.Boolean),
});
const PendingRequestTool = Tool.make("t3_pending_request", {
  ...commandTool,
  description:
    "Pending user questions in a thread. Omit `threadId` for this thread. list: their ids; approvals are not listed. read: one by `requestId`. respond: answer one with `answers`; this cannot approve a permission request.",
  parameters: Schema.Struct({
    action: Schema.Literals(["list", "read", "respond"]),
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    requestId: Schema.optional(RuntimeRequestId),
    answers: Schema.optional(ProviderUserInputAnswers),
  }),
  success: Schema.Union([
    Schema.Struct({ requestIds: Schema.Array(RuntimeRequestId) }),
    Schema.Struct({ requestId: RuntimeRequestId, questions: Schema.Array(question) }),
    OrchestrationV2DispatchCommandResult,
  ]),
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const ThreadArchiveFamilyTool = Tool.make("t3_thread_archive_family", {
  ...commandTool,
  description:
    "Inspect a thread's recursive archive family IDs and working/unread members. This may repair saved activity when the provider proves that the exact turn has ended; unknown work remains active. Omit threadId for this thread. Includes grouped interactive conversations, nested subagents and native subagents; excludes forks and independent branches. Use t3_thread_read for individual thread details. To archive with t3_thread_organize, choose childDisposition and pass the returned childThreadIds as expectedChildThreadIds. The server rechecks them on submission; if the family changes, inspect it again before choosing.",
  parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: OrchestrationV2ThreadArchiveFamily.mapFields(Struct.omit(["threads"])),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

const threadConfiguration = Schema.Struct({
  threadId: ThreadId,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
const ThreadConfigureTool = Tool.make("t3_thread_configure", {
  ...commandTool,
  description:
    "Read a thread's provider, model, and modes, or set its provider, model, and options with `modelSelection`. Omit `threadId` for this thread. Permission modes stay. Values from `orchestrator_capabilities`.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    modelSelection: Schema.optional(ModelSelection),
  }),
  success: Schema.Union([threadConfiguration, OrchestrationV2DispatchCommandResult]),
}).annotate(Tool.Destructive, true);

const ThreadTransferTool = Tool.make("t3_thread_transfer", {
  ...commandTool,
  description:
    "Move context between threads. Omit `threadId` for this thread. fork: copy it from `sourcePoint` (default latest stable run) into a new thread with the same setup; no turn runs yet. merge_back: merge it from `sourcePoint` into a related `targetThreadId` in the same project. status: its context transfers.",
  parameters: Schema.Struct({
    action: Schema.Literals(["fork", "merge_back", "status"]),
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    sourcePoint: Schema.optional(OrchestrationV2ThreadForkSourcePoint),
    targetThreadId: Schema.optional(ThreadId),
    title: Schema.optional(TrimmedNonEmptyString),
  }),
  success: Schema.Union([
    Schema.Struct({ sequence: NonNegativeInt, targetThreadId: ThreadId }),
    Schema.Struct({
      transfers: Schema.Array(
        Schema.Struct({
          id: OrchestrationV2ContextTransfer.fields.id,
          sourceThreadId: OrchestrationV2ContextTransfer.fields.sourceThreadId,
          targetThreadId: OrchestrationV2ContextTransfer.fields.targetThreadId,
          status: OrchestrationV2ContextTransfer.fields.status,
        }),
      ),
    }),
  ]),
}).annotate(Tool.Destructive, true);
const SubagentPromoteTool = Tool.make("t3_subagent_promote", {
  ...commandTool,
  description:
    "Request an interactive native fork of a provider-owned subagent by threadId in this environment. A running subagent is allowed to finish first. Repeated requests reuse the existing promotion; a failed request retries it. Acceptance is not completion: use t3_subagent_promotion_status to read the destination and progress. The original subagent remains read-only, and its parent receives a handoff after the native fork succeeds.",
  parameters: Schema.Struct({ threadId: ThreadId }),
}).annotate(Tool.Destructive, true);
const SubagentPromotionCancelTool = Tool.make("t3_subagent_promotion_cancel", {
  ...commandTool,
  description:
    "Cancel a subagent promotion while it is waiting for the subagent to finish. Pass the requestId from t3_subagent_promotion_status. This does not stop the subagent; a native fork already in progress cannot be cancelled.",
  parameters: Schema.Struct({ threadId: ThreadId, requestId: CommandId }),
}).annotate(Tool.Destructive, true);
const SubagentPromotionStatusTool = Tool.make("t3_subagent_promotion_status", {
  ...commandTool,
  description:
    "Read durable subagent promotion progress for threadId in this environment. Null means no promotion was requested. The destination is usable only when status is promoted; use t3_thread_send on that interactive thread for further work.",
  parameters: Schema.Struct({ threadId: ThreadId }),
  success: Schema.Struct({ promotion: Schema.NullOr(OrchestrationV2SubagentPromotion) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ThreadSearchTool = Tool.make("t3_thread_search", {
  ...commandTool,
  description:
    "Search active threads by title, branch, PR, project, then message text. Skips subagent threads. `projectId`: one project, else yours, else all outside a thread. Not exhaustive.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...OrchestrationSearchThreadsInput.fields,
    projectId: Schema.optional(ProjectId),
  }),
  success: Schema.Struct({
    matches: Schema.Array(
      Schema.Struct({
        threadId: OrchestrationThreadSearchMatch.fields.threadId,
        projectId: OrchestrationThreadSearchMatch.fields.projectId,
        title: Schema.String,
        link: Schema.optional(Schema.String),
        source: Schema.Literals(["title", "user", "assistant"]),
        snippet: Schema.optional(OrchestrationThreadSearchMatch.fields.snippet),
        messageCreatedAt: Schema.optional(OrchestrationThreadSearchMatch.fields.messageCreatedAt),
      }),
    ),
  }),
  dependencies: [...commandTool.dependencies, ThreadSearch.ThreadSearch],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ScheduledTaskRunTool = Tool.make("run_scheduled_task_now", {
  ...commandTool,
  description:
    "Run one scheduled task now. Needs a full-access or default caller. Returns its thread, or null if not started. Success means started, not finished.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    taskId: ScheduledTaskId,
  }),
  success: Schema.Struct({
    taskId: ScheduledTaskId,
    threadId: ScheduledTask.fields.threadId,
    link: Schema.optional(Schema.String),
    lastRunStatus: ScheduledTask.fields.lastRunStatus,
    runCount: NonNegativeInt,
    nextRunAt: ScheduledTask.fields.nextRunAt,
  }),
  dependencies: [...commandTool.dependencies, ScheduledTaskService.ScheduledTaskService],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const ThreadRecoverTool = Tool.make("t3_thread_recover", {
  ...commandTool,
  description:
    "Check and reconcile a detected stale run using bounded deterministic recovery. Requires exact incident IDs from t3_thread_read. Does not restart completed work or launch an agent.",
  parameters: ThreadRecoveryInput,
  success: ThreadRecoveryResult,
  dependencies: [...commandTool.dependencies, ThreadRecovery.ThreadRecoveryService],
}).annotate(Tool.Destructive, true);
const ThreadRepairTool = Tool.make("t3_thread_repair", {
  ...commandTool,
  description:
    "Only after explicit user authorization: open an ordinary repair-agent thread for an incident whose deterministic recovery failed. Uses project default provider/model. Repeated calls return the same repair thread; never use automatically.",
  parameters: ThreadRecoveryInput,
  success: ThreadRepairResult,
  dependencies: [...commandTool.dependencies, ThreadRecoveryRepair.ThreadRecoveryRepairService],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);
export const ThreadToolkit = Toolkit.make(
  ThreadRecoverTool,
  ThreadRepairTool,
  ScheduledTaskRunTool,
  ThreadSearchTool,
  SubagentPromoteTool,
  SubagentPromotionCancelTool,
  SubagentPromotionStatusTool,
  ThreadArchiveFamilyTool,
  ThreadConfigureTool,
  ThreadTransferTool,
  ThreadOrganizeTool,
  PendingRequestTool,
  QueueTool,
);
