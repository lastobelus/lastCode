import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  getThreadArchivePlan,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
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
import * as EventSink from "./EventSink.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "@t3tools/provider-core/server/ProviderAdapter";
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
      EffectOutbox.layer.pipe(Layer.provide(database)),
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

const settleArchiveResults = Effect.fnUntraced(function* (command: ReturnType<typeof archive>) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  // Publish nested completion results before their owners, using the real
  // service under its locks rather than racing its terminal-event subscriber.
  for (const id of command.expectedChildThreadIds.toReversed()) {
    const run = (yield* orchestrator.getThreadProjection(id)).runs.at(-1);
    if (run !== undefined) yield* orchestrator.recoverDelegatedTask(id, run.id);
  }
});

const failArchive = Effect.fnUntraced(function* (command: ReturnType<typeof archive>) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch(command);
  yield* orchestrator.dispatch({
    type: "thread.archive.fail",
    commandId: CommandId.make(`${command.commandId}:failed`),
    threadId: command.threadId,
    requestId: command.commandId,
    error: "Isolated shutdown failed",
  });
  yield* settleArchiveResults(command);
});

const dismissArchive = (threadId: ThreadId, expectedArchiveCommandId: CommandId) => ({
  type: "thread.unarchive" as const,
  commandId: CommandId.make(`dismiss:${threadId}`),
  threadId,
  expectedArchiveCommandId,
});

/** An idle snapshot from real delegated history, with a nested runless native mirror. */
const idleArchiveFamily = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const ids = yield* family;
  const now = yield* DateTime.now;
  for (const id of [ids.parent, ids.child, ids.grandchild]) {
    const projection = yield* orchestrator.getThreadProjection(id);
    for (const run of projection.runs)
      yield* projections.apply({
        id: EventId.make(`idle-family-run:${run.id}`),
        type: "run.updated",
        threadId: id,
        occurredAt: now,
        payload: { ...run, status: "completed", completedAt: now },
      });
    for (const attempt of projection.attempts)
      yield* projections.apply({
        id: EventId.make(`idle-family-attempt:${attempt.id}`),
        type: "run-attempt.updated",
        threadId: id,
        occurredAt: now,
        payload: { ...attempt, status: "completed", completedAt: now },
      });
    for (const node of projection.nodes)
      yield* projections.apply({
        id: EventId.make(`idle-family-node:${node.id}`),
        type: "node.updated",
        threadId: id,
        occurredAt: now,
        payload: { ...node, status: "completed", completedAt: now },
      });
    for (const task of projection.subagents)
      yield* projections.apply({
        id: EventId.make(`idle-family-task:${task.id}`),
        type: "subagent.updated",
        threadId: id,
        occurredAt: now,
        payload: {
          ...task,
          status: "completed",
          result: "Published fixture result",
          completionDelivery: { state: "disposed", observedByRunId: null },
          completedAt: now,
          updatedAt: now,
        },
      });
    for (const item of projection.turnItems)
      yield* projections.apply({
        id: EventId.make(`idle-family-item:${item.id}`),
        type: "turn-item.updated",
        threadId: id,
        occurredAt: now,
        payload: { ...item, status: "completed", completedAt: now, updatedAt: now },
      });
  }
  yield* orchestrator.dispatch({
    type: "thread.pull-request.watch",
    commandId: CommandId.make("idle-family-end-watch"),
    threadId: ids.parent,
    ...pullRequest(1),
    watching: false,
  });
  const native = ThreadId.make("idle-family-runless-native");
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("idle-family-create-native"),
    threadId: native,
    projectId: ProjectId.make("project:thread-stop"),
    title: "Idle nested native mirror",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "agent",
    creationSource: "provider",
  });
  const thread = (yield* orchestrator.getThreadProjection(native)).thread;
  yield* projections.apply({
    id: EventId.make("idle-family-native-lineage"),
    type: "thread.metadata-updated",
    threadId: native,
    occurredAt: now,
    payload: {
      ...thread,
      lineage: {
        parentThreadId: ids.grandchild,
        relationshipToParent: "subagent",
        rootThreadId: ids.parent,
      },
    },
  });
  const decision = yield* orchestrator.getThreadArchiveFamily(ids.parent);
  assert.isFalse(decision.requiresConfirmation);
  assert.deepEqual(decision.keptThreadIds, [ids.child, ids.grandchild, native]);
  assert.equal(decision.nativeStopCount, 0);
  const snapshot = decision.threads;
  assert.lengthOf(snapshot, 4);
  for (const shell of snapshot) {
    assert.include(["idle", "completed"], shell.status);
    assert.isNull(shell.pendingRuntimeRequest);
    assert.isFalse(shell.hasActionableProposedPlan);
    assert.isNull(shell.attention ?? null);
    assert.isEmpty(shell.pendingBackgroundTasks ?? []);
  }
  return { ...ids, native, snapshot };
});

