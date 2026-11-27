import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ThreadWaitHandle,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ThreadWait from "./ThreadWait.ts";

const environmentId = EnvironmentId.make("environment:thread-wait");
const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const dependencies = Layer.mergeAll(
  EventSink.layer.pipe(Layer.provideMerge(stores)),
  Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(environmentId),
  }),
);
const testLayer = ThreadWait.layer.pipe(Layer.provideMerge(dependencies));

let fixtureNumber = 0;

const fixture = Effect.fn("ThreadWait.test.fixture")(function* (
  status: OrchestrationV2Run["status"] = "running",
) {
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(`thread:wait:${++fixtureNumber}`);
  const messageId = MessageId.make(`${threadId}:message:request`);
  const runId = RunId.make(`${threadId}:run:requested`);
  const providerInstanceId = ProviderInstanceId.make("codex");
  const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make("project:wait"),
    title: "Wait target",
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  const run: OrchestrationV2Run = {
    id: runId,
    threadId,
    ordinal: 1,
    providerInstanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: messageId,
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: now,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const user: OrchestrationV2ConversationMessage = {
    createdBy: "user",
    creationSource: "server",
    id: messageId,
    threadId,
    runId,
    nodeId: null,
    role: "user",
    text: "The exact request",
    attachments: [],
    streaming: false,
    createdAt: now,
    updatedAt: now,
  };
  let sequence = 0;
  const write = (...values: ReadonlyArray<Omit<OrchestrationV2DomainEvent, "id">>) =>
    sink.write({
      events: values.map(
        (event) =>
          ({
            ...event,
            id: EventId.make(`event:${threadId}:${++sequence}`),
          }) as OrchestrationV2DomainEvent,
      ),
    });
  const updateRun = (nextStatus: OrchestrationV2Run["status"]) =>
    write({
      type: "run.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: { ...run, status: nextStatus },
    });
  const response = (
    text: string,
    options: {
      id?: string;
      ordinal?: number;
      runId?: RunId;
      streaming?: boolean;
      nested?: boolean;
    } = {},
  ) => {
    const id = MessageId.make(`${threadId}:${options.id ?? "message:answer"}`);
    const responseRunId = options.runId ?? runId;
    return write(
      {
        type: "message.updated",
        threadId,
        runId: responseRunId,
        occurredAt: now,
        payload: {
          ...user,
          id,
          runId: responseRunId,
          role: "assistant",
          text,
          streaming: options.streaming ?? false,
        },
      },
      {
        type: "turn-item.updated",
        threadId,
        runId: responseRunId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make(`item:${id}`),
          type: "assistant_message",
          threadId,
          runId: responseRunId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: options.nested ? TurnItemId.make("item:subagent") : null,
          ordinal: options.ordinal ?? 1,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          messageId: id,
          text,
          streaming: options.streaming ?? false,
        },
      },
    );
  };
  yield* write(
    { type: "thread.created", threadId, occurredAt: now, payload: thread },
    { type: "run.created", threadId, runId, occurredAt: now, payload: run },
    { type: "message.updated", threadId, runId, occurredAt: now, payload: user },
  );
  const handle: ThreadWaitHandle = { kind: "wait-handle", environmentId, threadId, messageId };
  return { sink, now, thread, run, handle, write, updateRun, response };
});

