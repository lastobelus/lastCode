import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  getThreadArchivePlan,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  RunId,
  RunAttemptId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "./Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { DispatchModeLimit } from "./DispatchModeLimit.ts";
import { makeSubagentChildThread } from "@t3tools/provider-core/server/subagentProjection";
import { shellStreamItemFromThreadShell } from "./ShellStream.ts";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "model" };

it.effect.each(["announcement", "factory"] as const)(
  "late %s children and archive failure keep compact references in durable events and shells",
  (path) => {
    const database = SqlitePersistence.layerMemory;
    const adapter = {
      instanceId,
      driver,
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
      openSession: () => Effect.die("Compact archive fixtures never start a provider"),
    } as ProviderAdapterV2Shape;
    const base = Layer.mergeAll(
      ProviderReplayHarness.layerWithRegistry(
        { name: "late-native-archive-reference" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { runEffectWorker: false, databaseLayer: database },
      ),
      ProjectionStore.layer.pipe(Layer.provide(database)),
    );
    const layer = Layer.merge(
      base,
      ProviderEventIngestor.layer.pipe(
        Layer.provide(Layer.mergeAll(base, IdAllocator.layer, ThreadCommandExecutor.layer)),
      ),
    );
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const now = yield* DateTime.now;
      const ownerId = ThreadId.make("compact-archive-owner");
      const firstId = ThreadId.make("compact-archive-existing-child");
      const lateId = ThreadId.make("compact-archive-late-child");
      const nestedId = ThreadId.make("compact-archive-nested-child");
      const afterFailureId = ThreadId.make("compact-archive-after-failure-child");
      const requestId = CommandId.make("compact-archive-request");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("compact-archive-create-owner"),
        threadId: ownerId,
        projectId: ProjectId.make("project:compact-archive"),
        title: "Compact archive owner",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const announce = (parentId: ThreadId, childId: ThreadId) =>
        Effect.gen(function* () {
          const parent = yield* store.getThread(parentId);
          const child =
            path === "factory"
              ? makeSubagentChildThread({
                  parentThread: parent,
                  childThreadId: childId,
                  parentNodeId: NodeId.make(`native-node:${parentId}`),
                  activeProviderThreadId: null,
                  providerInstanceId: instanceId,
                  modelSelection,
                  title: "Late native child",
                  now,
                  createdBy: "agent",
                  creationSource: "provider",
                })
              : {
                  ...parent,
                  id: childId,
                  title: "Late native child",
                  creationSource: "provider" as const,
                  lineage: {
                    parentThreadId: parentId,
                    relationshipToParent: "subagent" as const,
                    rootThreadId: ownerId,
                  },
                };
          if (path === "factory") assert.isNull(getThreadArchivePlan(child.archivePending));
          return yield* ingestor.ingestNormalized({
            threadId: ownerId,
            providerSessionId: ProviderSessionId.make("compact-archive-provider-session"),
            providerInstanceId: instanceId,
            event: { type: "app_thread.created", driver, appThread: child },
          });
        });
      yield* announce(ownerId, firstId);
      yield* orchestrator
        .dispatch({
          type: "thread.archive",
          commandId: requestId,
          threadId: ownerId,
          childDisposition: "stop_and_archive",
          expectedChildThreadIds: [firstId],
        })
        .pipe(
          Effect.provideService(DispatchModeLimit, {
            runtimeMode: "full-access",
            interactionMode: "default",
          }),
        );
      const stopping = { threadId: ownerId, commandId: requestId, status: "stopping" as const };
      for (const [parentId, childId] of [
        [ownerId, lateId],
        [lateId, nestedId],
      ] as const) {
        const created = yield* announce(parentId, childId);
        const event = created.find(({ event }) => event.type === "thread.created")?.event;
        assert.isDefined(event);
        if (event?.type !== "thread.created") throw new Error("Expected native thread creation");
        assert.deepEqual(event.payload.archivePending, stopping);
        assert.deepEqual((yield* store.getThread(childId)).archivePending, stopping);
      }
      assert.isNotNull(getThreadArchivePlan((yield* store.getThread(ownerId)).archivePending));
      // The extra native branch changes the accepted partition. Drain the real
      // shutdown effect so its durable failure reaches every late participant.
      yield* worker.drain();
      const failedOwner = yield* store.getThread(ownerId);
      assert.equal(failedOwner.archivePending?.status, "failed");
      assert.isNotNull(getThreadArchivePlan(failedOwner.archivePending));
      const failed = {
        ...stopping,
        status: "failed" as const,
        error: failedOwner.archivePending?.error,
      };
      const failedEvents = yield* sink
        .readByCommandId({ commandId: CommandId.make(`${requestId}:failed`) })
        .pipe(Stream.runCollect);
      for (const childId of [firstId, lateId, nestedId]) {
        assert.deepEqual((yield* store.getThread(childId)).archivePending, failed);
        const update = failedEvents.find(({ event }) => event.threadId === childId)?.event;
        assert.isDefined(update);
        if (update?.type !== "thread.metadata-updated") throw new Error("Expected archive failure");
        assert.deepEqual(update.payload.archivePending, failed);
        const shell = yield* store.getThreadShell(childId);
        assert.isNotNull(shell);
        const streamed = shellStreamItemFromThreadShell({
          shell,
          stored: { sequence: failedEvents.at(-1)!.sequence, event: { threadId: childId } },
        });
        if (streamed.kind !== "thread.updated")
          throw new Error("Expected visible failed participant");
        assert.deepEqual(streamed.thread.archivePending, failed);
      }
      const last = yield* announce(nestedId, afterFailureId);
      const event = last.find(({ event }) => event.type === "thread.created")?.event;
      if (event?.type !== "thread.created") throw new Error("Expected late failed-state creation");
      assert.deepEqual(event.payload.archivePending, failed);
      assert.deepEqual((yield* store.getThread(afterFailureId)).archivePending, failed);
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each(["thread.archive", "thread.delete"] as const)(
  "%s stops native work announced after the child became inactive",
  (operation) =>
    Effect.gen(function* () {
      const interrupted = yield* Ref.make<Array<string>>([]);
      const unloaded = yield* Ref.make<Array<string>>([]);
      const closed = yield* Ref.make(0);
      const adapter: ProviderAdapterV2Shape = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            yield* Effect.addFinalizer(() => Ref.update(closed, (count) => count + 1));
            return {
              instanceId,
              driver,
              providerSessionId: input.providerSessionId,
              providerSession: {
                id: input.providerSessionId,
                driver,
                providerInstanceId: instanceId,
                status: "ready" as const,
                cwd: process.cwd(),
                model: "model",
                capabilities: CodexProviderCapabilitiesV2,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.never,
              publishEventsBarrier: () => Effect.void,
              ensureThread: () => Effect.die("unused"),
              resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
              startTurn: () => Effect.void,
              steerTurn: () => Effect.void,
              interruptTurn: ({ providerTurnId }) =>
                Ref.update(interrupted, (ids) => [...ids, providerTurnId]),
              unloadThread: ({ providerThread }) =>
                Ref.update(unloaded, (ids) => [...ids, providerThread.id]),
              respondToRuntimeRequest: () => Effect.void,
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
              forkThread: () => Effect.die("unused"),
            };
          }),
      };
      const base = Layer.mergeAll(
        ProviderReplayHarness.layerWithRegistry(
          { name: "late-native-lifecycle" },
          ProviderAdapterRegistry.layerFromAdapters([adapter]),
          { runEffectWorker: false, databaseLayer: SqlitePersistence.layerMemory },
        ),
        ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
      );
      const layer = Layer.merge(
        base,
        ProviderEventIngestor.layer.pipe(
          Layer.provide(Layer.mergeAll(base, IdAllocator.layer, ThreadCommandExecutor.layer)),
        ),
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const sink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const parentId = ThreadId.make(`parent:${operation}`);
        const siblingId = ThreadId.make(`sibling:${operation}`);
        const childId = ThreadId.make(`child:${operation}`);
        const sessionId = ProviderSessionId.make(`shared:${operation}`);
        for (const threadId of [parentId, siblingId]) {
          yield* orchestrator.dispatch({
            type: "thread.create",
            threadId,
            commandId: CommandId.make(`create:${threadId}`),
            projectId: ProjectId.make("project"),
            title: "Owner",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
          });
          yield* manager.open({
            threadId,
            providerSessionId: sessionId,
            modelSelection,
            runtimePolicy: {
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: process.cwd(),
            },
          });
        }
        for (const threadId of [parentId, siblingId]) {
          const providerThreadId = ProviderThreadId.make(`provider:${threadId}`);
          yield* sink.write({
            events: [
              {
                id: EventId.make(`owner-provider:${threadId}`),
                type: "provider-thread.updated",
                threadId,
                occurredAt: now,
                payload: {
                  id: providerThreadId,
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: sessionId,
                  appThreadId: threadId,
                  ownerNodeId: null,
                  nativeThreadRef: { driver, nativeId: `native:${threadId}`, strength: "strong" },
                  nativeConversationHeadRef: null,
                  status: "active",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                },
              },
              {
                id: EventId.make(`owner-turn:${threadId}`),
                type: "provider-turn.updated",
                threadId,
                occurredAt: now,
                payload: {
                  id: ProviderTurnId.make(`owner-turn:${threadId}`),
                  providerThreadId,
                  nodeId: NodeId.make(`owner-node:${threadId}`),
                  runAttemptId: null,
                  nativeTurnRef: null,
                  ordinal: 1,
                  status: "running",
                  startedAt: now,
                  completedAt: null,
                },
              },
            ],
          });
        }
        const parent = yield* store.getThread(parentId);
        yield* ingestor.ingestNormalized({
          threadId: parentId,
          providerSessionId: sessionId,
          providerInstanceId: instanceId,
          event: {
            type: "app_thread.created",
            driver,
            appThread: {
              ...parent,
              id: childId,
              createdBy: "agent",
              creationSource: "provider",
              lineage: {
                parentThreadId: parentId,
                rootThreadId: parentId,
                relationshipToParent: "subagent",
              },
            },
          },
        });
        // Delivery pauses before the provider-thread/session identity arrives.
        assert.deepEqual(
          (yield* store.getThreadRecords(childId, ["providerThreads"])).providerThreads,
          [],
        );
        yield* orchestrator.dispatch({
          type: operation,
          threadId: childId,
          commandId: CommandId.make(`inactive:${childId}`),
        });
        yield* worker.drain();
        const providerThread: OrchestrationV2ProviderThread = {
          id: ProviderThreadId.make(`native:${childId}`),
          driver,
          providerInstanceId: instanceId,
          providerSessionId: sessionId,
          appThreadId: childId,
          ownerNodeId: null,
          nativeThreadRef: { driver, nativeId: "child-native", strength: "strong" },
          nativeConversationHeadRef: null,
          status: "active",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        };
        yield* ingestor.ingestNormalized({
          threadId: parentId,
          providerSessionId: sessionId,
          providerInstanceId: instanceId,
          event: { type: "provider_thread.updated", driver, providerThread },
        });
        yield* worker.drain();
        assert.deepEqual(yield* Ref.get(unloaded), [providerThread.id]);
        const turnId = ProviderTurnId.make(`late-turn:${childId}`);
        yield* ingestor.ingestNormalized({
          threadId: parentId,
          providerSessionId: sessionId,
          providerInstanceId: instanceId,
          event: {
            type: "provider_turn.updated",
            driver,
            threadId: childId,
            providerTurn: {
              id: turnId,
              providerThreadId: providerThread.id,
              nodeId: NodeId.make(`node:${childId}`),
              runAttemptId: null,
              nativeTurnRef: null,
              ordinal: 1,
              status: "running",
              startedAt: now,
              completedAt: null,
            },
          },
        });
        yield* worker.drain();
        assert.deepEqual(yield* Ref.get(interrupted), [turnId]);
        assert.deepEqual(yield* Ref.get(unloaded), [providerThread.id, providerThread.id]);
        assert.equal(yield* Ref.get(closed), 0);
        for (const threadId of [parentId, siblingId]) {
          const thread = yield* store.getThread(threadId);
          assert.equal(
            (yield* store.getThreadRecords(threadId, ["providerTurns"])).providerTurns[0]?.status,
            "running",
          );
          assert.isNull(thread.archivedAt);
          assert.isNull(thread.deletedAt);
          assert.equal(
            (yield* store.getThreadRecords(threadId, ["providerSessions"])).providerSessions[0]
              ?.status,
            "ready",
          );
        }
        const inactive = yield* store.getThread(childId);
        assert.isNotNull(operation === "thread.delete" ? inactive.deletedAt : inactive.archivedAt);
        // A stale guarded delivery must enqueue no cleanup alongside its rejected event.
        const rejected = yield* ingestor.ingestNormalized({
          threadId: parentId,
          providerSessionId: sessionId,
          providerInstanceId: instanceId,
          writeIfProviderThreadOwner: {
            providerThreadId: providerThread.id,
            runId: RunId.make("stale-run"),
            activeAttemptId: RunAttemptId.make("stale-attempt"),
            expectedLastRunOrdinal: 1,
          },
          event: { type: "provider_thread.updated", driver, providerThread },
        });
        assert.equal(rejected.length, 0);
        yield* worker.drain();
        assert.deepEqual(yield* Ref.get(unloaded), [providerThread.id, providerThread.id]);
        // A history record pointing at another active owner cannot detach it.
        yield* sink.write({
          events: [
            {
              id: EventId.make(`foreign:${childId}`),
              type: "provider-thread.updated",
              threadId: childId,
              occurredAt: now,
              payload: {
                ...providerThread,
                id: ProviderThreadId.make(`foreign:${childId}`),
                appThreadId: siblingId,
              },
            },
          ],
        });
        yield* ingestor.ingestNormalized({
          threadId: childId,
          providerSessionId: sessionId,
          providerInstanceId: instanceId,
          event: {
            type: "provider_turn.updated",
            driver,
            threadId: childId,
            providerTurn: {
              id: ProviderTurnId.make(`foreign-turn:${childId}`),
              providerThreadId: ProviderThreadId.make(`foreign:${childId}`),
              nodeId: NodeId.make(`foreign-node:${childId}`),
              runAttemptId: null,
              nativeTurnRef: null,
              ordinal: 1,
              status: "running",
              startedAt: now,
              completedAt: null,
            },
          },
        });
        yield* worker.drain();
        assert.deepEqual(yield* Ref.get(interrupted), [turnId]);
      }).pipe(Effect.provide(layer));
    }),
);
