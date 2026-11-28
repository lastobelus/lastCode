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
    "Launch an eligible Action from list_project_actions and end your turn for the same-thread follow-up. The user can cancel the command. A delegated launch requires a verified execution source. If refused, end your turn and hand the Action request to your parent.",
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
    "Queue the retained result of an interrupted Project Action this thread launched. The command does not run again. Requires a result available for delivery and leaves running or pending follow-ups alone. After success, end your turn for the follow-up.",
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
    "Drop the retained follow-up for an interrupted Project Action this thread launched. Requires a result available for delivery and leaves running or pending follow-ups alone. Use inspect_action_run to check the command's outcome or resume_interrupted_action to continue from the result.",
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