it.layer(testLayer)("ThreadWait", (it) => {
  it.effect(
    "returns the last top-level response of the exact run, even when another run finished later",
    () =>
      Effect.gen(function* () {
        const target = yield* fixture("completed");
        yield* target.response("commentary", { id: "message:commentary", ordinal: 1 });
        yield* target.response("exact final", { ordinal: 2 });
        yield* target.response("nested answer", { id: "message:nested", ordinal: 3, nested: true });
        yield* target.response("unrelated answer", {
          id: "message:unrelated",
          ordinal: 4,
          runId: RunId.make("run:other"),
        });
        const service = yield* ThreadWait.ThreadWait;
        expect(yield* service.wait(target.handle, 1)).toEqual({
          kind: "completed",
          environmentId,
          threadId: target.handle.threadId,
          messageId: target.handle.messageId,
          runId: target.run.id,
          response: "exact final",
          responseTruncated: false,
        });
      }),
  );

  it.effect("returns bounded tail text and an explicit truncation flag", () =>
    Effect.gen(function* () {
      const target = yield* fixture("completed");
      yield* target.response("prefix" + "x".repeat(64_000));
      const service = yield* ThreadWait.ThreadWait;
      expect(yield* service.wait(target.handle, 1)).toMatchObject({
        kind: "completed",
        response: "x".repeat(64_000),
        responseTruncated: true,
      });
    }),
  );

  it.effect("returns an empty response for a completed run without assistant output", () =>
    Effect.gen(function* () {
      const target = yield* fixture("completed");
      const service = yield* ThreadWait.ThreadWait;
      expect(yield* service.wait(target.handle, 1)).toMatchObject({
        kind: "completed",
        response: "",
        responseTruncated: false,
      });
    }),
  );

  it.effect("does not return a nested subagent response when the run has no own answer", () =>
    Effect.gen(function* () {
      const target = yield* fixture("completed");
      yield* target.response("private nested output", { nested: true });
      const service = yield* ThreadWait.ThreadWait;
      expect(yield* service.wait(target.handle, 1)).toMatchObject({
        kind: "completed",
        response: "",
      });
    }),
  );

  it.effect.each(["failed", "interrupted", "cancelled", "rolled_back"] as const)(
    "maps terminal $0 runs without returning stale assistant text",
    (status) =>
      Effect.gen(function* () {
        const target = yield* fixture(status);
        yield* target.response("stale answer");
        const service = yield* ThreadWait.ThreadWait;
        expect(yield* service.wait(target.handle, 1)).toEqual({
          kind: status === "failed" ? "error" : "interrupted",
          environmentId,
          threadId: target.handle.threadId,
          messageId: target.handle.messageId,
          runId: target.run.id,
        });
      }),
  );

  it.effect(
    "replays completion committed between the queued projection read and subscription",
    () =>
      Effect.gen(function* () {
        const target = yield* fixture("queued");
        const service = yield* ThreadWait.ThreadWait.pipe(
          Effect.provide(Layer.fresh(ThreadWait.layer)),
          Effect.provideService(EventSink.EventSinkV2, {
            ...target.sink,
            stream: (input) =>
              Stream.unwrap(
                Effect.gen(function* () {
                  yield* target.response("queued result");
                  yield* target.updateRun("completed");
                  return target.sink.stream(input);
                }),
              ),
          }),
        );
        expect(yield* service.wait(target.handle, 60_000)).toMatchObject({
          kind: "completed",
          runId: target.run.id,
          response: "queued result",
        });
      }),
  );

  it.effect(
    "waits for final text rather than returning an earlier finished assistant message",
    () =>
      Effect.gen(function* () {
        const target = yield* fixture("completed");
        yield* target.response("earlier commentary", { id: "message:commentary", ordinal: 1 });
        yield* target.response("partial", { ordinal: 2, streaming: true });
        const service = yield* ThreadWait.ThreadWait.pipe(
          Effect.provide(Layer.fresh(ThreadWait.layer)),
          Effect.provideService(EventSink.EventSinkV2, {
            ...target.sink,
            stream: (input) =>
              Stream.unwrap(
                Effect.gen(function* () {
                  yield* target.response("finished final", { ordinal: 2 });
                  return target.sink.stream(input);
                }),
              ),
          }),
        );
        expect(yield* service.wait(target.handle, 60_000)).toMatchObject({
          kind: "completed",
          response: "finished final",
        });
      }),
  );

  it.effect("returns interrupted when the selected thread is deleted while waiting", () =>
    Effect.gen(function* () {
      const target = yield* fixture();
      const service = yield* ThreadWait.ThreadWait.pipe(
        Effect.provide(Layer.fresh(ThreadWait.layer)),
        Effect.provideService(EventSink.EventSinkV2, {
          ...target.sink,
          stream: (input) =>
            Stream.unwrap(
              Effect.gen(function* () {
                yield* target.write({
                  type: "thread.deleted",
                  threadId: target.thread.id,
                  occurredAt: target.now,
                  payload: { ...target.thread, deletedAt: target.now },
                });
                return target.sink.stream(input);
              }),
            ),
        }),
      );
      expect(yield* service.wait(target.handle, 60_000)).toMatchObject({
        kind: "interrupted",
        runId: target.run.id,
      });
    }),
  );

  it.effect("times out with the original handle using the virtual clock", () =>
    Effect.gen(function* () {
      const target = yield* fixture("queued");
      const subscribed = yield* Deferred.make<void>();
      const service = yield* ThreadWait.ThreadWait.pipe(
        Effect.provide(Layer.fresh(ThreadWait.layer)),
        Effect.provideService(EventSink.EventSinkV2, {
          ...target.sink,
          stream: (input) =>
            Stream.unwrap(
              Deferred.succeed(subscribed, undefined).pipe(Effect.as(target.sink.stream(input))),
            ),
        }),
      );
      const fiber = yield* service.wait(target.handle, 50).pipe(Effect.forkChild);
      yield* Deferred.await(subscribed);
      yield* TestClock.adjust(50);
      expect(yield* Fiber.join(fiber)).toEqual({ kind: "timed-out", waitHandle: target.handle });
    }),
  );

  it.effect("reads terminal state once more when timeout wins the event-delivery race", () =>
    Effect.gen(function* () {
      const target = yield* fixture();
      const subscribed = yield* Deferred.make<void>();
      const service = yield* ThreadWait.ThreadWait.pipe(
        Effect.provide(Layer.fresh(ThreadWait.layer)),
        Effect.provideService(EventSink.EventSinkV2, {
          ...target.sink,
          stream: () =>
            Stream.unwrap(Deferred.succeed(subscribed, undefined).pipe(Effect.as(Stream.never))),
        }),
      );
      const fiber = yield* service.wait(target.handle, 50).pipe(Effect.forkChild);
      yield* Deferred.await(subscribed);
      yield* target.response("committed at timeout");
      yield* target.updateRun("completed");
      yield* TestClock.adjust(50);
      expect(yield* Fiber.join(fiber)).toMatchObject({
        kind: "completed",
        response: "committed at timeout",
      });
    }),
  );

  it.effect("maps event-store failures to a typed internal error", () =>
    Effect.gen(function* () {
      const target = yield* fixture();
      const service = yield* ThreadWait.ThreadWait.pipe(
        Effect.provide(Layer.fresh(ThreadWait.layer)),
        Effect.provideService(EventSink.EventSinkV2, {
          ...target.sink,
          latestSequence: () =>
            Effect.fail(new EventSink.EventSinkStreamError({ cause: new Error("unavailable") })),
        }),
      );
      expect(yield* service.wait(target.handle, 1).pipe(Effect.flip)).toBeInstanceOf(
        ThreadWait.ThreadWaitInternalError,
      );
    }),
  );

  it.effect("reports wrong environment, absent thread and invalid correlation distinctly", () =>
    Effect.gen(function* () {
      const target = yield* fixture();
      const service = yield* ThreadWait.ThreadWait;
      expect(
        yield* service
          .wait({ ...target.handle, environmentId: EnvironmentId.make("other") }, 1)
          .pipe(Effect.flip),
      ).toBeInstanceOf(ThreadWait.ThreadWaitEnvironmentMismatchError);
      expect(
        yield* service
          .wait({ ...target.handle, threadId: ThreadId.make("missing") }, 1)
          .pipe(Effect.flip),
      ).toBeInstanceOf(ThreadWait.ThreadWaitThreadNotFoundError);
      expect(
        yield* service
          .wait({ ...target.handle, messageId: MessageId.make("missing") }, 1)
          .pipe(Effect.flip),
      ).toBeInstanceOf(ThreadWait.ThreadWaitCorrelationNotFoundError);
    }),
  );
});
