import {
  type EnvironmentId,
  type OrchestratorMcpThreadReadInput,
  type OrchestratorMcpThreadReadResult,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import * as EnvironmentRegistry from "./registry.ts";
import { request, subscribe } from "../rpc/client.ts";

const isThreadNotFound = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "thread_not_found";

/** Searches authorized destinations without forwarding a lookup back to its source. */
export const resolveThreadRead = Effect.fn("connection.resolveThreadRead")(function* <E, R>(
  sourceEnvironmentId: EnvironmentId,
  input: OrchestratorMcpThreadReadInput,
  entries: ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>,
  read: (
    environmentId: EnvironmentId,
    input: OrchestratorMcpThreadReadInput,
  ) => Effect.Effect<OrchestratorMcpThreadReadResult, E, R>,
) {
  const candidates = [...entries.entries()]
    .filter(
      ([environmentId, entry]) =>
        environmentId !== sourceEnvironmentId &&
        entry.enabled &&
        (input.environmentId === undefined || input.environmentId === environmentId),
    )
    .map(([environmentId]) => environmentId);
  const unavailable = new Set<EnvironmentId>();
  // Start every destination within the same timeout window, and interrupt the
  // remaining requests as soon as one returns the requested history.
  const result =
    candidates.length === 0
      ? null
      : yield* Effect.raceAll(
          candidates.map((environmentId) =>
            read(environmentId, input).pipe(
              Effect.timeout("5 seconds"),
              Effect.filterOrFail(
                (result) =>
                  result.thread.environmentId === environmentId &&
                  result.thread.threadId === input.threadId,
              ),
              Effect.tapError((error) =>
                Effect.sync(() => {
                  if (!isThreadNotFound(error)) unavailable.add(environmentId);
                }),
              ),
            ),
          ),
        ).pipe(Effect.orElseSucceed(() => null));
  if (
    input.environmentId !== undefined &&
    input.environmentId !== sourceEnvironmentId &&
    !candidates.includes(input.environmentId)
  ) {
    unavailable.add(input.environmentId);
  }
  return { result, unavailableEnvironmentIds: [...unavailable] };
});

/** Every client can broker reads using its existing authenticated environment connections. */
export const watchThreadReadRequests = Effect.fn("connection.watchThreadReadRequests")(
  function* () {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const subscriptions = new Map<EnvironmentId, Fiber.Fiber<void>>();
    yield* SubscriptionRef.changes(registry.entries).pipe(
      Stream.runForEach((entries) =>
        Effect.gen(function* () {
          for (const [environmentId, fiber] of subscriptions) {
            if (entries.get(environmentId)?.enabled === true) continue;
            yield* Fiber.interrupt(fiber);
            subscriptions.delete(environmentId);
          }
          for (const [environmentId, entry] of entries) {
            if (!entry.enabled || subscriptions.has(environmentId)) continue;
            const fiber = yield* registry
              .followStream(
                environmentId,
                subscribe(
                  WS_METHODS.threadReadConnect,
                  {},
                  {
                    // A connection without read permission cannot broker history. A new
                    // authenticated session may grant it, so keep watching session changes.
                    onExpectedFailure: () => Effect.void,
                  },
                ),
              )
              .pipe(
                Stream.mapEffect(
                  (event) =>
                    Effect.gen(function* () {
                      const destinations = yield* SubscriptionRef.get(registry.entries);
                      const response = yield* resolveThreadRead(
                        environmentId,
                        event.input,
                        destinations,
                        (destination, input) =>
                          registry.run(destination, request(WS_METHODS.threadReadLocal, input)),
                      );
                      yield* registry.run(
                        environmentId,
                        request(WS_METHODS.threadReadRespond, {
                          connectionId: event.connectionId,
                          requestId: event.requestId,
                          ...response,
                        }),
                      );
                    }).pipe(
                      Effect.catch((error) =>
                        Effect.logWarning("Could not answer a remote thread read.", { error }),
                      ),
                    ),
                  { concurrency: 4 },
                ),
                Stream.runDrain,
                Effect.catch((error) =>
                  Effect.logWarning("Remote thread read subscription stopped.", { error }),
                ),
                Effect.forkScoped,
              );
            subscriptions.set(environmentId, fiber);
          }
        }),
      ),
    );
  },
);
