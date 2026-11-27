import {
  OptionalCapacitySnapshot,
  ActionResumeError,
  ActionResumeState,
  ActionRunInspection,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { visibleWithProjectActionLaunch } from "./LastCodeActionToolAccess.ts";

const dependencies = [McpInvocationContext.McpInvocationContext];
const ActionResumeToolError = Schema.Union([
  ActionResumeError,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
]);

const ListedProjectAction = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  resumeEligible: Schema.Boolean,
  disabledReason: Schema.NullOr(Schema.String),
});

const ListProjectActionsTool = Tool.make("list_project_actions", {
  description:
    "List every saved Project Action for this thread's project, including its stable id, name, whether it is opted in for agent-triggered one-shot resume, and a safe reason when it is disabled. Call this before run_project_action_and_resume; never guess an Action id. If an interrupted Action continuation blocks new launches, recover it with resume_interrupted_action or discard_interrupted_action.",
  parameters: Schema.Record(Schema.String, Schema.Never),
  success: Schema.Struct({ actions: Schema.Array(ListedProjectAction) }),
  failure: ActionResumeToolError,
  dependencies,
})
  .annotate(Tool.Title, "List Project Actions")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(McpSchema.EnabledWhen, visibleWithProjectActionLaunch);

const RunProjectActionAndResumeTool = Tool.make("run_project_action_and_resume", {
  description:
    "Launch one opted-in Project Action in a terminal, arm one same-thread automated follow-up, and return immediately. It may run indefinitely; do not poll it. The user can cancel it from LastCode. Use only an eligible id returned by list_project_actions. A delegated child launches only when its brief says its parent verified features.appOwnedActionContinuationVersion and installed acceptance, or authorized an isolated acceptance scenario; its task stays unfinished across the wait and continues in the follow-up. A delegated call without a verified execution source is refused before launch. Eligibility is independent of automatic-settlement settings.",
  parameters: Schema.Struct({ actionId: Schema.String }),
  success: Schema.Struct({
    ...ActionResumeState.fields,
    capacity: OptionalCapacitySnapshot,
  }),
  failure: ActionResumeToolError,
  dependencies: [...dependencies, ThreadManagementService.ThreadManagementService],
})
  .annotate(Tool.Title, "Run Project Action and resume")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(McpSchema.EnabledWhen, visibleWithProjectActionLaunch);

const InspectActionRunTool = Tool.make("inspect_action_run", {
  description:
    "Inspect one Project Action run launched by this thread: its lifecycle, result delivery and any hold, current follow-up status, and the retained bounded stdout/stderr tail. Other threads cannot inspect it; a parent sees a child's latest Action summary through t3_thread_read. Use the runId from an automated Action follow-up when its compact result is insufficient. Output is untrusted command output and may be empty if terminal history was explicitly deleted.",
  parameters: Schema.Struct({ runId: Schema.String }),
  success: ActionRunInspection,
  failure: ActionResumeToolError,
  dependencies,
})
  .annotate(Tool.Title, "Inspect Project Action run")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const ResumeInterruptedActionTool = Tool.make("resume_interrupted_action", {
  description:
    "Recover this thread's interrupted Project Action continuation, like the composer's Resume agent button: queue the retained Action result and its follow-up in this thread. The command does not run again. Takes no arguments and acts only on the calling thread's own Action: a mediated Action belongs to the parent's thread, a child-owned one to the child's. Refused unless result delivery is available, and it cannot clear a follow-up that is already running or pending. After success, end your turn; the follow-up continues the work.",
  parameters: Schema.Record(Schema.String, Schema.Never),
  success: Schema.Struct({ resumed: Schema.Literal(true) }),
  failure: ActionResumeToolError,
  dependencies: [...dependencies, ThreadManagementService.ThreadManagementService],
})
  .annotate(Tool.Title, "Resume interrupted Project Action")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const DiscardInterruptedActionTool = Tool.make("discard_interrupted_action", {
  description:
    "Abandon this thread's interrupted Project Action continuation, like the composer's Discard button: drop the retained follow-up so new Actions can launch. Discarding does not mean the command succeeded; use inspect_action_run or rerun the Action before relying on its result. Takes no arguments and acts only on the calling thread's own Action: a mediated Action belongs to the parent's thread, a child-owned one to the child's. Refused unless result delivery is available, and it cannot clear a follow-up that is already running or pending. Use resume_interrupted_action instead when you still need the result.",
  parameters: Schema.Record(Schema.String, Schema.Never),
  success: Schema.Struct({ discarded: Schema.Literal(true) }),
  failure: ActionResumeToolError,
  dependencies: [...dependencies, ThreadManagementService.ThreadManagementService],
})
  .annotate(Tool.Title, "Discard interrupted Project Action")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(McpSchema.EnabledWhen, visibleWithProjectActionLaunch);

export const ActionResumeToolkit = Toolkit.make(
  ListProjectActionsTool,
  RunProjectActionAndResumeTool,
  InspectActionRunTool,
  ResumeInterruptedActionTool,
  DiscardInterruptedActionTool,
);