it.effect.each([
  "child work",
  "owner work",
  "question",
  "approval",
  "native turn",
  "attention",
  "background",
  "watch",
] as const)(
  "automatic archive rechecks an idle snapshot before stopping newly pending %s",
  (change) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const { parent, child, grandchild, native, snapshot } = yield* idleArchiveFamily;
      const childIds = snapshot.filter((shell) => shell.id !== parent).map((shell) => shell.id);
      const now = yield* DateTime.now;
      if (change === "child work" || change === "owner work")
        yield* send(
          change === "child work" ? child : parent,
          "work-after-idle-snapshot",
          "start_immediately",
        );
      if (change === "question" || change === "approval") {
        const owner = yield* orchestrator.getThreadProjection(grandchild);
        yield* projections.apply({
          id: EventId.make("idle-snapshot-new-runtime-request"),
          type: "runtime-request.updated",
          threadId: native,
          occurredAt: now,
          payload: {
            id: RuntimeRequestId.make("idle-snapshot-new-runtime-request"),
            nodeId: owner.runs[0]!.rootNodeId!,
            providerTurnId: null,
            nativeRequestRef: null,
            kind: change === "question" ? "user_input" : "command",
            status: "pending",
            responseCapability: { type: "not_resumable", reason: "fixture request" },
            createdAt: now,
            resolvedAt: null,
          },
        });
      }
      if (change === "native turn") {
        const owner = yield* orchestrator.getThreadProjection(grandchild);
        const providerThreadId = ProviderThreadId.make("idle-snapshot-native-provider-thread");
        yield* projections.apply({
          id: EventId.make("idle-snapshot-native-provider-thread"),
          type: "provider-thread.updated",
          threadId: native,
          occurredAt: now,
          payload: {
            ...owner.providerThreads[0]!,
            id: providerThreadId,
            appThreadId: native,
            ownerNodeId: null,
            providerSessionId: null,
          },
        });
        yield* projections.apply({
          id: EventId.make("idle-snapshot-native-provider-turn"),
          type: "provider-turn.updated",
          threadId: native,
          occurredAt: now,
          payload: {
            id: ProviderTurnId.make("idle-snapshot-native-provider-turn"),
            providerThreadId,
            nodeId: owner.runs[0]!.rootNodeId!,
            runAttemptId: null,
            nativeTurnRef: null,
            ordinal: 1,
            status: "running",
            startedAt: now,
            completedAt: null,
          },
        });
      }
      if (change === "attention") {
        yield* orchestrator.dispatch({
          type: "thread.attention.set",
          commandId: CommandId.make("idle-snapshot-attention"),
          threadId: grandchild,
          attention: { kind: "question", raisedAt: DateTime.formatIso(now) },
        });
      }
      if (change === "background") {
        const nested = yield* orchestrator.getThreadProjection(grandchild);
        yield* projections.apply({
          id: EventId.make("idle-snapshot-background-work"),
          type: "provider-thread.updated",
          threadId: grandchild,
          occurredAt: now,
          payload: {
            ...nested.providerThreads[0]!,
            pendingBackgroundTasks: [
              { taskId: "idle-snapshot-background-command", kind: "command" },
            ],
          },
        });
      }
      if (change === "watch") yield* watch(parent, 12);

      const decision = yield* orchestrator.getThreadArchiveFamily(parent);
      assert.deepEqual(decision.childThreadIds, childIds);
      assert.isTrue(decision.requiresConfirmation);
      assert.deepEqual(
        decision.activeChildThreadIds,
        change === "owner work" || change === "watch"
          ? []
          : [
              change === "child work"
                ? child
                : change === "attention" || change === "background"
                  ? grandchild
                  : native,
            ],
      );
      if (change === "question" || change === "approval" || change === "native turn")
        assert.isEmpty((yield* orchestrator.getThreadProjection(native)).runs);
      const before = yield* Effect.forEach(snapshot, (shell) =>
        orchestrator.getThreadProjection(shell.id),
      );
      const sequence = (yield* orchestrator.getShellSnapshot()).snapshotSequence;
      const refusal = yield* orchestrator
        .dispatch({
          ...archive(parent, childIds),
          commandId: CommandId.make("idle-snapshot-automatic-archive"),
          childDisposition: "archive_if_idle",
        })
        .pipe(Effect.flip);
      assert.equal(refusal._tag, "OrchestratorDispatchError");
      assert.include(String(refusal.cause), "Review the archive choices again");
      assert.equal((yield* orchestrator.getShellSnapshot()).snapshotSequence, sequence);
      assert.deepEqual(
        yield* Effect.forEach(snapshot, (shell) => orchestrator.getThreadProjection(shell.id)),
        before,
      );
      const explicit = archive(parent, childIds);
      yield* orchestrator.dispatch(explicit);
      yield* threads.executeArchive({ threadId: parent, requestId: explicit.commandId });
      for (const shell of snapshot) {
        const archived = yield* orchestrator.getThreadProjection(shell.id);
        assert.isNotNull(archived.thread.archivedAt);
        assert.isNull(archived.thread.archivePending);
        assert.isUndefined(archived.thread.lineage.independent);
      }
    }).pipe(Effect.provide(testLayer)),
);

it.effect("automatic archive accepts a genuinely idle recursive family", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const { parent, snapshot } = yield* idleArchiveFamily;
    const command = {
      ...archive(
        parent,
        snapshot.filter((shell) => shell.id !== parent).map((shell) => shell.id),
      ),
      commandId: CommandId.make("genuinely-idle-family-archive"),
      childDisposition: "archive_if_idle" as const,
    };
    yield* orchestrator.dispatch(command);
    yield* threads.executeArchive({ threadId: parent, requestId: command.commandId });
    for (const shell of snapshot) {
      const projection = yield* orchestrator.getThreadProjection(shell.id);
      assert.isNotNull(projection.thread.archivedAt);
      assert.isNull(projection.thread.archivePending);
      assert.isFalse(projection.turnItems.some((item) => item.type === "run_interrupt_request"));
    }
  }).pipe(Effect.provide(testLayer)),
);

