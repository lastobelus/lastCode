import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  RunAttemptId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { DispatchModeLimit } from "./DispatchModeLimit.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ThreadRecovery from "./ThreadRecoveryService.ts";
import { withVerifiedArchiveActivity } from "./ThreadArchiveActivity.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "fixture-model" };
const parentId = ThreadId.make("retention-parent");
const database = SqlitePersistence.layerMemory;
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Retention fixtures never start provider execution"),
} as ProviderAdapterV2Shape;
// Use normalized SQLite records: historical task references also return their
// child's provider thread, which a projection-only fixture would miss.
const testLayer = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      database,
      ProjectionStore.layer.pipe(Layer.provide(database)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "archive-retention" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: database, runEffectWorker: false },
      ),
    ),
  ),
);
const recoveryTestLayer = ThreadRecovery.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(testLayer, IdAllocator.layer, ThreadCommandExecutor.layer)),
);

const send = (threadId: ThreadId, label: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`retention-send:${label}`),
      threadId,
      messageId: MessageId.make(`retention-message:${label}`),
      text: label,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
  });

const createFamily = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("retention-create-parent"),
    threadId: parentId,
    projectId: ProjectId.make("project:archive-retention"),
    title: "Retention parent",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* send(parentId, "parent-work");
  const run = (yield* orchestrator.getThreadProjection(parentId)).runs[0]!;
  yield* orchestrator.dispatch({
    type: "delegated_task.request",
    commandId: CommandId.make("retention-delegate"),
    parentThreadId: parentId,
    parentRunId: run.id,
    parentNodeId: run.rootNodeId!,
    task: "Retained child work",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    completionWake: "settled_only",
    createdBy: "agent",
    creationSource: "mcp",
  });
  return (yield* orchestrator.getThreadProjection(parentId)).subagents[0]!.childThreadId!;
});

const finishRun = (threadId: ThreadId, label: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const run = projection.runs.at(-1)!;
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make(`retention-finish:${label}`),
      type: "run.updated",
      threadId,
      occurredAt: now,
      payload: { ...run, status: "completed", completedAt: now },
    });
    for (const node of projection.nodes.filter((candidate) => candidate.runId === run.id))
      yield* projections.apply({
        id: EventId.make(`retention-finish-node:${label}:${node.id}`),
        type: "node.updated",
        threadId,
        occurredAt: now,
        payload: { ...node, status: "completed", completedAt: now },
      });
    for (const attempt of projection.attempts.filter((candidate) => candidate.runId === run.id))
      yield* projections.apply({
        id: EventId.make(`retention-finish-attempt:${label}:${attempt.id}`),
        type: "run-attempt.updated",
        threadId,
        occurredAt: now,
        payload: { ...attempt, status: "completed", completedAt: now },
      });
    return { ...run, status: "completed" as const, completedAt: now };
  });

const requestArchive = (
  label: string,
  childIds: ReadonlyArray<ThreadId>,
  childDisposition: "stop_and_archive",
) => ({
  type: "thread.archive" as const,
  commandId: CommandId.make(`retention-archive:${label}`),
  threadId: parentId,
  childDisposition,
  expectedChildThreadIds: childIds,
});

