import { CommandId, ThreadAttentionToolError } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ThreadLifecycle from "../../../orchestration-v2/ThreadLifecycleService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ThreadAttentionToolkit } from "./tools.ts";

const dispatchFailure = () =>
  new ThreadAttentionToolError({
    message: "Could not update this thread's attention status.",
  });

export const threadAttentionHandlers = {
  set_thread_attention: ({ kind }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("orchestration");
      const invocation = yield* McpInvocationContext.requireThreadScope(
        scope,
        "set_thread_attention",
      );
      const threads = yield* ThreadLifecycle.ThreadLifecycleService;
      const crypto = yield* Crypto.Crypto;
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const attention = { kind, raisedAt: createdAt } as const;
      yield* threads
        .setAttention({
          commandId: CommandId.make(
            `mcp:thread-attention:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
          ),
          threadId: invocation.thread.threadId,
          attention,
        })
        .pipe(Effect.mapError(dispatchFailure));
      return { attention };
    }),
  clear_thread_attention: () =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("orchestration");
      const invocation = yield* McpInvocationContext.requireThreadScope(
        scope,
        "clear_thread_attention",
      );
      const threads = yield* ThreadLifecycle.ThreadLifecycleService;
      const crypto = yield* Crypto.Crypto;
      yield* threads
        .clearAttention({
          commandId: CommandId.make(
            `mcp:thread-attention:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
          ),
          threadId: invocation.thread.threadId,
        })
        .pipe(Effect.mapError(dispatchFailure));
      return { attention: null };
    }),
} satisfies Parameters<typeof ThreadAttentionToolkit.toLayer>[0];

export const ThreadAttentionToolkitHandlersLive =
  ThreadAttentionToolkit.toLayer(threadAttentionHandlers);
