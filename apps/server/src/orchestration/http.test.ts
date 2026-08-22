import {
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  type OrchestrationEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { readThreadWaitUntilTerminal } from "./http.ts";

it.effect("ignores message deltas until a terminal wait event arrives", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-wait-wake-filter");
    const turnId = TurnId.make("turn-wait-wake-filter");
    const occurredAt = "2026-01-01T00:00:00.000Z";
    const events: ReadonlyArray<OrchestrationEvent> = [
      {
        sequence: 1,
        type: "thread.message-sent",
        eventId: EventId.make("evt-wait-token-delta"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt,
        commandId: CommandId.make("cmd-wait-token-delta"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-wait-token-delta"),
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.make("assistant:wait-token-delta"),
          role: "assistant",
          text: "token",
          turnId,
          streaming: true,
          createdAt: occurredAt,
          updatedAt: occurredAt,
        },
      },
      {
        sequence: 2,
        type: "thread.turn-assistant-finalized",
        eventId: EventId.make("evt-wait-assistant-finalized"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt,
        commandId: CommandId.make("cmd-wait-assistant-finalized"),
        causationEventId: null,
        correlationId: CorrelationId.make("cmd-wait-assistant-finalized"),
        metadata: {},
        payload: { threadId, turnId, finalizedAt: occurredAt },
      },
    ];
    const finalized = yield* Ref.make(false);
    const reads = yield* Ref.make(0);
    const eventQueue = yield* Queue.unbounded<OrchestrationEvent>();
    yield* Queue.offerAll(eventQueue, events);
    const eventStream = Stream.fromQueue(eventQueue).pipe(
      Stream.tap((event) =>
        event.type === "thread.turn-assistant-finalized" ? Ref.set(finalized, true) : Effect.void,
      ),
    );
    const readState = Effect.gen(function* () {
      yield* Ref.update(reads, (count) => count + 1);
      return (yield* Ref.get(finalized))
        ? ({
            kind: "terminal",
            state: "completed",
            turnId,
            response: "complete",
          } as const)
        : ({ kind: "pending" } as const);
    });

    const result = yield* readThreadWaitUntilTerminal(
      threadId,
      { kind: "pending" },
      eventStream,
      readState,
    );

    assert.deepEqual(result, {
      kind: "terminal",
      state: "completed",
      turnId,
      response: "complete",
    });
    assert.equal(yield* Ref.get(reads), 1);
  }),
);
