import { assert, it } from "@effect/vitest";
import {
  CommandId,
  CheckpointScopeId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as SqlClient from "effect/sql/SqlClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Recovery from "./ProviderRuntimeRecoveryService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");

const adapter: ProviderAdapterV2Shape = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("Lifecycle tests do not run provider effects"),
};
const BaseTestLayer = Layer.mergeAll(
  SqlitePersistence.layerMemory,
  ProviderReplayHarness.layerWithRegistry(
    { name: "thread-family-lifecycle" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { runEffectWorker: false, databaseLayer: SqlitePersistence.layerMemory },
  ),
  EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
  EventStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
  ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
);

const seedHistoricalThread = Effect.fnUntraced(function* (
  threadId: ThreadId,
  overrides: Partial<OrchestrationV2AppThread> = {},
) {
  const now = yield* DateTime.now;
  const thread: OrchestrationV2AppThread = {
    id: threadId,
    projectId: ProjectId.make("creator-startup:project"),
    title: threadId,
    createdBy: "agent",
    creationSource: "mcp",
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      rootThreadId: threadId,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
  yield* (yield* EventSink.EventSinkV2).write({
    events: [
      {
        id: EventId.make(`legacy:${threadId}`),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      },
    ],
  });
  return thread;
});
const TestLayer = Layer.merge(
  BaseTestLayer,
  Recovery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        BaseTestLayer,
        IdAllocator.layer,
        ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
      ),
    ),
  ),
);

