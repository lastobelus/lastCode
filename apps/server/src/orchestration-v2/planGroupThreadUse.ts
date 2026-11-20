import {
  OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

type ThreadMetadataUpdate = Extract<
  OrchestrationV2DomainEvent,
  { type: "thread.metadata-updated" }
>;
const isThread = Schema.is(OrchestrationV2AppThread);

export const planGroupThreadUse = Effect.fnUntraced(function* <E>(input: {
  readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  readonly readStoredThread: (threadId: ThreadId) => Effect.Effect<OrchestrationV2AppThread, E>;
  readonly readPlannedThread: (threadId: ThreadId) => Effect.Effect<OrchestrationV2AppThread, E>;
  readonly makeMetadataUpdate: (
    event: Omit<ThreadMetadataUpdate, "id">,
  ) => Effect.Effect<ThreadMetadataUpdate, E>;
}) {
  const usedThreads = new Set<ThreadId>();
  for (const event of input.events) {
    if (
      (event.type === "run.created" && event.payload.ordinal === 1) ||
      (event.type === "message.updated" && event.payload.runId === null)
    ) {
      usedThreads.add(event.threadId);
    }
  }
  const updates: ThreadMetadataUpdate[] = [];
  for (const threadId of usedThreads) {
    const planned = input.events.findLast(
      (event) =>
        event.threadId === threadId && event.type.startsWith("thread.") && isThread(event.payload),
    )?.payload;
    const thread = isThread(planned) ? planned : yield* input.readStoredThread(threadId);
    if (thread.groupThread !== true) continue;

    // Commit the clear after the command's other metadata and provider-thread decisions.
    const { groupThread: _groupThread, ...activeThread } = yield* input.readPlannedThread(threadId);
    updates.push(
      yield* input.makeMetadataUpdate({
        type: "thread.metadata-updated",
        threadId,
        occurredAt: activeThread.updatedAt,
        payload: activeThread,
      }),
    );
  }
  return updates.length === 0 ? input.events : [...input.events, ...updates];
});