it.effect("archiving a former owner preserves an independent child's provider roster", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const childId = yield* createFamily;
    yield* finishRun(parentId, "parent");
    yield* finishRun(childId, "child-result");
    const parent = yield* orchestrator.getThreadProjection(parentId);
    const child = yield* orchestrator.getThreadProjection(childId);
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make("retention-completed-task-provider-reference"),
      type: "subagent.updated",
      threadId: parentId,
      occurredAt: now,
      payload: {
        ...parent.subagents[0]!,
        status: "completed",
        result: "Published child result",
        providerThreadId: child.providerThreads[0]!.id,
        completedAt: now,
      },
    });
    yield* send(childId, "independent-background-follow-up");
    yield* finishRun(childId, "follow-up");
    const childProviderThread = (yield* orchestrator.getThreadProjection(childId))
      .providerThreads[0]!;
    const roster = [{ taskId: "retained-background-command", kind: "command" as const }];
    yield* projections.apply({
      id: EventId.make("retention-child-background-roster"),
      type: "provider-thread.updated",
      threadId: childId,
      occurredAt: now,
      payload: { ...childProviderThread, pendingBackgroundTasks: roster },
    });
    const rootProviderThread = parent.providerThreads[0]!;
    yield* projections.apply({
      id: EventId.make("retention-root-shutdown-binding"),
      type: "provider-thread.updated",
      threadId: parentId,
      occurredAt: now,
      payload: {
        ...rootProviderThread,
        providerSessionId: ProviderSessionId.make("retention-unloaded-session"),
      },
    });
    const historicalRecords = yield* projections.getThreadRecords(parentId, ["providerThreads"]);
    assert.isTrue(historicalRecords.providerThreads.some((row) => row.appThreadId === childId));
    // Existing independently retained history is outside the archive family.
    yield* projections.apply({
      id: EventId.make("retention-independent-lineage"),
      type: "thread.metadata-updated",
      threadId: childId,
      occurredAt: now,
      payload: { ...child.thread, lineage: { ...child.thread.lineage, independent: true } },
    });
    const archivedOwner = requestArchive("independent-owner", [], "stop_and_archive");
    yield* orchestrator.dispatch(archivedOwner);
    yield* threads.executeArchive({ threadId: parentId, requestId: archivedOwner.commandId });
    assert.isTrue((yield* orchestrator.getThreadProjection(childId)).thread.lineage.independent);
    assert.deepEqual(
      (yield* orchestrator.getThreadProjection(childId)).providerThreads[0]?.pendingBackgroundTasks,
      roster,
    );
    yield* orchestrator.dispatch({
      type: "thread.unarchive",
      commandId: CommandId.make("retention-reopen-parent"),
      threadId: parentId,
    });
    const beforeChild = yield* orchestrator.getThreadProjection(childId);
    const reopenedParent = (yield* orchestrator.getThreadProjection(parentId)).thread;
    yield* projections.apply({
      id: EventId.make("retention-lower-former-owner-mode"),
      type: "thread.metadata-updated",
      threadId: parentId,
      occurredAt: yield* DateTime.now,
      payload: { ...reopenedParent, runtimeMode: "approval-required" },
    });
    const archived = requestArchive("former-owner", [], "stop_and_archive");
    const requested = yield* orchestrator.dispatch(archived).pipe(
      Effect.provideService(DispatchModeLimit, {
        runtimeMode: "approval-required",
        interactionMode: "default",
      }),
    );
    assert.isFalse(requested.storedEvents.some((stored) => stored.event.threadId === childId));
    yield* threads.executeArchive({ threadId: parentId, requestId: archived.commandId });
    const archivedParent = yield* orchestrator.getThreadProjection(parentId);
    assert.isNotNull(archivedParent.thread.archivedAt);
    const completion = yield* (yield* EventSink.EventSinkV2)
      .readByCommandId({ commandId: CommandId.make(`${archived.commandId}:complete`) })
      .pipe(Stream.runCollect);
    assert.isFalse(
      completion.some(
        ({ event }) =>
          event.type === "provider-thread.updated" && event.payload.appThreadId !== event.threadId,
      ),
    );
    assert.isFalse(completion.some(({ event }) => event.threadId === childId));
    assert.deepEqual(
      (yield* orchestrator.getThreadProjection(childId)).providerThreads,
      beforeChild.providerThreads,
    );
    assert.deepEqual((yield* orchestrator.getThreadProjection(childId)).runs, beforeChild.runs);
  }).pipe(Effect.provide(testLayer)),
);

