import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadLifecycle from "../../../orchestration-v2/ThreadLifecycleService.ts";
import { threadAttentionHandlers } from "./handlers.ts";

it.effect("dispatches attention commands only to the authenticated thread", () => {
  const commands: Array<OrchestrationV2Command> = [];
  const boundThreadId = ThreadId.make("bound-thread");
  const lifecycle = Layer.mock(ThreadLifecycle.ThreadLifecycleService)({
    setAttention: (input) =>
      Effect.sync(() => {
        commands.push({ type: "thread.attention.set", ...input });
        return { thread: { id: input.threadId } } as never;
      }),
    clearAttention: (input) =>
      Effect.sync(() => {
        commands.push({ type: "thread.attention.clear", ...input });
        return { thread: { id: input.threadId } } as never;
      }),
  });
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: boundThreadId,
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(),
    issuedAt: 0,
  };

  const testLayer = Layer.mergeAll(
    NodeServices.layer,
    lifecycle,
    Layer.succeed(McpInvocationContext.McpInvocationContext, invocation),
  );

  return Effect.gen(function* () {
    const marked = yield* threadAttentionHandlers.set_thread_attention({
      kind: "question",
    });
    const cleared = yield* threadAttentionHandlers.clear_thread_attention();

    expect(marked.attention.kind).toBe("question");
    expect(cleared.attention).toBeNull();
    expect(commands.map((command) => command.type)).toEqual([
      "thread.attention.set",
      "thread.attention.clear",
    ]);
    expect(
      commands.every((command) => "threadId" in command && command.threadId === boundThreadId),
    ).toBe(true);
  }).pipe(Effect.provide(testLayer));
});
