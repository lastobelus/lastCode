import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type { ProviderAdapterV2Shape } from "@t3tools/provider-core/server/ProviderAdapter";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as Threads from "./ThreadManagementService.ts";
import { ThreadReadAuthorization } from "./ThreadReadAuthorization.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter: ProviderAdapterV2Shape = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("Admission tests do not launch providers."),
};
const database = SqlitePersistence.layerMemory;
const replay = ProviderReplayHarness.layerWithRegistry(
  { name: "pause-admission" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { databaseLayer: database, runEffectWorker: false },
);
const testLayer = Threads.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      replay,
      ThreadCommandExecutor.layer,
      ProjectionStore.layer.pipe(Layer.provide(database)),
      EffectOutbox.layer.pipe(Layer.provide(database)),
    ),
  ),
);

const setup = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const threads = yield* Threads.ThreadManagementService;
  const threadId = ThreadId.make("thread-example");
  const projectId = ProjectId.make("project-example");
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-thread"),
    threadId,
    projectId,
    title: "Pause admission",
    modelSelection: { instanceId, model: "gpt-6" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("original-work"),
    threadId,
    messageId: MessageId.make("original-work"),
    text: "Existing work",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
  const now = yield* DateTime.now;
  const running = { ...run, status: "running" as const, startedAt: now };
  yield* sink.write({
    events: [
      {
        id: EventId.make("original-running"),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload: running,
      },
    ],
  });
  const complete = executor.withLock(
    threadId,
    Effect.gen(function* () {
      yield* sink.write({
        events: [
          {
            id: EventId.make("original-completed"),
            type: "run.updated",
            threadId,
            occurredAt: now,
            payload: { ...running, status: "completed", completedAt: now },
          },
        ],
      });
      // The harness does not execute the original provider start. Terminal
      // projection alone must not conceal a still-pending provider message.
      yield* outbox.cancelUnsettled({
        threadId,
        effectTypes: ["provider-turn.start"],
        reason: "Fixture provider work finished.",
      });
    }),
  );
  const send = (id: string, pauseOnlyIfActive = false) =>
    threads.sendToThread({
      projectId,
      threadId,
      messageId: MessageId.make(id),
      commandId: CommandId.make(id),
      text: id,
      attachments: [],
      mode: "cooperative",
      ...(pauseOnlyIfActive ? { pauseOnlyIfActive: true as const } : {}),
      createdBy: "user",
      creationSource: "server",
    });
  return { orchestrator, sink, outbox, threadId, run, complete, send };
});

it.effect(
  "refuses Pause under the dispatch lock after the recipient finishes during authorization",
  () =>
    Effect.gen(function* () {
      const h = yield* setup;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const sending = yield* h.send("pause-after-completion", true).pipe(
        Effect.provideService(ThreadReadAuthorization, {
          authorize: () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        }),
        Effect.result,
        Effect.forkChild,
      );
      yield* Deferred.await(entered);
      yield* h.complete;
      yield* h.outbox.enqueue([
        {
          id: "remaining-checkpoint",
          threadId: h.threadId,
          commandId: CommandId.make("checkpoint-example"),
          request: {
            type: "checkpoint.capture",
            runId: h.run.id,
            scopeId: CheckpointScopeId.make("scope-example"),
          },
        },
      ]);
      const shell = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadShell(h.threadId);
      assert.strictEqual(shell?.activeRunId, null);
      assert.strictEqual(shell?.activityRunStatus, null);
      assert.strictEqual(shell?.status, "completed");
      assert.deepEqual(shell?.pendingBackgroundTasks, []);
      assert.strictEqual(shell?.pendingRuntimeRequest, null);
      assert.deepEqual(yield* h.outbox.pendingExecution, [
        { threadId: h.threadId, providerMessage: false },
      ]);
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(sending);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure")
        assert.strictEqual(result.failure._tag, "OrchestratorPauseRecipientInactiveError");
      const projection = yield* h.orchestrator.getThreadProjection(h.threadId);
      assert.lengthOf(projection.runs, 1);
      assert.lengthOf(projection.messages, 1);
      assert.isEmpty(yield* h.outbox.listByCommandId(CommandId.make("pause-after-completion")));
      assert.deepEqual(yield* h.outbox.pendingExecution, [
        { threadId: h.threadId, providerMessage: false },
      ]);
      // Generic cooperative messages and Resume still start after ordinary completion.
      const ordinary = yield* h.send("resume");
      assert.strictEqual(ordinary.delivery, "started");
    }).pipe(Effect.provide(testLayer)),
);

it.effect("replays an admitted Pause after completion before applying the activity guard", () =>
  Effect.gen(function* () {
    const h = yield* setup;
    const admitted = yield* h.send("accepted-pause", true);
    assert.strictEqual(admitted.delivery, "queued");
    const queued = admitted.run;
    const now = yield* DateTime.now;
    yield* h.complete;
    yield* h.sink.write({
      events: [
        {
          id: EventId.make("pause-completed"),
          type: "run.updated",
          threadId: h.threadId,
          occurredAt: now,
          payload: { ...queued, status: "completed", completedAt: now },
        },
      ],
    });
    assert.isEmpty(yield* h.outbox.pendingExecution);
    const replayed = yield* h.orchestrator
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("accepted-pause"),
        threadId: h.threadId,
        messageId: MessageId.make("accepted-pause"),
        text: "accepted-pause",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(Effect.provideService(Orchestrator.PauseRecipientMustBeActive, true));
    assert.strictEqual(replayed.sequence, admitted.dispatch.sequence);
    assert.lengthOf((yield* h.orchestrator.getThreadProjection(h.threadId)).messages, 2);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("admits Pause for pending provider work even when the shell has no active run", () =>
  Effect.gen(function* () {
    const h = yield* setup;
    yield* h.complete;
    yield* h.outbox.enqueue([
      {
        id: "pending-provider-message",
        threadId: h.threadId,
        commandId: CommandId.make("pending-provider-example"),
        request: { type: "provider-turn.start", runId: h.run.id },
      },
    ]);
    const admitted = yield* h.send("pause-pending-provider", true);
    assert.strictEqual(admitted.delivery, "started");
    assert.lengthOf((yield* h.orchestrator.getThreadProjection(h.threadId)).messages, 2);
  }).pipe(Effect.provide(testLayer)),
);
