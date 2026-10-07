import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { DispatchModeLimit } from "./DispatchModeLimit.ts";
import { DelegatedTaskCancellation } from "./DelegatedTaskCancellation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const importSessionId = ProviderSessionId.make("archive-child-session");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapterV2Shape;
const database = SqlitePersistence.layerMemory;
// No effect worker: runs stay unstarted, so Stop ends them without a provider.
const testLayer = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      database,
      ProjectionStore.layer.pipe(Layer.provide(database)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "thread-stop" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: database, runEffectWorker: false },
      ),
    ),
  ),
);

const pullRequest = (number: number) => ({
  host: "github.com",
  repository: "pingdotgg/t3code",
  number,
});

const createWatchingThread = (threadId: ThreadId, number: number) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:thread-stop"),
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* watch(threadId, number);
  });

const watch = (threadId: ThreadId, number: number) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make(`watch:${threadId}:${number}`),
      threadId,
      ...pullRequest(number),
      watching: true,
      link: { url: `https://github.com/pingdotgg/t3code/pull/${number}`, source: "agent" },
    });
  });

const send = (threadId: ThreadId, text: string, type: "start_immediately" | "queue_after_active") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type },
      createdBy: "user",
      creationSource: "web",
    });
  });

/** Delegates `task` from the parent's latest run and returns the child thread. */
const delegate = (parentThreadId: ThreadId, task: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make(`delegate:${task}`),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const projection = yield* orchestrator.getThreadProjection(parentThreadId);
    return projection.subagents.find((candidate) => candidate.prompt === task)!.childThreadId!;
  });

const family = Effect.gen(function* () {
  const parent = ThreadId.make("archive-parent");
  yield* createWatchingThread(parent, 1);
  yield* send(parent, "work", "start_immediately");
  const child = yield* delegate(parent, "child");
  const grandchild = yield* delegate(child, "grandchild");
  return { parent, child, grandchild };
});

const archive = (
  parent: ThreadId,
  ids: ReadonlyArray<ThreadId>,
  disposition: "stop_and_archive" | "promote" = "stop_and_archive",
) => ({
  type: "thread.archive" as const,
  commandId: CommandId.make(`archive:${parent}:${disposition}`),
  threadId: parent,
  childDisposition: disposition,
  expectedChildThreadIds: ids,
});

const archiveModeLimits = [
  { runtimeMode: "approval-required", interactionMode: "default", mode: "runtime" },
  { runtimeMode: "full-access", interactionMode: "plan", mode: "interaction" },
] as const;

