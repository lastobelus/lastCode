import {
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  ThreadAttention,
  ThreadAttentionToolError,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLifecycle from "../../../orchestration-v2/ThreadLifecycleService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadLifecycle.ThreadLifecycleService,
  ThreadManagementService.ThreadManagementService,
  Crypto.Crypto,
];
const result = Schema.Struct({ attention: Schema.NullOr(ThreadAttention) });
const failure = Schema.Union([
  ThreadAttentionToolError,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
]);

const SetThreadAttentionTool = Tool.make("set_thread_attention", {
  description:
    "Mark this thread as waiting for the user to answer a question. Call this immediately before ending a turn only when your final response contains a question that blocks useful progress. The thread is derived from your authenticated session; never identify a thread yourself.",
  parameters: Schema.Struct({ kind: Schema.Literal("question") }),
  success: result,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Mark thread as awaiting an answer")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const ClearThreadAttentionTool = Tool.make("clear_thread_attention", {
  description:
    "Clear a question marker you previously set when the question was withdrawn or no answer is required. A user reply clears the marker automatically.",
  parameters: Schema.Record(Schema.String, Schema.Never),
  success: result,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Clear thread attention")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadAttentionToolkit = Toolkit.make(
  SetThreadAttentionTool,
  ClearThreadAttentionTool,
);