it.effect.each(["preparing", "starting", "running", "waiting"] as const)(
  "ordinary standalone archive refuses %s work without stopping it",
  (status) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const standalone = ThreadId.make("standalone-active-archive");
      yield* createWatchingThread(standalone, 7);
      yield* send(standalone, "standalone-work", "start_immediately");
      const run = (yield* orchestrator.getThreadProjection(standalone)).runs[0]!;
      yield* projections.apply({
        id: EventId.make("standalone-run-state"),
        type: "run.updated",
        threadId: standalone,
        occurredAt: yield* DateTime.now,
        payload: { ...run, status },
      });
      const sequence = (yield* orchestrator.getShellSnapshot()).snapshotSequence;
      for (const childDisposition of [undefined, "stop_and_archive"] as const) {
        const refused = yield* orchestrator
          .dispatch({
            type: "thread.archive",
            commandId: CommandId.make(`standalone-archive:${childDisposition ?? "ordinary"}`),
            threadId: standalone,
            ...(childDisposition ? { childDisposition, expectedChildThreadIds: [] } : {}),
          })
          .pipe(Effect.flip);
        assert.equal(refused._tag, "OrchestratorDispatchError");
        assert.include(String(refused.cause), "unfinished work");
      }
      const after = yield* orchestrator.getThreadProjection(standalone);
      assert.equal((yield* orchestrator.getShellSnapshot()).snapshotSequence, sequence);
      assert.isNull(after.thread.archivedAt);
      assert.isNull(after.thread.archivePending ?? null);
      assert.equal(after.runs[0]?.status, status);
      assert.isTrue(after.thread.pullRequests?.[0]?.watch?.startedAt !== undefined);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("ordinary standalone archive preserves a pending question after its run stopped", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const standalone = ThreadId.make("standalone-question-archive");
    yield* createWatchingThread(standalone, 8);
    yield* send(standalone, "standalone-question", "start_immediately");
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("standalone-stop-before-question"),
      threadId: standalone,
    });
    const run = (yield* orchestrator.getThreadProjection(standalone)).runs[0]!;
    yield* projections.apply({
      id: EventId.make("standalone-pending-question"),
      type: "runtime-request.updated",
      threadId: standalone,
      occurredAt: yield* DateTime.now,
      payload: {
        id: RuntimeRequestId.make("standalone-question"),
        nodeId: run.rootNodeId!,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "not_resumable", reason: "fixture" },
        createdAt: yield* DateTime.now,
        resolvedAt: null,
      },
    });
    const sequence = (yield* orchestrator.getShellSnapshot()).snapshotSequence;
    const refused = yield* orchestrator
      .dispatch({
        type: "thread.archive",
        commandId: CommandId.make("standalone-archive-pending-question"),
        threadId: standalone,
      })
      .pipe(Effect.flip);
    assert.include(String(refused.cause), "unfinished work");
    assert.equal((yield* orchestrator.getShellSnapshot()).snapshotSequence, sequence);
    const after = yield* orchestrator.getThreadProjection(standalone);
    assert.equal(after.runtimeRequests[0]?.status, "pending");
    assert.isNull(after.thread.archivedAt);
    assert.isNull(after.thread.archivePending ?? null);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("ordinary standalone archive preserves runless owned provider execution", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const { parent } = yield* family;
    const owner = yield* orchestrator.getThreadProjection(parent);
    const standalone = ThreadId.make("standalone-runless-archive");
    yield* createWatchingThread(standalone, 9);
    const providerThreadId = ProviderThreadId.make("standalone-owned-provider");
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make("standalone-owned-provider"),
      type: "provider-thread.updated",
      threadId: standalone,
      occurredAt: now,
      payload: {
        ...owner.providerThreads[0]!,
        id: providerThreadId,
        appThreadId: standalone,
        providerSessionId: importSessionId,
      },
    });
    yield* projections.apply({
      id: EventId.make("standalone-owned-turn"),
      type: "provider-turn.updated",
      threadId: standalone,
      occurredAt: now,
      payload: {
        id: ProviderTurnId.make("standalone-owned-turn"),
        providerThreadId,
        nodeId: owner.runs[0]!.rootNodeId!,
        runAttemptId: null,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    });
    assert.lengthOf((yield* orchestrator.getThreadProjection(standalone)).runs, 0);
    const sequence = (yield* orchestrator.getShellSnapshot()).snapshotSequence;
    const refused = yield* orchestrator
      .dispatch({
        type: "thread.archive",
        commandId: CommandId.make("standalone-archive-owned-turn"),
        threadId: standalone,
      })
      .pipe(Effect.flip);
    assert.include(String(refused.cause), "unfinished work");
    assert.equal((yield* orchestrator.getShellSnapshot()).snapshotSequence, sequence);
    const after = yield* orchestrator.getThreadProjection(standalone);
    assert.equal(after.providerTurns[0]?.status, "running");
    assert.isNull(after.thread.archivedAt);
    assert.isNull(after.thread.archivePending ?? null);
  }).pipe(Effect.provide(testLayer)),
);

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
      for (const id of [parent, child, grandchild]) {
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
      assert.deepEqual(getThreadArchivePlan(pending)?.modeLimit, {
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
        getThreadArchivePlan(
          (yield* orchestrator.getThreadProjection(parent)).thread.archivePending,
        )?.modeLimit,
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
        id: EventId.make("legacy-inherited-placement"),
        type: "thread.metadata-updated",
        threadId: child,
        occurredAt: now,
        payload: {
          ...(yield* orchestrator.getThreadProjection(child)).thread,
          pinnedAt: now,
          pinOrderKey: "m",
          activeOrderKey: "m",
        },
      });
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
      assert.isNull(restoredChild.pinnedAt);
      assert.isNull(restoredChild.pinOrderKey);
      assert.isNull(restoredChild.activeOrderKey);
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

it.effect.each([false, true])(
  "promotion gives independent roots fresh sidebar placement with pinned parent=%s",
  (pinned) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const parent = ThreadId.make("placement-parent");
      yield* createWatchingThread(parent, 1);
      yield* orchestrator.dispatch({
        type: "thread.active.reorder",
        commandId: CommandId.make("place-parent"),
        threadId: parent,
        orderKey: "m",
      });
      if (pinned)
        yield* orchestrator.dispatch({
          type: "thread.pin",
          commandId: CommandId.make("pin-parent"),
          threadId: parent,
          orderKey: "m",
        });
      yield* send(parent, "work", "start_immediately");
      const child = yield* delegate(parent, "placement-child");
      const sibling = yield* delegate(parent, "placement-sibling");
      const grandchild = yield* delegate(child, "placement-grandchild");
      const originalOwner = (yield* orchestrator.getThreadProjection(parent)).thread;
      const originalChildren = yield* Effect.forEach([child, sibling], (id) =>
        orchestrator.getThreadProjection(id),
      );
      for (const { thread } of originalChildren) {
        assert.equal(thread.activeOrderKey, "m");
        assert.deepEqual(thread.pinnedAt, originalOwner.pinnedAt);
        assert.equal(thread.pinOrderKey, originalOwner.pinOrderKey);
      }
      const command = archive(parent, [child, sibling, grandchild], "promote");
      yield* orchestrator.dispatch(command);
      for (const { thread } of originalChildren)
        assert.deepEqual((yield* orchestrator.getThreadProjection(thread.id)).thread, thread);
      yield* threads.executeArchive({ threadId: parent, requestId: command.commandId });
      for (const before of originalChildren) {
        const kept = yield* orchestrator.getThreadProjection(before.thread.id);
        assert.isTrue(kept.thread.lineage.independent);
        assert.isNull(kept.thread.pinnedAt);
        assert.isNull(kept.thread.pinOrderKey);
        assert.isNull(kept.thread.activeOrderKey);
        assert.equal(kept.thread.lineage.parentThreadId, parent);
        assert.deepEqual(kept.thread.forkedFrom, before.thread.forkedFrom);
        assert.deepEqual(kept.runs, before.runs);
      }
      assert.isUndefined(
        (yield* orchestrator.getThreadProjection(grandchild)).thread.lineage.independent,
      );
      yield* orchestrator.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("restore-placement-parent"),
        threadId: parent,
      });
      const restored = (yield* orchestrator.getThreadProjection(parent)).thread;
      assert.deepEqual(restored.pinnedAt, originalOwner.pinnedAt);
      assert.equal(restored.pinOrderKey, originalOwner.pinOrderKey);
      assert.equal(restored.activeOrderKey, originalOwner.activeOrderKey);
      for (const id of [child, sibling]) {
        const kept = (yield* orchestrator.getThreadProjection(id)).thread;
        assert.isTrue(kept.lineage.independent);
        assert.isNull(kept.pinnedAt);
        assert.isNull(kept.pinOrderKey);
        assert.isNull(kept.activeOrderKey);
      }
    }).pipe(Effect.provide(testLayer)),
);