it.effect.each(
  archiveModeLimits.flatMap((limit) =>
    (["stop_and_archive", "promote"] as const).map((disposition) => ({ limit, disposition })),
  ),
)(
  "refuses family $disposition above the caller's $limit.mode mode before stopping",
  ({ limit, disposition }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const { parent, child, grandchild } = yield* family;
      const root = (yield* orchestrator.getThreadProjection(parent)).thread;
      yield* projections.apply({
        id: EventId.make("limited-parent-mode"),
        type: "thread.metadata-updated",
        threadId: parent,
        occurredAt: yield* DateTime.now,
        payload: {
          ...root,
          runtimeMode: limit.runtimeMode,
          interactionMode: limit.interactionMode,
        },
      });
      const sequence = (yield* orchestrator.getShellSnapshot()).snapshotSequence;
      const refusal = yield* orchestrator
        .dispatch(archive(parent, [child, grandchild], disposition))
        .pipe(Effect.provideService(DispatchModeLimit, limit), Effect.flip);
      assert.ok(refusal._tag === "OrchestratorThreadAboveModeLimitError");
      assert.equal(refusal.threadId, child);
      assert.equal(refusal.mode, limit.mode);
      assert.equal((yield* orchestrator.getShellSnapshot()).snapshotSequence, sequence);
      for (const id of [parent, child, grandchild]) {
        const projection = yield* orchestrator.getThreadProjection(id);
        assert.isNull(projection.thread.archivedAt);
        assert.isUndefined(projection.thread.archivePending);
        assert.isUndefined(projection.thread.lineage.independent);
        assert.equal(projection.runs[0]?.status, "starting");
      }
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each(archiveModeLimits)(
  "keeps the family visible when promoted child $mode permissions rise during shutdown",
  (limit) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const { parent, child, grandchild } = yield* family;
      for (const id of [parent, child]) {
        const thread = (yield* orchestrator.getThreadProjection(id)).thread;
        yield* projections.apply({
          id: EventId.make(`initial-mode:${id}`),
          type: "thread.metadata-updated",
          threadId: id,
          occurredAt: yield* DateTime.now,
          payload: {
            ...thread,
            runtimeMode: limit.runtimeMode,
            interactionMode: limit.interactionMode,
          },
        });
      }
      const providerThread = (yield* orchestrator.getThreadProjection(parent)).providerThreads[0]!;
      yield* projections.apply({
        id: EventId.make("parent-shutdown-session"),
        type: "provider-thread.updated",
        threadId: parent,
        occurredAt: yield* DateTime.now,
        payload: { ...providerThread, providerSessionId: importSessionId },
      });
      const command = archive(parent, [child, grandchild], "promote");
      yield* orchestrator.dispatch(command).pipe(Effect.provideService(DispatchModeLimit, limit));
      const pending = (yield* orchestrator.getThreadProjection(parent)).thread.archivePending;
      const stopping = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const shutdown = yield* threads
        .executeArchive({ threadId: parent, requestId: command.commandId })
        .pipe(
          Effect.provide(
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              teardownThread: () =>
                Deferred.succeed(stopping, undefined).pipe(Effect.andThen(Deferred.await(resume))),
            }),
          ),
          Effect.forkChild,
        );
      yield* Deferred.await(stopping);
      yield* orchestrator.dispatch(
        limit.mode === "runtime"
          ? {
              type: "thread.runtime-mode.set",
              commandId: CommandId.make("raise-child-runtime"),
              threadId: child,
              runtimeMode: "full-access",
            }
          : {
              type: "thread.interaction-mode.set",
              commandId: CommandId.make("raise-child-interaction"),
              threadId: child,
              interactionMode: "default",
            },
      );
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(shutdown);
      const root = (yield* orchestrator.getThreadProjection(parent)).thread;
      assert.isNull(root.archivedAt);
      assert.equal(root.archivePending?.status, "failed");
      assert.include(root.archivePending?.error, "Permissions changed while stopping");
      assert.deepEqual(pending?.modeLimit, {
        runtimeMode: limit.runtimeMode,
        interactionMode: limit.interactionMode,
      });
      for (const id of [child, grandchild]) {
        const projection = yield* orchestrator.getThreadProjection(id);
        assert.isNull(projection.thread.archivedAt);
        assert.isUndefined(projection.thread.lineage.independent);
        assert.equal(projection.runs[0]?.status, "starting");
      }
      assert.isUndefined(
        (yield* orchestrator.getThreadProjection(parent)).subagents[0]?.ownershipReleased,
      );
      // A fresh user choice has no agent ceiling and can retry the failed archive.
      const retry = { ...command, commandId: CommandId.make(`${command.commandId}:retry`) };
      yield* orchestrator.dispatch(retry);
      assert.isUndefined(
        (yield* orchestrator.getThreadProjection(parent)).thread.archivePending?.modeLimit,
      );
      yield* threads.executeArchive({ threadId: parent, requestId: retry.commandId }).pipe(
        Effect.provide(
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            teardownThread: () => Effect.void,
          }),
        ),
      );
      assert.isNotNull((yield* orchestrator.getThreadProjection(parent)).thread.archivedAt);
      assert.isTrue((yield* orchestrator.getThreadProjection(child)).thread.lineage.independent);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "requires an explicit family choice and rejects stale consent before cancelling work",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { parent, child, grandchild } = yield* family;
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            orchestrator.dispatch({
              type: "thread.archive",
              commandId: CommandId.make("archive:no-choice"),
              threadId: parent,
            }),
          ),
        ),
      );
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(orchestrator.dispatch(archive(parent, [child])))),
      );
      for (const id of [parent, child, grandchild]) {
        const projection = yield* orchestrator.getThreadProjection(id);
        assert.isNull(projection.thread.archivedAt);
        assert.isUndefined(projection.thread.archivePending);
        assert.equal(projection.runs[0]?.status, "starting");
      }
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "archives and restores exactly the requested recursive family without restarting work",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const { parent, child, grandchild } = yield* family;
      yield* send(child, "queued", "queue_after_active");
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const childProjection = yield* orchestrator.getThreadProjection(child);
      yield* projections.apply({
        id: EventId.make("archive-pending-input"),
        type: "runtime-request.updated",
        threadId: child,
        occurredAt: now,
        payload: {
          id: RuntimeRequestId.make("pending-input"),
          nodeId: childProjection.runs[0]!.rootNodeId!,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "not_resumable", reason: "fixture" },
          createdAt: now,
          resolvedAt: null,
        },
      });
      const alreadyArchived = ThreadId.make("already-archived-child");
      yield* createWatchingThread(alreadyArchived, 2);
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("separate-archive"),
        threadId: alreadyArchived,
      });
      const separate = (yield* orchestrator.getThreadProjection(alreadyArchived)).thread;
      yield* projections.apply({
        id: EventId.make("separate-child-lineage"),
        type: "thread.metadata-updated",
        threadId: alreadyArchived,
        occurredAt: now,
        payload: {
          ...separate,
          lineage: {
            parentThreadId: parent,
            relationshipToParent: "subagent",
            rootThreadId: parent,
          },
        },
      });
      const command = archive(parent, [child, grandchild]);
      const result = yield* orchestrator.dispatch(command);
      for (const id of [parent, child, grandchild]) {
        const projection = yield* orchestrator.getThreadProjection(id);
        assert.isNull(projection.thread.archivedAt);
        assert.equal(projection.thread.archivePending?.status, "stopping");
        assert.isTrue(projection.runs.every((run) => run.status === "cancelled"));
      }
      yield* threads.executeArchive({ threadId: parent, requestId: command.commandId }).pipe(
        Effect.provide(
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            teardownThread: () => Effect.void,
          }),
        ),
      );
      for (const id of [parent, child, grandchild]) {
        const projection = yield* orchestrator.getThreadProjection(id);
        assert.isNotNull(projection.thread.archivedAt);
        assert.equal(projection.thread.archivedWith?.commandId, command.commandId);
      }
      for (const id of [child, grandchild]) {
        const error = yield* Effect.flip(
          orchestrator.dispatch({
            type: "thread.unarchive",
            commandId: CommandId.make(`restore-child:${id}`),
            threadId: id,
          }),
        );
        assert.instanceOf(error, Orchestrator.OrchestratorDispatchError);
        assert.equal(error.cause, "Restore the parent thread to reopen this family");
      }
      for (const id of [parent, child, grandchild])
        assert.isNotNull((yield* orchestrator.getThreadProjection(id)).thread.archivedAt);
      yield* orchestrator.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("restore-family"),
        threadId: parent,
      });
      for (const id of [parent, child, grandchild]) {
        const projection = yield* orchestrator.getThreadProjection(id);
        assert.isNull(projection.thread.archivedAt);
        assert.isTrue(projection.runs.every((run) => run.status === "cancelled"));
      }
      assert.equal(
        (yield* orchestrator.getThreadProjection(child)).runtimeRequests[0]?.status,
        "cancelled",
      );
      assert.isNotNull(
        (yield* orchestrator.getThreadProjection(alreadyArchived)).thread.archivedAt,
      );
      assert.isAbove(result.sequence, 0);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "restores a surviving legacy branch independently after its archived owner was deleted",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const { parent, child, grandchild } = yield* family;
      const sibling = yield* delegate(parent, "sibling");
      const separate = ThreadId.make("separately-archived-descendant");
      yield* createWatchingThread(separate, 6);
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("separate-descendant-archive"),
        threadId: separate,
      });
      const separateThread = (yield* orchestrator.getThreadProjection(separate)).thread;
      const now = yield* DateTime.now;
      yield* projections.apply({
        id: EventId.make("separate-descendant-lineage"),
        type: "thread.metadata-updated",
        threadId: separate,
        occurredAt: now,
        payload: {
          ...separateThread,
          lineage: {
            parentThreadId: child,
            relationshipToParent: "subagent",
            rootThreadId: parent,
          },
        },
      });
      const command = archive(parent, [child, grandchild, sibling]);
      yield* orchestrator.dispatch(command);
      yield* threads.executeArchive({ threadId: parent, requestId: command.commandId }).pipe(
        Effect.provide(
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            teardownThread: () => Effect.void,
          }),
        ),
      );
      // Earlier servers deleted only the owner. New family deletion must not
      // leave survivors, but existing archived branches still need recovery.
      const archivedOwner = (yield* orchestrator.getThreadProjection(parent)).thread;
      yield* projections.apply({
        id: EventId.make("legacy-owner-deleted"),
        type: "thread.deleted",
        threadId: parent,
        occurredAt: now,
        payload: { ...archivedOwner, deletedAt: now },
      });
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            orchestrator.dispatch({
              type: "thread.unarchive",
              commandId: CommandId.make("cannot-restore-deleted-owner"),
              threadId: parent,
            }),
          ),
        ),
      );
      yield* orchestrator.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("restore-surviving-branch"),
        threadId: child,
      });
      const restoredChild = (yield* orchestrator.getThreadProjection(child)).thread;
      assert.isTrue(restoredChild.lineage.independent);
      assert.equal(restoredChild.lineage.parentThreadId, parent);
      assert.equal(restoredChild.lineage.rootThreadId, parent);
      for (const id of [child, grandchild]) {
        const projection = yield* orchestrator.getThreadProjection(id);
        assert.isNull(projection.thread.archivedAt);
        assert.isNull(projection.thread.archivedWith);
        assert.isTrue(projection.runs.every((run) => run.status === "cancelled"));
      }
      const deletedOwner = (yield* orchestrator.getThreadProjection(parent)).thread;
      assert.isNotNull(deletedOwner.deletedAt);
      assert.isNotNull(deletedOwner.archivedAt);
      for (const id of [sibling, separate])
        assert.isNotNull((yield* orchestrator.getThreadProjection(id)).thread.archivedAt);
      assert.isUndefined(
        (yield* orchestrator.getThreadProjection(grandchild)).thread.lineage.independent,
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "keeping app-owned subagents preserves their subtree and releases future cancellation ownership",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const { parent, child, grandchild } = yield* family;
      yield* orchestrator.dispatch({
        type: "thread.persistence.set",
        commandId: CommandId.make("protect-child"),
        threadId: child,
        persistent: true,
      });
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(orchestrator.dispatch(archive(parent, [child, grandchild]))),
        ),
      );
      const command = archive(parent, [child, grandchild], "promote");
      yield* orchestrator.dispatch(command);
      yield* orchestrator.dispatch({
        type: "thread.archive.complete",
        commandId: CommandId.make("promote-complete"),
        threadId: parent,
        requestId: command.commandId,
      });
      const childProjection = yield* orchestrator.getThreadProjection(child);
      assert.isTrue(childProjection.thread.lineage.independent);
      assert.equal(childProjection.thread.lineage.parentThreadId, parent);
      assert.isNull(childProjection.thread.archivedAt);
      assert.equal(childProjection.runs[0]?.status, "starting");
      const task = (yield* orchestrator.getThreadProjection(parent)).subagents[0]!;
      assert.isTrue(task.ownershipReleased);
      assert.equal(task.completionDelivery?.state, "disposed");
      yield* threads.stopDelegatedTasks({
        threadId: parent,
        commandId: CommandId.make("later-parent-stop"),
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(grandchild)).runs[0]?.status,
        "starting",
      );
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      assert.equal(childProjection.thread.forkedFrom?.type, "node");
      yield* projections.apply({
        id: EventId.make("released-child-finished"),
        type: "run.updated",
        threadId: child,
        occurredAt: now,
        payload: { ...childProjection.runs[0]!, status: "completed", completedAt: now },
      });
      assert.notInclude(yield* projections.getRecoveryThreadIds("subagent-results"), child);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("archive RPC stays pending and returns a visible failure when shutdown fails", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const { parent, child, grandchild } = yield* family;
    const childProjection = yield* orchestrator.getThreadProjection(child);
    const providerThread = childProjection.providerThreads[0]!;
    yield* projections.apply({
      id: EventId.make("child-session"),
      type: "provider-thread.updated",
      threadId: child,
      occurredAt: yield* DateTime.now,
      payload: { ...providerThread, providerSessionId: importSessionId },
    });
    const command = archive(parent, [child, grandchild]);
    const sequence = (yield* orchestrator.getShellSnapshot()).snapshotSequence;
    const waiting = yield* threads.dispatch(command).pipe(Effect.result, Effect.forkChild);
    yield* orchestrator.streamStoredEventsFrom({ threadId: parent, afterSequence: sequence }).pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "thread.metadata-updated" &&
          stored.event.payload.archivePending?.status === "stopping",
      ),
      Stream.runHead,
    );
    assert.isUndefined(waiting.pollUnsafe());
    yield* threads.executeArchive({ threadId: parent, requestId: command.commandId }).pipe(
      Effect.provide(
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          teardownThread: () =>
            Effect.fail(
              new ProviderSessionManager.ProviderSessionReleaseError({
                providerSessionId: importSessionId,
                reason: "manual_shutdown",
                cause: "provider refuses shutdown",
              }),
            ),
        }),
      ),
    );
    assert.equal((yield* Fiber.join(waiting))._tag, "Failure");
    for (const id of [parent, child, grandchild]) {
      const projection = yield* orchestrator.getThreadProjection(id);
      assert.isNull(projection.thread.archivedAt);
      assert.equal(projection.thread.archivePending?.status, "failed");
      assert.isTrue(projection.runs.every((run) => run.status === "cancelled"));
    }
  }).pipe(Effect.provide(testLayer)),
);

