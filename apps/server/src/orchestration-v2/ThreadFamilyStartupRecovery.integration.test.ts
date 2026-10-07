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
  type OrchestrationV2Run,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as SqlClient from "effect/sql/SqlClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
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
  ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
);
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
