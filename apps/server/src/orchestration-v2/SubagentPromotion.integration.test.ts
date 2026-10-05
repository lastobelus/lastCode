import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ContextTransferId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  isProviderNativeSubagentThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2ExecutionNode,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { ProviderAdapterV2Shape, ProviderAdapterV2ThreadSnapshot } from "./ProviderAdapter.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as SubagentPromotionService from "./SubagentPromotionService.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const sourceId = ThreadId.make("native-subagent");
const parentId = ThreadId.make("parent-thread");
const targetId = ThreadId.make("interactive-thread");
const providerThreadId = ProviderThreadId.make("native-source-thread");
const sourceTurnId = ProviderTurnId.make("native-source-turn");
const requestId = CommandId.make("promotion-request");
const adapter: ProviderAdapterV2Shape = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("The lifecycle tests do not run provider effects"),
};
const replayLayer = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "subagent-promotion-lifecycle" },
  ProviderAdapterRegistry.makeLayer([adapter]),
  { runEffectWorker: false, databaseLayer: SqlitePersistenceMemory },
);
const TestLayer = Layer.mergeAll(
  replayLayer,
  EffectOutbox.layer.pipe(Layer.provide(SqlitePersistenceMemory)),
);

const seed = Effect.fn("SubagentPromotionTest.seed")(function* (
  status: OrchestrationV2ProviderTurn["status"],
  includeProviderTurn = true,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const now = yield* DateTime.now;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-parent"),
    threadId: parentId,
    projectId: ProjectId.make("project"),
    title: "Parent",
    modelSelection: { instanceId, model: "model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  const parent = (yield* orchestrator.getThreadProjection(parentId)).thread;
  const source = {
    ...parent,
    id: sourceId,
    title: "Native subagent",
    createdBy: "agent" as const,
    creationSource: "provider" as const,
    lineage: {
      parentThreadId: parentId,
      relationshipToParent: "subagent" as const,
      rootThreadId: parentId,
    },
    activeProviderThreadId: providerThreadId,
  };
  const providerThread = {
    id: providerThreadId,
    driver,
    providerInstanceId: instanceId,
    providerSessionId: null,
    appThreadId: sourceId,
    ownerNodeId: null,
    nativeThreadRef: { driver, nativeId: "native-source", strength: "strong" as const },
    nativeConversationHeadRef: null,
    status: "idle" as const,
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const turn = {
    id: sourceTurnId,
    providerThreadId,
    nodeId: NodeId.make("native-source-node"),
    runAttemptId: null,
    nativeTurnRef: { driver, nativeId: "native-turn", strength: "strong" as const },
    ordinal: 1,
    status,
    startedAt: now,
    completedAt: status === "running" ? null : now,
  };
  yield* sink.write({
    events: [
      {
        id: EventId.make("source-created"),
        type: "thread.created",
        threadId: sourceId,
        occurredAt: now,
        payload: source,
      },
      {
        id: EventId.make("source-provider-thread"),
        type: "provider-thread.updated",
        threadId: sourceId,
        occurredAt: now,
        payload: providerThread,
      },
      ...(includeProviderTurn
        ? [
            {
              id: EventId.make("source-provider-turn"),
              type: "provider-turn.updated" as const,
              threadId: sourceId,
              occurredAt: now,
              payload: turn,
            },
          ]
        : []),
    ],
  });
  return { orchestrator, sink, outbox, now, source, providerThread, turn };
});

const sourceRootNode = (
  h: Effect.Success<ReturnType<typeof seed>>,
  status: "running" | "cancelled",
  nativeProviderTurnId: ProviderTurnId | null = sourceTurnId,
): OrchestrationV2ExecutionNode => ({
  id: h.turn.nodeId,
  threadId: sourceId,
  runId: null,
  parentNodeId: null,
  rootNodeId: h.turn.nodeId,
  kind: "root_turn",
  status,
  countsForRun: false,
  providerThreadId,
  providerTurnId: nativeProviderTurnId,
  nativeItemRef: null,
  runtimeRequestId: null,
  checkpointScopeId: null,
  startedAt: h.now,
  completedAt: status === "running" ? null : h.now,
});

const writeSourceRootNode = (
  h: Effect.Success<ReturnType<typeof seed>>,
  status: "running" | "cancelled",
  nativeProviderTurnId: ProviderTurnId | null = sourceTurnId,
) =>
  h.sink.write({
    events: [
      {
        id: EventId.make(`source-root-turn-${status}`),
        type: "node.updated",
        threadId: sourceId,
        nodeId: h.turn.nodeId,
        occurredAt: h.now,
        payload: sourceRootNode(h, status, nativeProviderTurnId),
      },
    ],
  });

const observePromotionForking = Effect.fn("SubagentPromotionTest.observeForking")(function* (
  h: Effect.Success<ReturnType<typeof seed>>,
) {
  const afterSequence = yield* h.sink.latestSequence();
  const promotionPersisted = yield* Deferred.make<void>();
  yield* h.sink
    .stream({ threadId: sourceId, afterSequence, eventType: "thread.metadata-updated" })
    .pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "thread.metadata-updated" &&
          stored.event.payload.subagentPromotion?.requestId === requestId &&
          stored.event.payload.subagentPromotion.status === "forking",
      ),
      Stream.take(1),
      Stream.runForEach(() => Deferred.succeed(promotionPersisted, undefined)),
      Effect.forkScoped,
    );
  return Deferred.await(promotionPersisted);
});

