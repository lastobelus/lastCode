import { CommandId, ThreadDashboardToolError } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import * as ThreadLifecycle from "../../../orchestration-v2/ThreadLifecycleService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ThreadDashboardToolkit } from "./tools.ts";

const dispatchFailure = () =>
  new ThreadDashboardToolError({ message: "Could not update this thread's dashboard items." });

export const threadDashboardHandlers = {
  upsert_dashboard_item: ({ item }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("orchestration");
      const invocation = yield* McpInvocationContext.requireThreadScope(
        scope,
        "upsert_dashboard_item",
      );
      const threads = yield* ThreadLifecycle.ThreadLifecycleService;
      const crypto = yield* Crypto.Crypto;
      const result = yield* threads
        .upsertDashboardItem({
          commandId: CommandId.make(
            `mcp:dashboard:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
          ),
          threadId: invocation.thread.threadId,
          item,
        })
        .pipe(Effect.mapError(dispatchFailure));
      return { items: result.thread.dashboardItems ?? [] };
    }),
  remove_dashboard_item: ({ itemId }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("orchestration");
      const invocation = yield* McpInvocationContext.requireThreadScope(
        scope,
        "remove_dashboard_item",
      );
      const threads = yield* ThreadLifecycle.ThreadLifecycleService;
      const crypto = yield* Crypto.Crypto;
      const result = yield* threads
        .removeDashboardItem({
          commandId: CommandId.make(
            `mcp:dashboard:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
          ),
          threadId: invocation.thread.threadId,
          itemId,
        })
        .pipe(Effect.mapError(dispatchFailure));
      return { items: result.thread.dashboardItems ?? [] };
    }),
} satisfies Parameters<typeof ThreadDashboardToolkit.toLayer>[0];

export const ThreadDashboardToolkitHandlersLive =
  ThreadDashboardToolkit.toLayer(threadDashboardHandlers);
