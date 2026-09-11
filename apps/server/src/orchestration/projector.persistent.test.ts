import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-08-30T00:00:00.000Z";

function event(sequence: number, type: OrchestrationEvent["type"], payload: unknown) {
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    type,
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-new"),
    occurredAt: NOW,
    commandId: CommandId.make(`command-${sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload,
  } as OrchestrationEvent;
}

const created = (sequence: number, threadId: string) =>
  event(sequence, "thread.created", {
    threadId: ThreadId.make(threadId),
    projectId: ProjectId.make("project-1"),
    title: threadId,
    modelSelection: { provider: "codex", model: "gpt-5.6" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: NOW,
    updatedAt: NOW,
  });

it.effect("projects persistent thread replacement atomically", () =>
  Effect.gen(function* () {
    const withOld = yield* projectEvent(createEmptyReadModel(NOW), created(1, "thread-old"));
    const withBoth = yield* projectEvent(withOld, created(2, "thread-new"));
    const oldPersistent = yield* projectEvent(
      withBoth,
      event(3, "thread.persistence-changed", {
        threadId: ThreadId.make("thread-old"),
        persistentThreadId: ThreadId.make("thread-old"),
        replacedThreadId: null,
        updatedAt: NOW,
      }),
    );
    const replaced = yield* projectEvent(
      oldPersistent,
      event(4, "thread.persistence-changed", {
        threadId: ThreadId.make("thread-new"),
        persistentThreadId: ThreadId.make("thread-new"),
        replacedThreadId: ThreadId.make("thread-old"),
        updatedAt: NOW,
      }),
    );
    expect(replaced.threads.find((thread) => thread.id === "thread-old")?.persistent).toBe(false);
    expect(replaced.threads.find((thread) => thread.id === "thread-new")?.persistent).toBe(true);
  }),
);