it.effect("retained child completion leaves its former parent unchanged", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const sink = yield* EventSink.EventSinkV2;
    const parent = ThreadId.make("retained-completion:parent");
    yield* createWatchingThread(parent, 1);
    yield* send(parent, "work", "start_immediately");
    const child = yield* delegate(parent, "retained-completion:child");
    const keep = archive(parent, [child], "promote");
    yield* orchestrator.dispatch(keep);
    yield* threads.executeArchive({ threadId: parent, requestId: keep.commandId });
    const before = yield* orchestrator.getThreadProjection(parent);
    const childBefore = yield* orchestrator.getThreadProjection(child);
    const sequence = (yield* orchestrator.getShellSnapshot()).snapshotSequence;
    const now = yield* DateTime.now;
    yield* sink.write({
      commandId: CommandId.make("retained-completion:finished"),
      events: [
        {
          id: EventId.make("retained-completion:run-completed"),
          type: "run.updated",
          threadId: child,
          runId: childBefore.runs[0]!.id,
          occurredAt: now,
          payload: { ...childBefore.runs[0]!, status: "completed", completedAt: now },
        },
      ],
    });
    // The listener processes terminal runs in order. A normal child's result
    // proves it consumed the retained child's earlier completion as well.
    const controlParent = ThreadId.make("retained-completion:control-parent");
    yield* createWatchingThread(controlParent, 2);
    yield* send(controlParent, "control-work", "start_immediately");
    const controlChild = yield* delegate(controlParent, "retained-completion:control-child");
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("retained-completion:control-stop"),
      threadId: controlChild,
    });
    yield* orchestrator
      .streamStoredEventsFrom({ threadId: controlParent, afterSequence: sequence })
      .pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "context-transfer.created" &&
            stored.event.payload.type === "subagent_result" &&
            stored.event.payload.sourceThreadId === controlChild,
        ),
        Stream.runHead,
      );
    assert.deepEqual(yield* orchestrator.getThreadProjection(parent), before);
    yield* orchestrator.recoverDelegatedTask(child, childBefore.runs[0]!.id);
    yield* orchestrator.recoverDelegatedTasks;
    assert.deepEqual(yield* orchestrator.getThreadProjection(parent), before);
    const finished = (yield* orchestrator.getThreadProjection(child)).thread;
    assert.isTrue(finished.lineage.independent);
    assert.deepEqual(finished.lineage, childBefore.thread.lineage);
    assert.isNull(finished.archivedAt);
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
    for (const id of [parent, child, grandchild]) {
      const projection = yield* orchestrator.getThreadProjection(id);
      assert.isNull(projection.thread.archivedAt);
      assert.equal(projection.thread.archivePending?.status, "failed");
      assert.isTrue(projection.runs.every((run) => run.status === "cancelled"));
    }
    yield* threads.dispatch(dismissArchive(parent, command.commandId));
    assert.equal((yield* Fiber.join(waiting))._tag, "Failure");
    const replayedFailure = yield* threads.dispatch(command).pipe(Effect.flip);
    assert.equal(replayedFailure._tag, "OrchestratorDispatchError");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("dismisses a failed archive without changing execution or replaying shutdown", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const { parent, child, grandchild } = yield* family;
    const command = archive(parent, [child, grandchild]);
    yield* failArchive(command);
    // Work may resume after failure. Dismissing its notice must leave it alone.
    yield* send(child, "continued work", "start_immediately");
    const before = yield* Effect.forEach([parent, child, grandchild], (id) =>
      orchestrator.getThreadProjection(id),
    );
    const dismissal = dismissArchive(parent, command.commandId);
    const result = yield* threads.dispatch(dismissal);
    assert.deepEqual(
      result.storedEvents.map((stored) => stored.event.threadId).toSorted(),
      [parent, child, grandchild].toSorted(),
    );
    assert.isTrue(
      result.storedEvents.every((stored) => stored.event.type === "thread.metadata-updated"),
    );
    assert.isEmpty(yield* outbox.listByCommandId(dismissal.commandId));
    for (const previous of before) {
      const current = yield* orchestrator.getThreadProjection(previous.thread.id);
      assert.deepEqual(current.thread, {
        ...previous.thread,
        archivePending: null,
        updatedAt: current.thread.updatedAt,
      });
      assert.deepEqual({ ...current, thread: previous.thread }, previous);
    }
    yield* threads.executeArchive({ threadId: parent, requestId: command.commandId }).pipe(
      Effect.provide(
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          teardownThread: () => Effect.die("A dismissed archive must not shut down providers"),
        }),
      ),
    );
    for (const type of ["thread.archive.complete", "thread.archive.fail"] as const) {
      const stale = yield* orchestrator.dispatch({
        type,
        commandId: CommandId.make(`${command.commandId}:late:${type}`),
        threadId: parent,
        requestId: command.commandId,
        error: "Late shutdown failure",
      });
      assert.isEmpty(
        yield* outbox.listByCommandId(CommandId.make(`${command.commandId}:late:${type}`)),
      );
      assert.isTrue(
        stale.storedEvents.every((stored) => stored.event.type === "thread.metadata-updated"),
      );
    }
    for (const previous of before) {
      const current = yield* orchestrator.getThreadProjection(previous.thread.id);
      assert.isNull(current.thread.archivedAt);
      assert.isNull(current.thread.archivePending);
      assert.deepEqual({ ...current, thread: previous.thread }, previous);
    }
    const original = yield* threads.dispatch(command).pipe(Effect.flip);
    assert.equal(original._tag, "OrchestratorDispatchError");
    if (original._tag === "OrchestratorDispatchError")
      assert.equal(original.cause, "Isolated shutdown failed");
  }).pipe(Effect.provide(testLayer)),
);

