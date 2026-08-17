import {
  ActionResumeError,
  ActionResumeState,
  PreviewAutomationUnavailableError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext];
const ActionResumeToolError = Schema.Union([ActionResumeError, PreviewAutomationUnavailableError]);

const ListedProjectAction = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  resumeEligible: Schema.Boolean,
  disabledReason: Schema.NullOr(Schema.String),
});

export const ListProjectActionsTool = Tool.make("list_project_actions", {
  description:
    "List every saved Project Action for this thread's project, including its stable id, name, whether it is opted in for agent-triggered one-shot resume, and a safe reason when it is disabled. Call this before run_project_action_and_resume; never guess an Action id.",
  parameters: Schema.Struct({}),
  success: Schema.Struct({ actions: Schema.Array(ListedProjectAction) }),
  failure: ActionResumeToolError,
  dependencies,
})
  .annotate(Tool.Title, "List Project Actions")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const RunProjectActionAndResumeTool = Tool.make("run_project_action_and_resume", {
  description:
    "Launch one explicitly opted-in Project Action in a dedicated terminal, arm exactly one same-thread automated follow-up, and return immediately. The Action may run indefinitely; do not poll it. The user can cancel it from LastCode. Use only an eligible id returned by list_project_actions.",
  parameters: Schema.Struct({ actionId: Schema.String }),
  success: ActionResumeState,
  failure: ActionResumeToolError,
  dependencies,
})
  .annotate(Tool.Title, "Run Project Action and resume")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false);

export const ActionResumeToolkit = Toolkit.make(
  ListProjectActionsTool,
  RunProjectActionAndResumeTool,
);
