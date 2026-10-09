import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestratorMcpThreadReadResult,
  type ThreadReadRequest,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ThreadReadBroker from "./ThreadReadBroker.ts";

const threadId = ThreadId.make("thread-remote-example");
const environmentId = EnvironmentId.make("remote-environment");
const result: OrchestratorMcpThreadReadResult = {
  thread: {
    threadId,
    environmentId,
    link: "[Example](t3-thread://v1/remote-environment/thread-remote-example)",
    projectId: ProjectId.make("example-project"),
    title: "Example",
    createdBy: "user",
    creationSource: "web",
    status: "idle",
    latestRunId: null,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    model: "example-model",
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
    settled: false,
    settledAt: null,
    snoozed: false,
    snoozedUntil: null,
    createdAt: "2026-10-08T12:00:00Z",
    updatedAt: "2026-10-08T12:00:00Z",
  },
  recentRuns: [],
  items: [],
  nextPosition: 42,
  hasMore: true,
};

const makeBroker = ThreadReadBroker.ThreadReadBroker.pipe(
  Effect.provide(ThreadReadBroker.layer.pipe(Layer.provide(NodeCrypto.layer))),
);

describe("ThreadReadBroker", () => {
  it.effect("reports unavailable routing instead of falsely claiming the thread is missing", () =>
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      expect(yield* broker.read({ threadId }).pipe(Effect.flip)).toMatchObject({
        code: "environment_unavailable",
      });
    }),
  );

  it.effect("returns a remote result and preserves every paging option", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* makeBroker;
        const input = {
          threadId,
          environmentId,
          itemId: TurnItemId.make("example-item"),
          textOffset: 5000,
          afterPosition: 40,
          view: "activity" as const,
          limit: 2,
          runLimit: 1,
          maxCharsPerItem: 1000,
        };
        const consumer = yield* (yield* broker.connect("client-session")).pipe(
          Stream.runForEach((request) => {
            expect(request.input).toEqual(input);
            return broker.respond("client-session", {
              connectionId: request.connectionId,
              requestId: request.requestId,
              result,
              unavailableEnvironmentIds: [],
            });
          }),
          Effect.forkScoped,
        );
        expect(yield* broker.read(input)).toEqual(result);
        yield* Fiber.interrupt(consumer);
      }),
    ),
  );

  it.effect("continues past a miss from another tab sharing the same client session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* makeBroker;
        yield* (yield* broker.connect("client-session")).pipe(
          Stream.runForEach((request) =>
            broker.respond("client-session", {
              connectionId: request.connectionId,
              requestId: request.requestId,
              result: null,
              unavailableEnvironmentIds: [],
            }),
          ),
          Effect.forkScoped,
        );
        yield* (yield* broker.connect("client-session")).pipe(
          Stream.runForEach((request) =>
            broker.respond("client-session", {
              connectionId: request.connectionId,
              requestId: request.requestId,
              result,
              unavailableEnvironmentIds: [],
            }),
          ),
          Effect.forkScoped,
        );
        expect(yield* broker.read({ threadId })).toEqual(result);
      }),
    ),
  );

  it.effect("releases a pending read when its client disconnects", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* makeBroker;
        const connected = yield* Deferred.make<void>();
        const received = yield* Deferred.make<ThreadReadRequest>();
        const consumer = yield* Effect.scoped(
          Effect.gen(function* () {
            const stream = yield* broker.connect("client-session");
            yield* Deferred.succeed(connected, undefined);
            yield* stream.pipe(Stream.runForEach((request) => Deferred.succeed(received, request)));
          }),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(connected);
        const reading = yield* broker.read({ threadId }).pipe(Effect.flip, Effect.forkScoped);
        yield* Deferred.await(received);
        yield* Fiber.interrupt(consumer);
        expect(yield* Fiber.join(reading)).toMatchObject({ code: "environment_unavailable" });
      }),
    ),
  );

  it.effect("distinguishes an exhausted search from an unreachable destination", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* makeBroker;
        let unavailableEnvironmentIds: EnvironmentId[] = [];
        yield* (yield* broker.connect("client-session")).pipe(
          Stream.runForEach((request) =>
            broker.respond("client-session", {
              connectionId: request.connectionId,
              requestId: request.requestId,
              result: null,
              unavailableEnvironmentIds,
            }),
          ),
          Effect.forkScoped,
        );
        expect(yield* broker.read({ threadId }).pipe(Effect.flip)).toMatchObject({
          code: "thread_not_found",
        });
        unavailableEnvironmentIds = [environmentId];
        expect(yield* broker.read({ threadId }).pipe(Effect.flip)).toMatchObject({
          code: "environment_unavailable",
        });
      }),
    ),
  );

  it.effect("rejects unrelated sessions and mismatched results", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* makeBroker;
        const received = yield* Deferred.make<ThreadReadRequest>();
        yield* (yield* broker.connect("client-session")).pipe(
          Stream.runForEach((request) => Deferred.succeed(received, request)),
          Effect.forkScoped,
        );
        const reading = yield* broker.read({ threadId, environmentId }).pipe(Effect.forkScoped);
        const request = yield* Deferred.await(received);
        expect(
          yield* broker
            .respond("unrelated-session", {
              connectionId: request.connectionId,
              requestId: request.requestId,
              result,
              unavailableEnvironmentIds: [],
            })
            .pipe(Effect.flip),
        ).toMatchObject({ code: "capability_denied" });
        expect(
          yield* broker
            .respond("client-session", {
              connectionId: request.connectionId,
              requestId: request.requestId,
              result: {
                ...result,
                thread: {
                  ...result.thread,
                  environmentId: EnvironmentId.make("wrong-environment"),
                },
              },
              unavailableEnvironmentIds: [],
            })
            .pipe(Effect.flip),
        ).toMatchObject({ code: "invalid_request" });
        yield* broker.respond("client-session", {
          connectionId: request.connectionId,
          requestId: request.requestId,
          result,
          unavailableEnvironmentIds: [],
        });
        expect(yield* Fiber.join(reading)).toEqual(result);
      }),
    ),
  );

  it.effect("bounds an unanswered read and discards a late response", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* makeBroker;
        const received = yield* Deferred.make<ThreadReadRequest>();
        yield* (yield* broker.connect("client-session")).pipe(
          Stream.runForEach((request) => Deferred.succeed(received, request)),
          Effect.forkScoped,
        );
        const reading = yield* broker.read({ threadId }).pipe(Effect.flip, Effect.forkScoped);
        const request = yield* Deferred.await(received);
        yield* TestClock.adjust("15 seconds");
        expect(yield* Fiber.join(reading)).toMatchObject({ code: "environment_unavailable" });
        yield* broker.respond("client-session", {
          connectionId: request.connectionId,
          requestId: request.requestId,
          result,
          unavailableEnvironmentIds: [],
        });
      }),
    ),
  );
});