it.effect.each([
  "dismissed",
  "restored",
  "newer-failed",
  "stopping",
  "compact-owner",
  "different-owner",
  "direct-child",
  "deleted",
] as const)(
  "refuses a retry of an observed failure after %s without changing the family",
  (state) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const { parent, child, grandchild } = yield* family;
      const command = archive(parent, [child, grandchild]);
      yield* failArchive(command);
      const observed = (yield* orchestrator.getThreadProjection(child)).thread.archivePending!;
      const owner = (yield* orchestrator.getThreadProjection(observed.threadId)).thread;
      assert.equal(observed.commandId, owner.archivePending?.commandId);
      assert.equal(observed.status, "failed");
      if (state === "dismissed")
        yield* threads.dispatch(dismissArchive(parent, observed.commandId));
      if (state === "restored") {
        const completed = { ...command, commandId: CommandId.make("completed-before-stale-retry") };
        yield* orchestrator.dispatch(completed);
        yield* orchestrator.dispatch({
          type: "thread.archive.complete",
          commandId: CommandId.make(`${completed.commandId}:complete`),
          threadId: parent,
          requestId: completed.commandId,
        });
        yield* settleArchiveResults(completed);
        yield* threads.dispatch({
          type: "thread.unarchive",
          commandId: CommandId.make("restore-before-stale-retry"),
          threadId: parent,
        });
      }
      if (state === "newer-failed")
        yield* failArchive({
          ...command,
          commandId: CommandId.make("failure-after-observed-attempt"),
        });
      if (
        state === "stopping" ||
        state === "compact-owner" ||
        state === "different-owner" ||
        state === "deleted"
      ) {
        yield* projections.apply({
          id: EventId.make(`retry-changed-owner:${state}`),
          type: "thread.metadata-updated",
          threadId: parent,
          occurredAt: yield* DateTime.now,
          payload: {
            ...owner,
            ...(state === "deleted" ? { deletedAt: yield* DateTime.now } : {}),
            archivePending:
              state === "compact-owner"
                ? { threadId: parent, commandId: observed.commandId, status: "failed" }
                : {
                    ...getThreadArchivePlan(owner.archivePending)!,
                    ...(state === "stopping" ? { status: "stopping" as const } : {}),
                    ...(state === "different-owner" ? { threadId: child } : {}),
                  },
          },
        });
      }
      const before = yield* Effect.forEach([parent, child, grandchild], (id) =>
        orchestrator.getThreadProjection(id),
      );
      const archiveCommandIds = [
        command.commandId,
        CommandId.make("completed-before-stale-retry"),
        CommandId.make("failure-after-observed-attempt"),
      ];
      const effectsBefore = yield* Effect.forEach(archiveCommandIds, (id) =>
        outbox.listByCommandId(id),
      );
      const sequence = (yield* orchestrator.getShellSnapshot()).snapshotSequence;
      const retry = {
        ...command,
        commandId: CommandId.make(`stale-retry:${state}`),
        threadId: state === "direct-child" ? child : observed.threadId,
        expectedArchiveCommandId: observed.commandId,
      };
      const refusal = yield* threads.dispatch(retry).pipe(Effect.flip);
      if (state === "stopping") {
        assert.equal(refusal._tag, "OrchestratorThreadArchivingError");
        assert.equal(
          refusal.message,
          "This conversation is stopping before it is archived. Wait for the archive to finish.",
        );
      } else {
        assert.equal(refusal._tag, "OrchestratorDispatchError");
        if (refusal._tag === "OrchestratorDispatchError")
          assert.equal(
            refusal.cause,
            "This failed archive changed. Review the conversation before retrying it.",
          );
      }
      assert.equal((yield* orchestrator.getShellSnapshot()).snapshotSequence, sequence);
      assert.isEmpty(yield* outbox.listByCommandId(retry.commandId));
      assert.deepEqual(
        yield* Effect.forEach(archiveCommandIds, (id) => outbox.listByCommandId(id)),
        effectsBefore,
      );
      for (const previous of before)
        assert.deepEqual(yield* orchestrator.getThreadProjection(previous.thread.id), previous);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("retries the matching failed archive attempt on its original owner", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const { parent, child, grandchild } = yield* family;
    const command = archive(parent, [child, grandchild]);
    yield* failArchive(command);
    const observed = (yield* orchestrator.getThreadProjection(child)).thread.archivePending!;
    const retry = {
      ...command,
      commandId: CommandId.make("retry-matching-failed-archive"),
      threadId: observed.threadId,
      expectedArchiveCommandId: observed.commandId,
    };
    yield* orchestrator.dispatch(retry);
    for (const id of [parent, child, grandchild]) {
      const current = (yield* orchestrator.getThreadProjection(id)).thread;
      assert.equal(current.archivePending?.commandId, retry.commandId);
      assert.equal(current.archivePending?.status, "stopping");
      assert.isNull(current.archivedAt);
    }
    assert.lengthOf(yield* outbox.listByCommandId(retry.commandId), 1);
    yield* threads.executeArchive({ threadId: parent, requestId: retry.commandId }).pipe(
      Effect.provide(
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          teardownThread: () => Effect.void,
        }),
      ),
    );
    for (const id of [parent, child, grandchild]) {
      const current = (yield* orchestrator.getThreadProjection(id)).thread;
      assert.isNotNull(current.archivedAt);
      assert.isNull(current.archivePending);
      assert.equal(current.archivedWith?.threadId, parent);
      assert.equal(current.archivedWith?.commandId, retry.commandId);
    }
  }).pipe(Effect.provide(testLayer)),
);