const request = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  commandId = requestId,
  targetThreadId = targetId,
) =>
  orchestrator.dispatch({
    type: "subagent.promote.request",
    commandId,
    threadId: sourceId,
    targetThreadId,
    createdBy: "user",
    creationSource: "web",
  });

const completion = (
  h: Effect.Success<ReturnType<typeof seed>>,
  commandId = CommandId.make("promotion-complete"),
) => ({
  type: "subagent.promote.complete" as const,
  commandId,
  threadId: sourceId,
  requestId,
  providerThread: {
    ...h.providerThread,
    id: ProviderThreadId.make("native-fork"),
    appThreadId: targetId,
    nativeThreadRef: { driver, nativeId: "native-interactive-fork", strength: "strong" as const },
    forkedFrom: { providerThreadId, providerTurnId: sourceTurnId },
  },
  snapshot: {
    providerTurns: [
      {
        ...h.turn,
        id: ProviderTurnId.make("forked-turn"),
        providerThreadId: ProviderThreadId.make("native-fork"),
      },
    ],
    messages: [
      {
        id: MessageId.make("native-message"),
        threadId: sourceId,
        runId: null,
        nodeId: null,
        role: "assistant" as const,
        text: "Native subagent result",
        attachments: [],
        streaming: false,
        createdBy: "agent" as const,
        creationSource: "provider" as const,
        createdAt: h.now,
        updatedAt: h.now,
      },
    ],
  },
});

