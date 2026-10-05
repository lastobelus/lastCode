import {
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  ThreadDashboardItemInput,
  ThreadDashboardItems,
  ThreadDashboardToolError,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadLifecycle from "../../../orchestration-v2/ThreadLifecycleService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadLifecycle.ThreadLifecycleService,
  Crypto.Crypto,
];
const result = Schema.Struct({ items: ThreadDashboardItems });
const failure = Schema.Union([
  ThreadDashboardToolError,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
]);

const UpsertDashboardItemTool = Tool.make("upsert_dashboard_item", {
  description:
    "Create or update a dashboard item on this authenticated thread. Reuse its stable id when reporting updates. Questions, reviews, and QA requests stay open until explicitly resolved; ordinary user replies do not resolve them. Set status to resolved when the item is complete, or open to reopen it. Use metric, progress, or summary for informational reports. At most 32 items per thread. The authenticated session supplies the thread; do not identify a thread yourself.",
  parameters: Schema.Struct({ item: ThreadDashboardItemInput }),
  success: result,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Update dashboard item")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const RemoveDashboardItemTool = Tool.make("remove_dashboard_item", {
  description:
    "Remove one dashboard item from this authenticated thread by its stable id. Other requests and reports are preserved. Resolve an item instead when its completed report should remain visible.",
  parameters: Schema.Struct({ itemId: ThreadDashboardItemInput.fields.id }),
  success: result,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Remove dashboard item")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadDashboardToolkit = Toolkit.make(
  UpsertDashboardItemTool,
  RemoveDashboardItemTool,
);