it.layer(TestLayer)("inactive family startup recovery", (it) => {
  it.effect.each(["archived", "deleted"] as const)(
    "repairs %s owners before readiness without changing independent forks",
    (inactiveState) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const sink = yield* EventSink.EventSinkV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const rootId = ThreadId.make(`inactive-owner:${inactiveState}`);
        const nativeId = ThreadId.make(`native-child:${inactiveState}`);
        const orphanId = ThreadId.make(`orphan-native:${inactiveState}`);
        const waitingId = ThreadId.make(`waiting-child:${inactiveState}`);
        const forkId = ThreadId.make(`independent-fork:${inactiveState}`);
        const now = yield* DateTime.now;
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create:${rootId}`),
          threadId: rootId,
          projectId: ProjectId.make("project"),
          title: "Root",
          modelSelection: { instanceId, model: "model" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        const root = yield* store.getThread(rootId);
        let eventNumber = 0;
        const events: Array<OrchestrationV2DomainEvent> = [];
        const id = () => EventId.make(`startup:${inactiveState}:${++eventNumber}`);
        events.push({
          id: id(),
          type: "thread.metadata-updated",
          threadId: rootId,
          occurredAt: now,
          payload: {
            ...root,
            archivedAt: now,
            deletedAt: inactiveState === "deleted" ? now : null,
          },
        });
        for (const threadId of [nativeId, orphanId, waitingId, forkId]) {
          events.push({
            id: id(),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: {
              ...root,
              id: threadId,
              lineage: {
                parentThreadId: threadId === orphanId ? nativeId : rootId,
                rootThreadId: rootId,
                relationshipToParent: threadId === forkId ? "fork" : "subagent",
              },
            },
          });
        }
        for (const threadId of [nativeId, orphanId, forkId]) {
          const nodeId = NodeId.make(`question:${threadId}`);
          const turnId = ProviderTurnId.make(`native-turn:${threadId}`);
          if (threadId !== forkId)
            events.push({
              id: id(),
              type: "provider-thread.updated",
              threadId,
              occurredAt: now,
              payload: {
                id: ProviderThreadId.make(`provider:${threadId}`),
                driver: ProviderDriverKind.make("codex"),
                providerInstanceId: instanceId,
                providerSessionId: null,
                appThreadId: threadId,
                ownerNodeId: null,
                nativeThreadRef: null,
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
              },
            });
          events.push({
            id: id(),
            type: "node.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: nodeId,
              threadId,
              runId: null,
              parentNodeId: null,
              rootNodeId: nodeId,
              kind: "root_turn",
              status: "cancelled",
              countsForRun: false,
              providerThreadId: null,
              providerTurnId: turnId,
              nativeItemRef: null,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: now,
              completedAt: now,
            },
          });
          if (threadId !== forkId)
            events.push({
              id: id(),
              type: "provider-turn.updated",
              threadId,
              nodeId,
              occurredAt: now,
              payload: {
                id: turnId,
                providerThreadId: ProviderThreadId.make(`provider:${threadId}`),
                nodeId,
                runAttemptId: null,
                nativeTurnRef: null,
                ordinal: 1,
                status: "running",
                startedAt: now,
                completedAt: null,
              },
            });
          if (threadId !== orphanId)
            events.push({
              id: id(),
              type: "runtime-request.updated",
              threadId,
              nodeId,
              occurredAt: now,
              payload: {
                id: RuntimeRequestId.make(`request:${threadId}`),
                nodeId,
                providerTurnId: turnId,
                nativeRequestRef: null,
                kind: "user_input",
                status: "pending",
                responseCapability: { type: "message" },
                createdAt: now,
                resolvedAt: null,
              },
            });
        }
        const runIds: Array<RunId> = [];
        for (const threadId of [waitingId, forkId]) {
          const runId = RunId.make(`waiting:${threadId}`);
          runIds.push(runId);
          const run: OrchestrationV2Run = {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId: instanceId,
            modelSelection: { instanceId, model: "model" },
            providerThreadId: null,
            userMessageId: MessageId.make(`message:${threadId}`),
            rootNodeId: null,
            activeAttemptId: null,
            status: "waiting",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          };
          events.push({
            id: id(),
            type: "run.updated",
            threadId,
            runId,
            providerInstanceId: instanceId,
            occurredAt: now,
            payload: run,
          });
        }
        yield* sink.write({ events });
        for (const [index, threadId] of [waitingId, forkId].entries()) {
          const runId = runIds[index]!;
          yield* sink.writeWithEffects({
            commandId: CommandId.make(`command:effect:checkpoint.capture:${runId}`),
            events: [],
            effects: [
              {
                id: `checkpoint:${runId}`,
                threadId,
                commandId: CommandId.make(`command:effect:checkpoint.capture:${runId}`),
                request: {
                  type: "checkpoint.capture",
                  runId,
                  scopeId: CheckpointScopeId.make(`scope:${runId}`),
                },
              },
            ],
          });
        }
        const continuationCommand = CommandId.make(`prepared-continuation:${waitingId}`);
        yield* sink.writeWithEffects({
          commandId: continuationCommand,
          events: [],
          effects: [
            {
              id: `prepared:${waitingId}`,
              threadId: waitingId,
              commandId: continuationCommand,
              request: { type: "provider-runtime.continue", sourceRunId: runIds[0]! },
            },
          ],
        });
        assert.isFalse((yield* store.getRecoveryThreadIds("runtime")).includes(orphanId));
        yield* (yield* Recovery.ProviderRuntimeRecoveryService).recover;
        const native = yield* store.getThreadProjection(nativeId);
        assert.equal(
          (yield* store.getThreadProjection(orphanId)).providerTurns[0]?.status,
          "cancelled",
        );
        const sql = yield* SqlClient.SqlClient;
        const continuations = yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox
        WHERE thread_id IN (${nativeId}, ${orphanId}, ${waitingId})
          AND effect_type = 'provider-runtime.continue' AND status IN ('pending', 'running')`;
        assert.equal(continuations.length, 0);
        assert.equal(native.providerTurns[0]?.status, "cancelled");
        assert.equal(native.runtimeRequests[0]?.status, "expired");
        assert.equal((yield* store.getThreadProjection(waitingId)).runs[0]?.status, "cancelled");
        assert.equal((yield* outbox.listByCommandId(continuationCommand))[0]?.status, "cancelled");
        const fork = yield* store.getThreadProjection(forkId);
        assert.equal(fork.runtimeRequests[0]?.status, "pending");
        assert.equal(fork.runs[0]?.status, "waiting");
        yield* orchestrator.recoverDelegatedTasks;
        assert.deepEqual(yield* store.getRecoveryThreadIds("thread-families"), []);
        for (const threadId of [nativeId, orphanId, waitingId]) {
          const thread = yield* store.getThread(threadId);
          assert.isNotNull(inactiveState === "deleted" ? thread.deletedAt : thread.archivedAt);
        }
        assert.isNull((yield* store.getThread(forkId)).archivedAt);
        yield* (yield* Recovery.ProviderRuntimeRecoveryService).recover;
        yield* orchestrator.recoverDelegatedTasks;
        if (inactiveState === "archived") {
          yield* orchestrator.dispatch({
            type: "thread.unarchive",
            threadId: rootId,
            commandId: CommandId.make(`restore:${rootId}`),
          });
          assert.isNull((yield* store.getThread(nativeId)).archivedAt);
          assert.isNull((yield* store.getThread(waitingId)).archivedAt);
        }
      }),
  );
});