it.effect("shows runless native task activity and requires archiving its runtime owner", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const { parent, child, grandchild } = yield* family;
    const nativeId = ThreadId.make("runless-native-child");
    yield* createWatchingThread(nativeId, 5);
    const native = (yield* orchestrator.getThreadProjection(nativeId)).thread;
    const parentProjection = yield* orchestrator.getThreadProjection(parent);
    const now = yield* DateTime.now;
    const mirror = {
      ...native,
      creationSource: "provider" as const,
      pullRequests: [],
      lineage: {
        parentThreadId: parent,
        relationshipToParent: "subagent" as const,
        rootThreadId: parent,
      },
    };
    const nativeEvent = {
      id: EventId.make("runless-native-lineage"),
      type: "thread.metadata-updated" as const,
      threadId: nativeId,
      occurredAt: now,
      payload: mirror,
    };
    const taskEvent = {
      id: EventId.make("runless-native-task"),
      type: "subagent.updated" as const,
      threadId: parent,
      occurredAt: now,
      payload: {
        ...parentProjection.subagents[0]!,
        id: NodeId.make("runless-native-task"),
        origin: "provider_native" as const,
        driver: ProviderDriverKind.make("claudeAgent"),
        childThreadId: nativeId,
        providerThreadId: null,
        status: "running" as const,
        startedAt: now,
      },
    };
    yield* projections.apply(nativeEvent);
    yield* projections.apply(taskEvent);
    const projection = yield* orchestrator.getThreadProjection(nativeId);
    assert.lengthOf(projection.runs, 0);
    assert.lengthOf(projection.providerThreads, 0);
    assert.lengthOf(projection.providerTurns, 0);
    for (const shell of [
      yield* projections.getThreadShell(nativeId),
      (yield* projections.getShellSnapshot()).threads.find((thread) => thread.id === nativeId),
    ]) {
      assert.equal(shell?.status, "running");
      assert.isNull(shell?.latestRunId);
      assert.isNull(shell?.activeRunId);
    }
    const replayShell = yield* Effect.gen(function* () {
      const replay = yield* ProjectionStore.ProjectionStoreV2;
      yield* replay.apply({
        id: EventId.make("native-parent-replay"),
        type: "thread.created",
        threadId: parent,
        occurredAt: now,
        payload: parentProjection.thread,
      });
      yield* replay.apply({ ...nativeEvent, type: "thread.created" });
      yield* replay.apply(taskEvent);
      return yield* replay.getThreadShell(nativeId);
    }).pipe(Effect.provide(ProjectionStore.layerMemory));
    assert.equal(replayShell?.status, "running");
    assert.isNull(replayShell?.latestRunId);
    const rejection = yield* Effect.flip(orchestrator.dispatch(archive(nativeId, [])));
    assert.equal(
      rejection.cause,
      "Archive the parent thread to stop and archive this running native subagent.",
    );
    assert.isNull((yield* projections.getThreadShell(nativeId))?.archivedAt);
    assert.equal((yield* orchestrator.getThreadProjection(parent)).runs[0]?.status, "starting");
    const missingChoice = yield* Effect.exit(
      orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("runless-native-no-consent"),
        threadId: parent,
      }),
    );
    assert.isTrue(Exit.isFailure(missingChoice));
    yield* projections.apply({
      ...taskEvent,
      id: EventId.make("runless-native-completed"),
      payload: { ...taskEvent.payload, status: "completed", completedAt: now },
    });
    assert.equal((yield* projections.getThreadShell(nativeId))?.status, "completed");
    // A completed child still shares a runtime with its working owner.
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(
          orchestrator.dispatch({
            ...archive(nativeId, []),
            commandId: CommandId.make("runless-native-owner-still-active"),
          }),
        ),
      ),
    );
    yield* orchestrator.dispatch(archive(parent, [child, grandchild, nativeId]));
    assert.equal((yield* projections.getThreadShell(nativeId))?.archivePending?.status, "stopping");
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "keeping app-owned children still stops native mirrors and rejects protected native branches",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const { parent, child, grandchild } = yield* family;
      const nativeId = ThreadId.make("native-child");
      yield* createWatchingThread(nativeId, 4);
      const native = (yield* orchestrator.getThreadProjection(nativeId)).thread;
      const now = yield* DateTime.now;
      const mirror = {
        ...native,
        creationSource: "provider" as const,
        lineage: {
          parentThreadId: parent,
          relationshipToParent: "subagent" as const,
          rootThreadId: parent,
        },
      };
      yield* projections.apply({
        id: EventId.make("native-lineage"),
        type: "thread.metadata-updated",
        threadId: nativeId,
        occurredAt: now,
        payload: { ...mirror, persistent: true },
      });
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            orchestrator.dispatch(archive(parent, [child, grandchild, nativeId], "promote")),
          ),
        ),
      );
      assert.equal((yield* orchestrator.getThreadProjection(parent)).runs[0]?.status, "starting");
      yield* projections.apply({
        id: EventId.make("native-unprotected"),
        type: "thread.metadata-updated",
        threadId: nativeId,
        occurredAt: now,
        payload: { ...mirror, persistent: false },
      });
      const command = {
        ...archive(parent, [child, grandchild, nativeId], "promote"),
        commandId: CommandId.make("keep-app-stop-native"),
      };
      yield* orchestrator.dispatch(command);
      yield* orchestrator.dispatch({
        type: "thread.archive.complete",
        commandId: CommandId.make("keep-app-stop-native-complete"),
        threadId: parent,
        requestId: command.commandId,
      });
      assert.isNotNull((yield* orchestrator.getThreadProjection(nativeId)).thread.archivedAt);
      assert.isNull((yield* orchestrator.getThreadProjection(child)).thread.archivedAt);
      assert.isTrue((yield* orchestrator.getThreadProjection(child)).thread.lineage.independent);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("keeps an idle native mirror visible when its unbound session cannot unload", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const { parent, child, grandchild } = yield* family;
    for (const threadId of [parent, child, grandchild])
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make(`stop-before-native-archive:${threadId}`),
        threadId,
      });
    const native = yield* orchestrator.getThreadProjection(grandchild);
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make("idle-native-mirror"),
      type: "thread.metadata-updated",
      threadId: grandchild,
      occurredAt: now,
      payload: { ...native.thread, creationSource: "provider" },
    });
    yield* projections.apply({
      id: EventId.make("idle-native-unbound-session"),
      type: "provider-thread.updated",
      threadId: grandchild,
      occurredAt: now,
      payload: { ...native.providerThreads[0]!, providerSessionId: importSessionId },
    });
    assert.lengthOf((yield* orchestrator.getThreadProjection(grandchild)).providerSessions, 0);
    const command = archive(grandchild, []);
    yield* orchestrator.dispatch(command);
    const stopping = (yield* orchestrator.getThreadProjection(grandchild)).thread;
    assert.isNull(stopping.archivedAt);
    assert.equal(stopping.archivePending?.status, "stopping");
    const shutdownCalls: Array<ThreadId> = [];
    yield* threads.executeArchive({ threadId: grandchild, requestId: command.commandId }).pipe(
      Effect.provide(
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          teardownThread: (input) => {
            shutdownCalls.push(input.threadId);
            return Effect.fail(
              new ProviderSessionManager.ProviderSessionReleaseError({
                providerSessionId: input.providerSessionId,
                reason: "manual_shutdown",
                cause: "native unload refused",
              }),
            );
          },
        }),
      ),
    );
    assert.deepEqual(shutdownCalls, [grandchild]);
    const failed = (yield* orchestrator.getThreadProjection(grandchild)).thread;
    assert.isNull(failed.archivedAt);
    assert.equal(failed.archivePending?.status, "failed");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects deleting an ancestor while a descendant archive is stopping", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { parent, child, grandchild } = yield* family;
    const command = archive(child, [grandchild]);
    yield* orchestrator.dispatch(command);
    const sequence = (yield* orchestrator.getShellSnapshot()).snapshotSequence;
    const rejection = yield* orchestrator
      .dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete-ancestor-during-archive"),
        threadId: parent,
      })
      .pipe(Effect.flip);
    assert.equal(rejection._tag, "OrchestratorDispatchError");
    assert.equal((yield* orchestrator.getShellSnapshot()).snapshotSequence, sequence);
    yield* orchestrator.dispatch({
      type: "thread.archive.fail",
      commandId: CommandId.make("child-archive-shutdown-failed"),
      threadId: child,
      requestId: command.commandId,
      error: "Shutdown could not be confirmed.",
    });
    for (const id of [parent, child, grandchild]) {
      const thread = (yield* orchestrator.getThreadProjection(id)).thread;
      assert.isNull(thread.deletedAt);
      assert.isNull(thread.archivedAt);
    }
    assert.equal(
      (yield* orchestrator.getThreadProjection(child)).thread.archivePending?.status,
      "failed",
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "keeps a stranded native child visible when archived-family repair cannot unload it",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const { parent, child, grandchild } = yield* family;
      for (const threadId of [parent, child, grandchild])
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make(`stop-before-repair:${threadId}`),
          threadId,
        });
      const now = yield* DateTime.now;
      const original = {
        threadId: parent,
        commandId: CommandId.make("original-family-archive"),
      };
      const owner = (yield* orchestrator.getThreadProjection(parent)).thread;
      yield* projections.apply({
        id: EventId.make("legacy-archived-owner"),
        type: "thread.metadata-updated",
        threadId: parent,
        occurredAt: now,
        payload: { ...owner, archivedAt: now, archivedWith: original },
      });
      const native = yield* orchestrator.getThreadProjection(grandchild);
      yield* projections.apply({
        id: EventId.make("stranded-native-mirror"),
        type: "thread.metadata-updated",
        threadId: grandchild,
        occurredAt: now,
        payload: { ...native.thread, creationSource: "provider" },
      });
      yield* projections.apply({
        id: EventId.make("stranded-native-session"),
        type: "provider-thread.updated",
        threadId: grandchild,
        occurredAt: now,
        payload: { ...native.providerThreads[0]!, providerSessionId: importSessionId },
      });
      const command = {
        type: "thread.archive" as const,
        commandId: CommandId.make("repair-stranded-family"),
        threadId: parent,
      };
      const result = yield* orchestrator.dispatch(command);
      assert.isFalse(result.storedEvents.some((stored) => stored.event.type === "thread.archived"));
      for (const id of [child, grandchild]) {
        const thread = (yield* orchestrator.getThreadProjection(id)).thread;
        assert.isNull(thread.archivedAt);
        assert.equal(thread.archivePending?.status, "stopping");
      }
      yield* threads.executeArchive({ threadId: parent, requestId: command.commandId }).pipe(
        Effect.provide(
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            teardownThread: (input) =>
              Effect.fail(
                new ProviderSessionManager.ProviderSessionReleaseError({
                  providerSessionId: input.providerSessionId,
                  reason: "manual_shutdown",
                  cause: "native unload refused",
                }),
              ),
          }),
        ),
      );
      for (const id of [child, grandchild]) {
        const failed = (yield* orchestrator.getThreadProjection(id)).thread;
        assert.isNull(failed.archivedAt);
        assert.equal(failed.archivePending?.status, "failed");
      }
      const root = (yield* orchestrator.getThreadProjection(parent)).thread;
      assert.deepEqual(root.archivedAt, now);
      assert.deepEqual(root.archivedWith, original);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "rechecks released cancellation ownership under locks before stopping or replaying a receipt",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { parent, child, grandchild } = yield* family;
      const task = (yield* orchestrator.getThreadProjection(parent)).subagents.find(
        (candidate) => candidate.childThreadId === child,
      )!;
      const ownership = [{ parentThreadId: parent, taskId: task.id, childThreadId: child }];
      const stop = {
        type: "thread.stop" as const,
        commandId: CommandId.make("owned-task-stop-before-promotion"),
        threadId: child,
      };
      yield* orchestrator
        .dispatch(stop)
        .pipe(Effect.provideService(DelegatedTaskCancellation, ownership));
      const promote = archive(parent, [child, grandchild], "promote");
      yield* orchestrator.dispatch(promote);
      yield* orchestrator.dispatch({
        type: "thread.archive.complete",
        commandId: CommandId.make("release-task-ownership"),
        threadId: parent,
        requestId: promote.commandId,
      });
      yield* orchestrator.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("reopen-former-task-owner"),
        threadId: parent,
      });
      yield* send(child, "independent-follow-up", "start_immediately");
      const sequence = (yield* orchestrator.getShellSnapshot()).snapshotSequence;
      for (const command of [
        stop,
        { ...stop, commandId: CommandId.make("new-former-owner-stop") },
      ]) {
        const refused = yield* orchestrator
          .dispatch(command)
          .pipe(Effect.provideService(DelegatedTaskCancellation, ownership), Effect.flip);
        assert.equal(refused._tag, "OrchestratorDispatchError");
        assert.include(String(refused.cause), "independent thread");
      }
      assert.equal((yield* orchestrator.getShellSnapshot()).snapshotSequence, sequence);
      const independent = yield* orchestrator.getThreadProjection(child);
      assert.equal(independent.runs.at(-1)?.status, "starting");
      assert.isTrue(independent.thread.lineage.independent);
      assert.equal(
        (yield* orchestrator.getThreadProjection(grandchild)).runs[0]?.status,
        "starting",
      );
    }).pipe(Effect.provide(testLayer)),
);
