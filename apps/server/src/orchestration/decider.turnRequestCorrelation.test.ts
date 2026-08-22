import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel } from "./projector.ts";

it.effect("resolves tracked requests without requiring the thread to still exist", () =>
  Effect.gen(function* () {
    const event = yield* decideOrchestrationCommand({
      command: {
        type: "thread.turn-request.resolve",
        commandId: CommandId.make("turn-request:event-1"),
        threadId: ThreadId.make("deleted-thread"),
        messageId: MessageId.make("message-1"),
        outcome: { kind: "started", turnId: TurnId.make("turn-1") },
        createdAt: "2026-08-22T00:00:00.000Z",
      },
      readModel: createEmptyReadModel("2026-08-22T00:00:00.000Z"),
    });

    const isResolved = "type" in event && event.type === "thread.turn-request-resolved";
    assert.strictEqual(isResolved, true);
    if (isResolved) {
      const resolved = event as Extract<
        OrchestrationEvent,
        { readonly type: "thread.turn-request-resolved" }
      >;
      assert.strictEqual(resolved.payload.threadId, "deleted-thread");
      assert.strictEqual(resolved.payload.messageId, "message-1");
      assert.deepStrictEqual(resolved.payload.outcome, {
        kind: "started",
        turnId: TurnId.make("turn-1"),
      });
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
