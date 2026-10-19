import { ThreadRecoveryInput, ThreadRecoveryResult, ThreadRepairResult } from "@t3tools/contracts";
import * as ThreadRecovery from "../../../orchestration-v2/ThreadRecoveryService.ts";
import * as ThreadRecoveryRepair from "../../../orchestration-v2/ThreadRecoveryRepairService.ts";
import {
  ScheduledTaskId,
  ScheduledTask,
  OrchestrationSearchThreadsInput,
  OrchestrationSearchThreadsResult,
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
  .annotate(Tool.Destructive, true);

const queueTarget = { threadId: Schema.optional(ThreadId), queuedRunId: RunId };
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
const QueueListTool = Tool.make("t3_queue_list", {
  ...commandTool,
  description:
    "List queued messages in delivery order. Results are a live offset page; use t3_thread_read for full thread history.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    cursor: Schema.optional(NonNegativeInt),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  }),
  success: Schema.Struct({
    items: Schema.Array(queueEntry),
    nextCursor: Schema.NullOr(NonNegativeInt),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const QueueReadTool = Tool.make("t3_queue_read", {
  ...commandTool,
  description: "Read up to 16,000 characters of a queued message. Omit threadId for this thread.",
  parameters: Schema.Struct(queueTarget),
  success: queueEntry,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const QueueEditTool = Tool.make("t3_queue_edit", {
  ...commandTool,
  description:
    "Replace a queued message's text, preserving its attachments. The service rejects runs that are no longer queued.",
  parameters: Schema.Struct({
    ...queueTarget,
    text: Schema.String.check(Schema.isMaxLength(100000)),
  }),
}).annotate(Tool.Destructive, true);
const QueueCancelTool = Tool.make("t3_queue_cancel", {
  ...commandTool,
  description: "Cancel a queued run using the existing queue command.",
  parameters: Schema.Struct(queueTarget),
}).annotate(Tool.Destructive, true);
const QueueReorderTool = Tool.make("t3_queue_reorder", {
  ...commandTool,
  description: "Move a queued run before another queued run, or to the end with beforeRunId=null.",
  parameters: Schema.Struct({ ...queueTarget, beforeRunId: Schema.NullOr(RunId) }),
}).annotate(Tool.Destructive, true);
const QueuePromoteTool = Tool.make("t3_queue_promote_to_steer", {
  ...commandTool,
  description:
    "Deliver a queued message as steering to the specified active run. Existing provider and run-state rules apply.",
  parameters: Schema.Struct({ ...queueTarget, targetRunId: RunId }),
}).annotate(Tool.Destructive, true);

const requestTarget = { threadId: Schema.optional(ThreadId), requestId: RuntimeRequestId };
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
const pendingRequest = Schema.Struct({
  requestId: RuntimeRequestId,
  questions: Schema.Array(question),
});
const PendingRequestListTool = Tool.make("t3_pending_request_list", {
  ...commandTool,
  description:
    "List pending user questions in a thread. Omit threadId for this thread. Approval requests are not included.",
  parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: Schema.Struct({ requestIds: Schema.Array(RuntimeRequestId) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const PendingRequestReadTool = Tool.make("t3_pending_request_read", {
  ...commandTool,
  description:
    "Read a pending user question. Answer with t3_pending_request_respond; existing live or message response handling is used.",
  parameters: Schema.Struct(requestTarget),
  success: pendingRequest,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const PendingRequestRespondTool = Tool.make("t3_pending_request_respond", {
  ...commandTool,
  description:
    "Answer a pending user-input request using the existing runtime response command. This cannot approve a permission request.",
  parameters: Schema.Struct({ ...requestTarget, answers: ProviderUserInputAnswers }),
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

const ThreadConfigurationTool = Tool.make("t3_thread_configuration", {
  ...commandTool,
  description:
    "Read a thread's provider/model selection and modes. Omit threadId for this thread. orchestrator_capabilities lists available providers and models.",
  parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: Schema.Struct({
    threadId: ThreadId,
    modelSelection: ModelSelection,
    runtimeMode: RuntimeMode,
    interactionMode: ProviderInteractionMode,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ThreadConfigureTool = Tool.make("t3_thread_configure", {
  ...commandTool,
  description:
    "Set a thread's provider, model and options with the existing selection command. Omit threadId for this thread. This does not change permission modes. Use orchestrator_capabilities to choose a selection.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    modelSelection: ModelSelection,
  }),
}).annotate(Tool.Destructive, true);

const transferResult = Schema.Struct({ sequence: NonNegativeInt, targetThreadId: ThreadId });
const ThreadForkTool = Tool.make("t3_thread_fork", {
  ...commandTool,
  description:
    "Fork a thread from a stable run or checkpoint using the existing fork command. Omit threadId to fork this thread. The fork inherits the source configuration. Acceptance does not mean a provider turn has completed.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    sourcePoint: OrchestrationV2ThreadForkSourcePoint,
    title: Schema.optional(TrimmedNonEmptyString),
  }),
  success: transferResult,
}).annotate(Tool.Destructive, true);
const ThreadMergeBackTool = Tool.make("t3_thread_merge_back", {
  ...commandTool,
  description:
    "Merge context from a thread back to a related thread in the same project. Omit sourceThreadId to merge from this thread. Existing lineage and transfer rules apply.",
  parameters: Schema.Struct({
    sourceThreadId: Schema.optional(ThreadId),
    targetThreadId: ThreadId,
    sourcePoint: OrchestrationV2ThreadForkSourcePoint,
  }),
  success: transferResult,
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
const ThreadTransfersTool = Tool.make("t3_thread_transfers", {
  ...commandTool,
  description: "Read context transfer status for a thread. Omit threadId for this thread.",
  parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: Schema.Struct({
    transfers: Schema.Array(
      Schema.Struct({
        id: OrchestrationV2ContextTransfer.fields.id,
        sourceThreadId: OrchestrationV2ContextTransfer.fields.sourceThreadId,
        targetThreadId: OrchestrationV2ContextTransfer.fields.targetThreadId,
        status: OrchestrationV2ContextTransfer.fields.status,
      }),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ThreadSearchTool = Tool.make("t3_thread_search", {
  ...commandTool,
  description:
    "Search active thread titles and content with the app's existing bounded search. Matches are limited to one project (projectId, else the calling thread's project) out of the global top matches, so this may return fewer than limit. A caller outside a T3 thread that omits projectId searches every project. No pagination or exhaustive-result guarantee.",
  parameters: Schema.Struct({
    ...OrchestrationSearchThreadsInput.fields,
    projectId: Schema.optional(ProjectId),
  }),
  success: OrchestrationSearchThreadsResult,
  dependencies: [...commandTool.dependencies, ThreadSearch.ThreadSearch],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ScheduledTaskRunTool = Tool.make("run_scheduled_task_now", {
  ...commandTool,
  description:
    "Run a scheduled task now through the existing scheduler. Requires a full-access/default caller. Each call is a new manual run; completion means dispatch/bookkeeping completed, not that the provider turn finished.",
  parameters: Schema.Struct({ taskId: ScheduledTaskId }),
  success: Schema.Struct({
    taskId: ScheduledTaskId,
    threadId: ScheduledTask.fields.threadId,
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
  ThreadForkTool,
  SubagentPromoteTool,
  SubagentPromotionCancelTool,
  SubagentPromotionStatusTool,
  ThreadMergeBackTool,
  ThreadTransfersTool,
  ThreadArchiveFamilyTool,
  ThreadConfigurationTool,
  ThreadConfigureTool,
  PendingRequestListTool,
  PendingRequestReadTool,
  PendingRequestRespondTool,
  ThreadOrganizeTool,
  QueueListTool,
  QueueReadTool,
  QueueEditTool,
  QueueCancelTool,
  QueueReorderTool,
  QueuePromoteTool,
);
