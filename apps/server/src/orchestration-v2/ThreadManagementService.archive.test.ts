import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { DispatchModeLimit } from "./DispatchModeLimit.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const database = SqlitePersistence.layerMemory;
const testLayer = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      ProjectionStore.layer.pipe(Layer.provide(database)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "thread-service-archive" },
        ProviderAdapterRegistry.layerFromAdapters([]),
        { databaseLayer: database, runEffectWorker: false },
      ),
    ),
  ),
);
const rootId = ThreadId.make("service-archive:parent");
const childId = ThreadId.make("service-archive:child");
const originalId = CommandId.make("service-archive:original");
const instanceId = ProviderInstanceId.make("codex");

const createArchivedRoot = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
  yield* threads.dispatch({
    type: "thread.create",
    commandId: CommandId.make("service-archive:create"),
    threadId: rootId,
    projectId: ProjectId.make("service-archive:project"),
    title: "Archived parent",
    modelSelection: { instanceId, model: "example-model" },
    runtimeMode: "full-access",
    interactionMode: "plan",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* threads.dispatch({ type: "thread.archive", commandId: originalId, threadId: rootId });
  yield* worker.drain();
  return (yield* threads.getThreadRecords(rootId, [])).thread;
});

const addStrandedChild = (withProviderBinding: boolean) =>
  Effect.gen(function* () {
    const root = yield* createArchivedRoot;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make("service-archive:create-child"),
      type: "thread.created",
      threadId: childId,
      occurredAt: now,
      payload: {
        ...root,
        id: childId,
        title: "Stranded child",
        creationSource: "mcp",
        createdBy: "agent",
        archivedAt: null,
        archivedWith: null,
        archivePending: null,
        lineage: {
          rootThreadId: rootId,
          parentThreadId: rootId,
          relationshipToParent: "subagent",
        },
      },
    });
    if (withProviderBinding)
      yield* projections.apply({
        id: EventId.make("service-archive:child-provider"),
        type: "provider-thread.updated",
        threadId: childId,
        occurredAt: now,
        payload: {
          id: ProviderThreadId.make("service-archive:provider-thread"),
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: instanceId,
          providerSessionId: ProviderSessionId.make("service-archive:old-session"),
          appThreadId: childId,
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
    return root;
  });

it.effect("a fresh archive request on an archived root succeeds without replacing its cohort", () =>
  Effect.gen(function* () {
    const original = yield* createArchivedRoot;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const result = yield* threads.dispatch({
      type: "thread.archive",
      threadId: rootId,
      commandId: CommandId.make("service-archive:repeat"),
    });
    const repeated = (yield* threads.getThreadRecords(rootId, [])).thread;
    assert.equal(result.storedEvents.length, 0);
    assert.deepEqual(repeated.archivedAt, original.archivedAt);
    assert.deepEqual(repeated.archivedWith, original.archivedWith);
    assert.isNull(repeated.archivePending ?? null);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("an idle stranded child repair returns success under the original archive cohort", () =>
  Effect.gen(function* () {
    const original = yield* addStrandedChild(false);
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    yield* threads.dispatch({
      type: "thread.archive",
      threadId: rootId,
      commandId: CommandId.make("service-archive:idle-repair"),
    });
    yield* worker.drain();
    const root = (yield* threads.getThreadRecords(rootId, [])).thread;
    const child = (yield* threads.getThreadRecords(childId, [])).thread;
    assert.deepEqual(root.archivedAt, original.archivedAt);
    assert.deepEqual(root.archivedWith, original.archivedWith);
    assert.isNotNull(child.archivedAt);
    assert.deepEqual(child.archivedWith, original.archivedWith);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("explicit promotion preserves a protected idle child of an archived owner", () =>
  Effect.gen(function* () {
    const original = yield* addStrandedChild(false);
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const child = (yield* threads.getThreadRecords(childId, [])).thread;
    yield* projections.apply({
      id: EventId.make("service-archive:protect-stranded-child"),
      type: "thread.metadata-updated",
      threadId: childId,
      occurredAt: yield* DateTime.now,
      payload: { ...child, persistent: true },
    });
    const command = {
      type: "thread.archive" as const,
      threadId: rootId,
      commandId: CommandId.make("service-archive:promote-idle-child"),
      childDisposition: "promote" as const,
      expectedChildThreadIds: [childId],
    };
    yield* orchestrator.dispatch(command);
    const observing = yield* threads.dispatch(command).pipe(Effect.forkChild);
    yield* worker.drain();
    yield* Fiber.join(observing);
    const kept = (yield* threads.getThreadRecords(childId, [])).thread;
    assert.isNull(kept.archivedAt);
    assert.isTrue(kept.persistent);
    assert.isTrue(kept.lineage.independent);
    assert.equal(kept.lineage.parentThreadId, rootId);
    const root = (yield* threads.getThreadRecords(rootId, [])).thread;
    assert.deepEqual(root.archivedAt, original.archivedAt);
    assert.deepEqual(root.archivedWith, original.archivedWith);
  }).pipe(Effect.provide(testLayer)),
);

it.effect.each(["stop_and_archive", "promote"] as const)(
  "archived-owner repair rejects stale explicit %s participants before any mutation",
  (childDisposition) =>
    Effect.gen(function* () {
      const original = yield* addStrandedChild(false);
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sequence = (yield* orchestrator.getShellSnapshot()).snapshotSequence;
      const refused = yield* threads
        .dispatch({
          type: "thread.archive",
          threadId: rootId,
          commandId: CommandId.make(`service-archive:stale-repair:${childDisposition}`),
          childDisposition,
          expectedChildThreadIds: [],
        })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "OrchestratorDispatchError");
      assert.include(String(refused.cause), "subagents changed");
      assert.equal((yield* orchestrator.getShellSnapshot()).snapshotSequence, sequence);
      const child = (yield* threads.getThreadRecords(childId, [])).thread;
      const root = (yield* threads.getThreadRecords(rootId, [])).thread;
      assert.isNull(child.archivedAt);
      assert.isNull(child.archivePending ?? null);
      assert.isUndefined(child.lineage.independent);
      assert.deepEqual(root.archivedAt, original.archivedAt);
      assert.deepEqual(root.archivedWith, original.archivedWith);
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each(["complete", "fail"] as const)(
  "provider-binding repair waits for the real effect worker to %s despite the archived root",
  (outcome) =>
    Effect.gen(function* () {
      const original = yield* addStrandedChild(true);
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const sequence = (yield* orchestrator.getShellSnapshot()).snapshotSequence;
      const commandId = CommandId.make(`service-archive:strict-repair:${outcome}`);
      const waiting = yield* threads
        .dispatch({ type: "thread.archive", threadId: rootId, commandId })
        .pipe(
          Effect.provideService(DispatchModeLimit, {
            runtimeMode: "full-access",
            interactionMode: "plan",
          }),
          Effect.result,
          Effect.forkChild,
        );
      yield* orchestrator
        .streamStoredEventsFrom({ threadId: rootId, afterSequence: sequence })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "thread.metadata-updated" &&
              stored.event.payload.archivePending?.commandId === commandId &&
              stored.event.payload.archivePending.status === "stopping",
          ),
          Stream.runHead,
        );
      assert.isUndefined(waiting.pollUnsafe());
      const pendingRoot = (yield* threads.getThreadRecords(rootId, [])).thread;
      assert.deepEqual(pendingRoot.archivedAt, original.archivedAt);
      assert.isNull((yield* threads.getThreadRecords(childId, [])).thread.archivedAt);
      // Replaying the original receipt acknowledges only that completed request.
      const replay = yield* threads
        .dispatch({ type: "thread.archive", threadId: rootId, commandId: originalId })
        .pipe(Effect.result);
      assert.equal(replay._tag, "Success");
      assert.equal(
        (yield* threads.getThreadRecords(rootId, [])).thread.archivePending?.commandId,
        commandId,
      );
      if (outcome === "fail") {
        const child = (yield* threads.getThreadRecords(childId, [])).thread;
        const now = yield* DateTime.now;
        yield* projections.apply({
          id: EventId.make("service-archive:child-mode-raised"),
          type: "thread.metadata-updated",
          threadId: childId,
          occurredAt: now,
          payload: { ...child, interactionMode: "default", updatedAt: now },
        });
      }
      yield* worker.drain();
      const result = yield* Fiber.join(waiting);
      const root = (yield* threads.getThreadRecords(rootId, [])).thread;
      const child = (yield* threads.getThreadRecords(childId, [])).thread;
      assert.deepEqual(root.archivedAt, original.archivedAt);
      assert.deepEqual(root.archivedWith, original.archivedWith);
      if (outcome === "complete") {
        assert.equal(result._tag, "Success");
        assert.isNull(root.archivePending ?? null);
        assert.isNotNull(child.archivedAt);
        assert.deepEqual(child.archivedWith, original.archivedWith);
      } else {
        assert.equal(result._tag, "Failure");
        assert.equal(root.archivePending?.status, "failed");
        assert.isNull(child.archivedAt);
        assert.equal(child.archivePending?.status, "failed");
        const restore = {
          type: "thread.unarchive" as const,
          threadId: rootId,
          commandId: CommandId.make("service-archive:restore-failed-repair"),
        };
        const refused = yield* threads.dispatch(restore).pipe(
          Effect.provideService(DispatchModeLimit, {
            runtimeMode: "full-access",
            interactionMode: "plan",
          }),
          Effect.flip,
        );
        assert.equal(refused._tag, "OrchestratorThreadAboveModeLimitError");
        assert.deepEqual(
          (yield* threads.getThreadRecords(rootId, [])).thread.archivedAt,
          root.archivedAt,
        );
        assert.deepEqual(
          (yield* threads.getThreadRecords(childId, [])).thread.archivePending,
          child.archivePending,
        );
        yield* threads.dispatch(restore);
        for (const id of [rootId, childId]) {
          const restored = (yield* threads.getThreadRecords(id, [])).thread;
          assert.isNull(restored.archivedAt);
          assert.isNull(restored.archivePending);
        }
      }
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each(["matching", "legacy", "other-owner", "other-request"] as const)(
  "restore clears only the owner's matching failed repair (%s)",
  (kind) =>
    Effect.gen(function* () {
      const original = yield* addStrandedChild(true);
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const nestedId = ThreadId.make("service-archive:nested-child");
      const childBefore = (yield* threads.getThreadRecords(childId, [])).thread;
      yield* projections.apply({
        id: EventId.make("service-archive:create-nested-child"),
        type: "thread.created",
        threadId: nestedId,
        occurredAt: now,
        payload: {
          ...childBefore,
          id: nestedId,
          lineage: { ...childBefore.lineage, parentThreadId: childId },
        },
      });
      if (kind === "legacy")
        yield* projections.apply({
          id: EventId.make("service-archive:legacy-owner"),
          type: "thread.metadata-updated",
          threadId: rootId,
          occurredAt: now,
          payload: { ...original, archivedWith: null },
        });
      const repairId = CommandId.make("service-archive:failed-repair");
      yield* orchestrator.dispatch({
        type: "thread.archive",
        threadId: rootId,
        commandId: repairId,
      });
      yield* orchestrator.dispatch({
        type: "thread.archive.fail",
        commandId: CommandId.make("service-archive:fail-repair"),
        threadId: rootId,
        requestId: repairId,
        error: "Synthetic shutdown failure",
      });
      const failedChild = (yield* threads.getThreadRecords(childId, [])).thread;
      assert.equal(failedChild.archivePending?.status, "failed");
      const pending = {
        ...failedChild.archivePending!,
        threadId: kind === "other-owner" ? childId : rootId,
        commandId:
          kind === "other-request" ? CommandId.make("service-archive:other-request") : repairId,
      };
      yield* projections.apply({
        id: EventId.make("service-archive:child-failure-identity"),
        type: "thread.metadata-updated",
        threadId: childId,
        occurredAt: now,
        payload: { ...failedChild, archivePending: pending },
      });
      yield* threads.dispatch({
        type: "thread.unarchive",
        threadId: rootId,
        commandId: CommandId.make("service-archive:restore-owner"),
      });
      const restoredRoot = (yield* threads.getThreadRecords(rootId, [])).thread;
      const child = (yield* threads.getThreadRecords(childId, [])).thread;
      const nested = (yield* threads.getThreadRecords(nestedId, [])).thread;
      assert.isNull(restoredRoot.archivedAt);
      assert.isNull(restoredRoot.archivePending);
      assert.isNull(child.archivedAt);
      assert.deepEqual(child.lineage, failedChild.lineage);
      assert.isNull(nested.archivedAt);
      assert.isNull(nested.archivePending);
      assert.equal(nested.lineage.parentThreadId, childId);
      assert.isUndefined(nested.lineage.independent);
      if (kind === "matching" || kind === "legacy") assert.isNull(child.archivePending);
      else assert.deepEqual(child.archivePending, pending);
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each(["reopen", "new-archive", "retry-after-failure"] as const)(
  "reports the original archive outcome when %s commits before completion is consumed",
  (laterAction) =>
    Effect.gen(function* () {
      yield* addStrandedChild(true);
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const observing = yield* Deferred.make<void>();
      const consume = yield* Deferred.make<void>();
      // Delay only this RPC's observation; dispatch, persistence, and the worker
      // remain real, so later commands can commit before it consumes the outcome.
      const observer = yield* ThreadManagementService.ThreadManagementService.pipe(
        Effect.provide(
          Layer.fresh(ThreadManagementService.layer).pipe(
            Layer.provide(
              Layer.succeed(
                Orchestrator.OrchestratorV2,
                Orchestrator.OrchestratorV2.of({
                  ...orchestrator,
                  streamStoredEventsFrom: (input) =>
                    Stream.unwrap(
                      Deferred.succeed(observing, undefined).pipe(
                        Effect.andThen(Deferred.await(consume)),
                        Effect.as(orchestrator.streamStoredEventsFrom(input)),
                      ),
                    ),
                }),
              ),
            ),
          ),
        ),
      );
      const commandId = CommandId.make(`service-archive:delayed:${laterAction}`);
      const waiting = yield* observer
        .dispatch({ type: "thread.archive", threadId: rootId, commandId })
        .pipe(
          Effect.provideService(DispatchModeLimit, {
            runtimeMode: "full-access",
            interactionMode: "plan",
          }),
          Effect.result,
          Effect.forkChild,
        );
      yield* Deferred.await(observing);
      if (laterAction === "retry-after-failure") {
        const child = (yield* threads.getThreadRecords(childId, [])).thread;
        const now = yield* DateTime.now;
        yield* projections.apply({
          id: EventId.make("service-archive:delayed-child-mode"),
          type: "thread.metadata-updated",
          threadId: childId,
          occurredAt: now,
          payload: { ...child, interactionMode: "default", updatedAt: now },
        });
      }
      yield* worker.drain();
      if (laterAction === "retry-after-failure") {
        assert.equal(
          (yield* threads.getThreadRecords(rootId, [])).thread.archivePending?.status,
          "failed",
        );
        yield* orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("service-archive:later-successful-retry"),
          threadId: rootId,
        });
        yield* worker.drain();
        assert.isNull((yield* threads.getThreadRecords(rootId, [])).thread.archivePending ?? null);
      } else {
        yield* threads.dispatch({
          type: "thread.unarchive",
          threadId: rootId,
          commandId: CommandId.make(`service-archive:later-reopen:${laterAction}`),
        });
        if (laterAction === "new-archive")
          yield* orchestrator.dispatch({
            type: "thread.archive",
            threadId: rootId,
            commandId: CommandId.make("service-archive:later-pending-request"),
            childDisposition: "stop_and_archive",
            expectedChildThreadIds: [childId],
          });
      }
      assert.isUndefined(waiting.pollUnsafe());
      yield* Deferred.succeed(consume, undefined);
      const result = yield* Fiber.join(waiting);
      assert.equal(result._tag, laterAction === "retry-after-failure" ? "Failure" : "Success");
      if (laterAction === "retry-after-failure") {
        const replay = yield* threads
          .dispatch({ type: "thread.archive", threadId: rootId, commandId })
          .pipe(Effect.result);
        assert.equal(replay._tag, "Failure");
      }
      if (laterAction === "new-archive")
        assert.equal(
          (yield* threads.getThreadRecords(rootId, [])).thread.archivePending?.commandId,
          CommandId.make("service-archive:later-pending-request"),
        );
      if (laterAction === "reopen")
        assert.isNull((yield* threads.getThreadRecords(rootId, [])).thread.archivedAt);
    }).pipe(Effect.provide(testLayer)),
);
