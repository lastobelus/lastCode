import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
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
const sourceThreadId = ThreadId.make("source-thread");
const sourceMessageId = MessageId.make("source-message");
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

const makeBroker = Effect.gen(function* () {
  const broker = yield* ThreadReadBroker.ThreadReadBroker;
  yield* broker.authorize({
    threadId: sourceThreadId,
    messageId: sourceMessageId,
    sessionId: "client-session",
    alreadyStored: false,
  });
  return broker;
}).pipe(Effect.provide(ThreadReadBroker.layer.pipe(Layer.provide(NodeCrypto.layer))));

describe("ThreadReadBroker", () => {
  it.effect(
    "keeps running and queued inputs bound to their independently authenticated clients",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* makeBroker;
          const queuedMessageId = MessageId.make("queued-message");
          yield* broker.authorize({
            threadId: sourceThreadId,
            messageId: queuedMessageId,
            sessionId: "other-session",
            alreadyStored: false,
          });
          const delivered: string[] = [];
          for (const sessionId of ["client-session", "other-session"]) {
            yield* (yield* broker.connect(sessionId)).pipe(
              Stream.runForEach((request) => {
                delivered.push(sessionId);
                return broker.respond(sessionId, {
                  connectionId: request.connectionId,
                  requestId: request.requestId,
                  result,
                  unavailableEnvironmentIds: [],
                });
              }),
              Effect.forkScoped,
            );
          }
          expect(yield* broker.read(sourceThreadId, sourceMessageId, { threadId })).toEqual(result);
          expect(delivered).toEqual(["client-session"]);
          expect(yield* broker.read(sourceThreadId, queuedMessageId, { threadId })).toEqual(result);
          expect(delivered).toEqual(["client-session", "other-session"]);
        }),
      ),
  );

  it.effect("refuses replay claims and preserves the original input's authority", () =>
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const replayedMessageId = MessageId.make("existing-unassociated-message");
      yield* broker.authorize({
        threadId: sourceThreadId,
        messageId: replayedMessageId,
        sessionId: "other-session",
        alreadyStored: true,
      });
      yield* broker.authorize({
        threadId: sourceThreadId,
        messageId: sourceMessageId,
        sessionId: "other-session",
        alreadyStored: false,
      });
      expect(yield* broker.authorizedSession(sourceThreadId, sourceMessageId)).toBe(
        "client-session",
      );
      expect(yield* broker.authorizedSession(sourceThreadId, replayedMessageId)).toBeUndefined();
      expect(
        yield* broker.read(sourceThreadId, replayedMessageId, { threadId }).pipe(Effect.flip),
      ).toMatchObject({ code: "environment_unavailable" });
    }),
  );

  it.effect("refreshes valid authority use while expiring idle bindings", () =>
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const idleMessageId = MessageId.make("idle-message");
      yield* broker.authorize({
        threadId: sourceThreadId,
        messageId: idleMessageId,
        sessionId: "other-session",
        alreadyStored: false,
      });
      yield* TestClock.adjust("6 days");
      expect(yield* broker.authorizedSession(sourceThreadId, sourceMessageId)).toBe(
        "client-session",
      );
      yield* TestClock.adjust("6 days");
      expect(yield* broker.authorizedSession(sourceThreadId, idleMessageId)).toBeUndefined();
      expect(yield* broker.authorizedSession(sourceThreadId, sourceMessageId)).toBe(
        "client-session",
      );
      yield* TestClock.adjust("7 days");
      expect(yield* broker.authorizedSession(sourceThreadId, sourceMessageId)).toBeUndefined();
    }),
  );

  it.effect(
    "does not let a replay claim expired authority or refresh another requester's binding",
    () =>
      Effect.gen(function* () {
        const broker = yield* makeBroker;
        yield* TestClock.adjust("6 days");
        yield* broker.authorize({
          threadId: sourceThreadId,
          messageId: sourceMessageId,
          sessionId: "other-session",
          alreadyStored: false,
        });
        yield* TestClock.adjust("1 day");
        // Lazy pruning on authorize must still reject the now-stored execution.
        yield* broker.authorize({
          threadId: sourceThreadId,
          messageId: sourceMessageId,
          sessionId: "other-session",
          alreadyStored: true,
        });
        expect(yield* broker.authorizedSession(sourceThreadId, sourceMessageId)).toBeUndefined();
        expect(
          yield* broker.read(sourceThreadId, sourceMessageId, { threadId }).pipe(Effect.flip),
        ).toMatchObject({ code: "environment_unavailable" });
      }),
  );

  it.effect("evicts the least recently used binding at capacity and rejects its replay", () =>
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      for (let index = 0; index < 9_999; index++) {
        yield* broker.authorize({
          threadId: sourceThreadId,
          messageId: MessageId.make(`capacity-message-${index}`),
          sessionId: "other-session",
          alreadyStored: false,
        });
      }
      expect(yield* broker.authorizedSession(sourceThreadId, sourceMessageId)).toBe(
        "client-session",
      );
      const newestMessageId = MessageId.make("newest-message");
      yield* broker.authorize({
        threadId: sourceThreadId,
        messageId: newestMessageId,
        sessionId: "other-session",
        alreadyStored: false,
      });
      const evictedMessageId = MessageId.make("capacity-message-0");
      expect(yield* broker.authorizedSession(sourceThreadId, evictedMessageId)).toBeUndefined();
      expect(yield* broker.authorizedSession(sourceThreadId, sourceMessageId)).toBe(
        "client-session",
      );
      expect(yield* broker.authorizedSession(sourceThreadId, newestMessageId)).toBe(
        "other-session",
      );
      yield* broker.authorize({
        threadId: sourceThreadId,
        messageId: evictedMessageId,
        sessionId: "client-session",
        alreadyStored: true,
      });
      expect(yield* broker.authorizedSession(sourceThreadId, evictedMessageId)).toBeUndefined();
      expect(
        yield* broker.read(sourceThreadId, evictedMessageId, { threadId }).pipe(Effect.flip),
      ).toMatchObject({ code: "environment_unavailable" });
    }),
  );

  it.effect(
    "inherits the exact delegated parent run and fails closed for absent or cyclic ancestry",
    () =>
      Effect.gen(function* () {
        const broker = yield* makeBroker;
        const parentRun = { id: RunId.make("original-run"), userMessageId: sourceMessageId };
        const laterRun = {
          id: RunId.make("later-run"),
          userMessageId: MessageId.make("later-message"),
        };
        const childThreadId = ThreadId.make("delegated-child");
        const childRun = {
          id: RunId.make("child-run"),
          userMessageId: MessageId.make("child-message"),
        };
        yield* broker.authorize({
          threadId: sourceThreadId,
          messageId: laterRun.userMessageId,
          sessionId: "other-session",
          alreadyStored: false,
        });
        const parent = {
          thread: { id: sourceThreadId },
          runs: [parentRun, laterRun],
          contextTransfers: [],
        };
        const child = {
          thread: { id: childThreadId },
          runs: [childRun],
          contextTransfers: [
            {
              type: "subagent_spawn" as const,
              targetRunId: childRun.id,
              sourceThreadId,
              sourcePoint: { threadId: sourceThreadId, runId: parentRun.id },
            },
          ],
        };
        expect(
          yield* ThreadReadBroker.resolveAuthority(broker, child, childRun, () =>
            Effect.succeed(parent),
          ),
        ).toEqual({
          threadId: sourceThreadId,
          messageId: sourceMessageId,
          sessionId: "client-session",
        });
        expect(
          yield* ThreadReadBroker.resolveAuthority(broker, child, childRun, () =>
            Effect.succeed({ ...parent, runs: [laterRun] }),
          ),
        ).toBeUndefined();
        const cyclic = {
          ...child,
          contextTransfers: [
            {
              ...child.contextTransfers[0]!,
              sourcePoint: { threadId: childThreadId, runId: childRun.id },
            },
          ],
        };
        expect(
          yield* ThreadReadBroker.resolveAuthority(broker, cyclic, childRun, () =>
            Effect.succeed(cyclic),
          ),
        ).toBeUndefined();
      }),
  );

  it.effect("reports unavailable routing instead of falsely claiming the thread is missing", () =>
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      expect(
        yield* broker.read(sourceThreadId, sourceMessageId, { threadId }).pipe(Effect.flip),
      ).toMatchObject({
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
        expect(yield* broker.read(sourceThreadId, sourceMessageId, input)).toEqual(result);
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
        expect(yield* broker.read(sourceThreadId, sourceMessageId, { threadId })).toEqual(result);
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
        const reading = yield* broker
          .read(sourceThreadId, sourceMessageId, { threadId })
          .pipe(Effect.flip, Effect.forkScoped);
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
        expect(
          yield* broker.read(sourceThreadId, sourceMessageId, { threadId }).pipe(Effect.flip),
        ).toMatchObject({
          code: "thread_not_found",
        });
        unavailableEnvironmentIds = [environmentId];
        expect(
          yield* broker.read(sourceThreadId, sourceMessageId, { threadId }).pipe(Effect.flip),
        ).toMatchObject({
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
        const reading = yield* broker
          .read(sourceThreadId, sourceMessageId, { threadId, environmentId })
          .pipe(Effect.forkScoped);
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
        const reading = yield* broker
          .read(sourceThreadId, sourceMessageId, { threadId })
          .pipe(Effect.flip, Effect.forkScoped);
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