it.effect.each(["different-owner", "newer-attempt", "archived", "deleted", "independent"] as const)(
  "dismissal preserves a descendant with %s metadata",
  (state) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const { parent, child, grandchild } = yield* family;
      const command = archive(parent, [child, grandchild]);
      yield* failArchive(command);
      const previous = (yield* orchestrator.getThreadProjection(grandchild)).thread;
      const now = yield* DateTime.now;
      const retained = {
        ...previous,
        ...(state === "different-owner"
          ? { archivePending: { ...previous.archivePending!, threadId: grandchild } }
          : state === "newer-attempt"
            ? {
                archivePending: {
                  ...previous.archivePending!,
                  commandId: CommandId.make("newer-archive"),
                },
              }
            : state === "archived"
              ? {
                  archivedAt: now,
                  archivedWith: {
                    threadId: grandchild,
                    commandId: CommandId.make("separate-cohort"),
                  },
                }
              : state === "deleted"
                ? { deletedAt: now }
                : { lineage: { ...previous.lineage, independent: true } }),
      };
      yield* projections.apply({
        id: EventId.make(`dismissal-retained:${state}`),
        type: "thread.metadata-updated",
        threadId: grandchild,
        occurredAt: now,
        payload: retained,
      });
      yield* orchestrator.dispatch(dismissArchive(parent, command.commandId));
      for (const id of [parent, child])
        assert.isNull((yield* orchestrator.getThreadProjection(id)).thread.archivePending);
      assert.deepEqual((yield* orchestrator.getThreadProjection(grandchild)).thread, retained);
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each([
  "active",
  "stopping",
  "newer-failed",
  "completed",
  "deleted",
  "direct-child",
  "compact-owner",
  "restore-active",
] as const)("refuses dismissal against %s without changing the family", (state) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const { parent, child, grandchild } = yield* family;
    const command = archive(parent, [child, grandchild]);
    if (state === "stopping" || state === "completed") {
      yield* orchestrator.dispatch(command);
      if (state === "completed") {
        yield* orchestrator.dispatch({
          type: "thread.archive.complete",
          commandId: CommandId.make(`${command.commandId}:complete`),
          threadId: parent,
          requestId: command.commandId,
        });
        yield* settleArchiveResults(command);
      }
    } else if (state !== "active") yield* failArchive(command);
    if (state === "newer-failed")
      yield* failArchive({ ...command, commandId: CommandId.make("newer-failed-archive") });
    if (state === "deleted" || state === "compact-owner") {
      const thread = (yield* orchestrator.getThreadProjection(parent)).thread;
      yield* projections.apply({
        id: EventId.make(`dismissal-refused:${state}`),
        type: "thread.metadata-updated",
        threadId: parent,
        occurredAt: yield* DateTime.now,
        payload:
          state === "deleted"
            ? { ...thread, deletedAt: yield* DateTime.now }
            : {
                ...thread,
                archivePending: {
                  threadId: parent,
                  commandId: command.commandId,
                  status: "failed",
                },
              },
      });
    }
    const before = yield* Effect.forEach([parent, child, grandchild], (id) =>
      orchestrator.getThreadProjection(id),
    );
    const sequence = (yield* orchestrator.getShellSnapshot()).snapshotSequence;
    const dismissal =
      state === "restore-active"
        ? {
            type: "thread.unarchive" as const,
            commandId: CommandId.make("restore-active"),
            threadId: parent,
          }
        : dismissArchive(state === "direct-child" ? child : parent, command.commandId);
    const refusal = yield* orchestrator.dispatch(dismissal).pipe(Effect.flip);
    assert.equal(
      refusal._tag,
      state === "stopping" ? "OrchestratorThreadArchivingError" : "OrchestratorDispatchError",
    );
    assert.equal((yield* orchestrator.getShellSnapshot()).snapshotSequence, sequence);
    assert.isEmpty(yield* outbox.listByCommandId(dismissal.commandId));
    for (const previous of before)
      assert.deepEqual(yield* orchestrator.getThreadProjection(previous.thread.id), previous);
  }).pipe(Effect.provide(testLayer)),
);