it.effect(
  "waits while running, retains the canonical target on repeats and cancels only waiting requests",
  () =>
    Effect.gen(function* () {
      const h = yield* seed("running");
      yield* request(h.orchestrator);
      const waiting = (yield* h.orchestrator.getThreadProjection(sourceId)).thread
        .subagentPromotion;
      assert.equal(waiting?.status, "waiting");
      assert.equal(waiting?.targetThreadId, targetId);
      assert.isFalse(Option.isSome(yield* h.outbox.get(`effect:${requestId}:subagent.promote`)));
      yield* request(
        h.orchestrator,
        CommandId.make("duplicate-request"),
        ThreadId.make("other-target"),
      );
      assert.deepEqual(
        (yield* h.orchestrator.getThreadProjection(sourceId)).thread.subagentPromotion,
        waiting,
      );
      const staleCancel = yield* Effect.exit(
        h.orchestrator.dispatch({
          type: "subagent.promote.cancel",
          commandId: CommandId.make("stale-cancel"),
          threadId: sourceId,
          requestId: CommandId.make("different-request"),
        }),
      );
      assert.isTrue(Exit.isFailure(staleCancel));
      yield* h.orchestrator.dispatch({
        type: "subagent.promote.cancel",
        commandId: CommandId.make("cancel"),
        threadId: sourceId,
        requestId,
      });
      assert.isNull((yield* h.orchestrator.getThreadProjection(sourceId)).thread.subagentPromotion);
      yield* h.orchestrator.dispatch({
        type: "subagent.promote.advance",
        commandId: CommandId.make("late-advance"),
        threadId: sourceId,
        requestId,
      });
      assert.isNull((yield* h.orchestrator.getThreadProjection(sourceId)).thread.subagentPromotion);
    }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "immediately forks a terminal runless subagent and pins the completed provider turn",
  () =>
    Effect.gen(function* () {
      const h = yield* seed("completed");
      yield* request(h.orchestrator);
      const projection = yield* h.orchestrator.getThreadProjection(sourceId);
      assert.equal(projection.thread.subagentPromotion?.status, "forking");
      assert.equal(projection.thread.subagentPromotion?.sourceProviderTurnId, sourceTurnId);
      assert.lengthOf(projection.runs, 0);
      const effect = Option.getOrThrow(yield* h.outbox.get(`effect:${requestId}:subagent.promote`));
      assert.deepEqual(effect.request, { type: "subagent.promote", requestId });
      const cancel = yield* Effect.exit(
        h.orchestrator.dispatch({
          type: "subagent.promote.cancel",
          commandId: CommandId.make("cancel-forking"),
          threadId: sourceId,
          requestId,
        }),
      );
      assert.isTrue(Exit.isFailure(cancel));
    }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "forks a cancelled native root turn even when its provider turn remains running after restart",
  () =>
    Effect.gen(function* () {
      const h = yield* seed("running");
      yield* writeSourceRootNode(h, "cancelled");
      yield* request(h.orchestrator);
      const projection = yield* h.orchestrator.getThreadProjection(sourceId);
      assert.equal(projection.thread.subagentPromotion?.status, "forking");
      assert.equal(projection.thread.subagentPromotion?.sourceProviderTurnId, sourceTurnId);
      assert.equal(projection.providerTurns[0]?.status, "running");
      assert.isNull(projection.providerTurns[0]?.completedAt);
      assert.lengthOf(projection.runs, 0);
      assert.isTrue(Option.isSome(yield* h.outbox.get(`effect:${requestId}:subagent.promote`)));
    }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "advances a waiting promotion when the matching runless native root turn is cancelled",
  () =>
    Effect.gen(function* () {
      const h = yield* seed("running");
      yield* writeSourceRootNode(h, "running");
      yield* request(h.orchestrator);
      assert.equal(
        (yield* h.orchestrator.getThreadProjection(sourceId)).thread.subagentPromotion?.status,
        "waiting",
      );
      const promotionPersisted = yield* observePromotionForking(h);
      yield* writeSourceRootNode(h, "cancelled");
      yield* promotionPersisted;
      const projection = yield* h.orchestrator.getThreadProjection(sourceId);
      assert.equal(projection.thread.subagentPromotion?.status, "forking");
      assert.equal(projection.thread.subagentPromotion?.sourceProviderTurnId, sourceTurnId);
      assert.equal(projection.providerTurns[0]?.status, "running");
      assert.isNull(projection.providerTurns[0]?.completedAt);
      assert.isTrue(Option.isSome(yield* h.outbox.get(`effect:${requestId}:subagent.promote`)));
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect(
  "does not use an older completed root as evidence that a newer native turn is finished",
  () =>
    Effect.gen(function* () {
      const h = yield* seed("running", false);
      const olderNodeId = NodeId.make("older-native-root");
      const olderTurnId = ProviderTurnId.make("older-native-turn");
      yield* h.sink.write({
        events: [
          {
            id: EventId.make("older-completed-turn"),
            type: "provider-turn.updated",
            threadId: sourceId,
            occurredAt: h.now,
            payload: {
              ...h.turn,
              id: olderTurnId,
              nativeTurnRef: { ...h.turn.nativeTurnRef, nativeId: "older-native-turn" },
              nodeId: olderNodeId,
              status: "completed",
              completedAt: h.now,
            },
          },
          {
            id: EventId.make("newer-running-turn"),
            type: "provider-turn.updated",
            threadId: sourceId,
            occurredAt: h.now,
            payload: { ...h.turn, ordinal: 2 },
          },
          {
            id: EventId.make("older-completed-root"),
            type: "node.updated",
            threadId: sourceId,
            nodeId: olderNodeId,
            occurredAt: h.now,
            payload: {
              ...sourceRootNode(h, "cancelled"),
              id: olderNodeId,
              rootNodeId: olderNodeId,
              providerTurnId: olderTurnId,
              status: "completed",
            },
          },
        ],
      });
      yield* request(h.orchestrator);
      const promotion = (yield* h.orchestrator.getThreadProjection(sourceId)).thread
        .subagentPromotion;
      assert.equal(promotion?.status, "waiting");
      assert.isUndefined(promotion?.sourceProviderTurnId);
      assert.isFalse(Option.isSome(yield* h.outbox.get(`effect:${requestId}:subagent.promote`)));
    }).pipe(Effect.provide(TestLayer)),
);

it.effect("forks a native child cancelled before its first provider turn is recorded", () =>
  Effect.gen(function* () {
    const h = yield* seed("running", false);
    yield* writeSourceRootNode(h, "cancelled", null);
    yield* request(h.orchestrator);
    const projection = yield* h.orchestrator.getThreadProjection(sourceId);
    assert.equal(projection.thread.subagentPromotion?.status, "forking");
    assert.isUndefined(projection.thread.subagentPromotion?.sourceProviderTurnId);
    assert.lengthOf(projection.providerTurns, 0);
    assert.isTrue(Option.isSome(yield* h.outbox.get(`effect:${requestId}:subagent.promote`)));
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("continues an accepted waiting promotion while its source is archived", () =>
  Effect.gen(function* () {
    const h = yield* seed("running");
    yield* writeSourceRootNode(h, "running");
    yield* request(h.orchestrator);
    assert.equal(
      (yield* h.orchestrator.getThreadProjection(sourceId)).thread.subagentPromotion?.status,
      "waiting",
    );
    yield* h.orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("archive-waiting-source"),
      threadId: sourceId,
    });
    const archivedAt = (yield* h.orchestrator.getThreadProjection(sourceId)).thread.archivedAt;
    assert.isNotNull(archivedAt);
    const promotionPersisted = yield* observePromotionForking(h);
    yield* writeSourceRootNode(h, "cancelled");
    yield* promotionPersisted;
    const archived = (yield* h.orchestrator.getThreadProjection(sourceId)).thread;
    assert.equal(archived.subagentPromotion?.status, "forking");
    assert.deepEqual(archived.archivedAt, archivedAt);
    assert.isTrue(Option.isSome(yield* h.outbox.get(`effect:${requestId}:subagent.promote`)));
    yield* h.orchestrator.dispatch({
      type: "thread.unarchive",
      commandId: CommandId.make("unarchive-promoting-source"),
      threadId: sourceId,
    });
    const unarchived = (yield* h.orchestrator.getThreadProjection(sourceId)).thread;
    assert.isNull(unarchived.archivedAt);
    assert.equal(unarchived.subagentPromotion?.status, "forking");
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect(
  "preserves source-owned dashboard requests without copying them to the promoted thread",
  () =>
    Effect.gen(function* () {
      const h = yield* seed("completed");
      for (const kind of ["question", "qa"] as const) {
        yield* h.orchestrator.dispatch({
          type: "thread.dashboard-item.upsert",
          commandId: CommandId.make(`source-dashboard-${kind}`),
          threadId: sourceId,
          item: {
            id: `source-${kind}`,
            title: `Source ${kind}`,
            body: "A request owned by the original subagent thread.",
            kind,
            status: "open",
            priority: "normal",
            effort: "focused",
            requiresComputer: kind === "qa",
          },
        });
      }
      const ownedItems = (yield* h.orchestrator.getThreadProjection(sourceId)).thread
        .dashboardItems;
      assert.lengthOf(ownedItems ?? [], 2);
      yield* request(h.orchestrator);
      yield* h.orchestrator.dispatch(completion(h));

      const source = (yield* h.orchestrator.getThreadProjection(sourceId)).thread;
      const promoted = (yield* h.orchestrator.getThreadProjection(targetId)).thread;
      assert.equal(source.subagentPromotion?.status, "promoted");
      assert.deepEqual(source.dashboardItems, ownedItems);
      assert.deepEqual(promoted.dashboardItems, []);
    }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "creates an interactive native fork and one parent notification despite duplicate completion",
  () =>
    Effect.gen(function* () {
      const h = yield* seed("completed");
      yield* request(h.orchestrator);
      yield* h.orchestrator.dispatch(completion(h));
      const target = yield* h.orchestrator.getThreadProjection(targetId);
      assert.isFalse(isProviderNativeSubagentThread(target.thread));
      assert.equal(target.thread.lineage.parentThreadId, sourceId);
      assert.equal(target.thread.lineage.relationshipToParent, "fork");
      assert.equal(target.providerThreads[0]?.nativeThreadRef?.nativeId, "native-interactive-fork");
      assert.equal(target.messages[0]?.text, "Native subagent result");
      assert.equal(target.messages[0]?.threadId, targetId);
      assert.equal(target.visibleTurnItems[0]?.item.type, "assistant_message");
      assert.equal(
        (yield* h.orchestrator.getThreadProjection(sourceId)).thread.subagentPromotion?.status,
        "promoted",
      );
      yield* h.orchestrator.dispatch(completion(h, CommandId.make("duplicate-complete")));
      assert.lengthOf((yield* h.orchestrator.getThreadProjection(targetId)).messages, 1);
      const parent = yield* h.orchestrator.getThreadProjection(parentId);
      const notifications = parent.messages.filter(
        (message) => message.id === `${requestId}:handoff`,
      );
      assert.lengthOf(notifications, 1);
      assert.include(notifications[0]!.text, String(targetId));
      assert.include(notifications[0]!.text, "t3_thread_send");
    }).pipe(Effect.provide(TestLayer)),
);

it.effect("rejects an occupied destination before scheduling any native fork", () =>
  Effect.gen(function* () {
    const h = yield* seed("completed");
    const rejectedId = CommandId.make("occupied-destination-request");
    const rejected = yield* Effect.exit(request(h.orchestrator, rejectedId, parentId));
    assert.isTrue(Exit.isFailure(rejected));
    assert.deepEqual((yield* h.orchestrator.getThreadProjection(sourceId)).thread, h.source);
    assert.isFalse(Option.isSome(yield* h.outbox.get(`effect:${rejectedId}:subagent.promote`)));
    assert.equal((yield* h.orchestrator.getThreadProjection(parentId)).thread.title, "Parent");
    yield* request(h.orchestrator);
    assert.equal(
      (yield* h.orchestrator.getThreadProjection(sourceId)).thread.subagentPromotion?.status,
      "forking",
    );
  }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "retries a destination collision with a fresh ID without replacing the existing thread",
  () =>
    Effect.gen(function* () {
      const h = yield* seed("completed");
      yield* request(h.orchestrator);
      const existing = { ...h.source, id: targetId, title: "Existing destination" };
      yield* h.sink.write({
        events: [
          {
            id: EventId.make("occupied-destination-created"),
            type: "thread.created",
            threadId: targetId,
            occurredAt: h.now,
            payload: existing,
          },
        ],
      });
      yield* h.orchestrator.dispatch(completion(h));
      assert.equal(
        (yield* h.orchestrator.getThreadProjection(sourceId)).thread.subagentPromotion?.status,
        "failed",
      );
      const retryId = CommandId.make("retry-destination-collision");
      const freshTargetId = ThreadId.make("fresh-interactive-thread");
      yield* request(h.orchestrator, retryId, freshTargetId);
      const promotion = (yield* h.orchestrator.getThreadProjection(sourceId)).thread
        .subagentPromotion;
      assert.equal(promotion?.status, "forking");
      assert.equal(promotion?.targetThreadId, freshTargetId);
      const retryCompletion = completion(h, CommandId.make("retry-destination-complete"));
      yield* h.orchestrator.dispatch({
        ...retryCompletion,
        requestId: retryId,
        providerThread: { ...retryCompletion.providerThread, appThreadId: freshTargetId },
      });
      assert.equal(
        (yield* h.orchestrator.getThreadProjection(sourceId)).thread.subagentPromotion?.status,
        "promoted",
      );
      assert.deepEqual((yield* h.orchestrator.getThreadProjection(targetId)).thread, existing);
      assert.equal(
        (yield* h.orchestrator.getThreadProjection(freshTargetId)).messages[0]?.text,
        "Native subagent result",
      );
      assert.lengthOf((yield* h.orchestrator.getThreadProjection(parentId)).messages, 1);
    }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "retries a failed promotion with the same target and ignores late results from the old request",
  () =>
    Effect.gen(function* () {
      const h = yield* seed("completed");
      yield* request(h.orchestrator);
      yield* h.orchestrator.dispatch({
        type: "subagent.promote.fail",
        commandId: CommandId.make("fork-failed"),
        threadId: sourceId,
        requestId,
        error: "Native fork failed",
      });
      assert.equal(
        (yield* h.orchestrator.getThreadProjection(sourceId)).thread.subagentPromotion?.status,
        "failed",
      );
      const retryId = CommandId.make("retry-promotion");
      yield* request(h.orchestrator, retryId, ThreadId.make("incorrect-new-target"));
      const retry = (yield* h.orchestrator.getThreadProjection(sourceId)).thread.subagentPromotion;
      assert.equal(retry?.status, "forking");
      assert.equal(retry?.requestId, retryId);
      assert.equal(retry?.targetThreadId, targetId);
      assert.isNull(retry?.error);
      yield* h.orchestrator.dispatch(completion(h, CommandId.make("late-old-completion")));
      assert.deepEqual(
        (yield* h.orchestrator.getThreadProjection(sourceId)).thread.subagentPromotion,
        retry,
      );
      assert.isNull(yield* h.orchestrator.getThreadShell(targetId));
    }).pipe(Effect.provide(TestLayer)),
);

it.effect("clears the stale promoted link when its target is deleted", () =>
  Effect.gen(function* () {
    const h = yield* seed("completed");
    yield* request(h.orchestrator);
    yield* h.orchestrator.dispatch(completion(h));
    yield* h.orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete-target"),
      threadId: targetId,
    });
    assert.isNull((yield* h.orchestrator.getThreadProjection(sourceId)).thread.subagentPromotion);
    assert.isNotNull((yield* h.orchestrator.getThreadProjection(targetId)).thread.deletedAt);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "returns promotion to failed after the real completion receipt is permanently rejected",
  () => {
    let nativeSnapshot: ProviderAdapterV2ThreadSnapshot | undefined;
    let forkCount = 0;
    const forbidden = () => Effect.die("This regression only forks and reads native history.");
    const nativeAdapter: ProviderAdapterV2Shape = {
      ...adapter,
      openSession: (input) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          return {
            instanceId,
            driver,
            providerSessionId: input.providerSessionId,
            providerSession: {
              id: input.providerSessionId,
              providerInstanceId: instanceId,
              driver,
              status: "ready" as const,
              cwd: "/workspace",
              model: input.modelSelection.model,
              capabilities: CodexProviderCapabilitiesV2,
              lastError: null,
              createdAt: now,
              updatedAt: now,
            },
            events: Stream.empty,
            ensureThread: forbidden,
            resumeThread: forbidden,
            startTurn: forbidden,
            steerTurn: forbidden,
            interruptTurn: forbidden,
            respondToRuntimeRequest: forbidden,
            rollbackThread: forbidden,
            forkThread: () =>
              Effect.sync(() => {
                forkCount += 1;
                if (nativeSnapshot === undefined) throw new Error("Native fixture not seeded.");
                return nativeSnapshot.providerThread;
              }),
            readThreadSnapshot: () =>
              nativeSnapshot === undefined
                ? Effect.die("Native fixture not seeded.")
                : Effect.succeed(nativeSnapshot),
          };
        }),
    };
    const nativeRegistry = ProviderAdapterRegistry.makeSingleLayer(nativeAdapter);
    const nativeTestLayer = Layer.mergeAll(
      makeOrchestratorV2ReplayLayerWithRegistry(
        { name: "subagent-promotion-rejected-completion" },
        nativeRegistry,
        { runEffectWorker: false, databaseLayer: SqlitePersistenceMemory },
      ),
      EffectOutbox.layer.pipe(Layer.provide(SqlitePersistenceMemory)),
    );
    const promotionLayer = SubagentPromotionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          nativeTestLayer,
          ProjectionStore.layer.pipe(Layer.provide(SqlitePersistenceMemory)),
          RuntimePolicy.layer,
          nativeRegistry,
        ),
      ),
    );
    return Effect.gen(function* () {
      const h = yield* seed("completed");
      const service = yield* SubagentPromotionService.SubagentPromotionService;
      const complete = completion(h, CommandId.make(`${requestId}:promotion-complete`));
      nativeSnapshot = {
        ...complete.snapshot,
        providerThread: complete.providerThread,
        runtimeRequests: [],
      };
      // The parent's active run can queue a handoff, except while a merge-back
      // still needs consumption. Completion must atomically reject all target
      // events when that handoff cannot be planned.
      yield* h.orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("start-active-parent"),
        threadId: parentId,
        messageId: MessageId.make("active-parent-message"),
        text: "Parent work",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* h.sink.write({
        events: [
          {
            id: EventId.make("pending-parent-merge-back"),
            type: "context-transfer.created",
            threadId: parentId,
            occurredAt: h.now,
            payload: {
              id: ContextTransferId.make("pending-parent-merge-back"),
              type: "merge_back",
              sourceThreadId: ThreadId.make("merge-back-source"),
              targetThreadId: parentId,
              sourcePoint: {
                threadId: ThreadId.make("merge-back-source"),
                runId: RunId.make("merge-back-source-run"),
              },
              basePoint: null,
              sourceProviderInstanceId: instanceId,
              targetProviderInstanceId: instanceId,
              targetRunId: null,
              status: "pending",
              resolution: null,
              createdBy: "user",
              error: null,
              createdAt: h.now,
              updatedAt: h.now,
              consumedAt: null,
            },
          },
        ],
      });
      yield* request(h.orchestrator);
      const first = yield* Effect.result(
        service.execute({ threadId: sourceId, requestId, willRetry: true }),
      );
      assert.equal(first._tag, "Failure");
      const rejectedReplay = yield* Effect.result(h.orchestrator.dispatch(complete));
      assert.equal(rejectedReplay._tag, "Failure");
      if (rejectedReplay._tag === "Failure") {
        assert.equal(rejectedReplay.failure._tag, "OrchestratorCommandPreviouslyRejectedError");
      }
      yield* service.execute({ threadId: sourceId, requestId, willRetry: true });
      const failed = (yield* h.orchestrator.getThreadProjection(sourceId)).thread.subagentPromotion;
      assert.equal(failed?.status, "failed");
      assert.include(failed?.error ?? "", "retry promotion");
      assert.equal(forkCount, 1);
      assert.isNull(yield* h.orchestrator.getThreadShell(targetId));
      assert.equal((yield* h.orchestrator.getThreadProjection(parentId)).messages.length, 1);
      yield* request(h.orchestrator, CommandId.make("retry-rejected-promotion"));
      const retry = (yield* h.orchestrator.getThreadProjection(sourceId)).thread.subagentPromotion;
      assert.equal(retry?.status, "forking");
      assert.isNull(retry?.error);
      assert.equal(retry?.targetThreadId, targetId);
    }).pipe(Effect.provide(Layer.merge(nativeTestLayer, promotionLayer)));
  },
);

it.effect("recovers a persisted waiting request after the provider turn is already terminal", () =>
  Effect.gen(function* () {
    const h = yield* seed("completed");
    // This request represents state persisted before startup; no live terminal event follows it.
    yield* h.sink.write({
      events: [
        {
          id: EventId.make("persisted-waiting-promotion"),
          type: "thread.metadata-updated",
          threadId: sourceId,
          occurredAt: h.now,
          payload: {
            ...h.source,
            subagentPromotion: {
              requestId,
              targetThreadId: targetId,
              status: "waiting",
              error: null,
              requestedAt: h.now,
              updatedAt: h.now,
              createdBy: "user",
              creationSource: "web",
            },
          },
        },
      ],
    });
    yield* h.orchestrator.recoverDelegatedTasks;
    const promotion = (yield* h.orchestrator.getThreadProjection(sourceId)).thread
      .subagentPromotion;
    assert.equal(promotion?.status, "forking");
    assert.equal(promotion?.sourceProviderTurnId, sourceTurnId);
    assert.isTrue(Option.isSome(yield* h.outbox.get(`effect:${requestId}:subagent.promote`)));
  }).pipe(Effect.provide(TestLayer)),
);
