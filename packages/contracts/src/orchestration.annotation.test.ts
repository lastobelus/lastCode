import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ClientOrchestrationCommand,
  OrchestrationEvent,
  THREAD_ANNOTATION_MAX_BODY_CHARS,
  ThreadAnnotation,
} from "./orchestration.ts";

const decodeAnnotation = Schema.decodeUnknownEffect(ThreadAnnotation);
const decodeCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand);
const decodeEvent = Schema.decodeUnknownEffect(OrchestrationEvent);

it.effect("decodes Markdown annotations and rejects empty or oversized bodies", () =>
  Effect.gen(function* () {
    const annotation = yield* decodeAnnotation({
      body: "# Header\n\n- [ ] Todo\n- #tag",
      anchorMessageId: "message-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      resolvedAt: null,
    });
    assert.match(annotation.body, /#tag/);

    assert.strictEqual(
      (yield* Effect.exit(decodeAnnotation({ ...annotation, body: "   " })))._tag,
      "Failure",
    );
    assert.strictEqual(
      (yield* Effect.exit(
        decodeAnnotation({ ...annotation, body: "x".repeat(THREAD_ANNOTATION_MAX_BODY_CHARS + 1) }),
      ))._tag,
      "Failure",
    );
  }),
);

it.effect("decodes annotation client commands and domain events", () =>
  Effect.gen(function* () {
    const upsert = yield* decodeCommand({
      type: "thread.annotation.upsert",
      commandId: "command-1",
      threadId: "thread-1",
      body: "Note",
    });
    assert.strictEqual(upsert.type, "thread.annotation.upsert");

    const event = yield* decodeEvent({
      sequence: 1,
      eventId: "event-1",
      type: "thread.annotation-resolved",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      occurredAt: "2026-01-01T00:01:00.000Z",
      commandId: "command-2",
      causationEventId: null,
      correlationId: "command-2",
      metadata: {},
      payload: {
        threadId: "thread-1",
        annotation: {
          body: "Note",
          anchorMessageId: "message-2",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:01:00.000Z",
          resolvedAt: "2026-01-01T00:01:00.000Z",
        },
      },
    });
    assert.strictEqual(event.type, "thread.annotation-resolved");
  }),
);
