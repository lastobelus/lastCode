import {
  EnvironmentId,
  OrchestratorMcpFailure,
  type OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import { ConnectionTransientError, PrimaryConnectionTarget } from "./model.ts";
import { resolveThreadRead } from "./threadRead.ts";

const source = EnvironmentId.make("source");
const destination = EnvironmentId.make("destination");
const other = EnvironmentId.make("other");
const threadId = ThreadId.make("archived-thread");
const input: OrchestratorMcpThreadReadInput = {
  threadId,
  view: "activity",
  afterPosition: 42,
  limit: 5,
  maxCharsPerItem: 100,
};

function entries(...values: Array<readonly [EnvironmentId, boolean]>) {
  return new Map<EnvironmentId, ConnectionCatalogEntry>(
    values.map(([environmentId, enabled]) => [
      environmentId,
      {
        target: new PrimaryConnectionTarget({
          environmentId,
          label: environmentId,
          httpBaseUrl: "https://workstation.example",
          wsBaseUrl: "wss://workstation.example",
        }),
        enabled,
        profile: Option.none(),
      },
    ]),
  );
}

const decodeThreadReadResult = Schema.decodeUnknownSync(OrchestratorMcpThreadReadResult);

function result(environmentId = destination, id = threadId) {
  return decodeThreadReadResult({
    thread: {
      threadId: id,
      environmentId,
      link: `[Archived thread](t3-thread://v1/${environmentId}/${id})`,
      projectId: "project",
      title: "Archived thread",
      createdBy: "user",
      creationSource: "web",
      status: "idle",
      latestRunId: null,
      activeRunId: null,
      providerInstanceId: "codex",
      model: "model",
      runtimeMode: "full-access",
      interactionMode: "default",
      linkedPullRequest: null,
      titleRegeneration: null,
      branch: null,
      worktreePath: null,
      parentThreadId: null,
      relationshipToParent: null,
      runCount: 0,
      itemCount: 0,
      pendingRequestCount: 0,
      archived: true,
      settled: true,
      settledAt: null,
      snoozed: false,
      snoozedUntil: null,
      createdAt: "2026-10-08T00:00:00.000Z",
      updatedAt: "2026-10-08T00:00:00.000Z",
    },
    recentRuns: [],
    items: [],
    nextPosition: 43,
    hasMore: true,
  });
}

const notFound = () =>
  Effect.fail(new OrchestratorMcpFailure({ code: "thread_not_found", message: "Missing" }));

describe("connected environment thread reads", () => {
  it.effect(
    "finds archived IDs and preserves all paging options without revisiting the source",
    () =>
      Effect.gen(function* () {
        const calls: Array<readonly [EnvironmentId, OrchestratorMcpThreadReadInput]> = [];
        const found = result();
        const response = yield* resolveThreadRead(
          source,
          input,
          entries([source, true], [other, true], [destination, true]),
          (environmentId, requestInput) => {
            calls.push([environmentId, requestInput]);
            return environmentId === destination ? Effect.succeed(found) : notFound();
          },
        );
        expect(calls).toEqual([
          [other, input],
          [destination, input],
        ]);
        expect(response).toEqual({ result: found, unavailableEnvironmentIds: [] });
      }),
  );

  it.effect("only searches the explicitly requested environment", () =>
    Effect.gen(function* () {
      const calls: EnvironmentId[] = [];
      const response = yield* resolveThreadRead(
        source,
        { ...input, environmentId: destination },
        entries([source, true], [other, true], [destination, true]),
        (environmentId) => {
          calls.push(environmentId);
          return Effect.succeed(result());
        },
      );
      expect(calls).toEqual([destination]);
      expect(response.result?.thread.environmentId).toBe(destination);
    }),
  );

  it.effect("reports denied or disconnected destinations while continuing the search", () =>
    Effect.gen(function* () {
      const denied = new OrchestratorMcpFailure({ code: "capability_denied", message: "Denied" });
      const response = yield* resolveThreadRead(
        source,
        input,
        entries([other, true], [destination, true]),
        (environmentId) =>
          environmentId === other ? Effect.fail(denied) : Effect.succeed(result()),
      );
      expect(response.result?.thread.environmentId).toBe(destination);
      expect(response.unavailableEnvironmentIds).toEqual([other]);
      const disconnected = yield* resolveThreadRead(
        source,
        input,
        entries([destination, true]),
        () =>
          Effect.fail(
            new ConnectionTransientError({ reason: "transport", detail: "Socket disconnected" }),
          ),
      );
      expect(disconnected).toEqual({ result: null, unavailableEnvironmentIds: [destination] });
    }),
  );

  it.effect(
    "does not probe disabled environments and reports an explicitly unavailable target",
    () =>
      Effect.gen(function* () {
        const calls: EnvironmentId[] = [];
        const response = yield* resolveThreadRead(
          source,
          input,
          entries([destination, false]),
          (environmentId) => {
            calls.push(environmentId);
            return notFound();
          },
        );
        expect(calls).toEqual([]);
        expect(response).toEqual({ result: null, unavailableEnvironmentIds: [] });
        const explicit = yield* resolveThreadRead(
          source,
          { ...input, environmentId: destination },
          entries([destination, false]),
          () => notFound(),
        );
        expect(explicit.unavailableEnvironmentIds).toEqual([destination]);
      }),
  );

  it.effect("rejects results for a different environment or thread", () =>
    Effect.gen(function* () {
      for (const mismatched of [
        result(other),
        result(destination, ThreadId.make("wrong-thread")),
      ]) {
        const response = yield* resolveThreadRead(source, input, entries([destination, true]), () =>
          Effect.succeed(mismatched),
        );
        expect(response).toEqual({ result: null, unavailableEnvironmentIds: [destination] });
      }
    }),
  );

  it.effect("returns successful history immediately and cancels a stalled destination", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const canceled = yield* Deferred.make<void>();
      const found = result();
      const response = yield* resolveThreadRead(
        source,
        input,
        entries([other, true], [destination, true]),
        (environmentId) =>
          environmentId === other
            ? Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Deferred.succeed(canceled, undefined)),
              )
            : Deferred.await(started).pipe(Effect.as(found)),
      );
      yield* Deferred.await(canceled);
      expect(response).toEqual({ result: found, unavailableEnvironmentIds: [] });
    }),
  );

  it.effect("starts a reachable destination even after twelve stalled candidates", () =>
    Effect.gen(function* () {
      const stale = Array.from({ length: 12 }, (_, index) => EnvironmentId.make(`stale-${index}`));
      const started = yield* Effect.forEach(stale, () => Deferred.make<void>());
      const canceled = yield* Effect.forEach(stale, () => Deferred.make<void>());
      const found = result();
      const response = yield* resolveThreadRead(
        source,
        input,
        entries(...stale.map((id) => [id, true] as const), [destination, true]),
        (environmentId) => {
          const index = stale.indexOf(environmentId);
          return index === -1
            ? Effect.forEach(started, Deferred.await).pipe(Effect.as(found))
            : Deferred.succeed(started[index]!, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Deferred.succeed(canceled[index]!, undefined)),
              );
        },
      );
      yield* Effect.forEach(canceled, Deferred.await);
      expect(response).toEqual({ result: found, unavailableEnvironmentIds: [] });
    }),
  );

  it.effect(
    "waits for bounded failures before reporting a miss with unavailable destinations",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const pending = yield* resolveThreadRead(
          source,
          input,
          entries([other, true], [destination, true]),
          (environmentId) =>
            environmentId === other
              ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
              : notFound(),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* TestClock.adjust("5 seconds");
        expect(yield* Fiber.join(pending)).toEqual({
          result: null,
          unavailableEnvironmentIds: [other],
        });
      }),
  );
});