it.layer(TestLayer)("creator grouping startup recovery", (it) => {
  it.effect.each(["archived", "deleted", "missing"] as const)(
    "releases ordinary conversations with a historical %s creator without cancelling resumable work",
    (creatorState) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const sink = yield* EventSink.EventSinkV2;
        const events = yield* EventStore.EventStoreV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const recovery = yield* Recovery.ProviderRuntimeRecoveryService;
        const creatorId = ThreadId.make(`historical-creator:${creatorState}`);
        const ordinaryId = ThreadId.make(`ordinary-conversation:${creatorState}`);
        const archivedId = ThreadId.make(`archived-ordinary:${creatorState}`);
        const now = yield* DateTime.now;
        if (creatorState !== "missing") {
          yield* seedHistoricalThread(creatorId, {
            createdBy: "user",
            creationSource: "web",
            archivedAt: creatorState === "archived" ? now : null,
            deletedAt: creatorState === "deleted" ? now : null,
          });
        }
        yield* seedHistoricalThread(ordinaryId, {
          creatorThreadId: creatorId,
          creatorGrouping: "grouped",
          persistent: true,
          pinnedAt: now,
          pinOrderKey: "a0",
          activeOrderKey: "a1",
        });
        yield* seedHistoricalThread(archivedId, {
          creatorThreadId: creatorId,
          creatorGrouping: "grouped",
          archivedAt: now,
          archivedWith: {
            threadId: archivedId,
            commandId: CommandId.make(`own-archive:${archivedId}`),
          },
          pinnedAt: now,
          pinOrderKey: "a2",
          activeOrderKey: "a3",
        });
        const runId = RunId.make(`checkpoint-wait:${ordinaryId}`);
        const nodeId = NodeId.make(`user-input:${ordinaryId}`);
        const requestId = RuntimeRequestId.make(`user-input-request:${ordinaryId}`);
        const checkpointCommand = CommandId.make(`command:effect:checkpoint.capture:${runId}`);
        yield* sink.writeWithEffects({
          commandId: checkpointCommand,
          events: [
            {
              id: EventId.make(`legacy-run:${ordinaryId}`),
              type: "run.updated",
              threadId: ordinaryId,
              runId,
              occurredAt: now,
              payload: {
                id: runId,
                threadId: ordinaryId,
                ordinal: 1,
                providerInstanceId: instanceId,
                modelSelection: { instanceId, model: "model" },
                providerThreadId: null,
                userMessageId: MessageId.make(`user-message:${ordinaryId}`),
                rootNodeId: null,
                activeAttemptId: null,
                status: "waiting",
                requestedAt: now,
                startedAt: now,
                completedAt: null,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
            {
              id: EventId.make(`legacy-node:${ordinaryId}`),
              type: "node.updated",
              threadId: ordinaryId,
              nodeId,
              occurredAt: now,
              payload: {
                id: nodeId,
                threadId: ordinaryId,
                runId: null,
                parentNodeId: null,
                rootNodeId: nodeId,
                kind: "user_input_request",
                status: "waiting",
                countsForRun: false,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                runtimeRequestId: requestId,
                checkpointScopeId: null,
                startedAt: now,
                completedAt: null,
              },
            },
            {
              id: EventId.make(`legacy-request:${ordinaryId}`),
              type: "runtime-request.updated",
              threadId: ordinaryId,
              nodeId,
              occurredAt: now,
              payload: {
                id: requestId,
                nodeId,
                providerTurnId: null,
                nativeRequestRef: null,
                kind: "user_input",
                status: "pending",
                responseCapability: { type: "message" },
                createdAt: now,
                resolvedAt: null,
              },
            },
          ],
          effects: [
            {
              id: `checkpoint:${runId}`,
              threadId: ordinaryId,
              commandId: checkpointCommand,
              request: {
                type: "checkpoint.capture",
                runId,
                scopeId: CheckpointScopeId.make(`scope:${runId}`),
              },
            },
          ],
        });
        const originals = yield* Effect.forEach([ordinaryId, archivedId], (id) =>
          store.getThreadProjection(id),
        );
        const checkpointBefore = yield* outbox.listByCommandId(checkpointCommand);
        const beforeSequence = yield* events.latestSequence();
        yield* recovery.recover;
        yield* orchestrator.recoverDelegatedTasks;
        const repairs = yield* events
          .read({ afterSequence: beforeSequence })
          .pipe(Stream.runCollect);
        assert.equal(repairs.length, 2);
        assert.deepEqual(
          repairs.map((stored) => stored.event.threadId).toSorted(),
          [ordinaryId, archivedId].toSorted(),
        );
        for (const stored of repairs) {
          assert.equal(stored.event.type, "thread.metadata-updated");
          assert.isNotNull(stored.commandId);
          assert.deepEqual(yield* outbox.listByCommandId(stored.commandId!), []);
        }
        for (const original of originals) {
          const repaired = yield* store.getThreadProjection(original.thread.id);
          assert.deepEqual(repaired, {
            ...original,
            thread: {
              ...original.thread,
              creatorGrouping: "independent",
              pinnedAt: null,
              pinOrderKey: null,
              activeOrderKey: null,
              updatedAt: repaired.thread.updatedAt,
            },
            updatedAt: repaired.updatedAt,
          });
          assert.equal(
            (yield* store.getThreadShell(original.thread.id))?.creatorGrouping,
            "independent",
          );
        }
        assert.deepEqual(yield* outbox.listByCommandId(checkpointCommand), checkpointBefore);
        const repairedSequence = yield* events.latestSequence();
        yield* recovery.recover;
        yield* orchestrator.recoverDelegatedTasks;
        assert.equal(yield* events.latestSequence(), repairedSequence);
        if (creatorState === "archived") {
          yield* orchestrator.dispatch({
            type: "thread.unarchive",
            commandId: CommandId.make(`restore-creator:${creatorId}`),
            threadId: creatorId,
          });
        } else if (creatorState === "missing") {
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`restore-missing-creator:${creatorId}`),
            threadId: creatorId,
            projectId: ProjectId.make("creator-startup:project"),
            title: "Restored creator",
            modelSelection: { instanceId, model: "model" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
          });
        }
        const restoredSequence = yield* events.latestSequence();
        yield* recovery.recover;
        yield* orchestrator.recoverDelegatedTasks;
        assert.equal(yield* events.latestSequence(), restoredSequence);
        assert.equal((yield* store.getThread(ordinaryId)).creatorGrouping, "independent");
        const archived = yield* store.getThread(archivedId);
        assert.equal(archived.creatorGrouping, "independent");
        assert.isNotNull(archived.archivedAt);
        assert.equal(archived.archivedWith?.commandId, `own-archive:${archivedId}`);
      }),
  );

  it.effect.each(["fail", "complete"] as const)(
    "repairs creator placement while an ordinary archive is stopping before %s",
    (result) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const sink = yield* EventSink.EventSinkV2;
        const events = yield* EventStore.EventStoreV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const creatorId = ThreadId.make(`pending-creator:${result}`);
        const ordinaryId = ThreadId.make(`pending-ordinary:${result}`);
        const requestId = CommandId.make(`pending-archive:${result}`);
        const now = yield* DateTime.now;
        yield* seedHistoricalThread(creatorId, {
          archivedAt: result === "complete" ? now : null,
          deletedAt: result === "fail" ? now : null,
        });
        yield* seedHistoricalThread(ordinaryId, {
          creatorThreadId: creatorId,
          creatorGrouping: "grouped",
          runtimeMode: "approval-required",
          interactionMode: "plan",
          pinnedAt: now,
          pinOrderKey: "a0",
          activeOrderKey: "a1",
          archivePending: {
            threadId: ordinaryId,
            commandId: requestId,
            status: "stopping",
            childDisposition: "stop_and_archive",
            childThreadIds: [],
            archiveThreadIds: [ordinaryId],
            promoteThreadIds: [],
            modeLimit: { runtimeMode: "auto-accept-edits", interactionMode: "plan" },
          },
        });
        const runId = RunId.make(`pending-archive-run:${result}`);
        yield* sink.writeWithEffects({
          commandId: requestId,
          events: [
            {
              id: EventId.make(`pending-archive-run-event:${result}`),
              type: "run.updated",
              threadId: ordinaryId,
              runId,
              occurredAt: now,
              payload: {
                id: runId,
                threadId: ordinaryId,
                ordinal: 1,
                providerInstanceId: instanceId,
                modelSelection: { instanceId, model: "model" },
                providerThreadId: null,
                userMessageId: MessageId.make(`pending-archive-message:${result}`),
                rootNodeId: null,
                activeAttemptId: null,
                status: "cancelled",
                requestedAt: now,
                startedAt: now,
                completedAt: now,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
          ],
          effects: [
            {
              id: `effect:${requestId}:thread.archive`,
              commandId: requestId,
              threadId: ordinaryId,
              request: { type: "thread.archive", requestId },
            },
          ],
        });
        const original = yield* store.getThreadProjection(ordinaryId);
        const pendingEffects = yield* outbox.listByCommandId(requestId);
        const beforeSequence = yield* events.latestSequence();
        for (const [index, extra] of [
          { title: "Changed title" },
          { worktreePath: "/workspace/other" },
        ].entries()) {
          const refused = yield* orchestrator
            .dispatch({
              type: "thread.metadata.update",
              commandId: CommandId.make(`pending-compound-placement:${result}:${index}`),
              threadId: ordinaryId,
              creatorGrouping: "independent",
              ...extra,
            })
            .pipe(Effect.flip);
          assert.equal(refused._tag, "OrchestratorThreadArchivingError");
          assert.deepEqual(yield* store.getThreadProjection(ordinaryId), original);
          assert.deepEqual(yield* outbox.listByCommandId(requestId), pendingEffects);
          assert.equal(yield* events.latestSequence(), beforeSequence);
        }
        yield* (yield* Recovery.ProviderRuntimeRecoveryService).recover;
        yield* orchestrator.recoverDelegatedTasks;
        const repaired = yield* store.getThreadProjection(ordinaryId);
        assert.deepEqual(repaired, {
          ...original,
          thread: {
            ...original.thread,
            creatorGrouping: "independent",
            pinnedAt: null,
            pinOrderKey: null,
            activeOrderKey: null,
            updatedAt: repaired.thread.updatedAt,
          },
          updatedAt: repaired.updatedAt,
        });
        assert.deepEqual(yield* outbox.listByCommandId(requestId), pendingEffects);
        const repairs = yield* events
          .read({ afterSequence: beforeSequence })
          .pipe(Stream.runCollect);
        assert.equal(repairs.length, 1);
        assert.equal(repairs[0]?.event.type, "thread.metadata-updated");
        assert.equal(repairs[0]?.event.threadId, ordinaryId);
        assert.isNotNull(repairs[0]?.commandId);
        const repairedSequence = yield* events.latestSequence();
        yield* orchestrator.recoverDelegatedTasks;
        assert.equal(yield* events.latestSequence(), repairedSequence);
        if (result === "fail") {
          yield* orchestrator.dispatch({
            type: "thread.archive.fail",
            commandId: CommandId.make(`pending-archive-failed:${result}`),
            threadId: ordinaryId,
            requestId,
            error: "Synthetic shutdown failure",
          });
          const visible = (yield* store.getShellSnapshot()).threads.find(
            (thread) => thread.id === ordinaryId,
          );
          assert.equal(visible?.creatorGrouping, "independent");
          assert.equal(visible?.creatorThreadId, creatorId);
          assert.equal(visible?.archivePending?.status, "failed");
          assert.isNull(visible?.archivedAt);
        } else {
          yield* orchestrator.dispatch({
            type: "thread.archive.complete",
            commandId: CommandId.make(`pending-archive-completed:${result}`),
            threadId: ordinaryId,
            requestId,
          });
          const archived = yield* store.getThread(ordinaryId);
          assert.isNotNull(archived.archivedAt);
          assert.isNull(archived.archivePending);
          assert.equal(archived.creatorGrouping, "independent");
          yield* orchestrator.dispatch({
            type: "thread.unarchive",
            commandId: CommandId.make(`restore-pending-ordinary:${result}`),
            threadId: ordinaryId,
          });
          const restored = yield* store.getThread(ordinaryId);
          assert.isNull(restored.archivedAt);
          assert.equal(restored.creatorGrouping, "independent");
          assert.equal(restored.creatorThreadId, creatorId);
        }
      }),
  );

  it.effect(
    "leaves active creator groups, ownership, forks and explicit independence unchanged",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const events = yield* EventStore.EventStoreV2;
        const activeCreator = ThreadId.make("excluded:active-origin");
        const archivedCreator = ThreadId.make("excluded:archived-origin");
        const now = yield* DateTime.now;
        yield* seedHistoricalThread(activeCreator);
        yield* seedHistoricalThread(archivedCreator, { archivedAt: now });
        const cases: ReadonlyArray<{
          id: string;
          overrides: Partial<OrchestrationV2AppThread>;
        }> = [
          { id: "active-creator", overrides: { creatorThreadId: activeCreator } },
          {
            id: "fork",
            overrides: {
              lineage: {
                parentThreadId: archivedCreator,
                rootThreadId: archivedCreator,
                relationshipToParent: "fork",
              },
              forkedFrom: { type: "node", nodeId: NodeId.make("excluded:fork-source") },
            },
          },
          {
            id: "archived-subagent",
            overrides: {
              archivedAt: now,
              lineage: {
                parentThreadId: archivedCreator,
                rootThreadId: archivedCreator,
                relationshipToParent: "subagent",
              },
            },
          },
          {
            id: "promoted-subagent",
            overrides: {
              lineage: {
                parentThreadId: archivedCreator,
                rootThreadId: archivedCreator,
                relationshipToParent: "subagent",
                independent: true,
              },
            },
          },
          { id: "independent", overrides: { creatorGrouping: "independent" } },
          { id: "deleted", overrides: { deletedAt: now } },
        ];
        const originals = yield* Effect.forEach(cases, (testCase) =>
          seedHistoricalThread(ThreadId.make(`excluded:${testCase.id}`), {
            creatorThreadId: archivedCreator,
            creatorGrouping: "grouped",
            persistent: true,
            pinnedAt: now,
            pinOrderKey: "a0",
            activeOrderKey: "a1",
            ...testCase.overrides,
          }),
        );
        const beforeSequence = yield* events.latestSequence();
        yield* orchestrator.recoverDelegatedTasks;
        assert.equal(yield* events.latestSequence(), beforeSequence);
        for (const original of originals)
          assert.deepEqual(yield* store.getThread(original.id), original);
      }),
  );
});
