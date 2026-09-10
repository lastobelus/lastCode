import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

const THREAD_UPDATED_AT = "2026-01-01T00:00:00.000Z";
const ANNOTATION_UPDATED_AT = "2026-01-01T00:05:00.000Z";

function event(input: {
  readonly sequence: number;
  readonly type: OrchestrationEvent["type"];
  readonly payload: unknown;
  readonly occurredAt?: string;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    occurredAt: input.occurredAt ?? THREAD_UPDATED_AT,
    commandId: CommandId.make(`command-${input.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

it.effect("projects annotation changes without changing thread recency", () =>
  Effect.gen(function* () {
    const created = yield* projectEvent(
      createEmptyReadModel(THREAD_UPDATED_AT),
      event({
        sequence: 1,
        type: "thread.created",
        payload: {
          threadId: ThreadId.make("thread-1"),
          projectId: ProjectId.make("project-1"),
          title: "Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: THREAD_UPDATED_AT,
          updatedAt: THREAD_UPDATED_AT,
        },
      }),
    );

    const annotated = yield* projectEvent(
      created,
      event({
        sequence: 2,
        type: "thread.annotation-upserted",
        occurredAt: ANNOTATION_UPDATED_AT,
        payload: {
          threadId: ThreadId.make("thread-1"),
          annotation: {
            body: "# Note",
            anchorMessageId: MessageId.make("message-1"),
            createdAt: ANNOTATION_UPDATED_AT,
            updatedAt: ANNOTATION_UPDATED_AT,
            resolvedAt: null,
          },
        },
      }),
    );

    expect(annotated.threads[0]?.annotation?.body).toBe("# Note");
    expect(annotated.threads[0]?.updatedAt).toBe(THREAD_UPDATED_AT);
  }),
);