it.effect.each([false, true])(
  "archive and restore preserve completed history; pending background work=%s",
  (hasBackgroundWork) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const childId = yield* createFamily;
      const first = yield* finishRun(parentId, "first-completed-turn");
      yield* send(parentId, "second-completed-turn");
      const second = yield* finishRun(parentId, "second-completed-turn");
      const completedParent = yield* orchestrator.getThreadProjection(parentId);
      const now = yield* DateTime.now;
      yield* projections.apply({
        id: EventId.make("retention-history-completed-task"),
        type: "subagent.updated",
        threadId: parentId,
        occurredAt: now,
        payload: {
          ...completedParent.subagents[0]!,
          status: "completed",
          result: "Published task result",
          completedAt: now,
        },
      });
      for (const item of completedParent.turnItems.filter(
        (candidate) => candidate.type === "subagent",
      ))
        yield* projections.apply({
          id: EventId.make(`retention-history-completed-task-item:${item.id}`),
          type: "turn-item.updated",
          threadId: parentId,
          occurredAt: now,
          payload: { ...item, status: "completed", completedAt: now, updatedAt: now },
        });
      if (hasBackgroundWork)
        yield* projections.apply({
          id: EventId.make("retention-history-ongoing-background-work"),
          type: "provider-thread.updated",
          threadId: parentId,
          occurredAt: now,
          payload: {
            ...completedParent.providerThreads.find((row) => row.id === second.providerThreadId)!,
            pendingBackgroundTasks: [{ taskId: "unfinished-root-command", kind: "command" }],
          },
        });
      // A superseded native turn is not the completed run's current execution.
      yield* projections.apply({
        id: EventId.make("retention-superseded-native-turn"),
        type: "provider-turn.updated",
        threadId: parentId,
        occurredAt: yield* DateTime.now,
        payload: {
          id: ProviderTurnId.make("retention-superseded-native-turn"),
          providerThreadId: first.providerThreadId!,
          nodeId: first.rootNodeId!,
          runAttemptId: null,
          nativeTurnRef: null,
          ordinal: 1,
          status: "running",
          startedAt: first.requestedAt,
          completedAt: null,
        },
      });
      const archived = requestArchive("history", [childId], "stop_and_archive");
      yield* orchestrator.dispatch(archived);
      yield* threads.executeArchive({ threadId: parentId, requestId: archived.commandId });
      yield* orchestrator.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("retention-restore-history"),
        threadId: parentId,
      });
      const restored = yield* orchestrator.getThreadProjection(parentId);
      assert.deepEqual(
        restored.runs.map((run) => run.status),
        ["completed", "completed"],
      );
      assert.deepEqual(
        restored.runs.map((run) => run.completedAt),
        [first.completedAt, second.completedAt],
      );
      assert.deepEqual(
        restored.turnItems
          .filter((item) => item.type === "run_interrupt_request")
          .map((item) => item.runId),
        hasBackgroundWork ? [second.id] : [],
      );
      assert.isNull(restored.thread.archivedAt);
      assert.isTrue(
        (yield* orchestrator.getThreadProjection(childId)).turnItems.some(
          (item) => item.type === "run_interrupt_request",
        ),
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each(["mode-refusal", "unknown", "provider-failure"] as const)(
  "archive inspection preserves an active descendant and reports %s correctly",
  (evidence) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const recovery = yield* ThreadRecovery.ThreadRecoveryService;
      const childId = yield* createFamily;
      yield* finishRun(parentId, "verified-owner");
      const owner = (yield* orchestrator.getThreadProjection(parentId)).thread;
      const child = yield* orchestrator.getThreadProjection(childId);
      const run = child.runs.at(-1)!;
      const attemptId = run.activeAttemptId ?? RunAttemptId.make("retention-verification-attempt");
      const providerThreadId = child.providerThreads[0]!.id;
      const providerTurnId = ProviderTurnId.make("retention-verification-turn");
      const now = yield* DateTime.now;
      yield* projections.apply({
        id: EventId.make("retention-verification-owner-limit"),
        type: "thread.metadata-updated",
        threadId: parentId,
        occurredAt: now,
        payload: { ...owner, runtimeMode: "approval-required" },
      });
      yield* projections.apply({
        id: EventId.make("retention-verification-running-child"),
        type: "run.updated",
        threadId: childId,
        occurredAt: now,
        payload: { ...run, status: "running", activeAttemptId: attemptId },
      });
      yield* projections.apply({
        id: EventId.make("retention-verification-provider-turn"),
        type: "provider-turn.updated",
        threadId: childId,
        occurredAt: now,
        payload: {
          id: providerTurnId,
          providerThreadId,
          nodeId: run.rootNodeId,
          runAttemptId: attemptId,
          nativeTurnRef: null,
          ordinal: 1,
          status: "running",
          startedAt: now,
          completedAt: null,
        },
      });
      yield* recovery.register({
        threadId: childId,
        runId: run.id,
        attemptId,
        inspect:
          evidence === "provider-failure"
            ? Effect.fail(
                new ThreadRecovery.ThreadRecoveryError({
                  threadId: childId,
                  cause: "Fixture inspection unavailable",
                }),
              )
            : Effect.succeed(
                evidence === "unknown"
                  ? { status: "unknown" as const }
                  : {
                      status: "terminal" as const,
                      event: {
                        type: "turn.terminal" as const,
                        driver: ProviderDriverKind.make("codex"),
                        providerThreadId,
                        providerTurnId,
                        runOrdinal: run.ordinal,
                        status: "completed" as const,
                        failure: null,
                        threadDisposition: "reusable" as const,
                      },
                    },
              ),
        finalize: () => Effect.die("Limited archive inspection must not finalize this descendant"),
      });
      const wrapped = withVerifiedArchiveActivity(threads, recovery);
      const before = yield* Effect.forEach([parentId, childId], (id) =>
        orchestrator.getThreadProjection(id),
      );
      const sequence = (yield* orchestrator.getShellSnapshot()).snapshotSequence;
      const limit = {
        runtimeMode: "approval-required" as const,
        interactionMode: "default" as const,
      };
      if (evidence === "mode-refusal") {
        const refused = yield* wrapped
          .getThreadArchiveFamily(parentId)
          .pipe(Effect.provideService(DispatchModeLimit, limit), Effect.flip);
        assert.equal(refused._tag, "OrchestratorProjectionError");
        if (refused._tag === "OrchestratorProjectionError")
          assert.instanceOf(refused.cause, ThreadRecovery.ThreadRecoveryAboveModeLimitError);
        const dispatchRefusal = yield* wrapped
          .dispatch(requestArchive("verification-refusal", [childId], "stop_and_archive"))
          .pipe(Effect.provideService(DispatchModeLimit, limit), Effect.flip);
        assert.equal(dispatchRefusal._tag, "OrchestratorProjectionError");
      } else {
        const inspected = yield* wrapped
          .getThreadArchiveFamily(parentId)
          .pipe(Effect.provideService(DispatchModeLimit, limit));
        assert.include(inspected.activeThreadIds, childId);
      }
      assert.equal((yield* orchestrator.getShellSnapshot()).snapshotSequence, sequence);
      for (const saved of before)
        assert.deepEqual(yield* orchestrator.getThreadProjection(saved.thread.id), saved);
    }).pipe(Effect.provide(recoveryTestLayer)),
);
