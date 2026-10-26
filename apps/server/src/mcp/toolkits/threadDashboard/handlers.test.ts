import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Command,
  type ThreadDashboardItemInput,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadLifecycle from "../../../orchestration-v2/ThreadLifecycleService.ts";
import { threadDashboardHandlers } from "./handlers.ts";

it.effect(
  "updates dashboard items only on the authenticated thread and returns saved state",
  () => {
    const commands: Array<OrchestrationV2Command> = [];
    const boundThreadId = ThreadId.make("bound-thread");
    const item: ThreadDashboardItemInput = {
      id: "question-1",
      title: "Choose a direction",
      body: "Choose a direction for the next step.",
      kind: "question",
      status: "open",
      priority: "normal",
      effort: "quick",
      requiresComputer: false,
    };
    const saved = {
      ...item,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const lifecycle = Layer.mock(ThreadLifecycle.ThreadLifecycleService)({
      upsertDashboardItem: (input) =>
        Effect.sync(() => {
          commands.push({ type: "thread.dashboard-item.upsert", ...input });
          return { thread: { id: input.threadId, dashboardItems: [saved] } } as never;
        }),
      removeDashboardItem: (input) =>
        Effect.sync(() => {
          commands.push({ type: "thread.dashboard-item.remove", ...input });
          return { thread: { id: input.threadId, dashboardItems: [] } } as never;
        }),
    });
    const invocation: McpInvocationContext.McpInvocationScope = {
      environmentId: EnvironmentId.make("environment-1"),
      thread: {
        threadId: boundThreadId,
        providerSessionId: "provider-session-1",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
      capabilities: new Set(["orchestration"]),
      issuedAt: 0,
      requestNamespace: "thread:bound-thread",
    };
    return Effect.gen(function* () {
      const upsert = yield* threadDashboardHandlers.upsert_dashboard_item({ item });
      const remove = yield* threadDashboardHandlers.remove_dashboard_item({ itemId: item.id });
      expect(upsert.items).toEqual([saved]);
      expect(remove.items).toEqual([]);
      expect(commands.map((command) => command.type)).toEqual([
        "thread.dashboard-item.upsert",
        "thread.dashboard-item.remove",
      ]);
      expect(
        commands.every((command) => "threadId" in command && command.threadId === boundThreadId),
      ).toBe(true);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          lifecycle,
          Layer.succeed(McpInvocationContext.McpInvocationContext, invocation),
        ),
      ),
    );
  },
);