it.effect.each(
  archiveModeLimits.flatMap((limit) => [false, true].map((unrelated) => ({ ...limit, unrelated }))),
)(
  "dismissal respects the $mode ceiling only for changed participants (unrelated=$unrelated)",
  (limit) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const { parent, child, grandchild } = yield* family;
      const command = archive(parent, [child, grandchild]);
      yield* failArchive(command);
      for (const id of [parent, child]) {
        const thread = (yield* orchestrator.getThreadProjection(id)).thread;
        yield* projections.apply({
          id: EventId.make(`dismissal-limited:${id}`),
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
      const nested = (yield* orchestrator.getThreadProjection(grandchild)).thread;
      if (limit.unrelated)
        yield* projections.apply({
          id: EventId.make("dismissal-unrelated-limit"),
          type: "thread.metadata-updated",
          threadId: grandchild,
          occurredAt: yield* DateTime.now,
          payload: {
            ...nested,
            archivePending: { ...nested.archivePending!, threadId: grandchild },
          },
        });
      const dismissal = dismissArchive(parent, command.commandId);
      if (!limit.unrelated) {
        const before = yield* Effect.forEach([parent, child, grandchild], (id) =>
          orchestrator.getThreadProjection(id),
        );
        const sequence = (yield* orchestrator.getShellSnapshot()).snapshotSequence;
        const refusal = yield* orchestrator
          .dispatch(dismissal)
          .pipe(Effect.provideService(DispatchModeLimit, limit), Effect.flip);
        assert.equal(refusal._tag, "OrchestratorThreadAboveModeLimitError");
        assert.equal((yield* orchestrator.getShellSnapshot()).snapshotSequence, sequence);
        for (const previous of before)
          assert.deepEqual(yield* orchestrator.getThreadProjection(previous.thread.id), previous);
        yield* projections.apply({
          id: EventId.make("dismissal-lower-limit"),
          type: "thread.metadata-updated",
          threadId: grandchild,
          occurredAt: yield* DateTime.now,
          payload: {
            ...nested,
            runtimeMode: limit.runtimeMode,
            interactionMode: limit.interactionMode,
          },
        });
      }
      yield* orchestrator.dispatch(dismissal).pipe(Effect.provideService(DispatchModeLimit, limit));
      for (const id of [parent, child])
        assert.isNull((yield* orchestrator.getThreadProjection(id)).thread.archivePending);
      assert.equal(
        (yield* orchestrator.getThreadProjection(grandchild)).thread.archivePending == null,
        !limit.unrelated,
      );
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

it.effect.each(["child", "grandchild", "late descendant"] as const)(
  "reserves %s against delegated cancellation while promotion waits, lifting the hold after failure",
  (target) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { parent, child, grandchild } = yield* family;
      const promote = archive(parent, [child, grandchild], "promote");
      yield* orchestrator.dispatch(promote);
      const parentThreadId = target === "child" ? parent : child;
      const childThreadId =
        target === "child"
          ? child
          : target === "grandchild"
            ? grandchild
            : yield* delegate(child, "late-retained-child");
      const task = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
        (candidate) => candidate.childThreadId === childThreadId,
      )!;
      const ownership = [{ parentThreadId, taskId: task.id, childThreadId }];
      const stop = {
        type: "thread.stop" as const,
        commandId: CommandId.make("cancel-during-promotion"),
        threadId: childThreadId,
      };
      const sequence = (yield* orchestrator.getShellSnapshot()).snapshotSequence;
      const refused = yield* orchestrator
        .dispatch(stop)
        .pipe(Effect.provideService(DelegatedTaskCancellation, ownership), Effect.flip);
      assert.include(String(refused.cause), "being kept separately");
      assert.equal((yield* orchestrator.getShellSnapshot()).snapshotSequence, sequence);
      assert.equal(
        (yield* orchestrator.getThreadProjection(childThreadId)).runs.at(-1)?.status,
        "starting",
      );
      assert.isFalse(
        (yield* orchestrator.getThreadProjection(child)).thread.lineage.independent === true,
      );
      yield* orchestrator.dispatch({
        type: "thread.archive.fail",
        commandId: CommandId.make("promotion-shutdown-failed"),
        threadId: parent,
        requestId: promote.commandId,
        error: "Synthetic shutdown failure",
      });
      // The temporary hold never records a rejected receipt or releases ownership.
      yield* orchestrator
        .dispatch(stop)
        .pipe(Effect.provideService(DelegatedTaskCancellation, ownership));
      assert.equal(
        (yield* orchestrator.getThreadProjection(childThreadId)).runs.at(-1)?.status,
        "interrupted",
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect("promotion retains new nested work created while shutdown waits", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const { parent, child, grandchild } = yield* family;
    const providerThread = (yield* orchestrator.getThreadProjection(parent)).providerThreads[0]!;
    yield* projections.apply({
      id: EventId.make("growing-retained-parent-session"),
      type: "provider-thread.updated",
      threadId: parent,
      occurredAt: yield* DateTime.now,
      payload: { ...providerThread, providerSessionId: importSessionId },
    });
    const command = archive(parent, [child, grandchild], "promote");
    yield* orchestrator.dispatch(command);
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
    const lateChild = yield* delegate(child, "growing-retained-child");
    const lateNested = yield* delegate(lateChild, "growing-retained-nested");
    yield* Deferred.succeed(resume, undefined);
    yield* Fiber.join(shutdown);
    const owner = (yield* orchestrator.getThreadProjection(parent)).thread;
    assert.isNotNull(owner.archivedAt);
    assert.isNull(owner.archivePending);
    const promoted = yield* orchestrator.getThreadProjection(child);
    assert.isTrue(promoted.thread.lineage.independent);
    assert.isTrue(
      (yield* orchestrator.getThreadProjection(parent)).subagents[0]?.ownershipReleased,
    );
    for (const id of [child, grandchild, lateChild, lateNested]) {
      const projection = yield* orchestrator.getThreadProjection(id);
      assert.isNull(projection.thread.archivedAt);
      assert.isNull(projection.thread.archivePending ?? null);
      assert.equal(projection.runs.at(-1)?.status, "starting");
    }
    assert.equal(
      (yield* orchestrator.getThreadProjection(lateChild)).thread.lineage.parentThreadId,
      child,
    );
    assert.equal(
      (yield* orchestrator.getThreadProjection(lateNested)).thread.lineage.parentThreadId,
      lateChild,
    );
    yield* orchestrator.dispatch({
      type: "thread.unarchive",
      commandId: CommandId.make("restore-growing-retained-owner"),
      threadId: parent,
    });
    assert.isTrue((yield* orchestrator.getThreadProjection(child)).thread.lineage.independent);
    assert.equal(
      (yield* orchestrator.getThreadProjection(lateNested)).runs.at(-1)?.status,
      "starting",
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect.each(archiveModeLimits)(
  "new retained descendants must respect the saved $mode ceiling before ownership release",
  (limit) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const { parent, child, grandchild } = yield* family;
      for (const id of [parent, child, grandchild]) {
        const thread = (yield* orchestrator.getThreadProjection(id)).thread;
        yield* projections.apply({
          id: EventId.make(`growing-mode:${id}`),
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
      const command = archive(parent, [child, grandchild], "promote");
      yield* orchestrator.dispatch(command).pipe(Effect.provideService(DispatchModeLimit, limit));
      const lateChild = yield* delegate(child, "growing-high-mode-child");
      yield* threads.executeArchive({ threadId: parent, requestId: command.commandId }).pipe(
        Effect.provide(
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            teardownThread: () => Effect.void,
          }),
        ),
      );
      const owner = yield* orchestrator.getThreadProjection(parent);
      assert.isNull(owner.thread.archivedAt);
      assert.equal(owner.thread.archivePending?.status, "failed");
      assert.include(owner.thread.archivePending?.error, "Permissions changed while stopping");
      assert.isUndefined(owner.subagents[0]?.ownershipReleased);
      assert.isUndefined(
        (yield* orchestrator.getThreadProjection(child)).thread.lineage.independent,
      );
      assert.isNull((yield* orchestrator.getThreadProjection(lateChild)).thread.archivedAt);
      assert.equal(
        (yield* orchestrator.getThreadProjection(lateChild)).runs.at(-1)?.status,
        "starting",
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each(["web", "provider"] as const)(
  "a new direct %s child changes the consented partition and keeps completion retryable",
  (creationSource) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const { parent, child, grandchild } = yield* family;
      const lateRoot = ThreadId.make("late-direct-family-child");
      yield* createWatchingThread(lateRoot, 10);
      const command = archive(parent, [child, grandchild], "promote");
      yield* orchestrator.dispatch(command);
      const late = (yield* orchestrator.getThreadProjection(lateRoot)).thread;
      yield* projections.apply({
        id: EventId.make("late-direct-family-lineage"),
        type: "thread.metadata-updated",
        threadId: lateRoot,
        occurredAt: yield* DateTime.now,
        payload: {
          ...late,
          creationSource,
          lineage: {
            parentThreadId: parent,
            rootThreadId: parent,
            relationshipToParent: "subagent",
          },
        },
      });
      yield* threads.executeArchive({ threadId: parent, requestId: command.commandId }).pipe(
        Effect.provide(
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            teardownThread: () => Effect.void,
          }),
        ),
      );
      const owner = yield* orchestrator.getThreadProjection(parent);
      assert.isNull(owner.thread.archivedAt);
      assert.equal(owner.thread.archivePending?.status, "failed");
      assert.isUndefined(owner.subagents[0]?.ownershipReleased);
      assert.isUndefined(
        (yield* orchestrator.getThreadProjection(child)).thread.lineage.independent,
      );
      assert.isNull((yield* orchestrator.getThreadProjection(lateRoot)).thread.archivedAt);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("an explicit direct Stop can still stop retained work during promotion", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { parent, child, grandchild } = yield* family;
    yield* orchestrator.dispatch(archive(parent, [child, grandchild], "promote"));
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("direct-stop-retained-child"),
      threadId: child,
    });
    assert.equal(
      (yield* orchestrator.getThreadProjection(child)).runs.at(-1)?.status,
      "interrupted",
    );
    assert.equal(
      (yield* orchestrator.getThreadProjection(parent)).thread.archivePending?.status,
      "stopping",
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("stores a single family plan through shutdown failure and completion", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { parent, child, grandchild } = yield* family;
    const command = archive(parent, [child, grandchild]);
    yield* orchestrator.dispatch(command);
    for (const status of ["stopping", "failed"] as const) {
      const { threads: shells } = yield* orchestrator.getThreadArchiveFamily(parent);
      const plans = shells.flatMap((shell) => {
        const pending = getThreadArchivePlan(shell.archivePending);
        return pending === null ? [] : [pending];
      });
      assert.lengthOf(plans, 1);
      assert.deepEqual(plans[0]?.archiveThreadIds, [parent, child, grandchild]);
      for (const shell of shells) {
        assert.equal(shell.archivePending?.status, status);
        assert.equal(shell.archivePending?.threadId, parent);
        assert.equal(shell.archivePending?.commandId, command.commandId);
      }
      if (status === "stopping")
        yield* orchestrator.dispatch({
          type: "thread.archive.fail",
          commandId: CommandId.make("compact-plan-failure"),
          threadId: parent,
          requestId: command.commandId,
          error: "Synthetic shutdown failure",
        });
    }
    const retry = { ...command, commandId: CommandId.make("compact-plan-retry") };
    yield* orchestrator.dispatch(retry);
    yield* orchestrator.dispatch({
      type: "thread.archive.complete",
      commandId: CommandId.make("compact-plan-complete"),
      threadId: parent,
      requestId: retry.commandId,
    });
    for (const id of [parent, child, grandchild]) {
      const projection = yield* orchestrator.getThreadProjection(id);
      assert.isNull(projection.thread.archivePending);
      assert.isNotNull(projection.thread.archivedAt);
    }
  }).pipe(Effect.provide(testLayer)),
);

it.effect.each([false, true])(
  "promotion after failed shutdown clears former-owner failures and preserves unrelated failures=%s",
  (unrelatedFailure) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const { parent, child, grandchild } = yield* family;
      const stop = archive(parent, [child, grandchild]);
      yield* orchestrator.dispatch(stop);
      yield* orchestrator.dispatch({
        type: "thread.archive.fail",
        commandId: CommandId.make(`${stop.commandId}:failed`),
        threadId: parent,
        requestId: stop.commandId,
        error: "Isolated shutdown failed",
      });
      const previous = (yield* orchestrator.getThreadProjection(grandchild)).thread;
      assert.equal(previous.archivePending?.status, "failed");
      if (unrelatedFailure) {
        yield* projections.apply({
          id: EventId.make("unrelated-grandchild-archive-failure"),
          type: "thread.metadata-updated",
          threadId: grandchild,
          occurredAt: yield* DateTime.now,
          payload: {
            ...previous,
            archivePending: {
              ...previous.archivePending!,
              threadId: grandchild,
              commandId: CommandId.make("unrelated-archive-request"),
            },
          },
        });
      }
      const promote = archive(parent, [child, grandchild], "promote");
      yield* orchestrator.dispatch(promote);
      yield* threads.executeArchive({ threadId: parent, requestId: promote.commandId });
      const kept = (yield* orchestrator.getThreadProjection(child)).thread;
      const nested = (yield* orchestrator.getThreadProjection(grandchild)).thread;
      assert.isTrue(kept.lineage.independent);
      assert.isNull(kept.archivePending ?? null);
      assert.isNull(kept.archivedAt);
      assert.isNull(nested.archivedAt);
      if (unrelatedFailure) {
        assert.equal(nested.archivePending?.threadId, grandchild);
        assert.equal(nested.archivePending?.commandId, "unrelated-archive-request");
      } else {
        assert.isNull(nested.archivePending ?? null);
        const independentArchive = archive(child, [grandchild]);
        yield* orchestrator.dispatch(independentArchive);
        yield* threads.executeArchive({ threadId: child, requestId: independentArchive.commandId });
        for (const id of [child, grandchild])
          assert.equal(
            (yield* orchestrator.getThreadProjection(id)).thread.archivedWith?.threadId,
            child,
          );
      }
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each(
  archiveModeLimits.flatMap((limit) =>
    [false, true].map((hadFailure) => ({ ...limit, hadFailure })),
  ),
)("a descendant's raised $mode ceiling blocks release with prior failure=$hadFailure", (limit) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const { parent, child, grandchild } = yield* family;
    for (const id of [parent, child, grandchild]) {
      const thread = (yield* orchestrator.getThreadProjection(id)).thread;
      yield* projections.apply({
        id: EventId.make(`retry-initial-mode:${id}`),
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
    const stop = archive(parent, [child, grandchild]);
    if (limit.hadFailure) {
      yield* orchestrator.dispatch(stop).pipe(Effect.provideService(DispatchModeLimit, limit));
      yield* orchestrator.dispatch({
        type: "thread.archive.fail",
        commandId: CommandId.make(`${stop.commandId}:failed`),
        threadId: parent,
        requestId: stop.commandId,
        error: "Isolated shutdown failed",
      });
    }
    const providerThread = (yield* orchestrator.getThreadProjection(parent)).providerThreads[0]!;
    yield* projections.apply({
      id: EventId.make("retry-parent-shutdown-session"),
      type: "provider-thread.updated",
      threadId: parent,
      occurredAt: yield* DateTime.now,
      payload: { ...providerThread, providerSessionId: importSessionId },
    });
    const promote = archive(parent, [child, grandchild], "promote");
    yield* orchestrator.dispatch(promote).pipe(Effect.provideService(DispatchModeLimit, limit));
    const stopping = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    const shutdown = yield* threads
      .executeArchive({ threadId: parent, requestId: promote.commandId })
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
            commandId: CommandId.make("raise-retained-descendant-runtime"),
            threadId: grandchild,
            runtimeMode: "full-access",
          }
        : {
            type: "thread.interaction-mode.set",
            commandId: CommandId.make("raise-retained-descendant-interaction"),
            threadId: grandchild,
            interactionMode: "default",
          },
    );
    yield* Deferred.succeed(resume, undefined);
    yield* Fiber.join(shutdown);
    const root = (yield* orchestrator.getThreadProjection(parent)).thread;
    assert.isNull(root.archivedAt);
    assert.equal(root.archivePending?.status, "failed");
    assert.include(root.archivePending?.error, "Permissions changed while stopping");
    const kept = (yield* orchestrator.getThreadProjection(child)).thread;
    const nested = (yield* orchestrator.getThreadProjection(grandchild)).thread;
    assert.isUndefined(kept.lineage.independent);
    if (limit.hadFailure) {
      assert.equal(kept.archivePending?.commandId, stop.commandId);
      assert.equal(nested.archivePending?.commandId, stop.commandId);
    } else {
      assert.isNull(kept.archivePending ?? null);
      assert.isNull(nested.archivePending ?? null);
    }
    assert.isUndefined(
      (yield* orchestrator.getThreadProjection(parent)).subagents[0]?.ownershipReleased,
    );
  }).pipe(Effect.provide(testLayer)),
);
