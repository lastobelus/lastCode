import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { ProjectionStoreV2 } from "./ProjectionStore.ts";

// The writer calls this inside the transaction that appends the merged event.
export const mergeProviderBackgroundRoster = Effect.fnUntraced(function* (
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
  projectionStore: Pick<ProjectionStoreV2["Service"], "getThreadRecords">,
) {
  const merged = yield* Effect.forEach(events, (event) =>
    Effect.gen(function* () {
      if (event.type !== "provider-thread.updated") return [event];
      const projection = yield* projectionStore
        .getThreadRecords(event.threadId, ["providerThreads"], {
          providerThreadIds: [event.payload.id],
        })
        .pipe(
          Effect.catchTags({
            ProjectionStoreThreadNotFoundError: () => Effect.succeed(null),
          }),
        );
      const current = projection?.providerThreads[0];
      if (
        current === undefined ||
        current.providerSessionId === null ||
        current.providerSessionId !== event.payload.providerSessionId
      )
        return [];
      return [
        {
          ...event,
          payload: {
            ...current,
            pendingBackgroundTasks: event.payload.pendingBackgroundTasks,
            owedBackgroundResults: event.payload.owedBackgroundResults,
            updatedAt: event.occurredAt,
          },
        },
      ];
    }),
  );
  return merged.flat();
});
