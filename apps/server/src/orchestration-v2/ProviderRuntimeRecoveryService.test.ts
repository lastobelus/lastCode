import { assert, it, vi } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import { makePausedEnvironment } from "./EnvironmentAutomation.testkit.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";

const recoveryStores = Layer.mergeAll(ProjectionStore.layer, EffectOutbox.layer, EventStore.layer);
const recoveryPersistence = ProviderRuntimeRecovery.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      recoveryStores,
      EventSink.layer.pipe(Layer.provide(recoveryStores)),
      IdAllocator.layer,
      ServerSettings.layerTest(),
    ),
  ),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const seedRecoveryRuns = Effect.fn("seedRecoveryRuns")(function* (
  suffix: string,
  inputs: ReadonlyArray<{
    readonly status: "queued" | "starting";
    readonly automatic: boolean;
    readonly queueHeld?: boolean;
  }>,
  archived = false,
) {
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(`thread:pause-recovery:${suffix}`);
  const commandId = CommandId.make(`command:pause-recovery:${suffix}`);
  const providerInstanceId = ProviderInstanceId.make("codex");
  const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };
  const events: Array<OrchestrationV2DomainEvent> = [
    {
      id: EventId.make(`event:${suffix}:thread`),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project:pause-recovery"),
        title: "Recovery fixture",
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
        archivedAt: archived ? now : null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    },
  ];
  const effects: Array<EffectOutbox.PendingOrchestrationEffectV2> = [];
  const runs = inputs.map((input, index) => ({
    ...input,
    runId: RunId.make(`run:${suffix}:${index}`),
    messageId: MessageId.make(`message:${suffix}:${index}`),
    effectId: `effect:${suffix}:${index}`,
  }));
  for (const [index, run] of runs.entries()) {
    events.push(
      {
        id: EventId.make(`event:${suffix}:${index}:message`),
        type: "message.updated",
        threadId,
        runId: run.runId,
        occurredAt: now,
        payload: {
          createdBy: run.automatic ? "agent" : "user",
          creationSource: run.automatic ? "server" : "web",
          ...(run.automatic
            ? {
                notification: {
                  source: { kind: "monitor" as const },
                  outcome: "updated" as const,
                  summary: "Checks finished",
                },
              }
            : {}),
          id: run.messageId,
          threadId,
          runId: run.runId,
          nodeId: null,
          role: "user",
          text: "Continue work",
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      },
      {
        id: EventId.make(`event:${suffix}:${index}:run`),
        type: "run.created",
        threadId,
        runId: run.runId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: run.runId,
          threadId,
          ordinal: index + 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: run.messageId,
          rootNodeId: null,
          activeAttemptId: null,
          status: run.status,
          queuePosition: run.status === "queued" ? index + 1 : null,
          queueHeld: run.queueHeld ?? false,
          requestedAt: now,
          startedAt: null,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      },
    );
    if (run.status === "starting") {
      effects.push({
        id: run.effectId,
        commandId,
        threadId,
        request: { type: "provider-turn.start", runId: run.runId },
      });
    }
  }
  yield* (yield* EventSink.EventSinkV2).writeWithEffects({ commandId, events, effects });
  return { threadId, commandId, runs };
});

it.effect.each(
  ([null, "pausing", "resuming"] as const).flatMap((phase) =>
    (["startup", "shutdown"] as const).map((trigger) => ({
      phase,
      trigger,
      phaseLabel: phase ?? "no pause",
    })),
  ),
)(
  "preserves only unstarted pause-held work during $trigger with $phaseLabel",
  ({ phase, trigger }) =>
    Effect.gen(function* () {
      const pause = yield* makePausedEnvironment;
      if (phase === null) yield* Ref.set(pause.state, null);
      if (phase === "resuming") yield* pause.resume;
      yield* Effect.gen(function* () {
        const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const sql = yield* SqlClient.SqlClient;
        // A user queue on the same thread forces recovery's transactional
        // cancellation path while the original automatic start stays pending.
        const starting = yield* seedRecoveryRuns("starting", [
          { status: "starting", automatic: true },
          { status: "queued", automatic: false },
        ]);
        const queued = yield* seedRecoveryRuns("queued", [{ status: "queued", automatic: true }]);
        const heldQueue = yield* seedRecoveryRuns("held", [
          { status: "queued", automatic: true },
          { status: "queued", automatic: false, queueHeld: true },
          { status: "queued", automatic: true, queueHeld: true },
        ]);
        const claimed = yield* seedRecoveryRuns("claimed", [
          { status: "starting", automatic: true },
        ]);
        const archived = yield* seedRecoveryRuns(
          "archived",
          [{ status: "starting", automatic: true }],
          true,
        );
        yield* sql`UPDATE orchestration_v2_effect_outbox
            SET status = 'running', attempt_count = 1, lease_owner = 'previous-process'
            WHERE effect_id = ${claimed.runs[0]!.effectId}`;
        assert.deepEqual(yield* outbox.deferredAutomaticExecution, [
          { threadId: archived.threadId, runId: archived.runs[0]!.runId },
          { threadId: heldQueue.threadId, runId: heldQueue.runs[0]!.runId },
          { threadId: heldQueue.threadId, runId: heldQueue.runs[2]!.runId },
          { threadId: queued.threadId, runId: queued.runs[0]!.runId },
          { threadId: starting.threadId, runId: starting.runs[0]!.runId },
        ]);
        assert.deepEqual(yield* outbox.pendingAutomaticRelease, [
          { threadId: queued.threadId, runId: queued.runs[0]!.runId },
          { threadId: starting.threadId, runId: starting.runs[0]!.runId },
        ]);

        yield* recovery.prepareForShutdown;
        yield* trigger === "startup" ? recovery.recover : recovery.reconcile(trigger);
        yield* recovery.recover;
        const hasPause = phase !== null;
        const startingProjection = yield* projections.getThreadProjection(starting.threadId);
        assert.equal(startingProjection.runs[0]?.status, hasPause ? "starting" : "cancelled");
        assert.isTrue(startingProjection.runs[1]?.queueHeld);
        const queuedProjection = yield* projections.getRuntimeRecoveryProjection(queued.threadId);
        assert.equal(queuedProjection.runs[0]?.status, "queued");
        assert.equal(queuedProjection.runs[0]?.queueHeld, !hasPause);
        const heldProjection = yield* projections.getThreadProjection(heldQueue.threadId);
        assert.isTrue(heldProjection.runs[0]?.queueHeld);
        assert.isTrue(heldProjection.runs[1]?.queueHeld);
        assert.isTrue(heldProjection.runs[2]?.queueHeld);
        const start = Option.getOrThrow(yield* outbox.get(starting.runs[0]!.effectId));
        assert.equal(start.status, hasPause ? "pending" : "cancelled");
        assert.equal(start.attemptCount, 0);
        for (const fixture of [claimed, archived]) {
          assert.equal(
            (yield* projections.getRuntimeRecoveryProjection(fixture.threadId)).runs[0]?.status,
            "cancelled",
          );
          assert.equal(
            Option.getOrThrow(yield* outbox.get(fixture.runs[0]!.effectId)).status,
            "cancelled",
          );
        }
        assert.lengthOf(yield* outbox.listByCommandId(starting.commandId), 1);
        if (hasPause) {
          yield* pause.resume;
          const claim = Option.getOrThrow(
            yield* outbox.claimNext({ workerId: "resumed-process", leaseDurationMs: 30_000 }),
          );
          assert.equal(claim.id, start.id);
          yield* outbox.succeed({ effectId: claim.id, workerId: "resumed-process" });
        }
        assert.isTrue(
          Option.isNone(
            yield* outbox.claimNext({ workerId: "resumed-process", leaseDurationMs: 30_000 }),
          ),
        );
      }).pipe(Effect.provide(recoveryPersistence.pipe(Layer.provide(pause.layer))));
    }),
);

it.effect("leaves durable effects for the worker after runtime reconciliation", () =>
  Effect.gen(function* () {
    const runs = yield* Ref.make(0);
    const layer = ProviderRuntimeRecovery.layer.pipe(
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([]),
          }),
          Layer.mock(EventSink.EventSinkV2)({}),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Ref.getAndUpdate(runs, (count) => count + 1).pipe(
              Effect.map((count) => count < 2),
            ),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );
    const summary = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService.pipe(
      Effect.flatMap((recovery) => recovery.recover),
      Effect.provide(layer),
    );
    assert.deepEqual(summary, {
      terminalizedRuns: 0,
      stoppedSessions: 0,
      closedRequests: 0,
      retiredEffects: 0,
      requeuedEffects: 0,
    });
    assert.equal(yield* Ref.get(runs), 0);
  }),
);

it.effect("reads recovery projections only for threads that need runtime recovery", () => {
  const settledThreadIds = Array.from({ length: 1_000 }, (_, index) =>
    ThreadId.make(`thread_recovery_settled_${index}`),
  );
  const recoveryThreadId = ThreadId.make("thread_recovery_candidate");
  const projectionReads = vi.fn<(threadId: ThreadId) => void>();
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 2,
              snapshotSequence: 0,
              threads: [...settledThreadIds, recoveryThreadId].map((id) => ({ id })),
              archivedThreads: [],
            } as never),
          getRecoveryThreadIds: (kind) =>
            Effect.succeed(kind === "runtime" ? [recoveryThreadId] : []),
          getRuntimeRecoveryProjection: (threadId) => {
            projectionReads(threadId);
            return Effect.succeed({
              thread: { id: threadId },
              runtimeRequests: [],
              providerSessions: [],
              providerThreads: [],
              providerTurns: [],
              runs: [],
              attempts: [],
              nodes: [],
              subagents: [],
              messages: [],
              turnItems: [],
            } as unknown as OrchestrationV2ThreadProjection);
          },
        }),
        Layer.mock(EventSink.EventSinkV2)({}),
        IdAllocator.layer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
          runRecoveryOnce: Effect.succeed(false),
        }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          cancelUnsettled: () => Effect.succeed([]),
          signalCancellations: () => Effect.void,
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).recover;
    assert.deepEqual(
      projectionReads.mock.calls.map(([threadId]) => threadId),
      [recoveryThreadId],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("expires orphaned runtime requests before command readiness", () => {
  const threadId = ThreadId.make("thread_recovery_requests");
  let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
    null;
  const committed = vi.fn(
    (input: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0]) => {
      committedInput = input;
      return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
    },
  );
  const projection = {
    thread: { id: threadId },
    runtimeRequests: [
      {
        id: RuntimeRequestId.make("request_orphaned"),
        nodeId: NodeId.make("node_orphaned"),
        status: "pending",
        responseCapability: { type: "not_resumable", reason: "old process" },
      },
    ],
    providerSessions: [],
    providerThreads: [],
    runs: [],
    nodes: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: (kind) => Effect.succeed(kind === "runtime" ? [threadId] : []),
          getRuntimeRecoveryProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(EventSink.EventSinkV2)({ commitCommand: committed }),
        IdAllocator.layer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
          runRecoveryOnce: Effect.succeed(false),
        }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).recover;
    const command = committedInput;
    assert.isNotNull(command);
    if (command === null) return;
    assert.equal(command?.events[0]?.type, "runtime-request.updated");
    if (command?.events[0]?.type === "runtime-request.updated") {
      assert.equal(command.events[0].payload.status, "expired");
      assert.equal(command.events[0].payload.responseCapability.type, "not_resumable");
    }
  }).pipe(Effect.provide(layer));
});

it.effect("preserves async questions across startup and shutdown", () => {
  const threadId = ThreadId.make("async-recovery-thread");
  const nodeId = NodeId.make("async-recovery-node");
  const projection = {
    thread: { id: threadId },
    runtimeRequests: [
      {
        id: RuntimeRequestId.make("async-recovery-request"),
        nodeId,
        status: "pending",
        responseCapability: { type: "message" },
      },
    ],
    providerSessions: [],
    providerThreads: [],
    runs: [],
    nodes: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const commitCommand = vi.fn(() => Effect.die("an async question needs no process-loss write"));
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: (kind) => Effect.succeed(kind === "runtime" ? [threadId] : []),
          getRuntimeRecoveryProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(EventSink.EventSinkV2)({ commitCommand }),
        IdAllocator.layer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
          runRecoveryOnce: Effect.succeed(false),
        }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          cancelUnsettled: () => Effect.succeed([]),
          signalCancellations: () => Effect.void,
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
    assert.equal((yield* recovery.reconcile("startup")).closedRequests, 0);
    assert.equal((yield* recovery.reconcile("startup")).closedRequests, 0);
    assert.isFalse(commitCommand.mock.calls.length > 0);
  }).pipe(Effect.provide(layer));
});

it.effect("uses the same reconciliation path to cancel runtime requests during shutdown", () => {
  const threadId = ThreadId.make("thread_shutdown_requests");
  let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
    null;
  const projection = {
    thread: { id: threadId },
    runtimeRequests: [
      {
        id: RuntimeRequestId.make("request_shutdown"),
        nodeId: NodeId.make("node_shutdown"),
        status: "pending",
        responseCapability: { type: "live" },
      },
    ],
    providerSessions: [],
    providerThreads: [],
    runs: [],
    nodes: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: (kind) => Effect.succeed(kind === "runtime" ? [threadId] : []),
          getRuntimeRecoveryProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          commitCommand: (input) => {
            committedInput = input;
            return Effect.succeed({ committed: true, cancelledEffectCount: 1 } as never);
          },
        }),
        IdAllocator.layer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
          runRecoveryOnce: Effect.succeed(false),
        }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const summary =
      yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("shutdown");
    assert.equal(summary.closedRequests, 1);
    assert.equal(summary.retiredEffects, 1);
    const requestEvent = committedInput?.events[0];
    assert.equal(requestEvent?.type, "runtime-request.updated");
    if (requestEvent?.type === "runtime-request.updated") {
      assert.equal(requestEvent.payload.status, "cancelled");
      assert.equal(requestEvent.payload.responseCapability.type, "not_resumable");
      if (requestEvent.payload.responseCapability.type === "not_resumable") {
        assert.match(requestEvent.payload.responseCapability.reason, /shut down/);
      }
    }
  }).pipe(Effect.provide(layer));
});

it.effect(
  "preserves a replayable waiting run while cancelling its process-bound background work",
  () => {
    const threadId = ThreadId.make("thread_waiting_checkpoint");
    const runId = RunId.make("run_waiting_checkpoint");
    const providerThreadId = ProviderThreadId.make("provider_thread_waiting_checkpoint");
    const providerInstanceId = ProviderInstanceId.make("claude");
    const backgroundItemId = TurnItemId.make("turn_item_waiting_checkpoint");
    let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
      null;
    const projection = {
      thread: { id: threadId },
      runtimeRequests: [],
      providerSessions: [],
      providerThreads: [
        {
          id: providerThreadId,
          driver: ProviderDriverKind.make("claude"),
          providerInstanceId,
          status: "idle",
          pendingBackgroundTasks: [
            { taskId: String(backgroundItemId), description: "Finish background task" },
          ],
        },
      ],
      runs: [{ id: runId, status: "waiting", providerInstanceId, providerThreadId }],
      attempts: [],
      nodes: [],
      subagents: [],
      messages: [],
      turnItems: [
        {
          id: backgroundItemId,
          runId,
          nodeId: null,
          providerThreadId,
          type: "command_execution",
          status: "running",
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const layer = ProviderRuntimeRecovery.layer.pipe(
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: (kind) => Effect.succeed(kind === "runtime" ? [threadId] : []),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) => {
              committedInput = input;
              return Effect.succeed({
                committed: true,
                cancelledEffectCount: 0,
              } as never);
            },
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            listByCommandId: () =>
              Effect.succeed([
                {
                  request: { type: "checkpoint.capture", runId },
                  status: "running",
                },
              ] as never),
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 1, cancelled: 0 }),
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const summary =
        yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
      assert.equal(summary.terminalizedRuns, 0);
      assert.equal(summary.requeuedEffects, 1);

      const command = committedInput;
      assert.isNotNull(command);
      if (command === null) return;
      // The run stays waiting for its checkpoint; it only records the work
      // the restart cancelled so the next provider turn can be told.
      assert.isFalse(command.events.some((event) => event.type === "run.updated"));
      const recorded = command.events.flatMap((event) =>
        event.type === "run.background-work-cancelled" ? [event.payload] : [],
      );
      // The roster entry is the same task as the item, so it is listed once.
      assert.deepEqual(
        recorded.map((entry) => ({
          runId: entry.runId,
          kinds: entry.restartCancelledBackgroundWork.map((work) => work.kind),
        })),
        [{ runId, kinds: ["shell"] }],
      );
      assert.isTrue(
        command.events.some(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.id === backgroundItemId &&
            event.payload.status === "cancelled",
        ),
      );
      assert.isTrue(
        command.events.some(
          (event) =>
            event.type === "provider-thread.updated" &&
            event.payload.id === providerThreadId &&
            event.payload.pendingBackgroundTasks?.length === 0,
        ),
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "records cancelled work on the provider thread that lost it after a provider switch",
  () => {
    const threadId = ThreadId.make("thread_switch_note");
    const claudeRunId = RunId.make("run_switch_note_claude");
    const codexRunId = RunId.make("run_switch_note_codex");
    const claudeThreadId = ProviderThreadId.make("provider_thread_switch_note_claude");
    const codexThreadId = ProviderThreadId.make("provider_thread_switch_note_codex");
    const claude = ProviderInstanceId.make("claude");
    const codex = ProviderInstanceId.make("codex");
    let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
      null;
    // Claude launched a background subagent, then the thread switched to Codex.
    const projection = {
      thread: { id: threadId },
      runtimeRequests: [],
      providerSessions: [],
      providerThreads: [
        {
          id: claudeThreadId,
          ownerNodeId: null,
          driver: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claude,
          status: "idle",
          pendingBackgroundTasks: [{ taskId: "task-claude", description: "Watch the build" }],
        },
        {
          id: codexThreadId,
          ownerNodeId: null,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: codex,
          status: "idle",
        },
      ],
      providerTurns: [],
      runs: [
        {
          id: claudeRunId,
          ordinal: 1,
          status: "completed",
          providerInstanceId: claude,
          providerThreadId: claudeThreadId,
        },
        {
          id: codexRunId,
          ordinal: 2,
          status: "completed",
          providerInstanceId: codex,
          providerThreadId: codexThreadId,
        },
      ],
      attempts: [],
      nodes: [],
      subagents: [],
      messages: [],
      turnItems: [
        {
          id: TurnItemId.make("turn_item_switch_note_subagent"),
          runId: claudeRunId,
          nodeId: null,
          providerThreadId: claudeThreadId,
          nativeItemRef: null,
          type: "subagent",
          title: "Background subagent",
          status: "running",
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const layer = ProviderRuntimeRecovery.layer.pipe(
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: (kind) => Effect.succeed(kind === "runtime" ? [threadId] : []),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) => {
              committedInput = input;
              return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
            },
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
      const recorded = (committedInput?.events ?? []).flatMap((event) =>
        event.type === "run.background-work-cancelled" ? [event.payload] : [],
      );
      // The Codex run is later, but only Claude's turns may be told about it.
      assert.deepEqual(
        recorded.map((entry) => ({
          runId: entry.runId,
          kinds: entry.restartCancelledBackgroundWork.map((work) => work.kind),
        })),
        [{ runId: claudeRunId, kinds: ["subagent", "task"] }],
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect("cancels a stale waiting run when no checkpoint capture can finish it", () => {
  const threadId = ThreadId.make("thread_stale_waiting");
  const runId = RunId.make("run_stale_waiting");
  let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
    null;
  const projection = {
    thread: { id: threadId },
    runtimeRequests: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runs: [
      {
        id: runId,
        status: "waiting",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
    ],
    attempts: [],
    nodes: [],
    subagents: [],
    messages: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: (kind) => Effect.succeed(kind === "runtime" ? [threadId] : []),
          getRuntimeRecoveryProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          commitCommand: (input) => {
            committedInput = input;
            return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
          },
        }),
        IdAllocator.layer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
          runRecoveryOnce: Effect.succeed(false),
        }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          listByCommandId: () => Effect.succeed([]),
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const summary =
      yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
    assert.equal(summary.terminalizedRuns, 1);
    const runEvent = committedInput?.events.find((event) => event.type === "run.updated");
    assert.equal(runEvent?.type === "run.updated" ? runEvent.payload.status : null, "cancelled");
  }).pipe(Effect.provide(layer));
});

it.effect("closes a secret request card's form when its run is recovered", () => {
  const threadId = ThreadId.make("thread_secret_recovery");
  const runId = RunId.make("run_secret_recovery");
  let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
    null;
  const projection = {
    thread: { id: threadId },
    runtimeRequests: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runs: [{ id: runId, status: "running", providerInstanceId: ProviderInstanceId.make("codex") }],
    attempts: [],
    nodes: [],
    subagents: [],
    messages: [],
    turnItems: [
      {
        id: "turn-item:secret-request:recovery",
        threadId,
        runId,
        nodeId: null,
        type: "secret_request",
        status: "waiting",
        secretStatus: "pending",
        label: "GitHub token",
        reason: "Used as GH_TOKEN.",
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: (kind) => Effect.succeed(kind === "runtime" ? [threadId] : []),
          getRuntimeRecoveryProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          commitCommand: (input) => {
            committedInput = input;
            return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
          },
        }),
        IdAllocator.layer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
          runRecoveryOnce: Effect.succeed(false),
        }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          listByCommandId: () => Effect.succeed([]),
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
    const itemEvent = committedInput?.events.find((event) => event.type === "turn-item.updated");
    const card = itemEvent?.type === "turn-item.updated" ? itemEvent.payload : null;
    assert.equal(card?.status, "cancelled");
    assert.equal(card?.type === "secret_request" ? card.secretStatus : null, "cancelled");
  }).pipe(Effect.provide(layer));
});

it.effect("holds accepted queued work without cancelling its execution state after restart", () => {
  const threadId = ThreadId.make("thread_queued_restart");
  const runId = RunId.make("run_queued_restart");
  const attemptId = RunAttemptId.make("attempt_queued_restart");
  const rootNodeId = NodeId.make("node_queued_restart");
  let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
    null;
  const projection = {
    thread: { id: threadId },
    runtimeRequests: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runs: [
      {
        id: runId,
        status: "queued",
        queuePosition: 1,
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
    ],
    attempts: [
      {
        id: attemptId,
        runId,
        rootNodeId,
        status: "pending",
      },
    ],
    nodes: [
      {
        id: rootNodeId,
        runId,
        status: "pending",
      },
    ],
    subagents: [],
    messages: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: (kind) => Effect.succeed(kind === "runtime" ? [threadId] : []),
          getRuntimeRecoveryProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          commitCommand: (input) => {
            committedInput = input;
            return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
          },
        }),
        IdAllocator.layer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
          runRecoveryOnce: Effect.succeed(false),
        }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const summary =
      yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
    assert.equal(summary.terminalizedRuns, 0);
    const command = committedInput;
    assert.isNotNull(command);
    if (command === null) return;
    const runEvent = command.events.find((event) => event.type === "run.updated");
    const attemptEvent = command.events.find((event) => event.type === "run-attempt.updated");
    const nodeEvent = command.events.find((event) => event.type === "node.updated");
    assert.equal(runEvent?.type === "run.updated" ? runEvent.payload.status : null, "queued");
    assert.equal(runEvent?.type === "run.updated" ? runEvent.payload.queuePosition : null, 1);
    assert.equal(runEvent?.type === "run.updated" ? runEvent.payload.queueHeld : false, true);
    assert.isUndefined(attemptEvent);
    assert.isUndefined(nodeEvent);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "cancels the complete in-flight subtree and stops its persisted session without reopening it",
  () => {
    const threadId = ThreadId.make("thread_recovery_cancel");
    const runId = RunId.make("run_recovery_cancel");
    const attemptId = RunAttemptId.make("attempt_recovery_cancel");
    const rootNodeId = NodeId.make("node_recovery_cancel");
    const providerThreadId = ProviderThreadId.make("provider_thread_recovery_cancel");
    const providerTurnId = ProviderTurnId.make("provider_turn_recovery_cancel");
    const providerSessionId = ProviderSessionId.make("provider_session_recovery_cancel");
    let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
      null;
    const projection = {
      thread: { id: threadId },
      runtimeRequests: [],
      providerSessions: [
        {
          id: providerSessionId,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          status: "ready",
        },
      ],
      providerThreads: [
        {
          id: providerThreadId,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          status: "active",
        },
      ],
      providerTurns: [
        {
          id: providerTurnId,
          runAttemptId: attemptId,
          nodeId: rootNodeId,
          status: "running",
        },
      ],
      runs: [
        {
          id: runId,
          status: "starting",
          providerThreadId,
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
      ],
      attempts: [
        {
          id: attemptId,
          runId,
          rootNodeId,
          status: "running",
        },
      ],
      nodes: [{ id: rootNodeId, runId, status: "running" }],
      subagents: [],
      messages: [{ id: MessageId.make("message_recovery_cancel"), runId, streaming: true }],
      turnItems: [
        {
          id: TurnItemId.make("turn_item_recovery_cancel"),
          runId,
          nodeId: rootNodeId,
          status: "running",
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const layer = ProviderRuntimeRecovery.layer.pipe(
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: (kind) => Effect.succeed(kind === "runtime" ? [threadId] : []),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) => {
              committedInput = input;
              return Effect.succeed({ committed: true, cancelledEffectCount: 2 } as never);
            },
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const summary = yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService)
        .recover;
      assert.equal(summary.terminalizedRuns, 1);
      assert.equal(summary.stoppedSessions, 1);
      assert.equal(summary.retiredEffects, 2);
      assert.deepEqual(committedInput?.cancelUnsettledEffects?.effectTypes, [
        "provider-turn.start",
        "provider-turn.interrupt",
        "provider-turn.steer",
        "provider-turn.restart",
        "runtime-request.respond",
      ]);
      const events = committedInput?.events ?? [];
      assert.deepEqual(
        events.map((event) => [
          event.type,
          "status" in event.payload ? event.payload.status : null,
        ]),
        [
          ["run.updated", "cancelled"],
          ["run-attempt.updated", "cancelled"],
          ["node.updated", "cancelled"],
          ["provider-turn.updated", "cancelled"],
          ["message.updated", null],
          ["turn-item.updated", "cancelled"],
          ["provider-thread.updated", "idle"],
          ["provider-session.updated", "stopped"],
        ],
      );
      const messageEvent = events.find((event) => event.type === "message.updated");
      assert.isFalse(messageEvent?.type === "message.updated" && messageEvent.payload.streaming);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "clears persisted pendingBackgroundTasks and terminalizes stale background items on settled runs",
  () => {
    const threadId = ThreadId.make("thread_recovery_background");
    const settledRunId = RunId.make("run_recovery_background_settled");
    const activeRunId = RunId.make("run_recovery_background_active");
    const activeAttemptId = RunAttemptId.make("attempt_recovery_background_active");
    const activeRootNodeId = NodeId.make("node_recovery_background_active");
    const idleProviderThreadId = ProviderThreadId.make("provider_thread_recovery_background_idle");
    const activeProviderThreadId = ProviderThreadId.make(
      "provider_thread_recovery_background_active",
    );
    const secondaryProviderThreadId = ProviderThreadId.make(
      "provider_thread_recovery_background_secondary",
    );
    const providerSessionId = ProviderSessionId.make("provider_session_recovery_background");
    const settledStaleItemId = TurnItemId.make("turn_item_recovery_background_stale");
    const activeRunItemId = TurnItemId.make("turn_item_recovery_background_active");
    const nullRunCommandItemId = TurnItemId.make("turn_item_recovery_background_null_run");
    const nullRunSubagentItemId = TurnItemId.make("turn_item_recovery_background_null_subagent");
    const claudeInstanceId = ProviderInstanceId.make("claude");
    const secondaryInstanceId = ProviderInstanceId.make("claude-secondary");
    const subagentInstanceId = ProviderInstanceId.make("claude-subagent");
    let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
      null;
    const projection = {
      thread: { id: threadId },
      runtimeRequests: [],
      providerSessions: [
        {
          id: providerSessionId,
          driver: ProviderDriverKind.make("claude"),
          providerInstanceId: claudeInstanceId,
          status: "ready",
        },
      ],
      providerThreads: [
        {
          id: idleProviderThreadId,
          driver: ProviderDriverKind.make("claude"),
          // Index-0 is intentionally a different instance so misattribution
          // to providerThreads[0] fails the assertions below.
          providerInstanceId: claudeInstanceId,
          status: "idle",
          pendingBackgroundTasks: [{ taskId: "bg-settled", description: "sleep 30" }],
        },
        {
          id: activeProviderThreadId,
          driver: ProviderDriverKind.make("claude"),
          providerInstanceId: claudeInstanceId,
          status: "active",
          pendingBackgroundTasks: [{ taskId: "bg-active", description: "npm test" }],
        },
        {
          id: secondaryProviderThreadId,
          driver: ProviderDriverKind.make("claude"),
          providerInstanceId: secondaryInstanceId,
          status: "idle",
          pendingBackgroundTasks: [],
        },
      ],
      providerTurns: [],
      runs: [
        {
          id: settledRunId,
          status: "completed",
          providerInstanceId: claudeInstanceId,
        },
        {
          id: activeRunId,
          status: "running",
          providerInstanceId: claudeInstanceId,
        },
      ],
      attempts: [
        {
          id: activeAttemptId,
          runId: activeRunId,
          rootNodeId: activeRootNodeId,
          status: "running",
        },
      ],
      nodes: [{ id: activeRootNodeId, runId: activeRunId, status: "running" }],
      subagents: [],
      messages: [],
      turnItems: [
        {
          id: settledStaleItemId,
          runId: settledRunId,
          nodeId: null,
          providerThreadId: idleProviderThreadId,
          type: "command_execution",
          status: "running",
        },
        {
          id: activeRunItemId,
          runId: activeRunId,
          nodeId: activeRootNodeId,
          providerThreadId: activeProviderThreadId,
          type: "dynamic_tool",
          status: "running",
        },
        {
          // Missing run: must attribute via providerThreadId, not index 0.
          id: nullRunCommandItemId,
          runId: null,
          nodeId: null,
          providerThreadId: secondaryProviderThreadId,
          type: "command_execution",
          status: "running",
        },
        {
          // Missing run with a real matching provider thread whose instance
          // differs from the subagent's own: own providerInstanceId must win.
          id: nullRunSubagentItemId,
          runId: null,
          nodeId: null,
          providerThreadId: secondaryProviderThreadId,
          type: "subagent",
          status: "running",
          providerInstanceId: subagentInstanceId,
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const layer = ProviderRuntimeRecovery.layer.pipe(
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: (kind) => Effect.succeed(kind === "runtime" ? [threadId] : []),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) => {
              committedInput = input;
              return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
            },
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            listByCommandId: () => Effect.succeed([]),
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const summary =
        yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
      assert.equal(summary.terminalizedRuns, 1);
      const events = committedInput?.events ?? [];

      const turnItemCancels = events.filter(
        (event) => event.type === "turn-item.updated" && event.payload.status === "cancelled",
      );
      // Active-run item + settled-run stale + null-run command + null-run subagent.
      assert.equal(turnItemCancels.length, 4);
      assert.deepEqual(
        turnItemCancels
          .map((event) => event.type === "turn-item.updated" && event.payload.id)
          .sort(),
        [activeRunItemId, nullRunCommandItemId, nullRunSubagentItemId, settledStaleItemId].sort(),
      );

      const cancelById = (id: TurnItemId) =>
        turnItemCancels.find(
          (event) => event.type === "turn-item.updated" && event.payload.id === id,
        );
      assert.equal(cancelById(nullRunCommandItemId)?.providerInstanceId, secondaryInstanceId);
      // Subagent own instance wins over the matching thread's secondary instance.
      assert.notEqual(subagentInstanceId, secondaryInstanceId);
      assert.equal(cancelById(nullRunSubagentItemId)?.providerInstanceId, subagentInstanceId);
      // Settled-run item still prefers the run's provider instance when present.
      assert.equal(cancelById(settledStaleItemId)?.providerInstanceId, claudeInstanceId);

      const providerThreadEvents = events.filter(
        (event) => event.type === "provider-thread.updated",
      );
      // Only threads with active status or nonempty rosters are rewritten.
      assert.equal(providerThreadEvents.length, 2);
      for (const event of providerThreadEvents) {
        if (event.type !== "provider-thread.updated") continue;
        assert.deepEqual(event.payload.pendingBackgroundTasks ?? [], []);
      }
      const idleThreadEvent = providerThreadEvents.find(
        (event) =>
          event.type === "provider-thread.updated" && event.payload.id === idleProviderThreadId,
      );
      assert.equal(
        idleThreadEvent?.type === "provider-thread.updated" ? idleThreadEvent.payload.status : null,
        "idle",
      );
      const activeThreadEvent = providerThreadEvents.find(
        (event) =>
          event.type === "provider-thread.updated" && event.payload.id === activeProviderThreadId,
      );
      assert.equal(
        activeThreadEvent?.type === "provider-thread.updated"
          ? activeThreadEvent.payload.status
          : null,
        "idle",
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "terminalizes a leftover nonpersistent dynamic_tool on a settled run after process loss",
  () => {
    const threadId = ThreadId.make("thread_recovery_orphan_wait");
    const settledRunId = RunId.make("run_recovery_orphan_wait_settled");
    const providerThreadId = ProviderThreadId.make("provider_thread_recovery_orphan_wait");
    const orphanWaitItemId = TurnItemId.make(
      "turn-item:provider:codex:native-item:exec-4669f3bb-78c9-4af1-b44e-daa340d2c538",
    );
    const persistentMonitorItemId = TurnItemId.make(
      "turn-item:provider:codex:native-item:exec-persistent-monitor",
    );
    const orphanWaitNodeId = NodeId.make("node_recovery_orphan_wait");
    const persistentMonitorNodeId = NodeId.make("node_recovery_persistent_monitor");
    const codexInstanceId = ProviderInstanceId.make("codex");
    let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
      null;
    const projection = {
      thread: { id: threadId, providerInstanceId: codexInstanceId },
      runtimeRequests: [],
      providerSessions: [],
      providerThreads: [
        {
          id: providerThreadId,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          status: "idle",
          pendingBackgroundTasks: [],
        },
      ],
      providerTurns: [],
      runs: [{ id: settledRunId, status: "completed", providerInstanceId: codexInstanceId }],
      attempts: [],
      nodes: [
        { id: orphanWaitNodeId, runId: settledRunId, status: "running", kind: "tool_call" },
        {
          id: persistentMonitorNodeId,
          runId: settledRunId,
          status: "running",
          kind: "tool_call",
        },
      ],
      subagents: [],
      messages: [],
      turnItems: [
        {
          id: orphanWaitItemId,
          runId: settledRunId,
          nodeId: orphanWaitNodeId,
          providerThreadId,
          type: "dynamic_tool",
          status: "running",
          toolName: "t3-code.t3_thread_wait",
          input: {
            threadId:
              "thread:delegated-task:command%3Amcp%3Aaafffab1-e811-458a-ae83-558e542c61ff%3Adelegate-task%3Areview-mobile-reconnect-opus-20260815",
            timeoutMs: 30000,
          },
        },
        {
          id: persistentMonitorItemId,
          runId: settledRunId,
          nodeId: persistentMonitorNodeId,
          providerThreadId,
          type: "dynamic_tool",
          status: "running",
          toolName: "grok.monitor",
          input: { persistent: true, command: "tail -f" },
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const layer = ProviderRuntimeRecovery.layer.pipe(
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: (kind) => Effect.succeed(kind === "runtime" ? [threadId] : []),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) => {
              committedInput = input;
              return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
            },
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            listByCommandId: () => Effect.succeed([]),
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const summary =
        yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
      assert.equal(summary.terminalizedRuns, 0);
      const turnItemCancels = (committedInput?.events ?? []).filter(
        (event) => event.type === "turn-item.updated" && event.payload.status === "cancelled",
      );
      // Process loss means the provider is gone, so even a persistent monitor
      // cannot still be alive. The leftover wait and the monitor both close.
      assert.equal(turnItemCancels.length, 2);
      assert.deepEqual(
        turnItemCancels
          .map((event) => event.type === "turn-item.updated" && event.payload.id)
          .sort(),
        [orphanWaitItemId, persistentMonitorItemId].sort(),
      );
      const nodeCancels = (committedInput?.events ?? []).filter(
        (event) => event.type === "node.updated" && event.payload.status === "cancelled",
      );
      assert.equal(nodeCancels.length, 2);
      assert.deepEqual(
        nodeCancels.map((event) => event.type === "node.updated" && event.payload.id).sort(),
        [orphanWaitNodeId, persistentMonitorNodeId].sort(),
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "terminalizes the linked subagent and node for a stale subagent item on a settled run",
  () => {
    const threadId = ThreadId.make("thread_recovery_subagent");
    const settledRunId = RunId.make("run_recovery_subagent_settled");
    const providerThreadId = ProviderThreadId.make("provider_thread_recovery_subagent");
    const staleSubagentNodeId = NodeId.make("node_recovery_subagent_stale");
    const doneSubagentNodeId = NodeId.make("node_recovery_subagent_done");
    const staleItemId = TurnItemId.make("turn_item_recovery_subagent_stale");
    const doneItemId = TurnItemId.make("turn_item_recovery_subagent_done");
    const claudeInstanceId = ProviderInstanceId.make("claude");
    let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
      null;
    const projection = {
      thread: { id: threadId },
      runtimeRequests: [],
      providerSessions: [],
      providerThreads: [
        {
          id: providerThreadId,
          driver: ProviderDriverKind.make("claude"),
          providerInstanceId: claudeInstanceId,
          status: "idle",
          pendingBackgroundTasks: [],
        },
      ],
      providerTurns: [],
      // Settled run: the stale-item loop owns it, not the nonterminal loop.
      runs: [{ id: settledRunId, status: "completed", providerInstanceId: claudeInstanceId }],
      attempts: [],
      nodes: [
        { id: staleSubagentNodeId, runId: settledRunId, status: "running" },
        { id: doneSubagentNodeId, runId: settledRunId, status: "completed" },
      ],
      subagents: [
        {
          id: staleSubagentNodeId,
          runId: settledRunId,
          driver: ProviderDriverKind.make("claude"),
          providerInstanceId: claudeInstanceId,
          status: "running",
        },
        {
          // Already finished with a real result: must never be overwritten.
          id: doneSubagentNodeId,
          runId: settledRunId,
          driver: ProviderDriverKind.make("claude"),
          providerInstanceId: claudeInstanceId,
          status: "completed",
          result: "done",
        },
      ],
      messages: [],
      turnItems: [
        {
          id: staleItemId,
          runId: settledRunId,
          nodeId: staleSubagentNodeId,
          providerThreadId,
          type: "subagent",
          status: "running",
          subagentId: staleSubagentNodeId,
          providerInstanceId: claudeInstanceId,
        },
        {
          id: doneItemId,
          runId: settledRunId,
          nodeId: doneSubagentNodeId,
          providerThreadId,
          type: "subagent",
          status: "completed",
          subagentId: doneSubagentNodeId,
          providerInstanceId: claudeInstanceId,
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const layer = ProviderRuntimeRecovery.layer.pipe(
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: (kind) => Effect.succeed(kind === "runtime" ? [threadId] : []),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) => {
              committedInput = input;
              return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
            },
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            listByCommandId: () => Effect.succeed([]),
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
      const events = committedInput?.events ?? [];

      // Only the nonterminal subagent item is cancelled.
      const turnItemCancels = events.filter(
        (event) => event.type === "turn-item.updated" && event.payload.status === "cancelled",
      );
      assert.equal(turnItemCancels.length, 1);

      // The linked subagent entity is terminalized alongside its turn item.
      const subagentCancels = events.filter((event) => event.type === "subagent.updated");
      assert.equal(subagentCancels.length, 1);
      const subagentCancel = subagentCancels[0];
      assert.equal(
        subagentCancel?.type === "subagent.updated" ? subagentCancel.payload.id : null,
        staleSubagentNodeId,
      );
      assert.equal(
        subagentCancel?.type === "subagent.updated" ? subagentCancel.payload.status : null,
        "cancelled",
      );

      // So is its execution node, which no live process can terminalize.
      const nodeCancels = events.filter((event) => event.type === "node.updated");
      assert.equal(nodeCancels.length, 1);
      const nodeCancel = nodeCancels[0];
      assert.equal(
        nodeCancel?.type === "node.updated" ? nodeCancel.payload.id : null,
        staleSubagentNodeId,
      );

      // The already-completed subagent and node are left untouched.
      assert.isFalse(
        events.some(
          (event) => event.type === "subagent.updated" && event.payload.id === doneSubagentNodeId,
        ),
      );
      assert.isFalse(
        events.some(
          (event) => event.type === "node.updated" && event.payload.id === doneSubagentNodeId,
        ),
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect("leaves delegated tasks to their own child threads after process loss", () => {
  const threadId = ThreadId.make("thread_recovery_delegation");
  const settledRunId = RunId.make("run_recovery_delegation_settled");
  const runningRunId = RunId.make("run_recovery_delegation_running");
  const providerThreadId = ProviderThreadId.make("provider_thread_recovery_delegation");
  const claudeInstanceId = ProviderInstanceId.make("claude");
  const driver = ProviderDriverKind.make("claude");
  const settledTaskId = NodeId.make("node_recovery_delegation_settled");
  const runningTaskId = NodeId.make("node_recovery_delegation_running");
  const nativeSubagentId = NodeId.make("node_recovery_native_subagent");
  const delegatedTask = (id: NodeId, runId: RunId) => ({
    id,
    runId,
    origin: "app_owned",
    childThreadId: ThreadId.make(`thread:delegated-task:${id}`),
    driver,
    providerInstanceId: claudeInstanceId,
    status: "running",
  });
  const subagentItem = (subagentId: NodeId, runId: RunId, origin: string) => ({
    id: TurnItemId.make(`turn_item:${subagentId}`),
    runId,
    nodeId: subagentId,
    providerThreadId,
    type: "subagent",
    status: "running",
    subagentId,
    origin,
    childThreadId:
      origin === "app_owned" ? ThreadId.make(`thread:delegated-task:${subagentId}`) : null,
    providerInstanceId: claudeInstanceId,
    title: `subagent ${subagentId}`,
  });
  let committedInput: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | null =
    null;
  const projection = {
    thread: { id: threadId, providerInstanceId: claudeInstanceId },
    runtimeRequests: [],
    providerSessions: [],
    providerThreads: [
      {
        id: providerThreadId,
        driver,
        providerInstanceId: claudeInstanceId,
        ownerNodeId: null,
        status: "idle",
        pendingBackgroundTasks: [],
      },
    ],
    providerTurns: [],
    runs: [
      {
        id: settledRunId,
        ordinal: 1,
        status: "completed",
        providerThreadId,
        providerInstanceId: claudeInstanceId,
      },
      {
        id: runningRunId,
        ordinal: 2,
        status: "running",
        providerThreadId,
        providerInstanceId: claudeInstanceId,
      },
    ],
    attempts: [],
    nodes: [
      { id: settledTaskId, runId: settledRunId, status: "running", kind: "subagent" },
      { id: runningTaskId, runId: runningRunId, status: "running", kind: "subagent" },
      { id: nativeSubagentId, runId: settledRunId, status: "running", kind: "subagent" },
    ],
    subagents: [
      delegatedTask(settledTaskId, settledRunId),
      delegatedTask(runningTaskId, runningRunId),
      {
        ...delegatedTask(nativeSubagentId, settledRunId),
        origin: "provider_native",
        childThreadId: null,
      },
    ],
    messages: [],
    turnItems: [
      subagentItem(settledTaskId, settledRunId, "app_owned"),
      subagentItem(runningTaskId, runningRunId, "app_owned"),
      subagentItem(nativeSubagentId, settledRunId, "provider_native"),
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRecoveryThreadIds: (kind) => Effect.succeed(kind === "runtime" ? [threadId] : []),
          getRuntimeRecoveryProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          commitCommand: (input) => {
            committedInput = input;
            return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
          },
        }),
        IdAllocator.layer,
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
          runRecoveryOnce: Effect.succeed(false),
        }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          listByCommandId: () => Effect.succeed([]),
          reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
    const events = committedInput?.events ?? [];
    const touched = events.flatMap((event) =>
      event.type === "turn-item.updated"
        ? event.payload.type === "subagent"
          ? [event.payload.subagentId]
          : []
        : event.type === "subagent.updated" || event.type === "node.updated"
          ? [event.payload.id]
          : [],
    );
    // The cut run itself is cancelled; only the provider-native subagent dies with it.
    assert.isTrue(
      events.some(
        (event) =>
          event.type === "run.updated" &&
          event.payload.id === runningRunId &&
          event.payload.status === "cancelled",
      ),
    );
    assert.notInclude(touched, settledTaskId);
    assert.notInclude(touched, runningTaskId);
    assert.include(touched, nativeSubagentId);
    // The note lists only provider-native work: delegated tasks report back on their own.
    const noted = events.flatMap((event) =>
      event.type === "run.background-work-cancelled"
        ? event.payload.restartCancelledBackgroundWork.map((work) => work.label)
        : [],
    );
    assert.deepEqual(noted, [`subagent ${nativeSubagentId}`]);
  }).pipe(Effect.provide(layer));
});

it.effect.each([false, true])(
  "reconciles unfinished recovery receipts at startup (superseded=%s)",
  (superseded) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:restart-recovery-receipt");
      const runId = RunId.make("run:restart-recovery-receipt");
      const attemptId = RunAttemptId.make("attempt:restart-recovery-receipt");
      const projection = {
        thread: {
          id: threadId,
          recovery: {
            runId,
            attemptId,
            status: "recovering",
            detail: "Reconciliation pending",
            updatedAt: now,
          },
        },
        runs: [
          {
            id: runId,
            activeAttemptId: attemptId,
            ordinal: 1,
            startedAt: now,
            status: "cancelled",
          },
          ...(superseded
            ? [{ id: RunId.make("run:newer"), ordinal: 2, startedAt: now, status: "completed" }]
            : []),
        ],
        runtimeRequests: [],
        providerSessions: [],
        providerThreads: [],
        providerTurns: [],
        attempts: [],
        nodes: [],
        subagents: [],
        messages: [],
        turnItems: [],
      } as unknown as OrchestrationV2ThreadProjection;
      let updated: OrchestrationV2ThreadProjection["thread"] | undefined;
      const layer = ProviderRuntimeRecovery.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ServerSettings.layerTest(),
            IdAllocator.layer,
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getRecoveryThreadIds: (kind) => Effect.succeed(kind === "runtime" ? [threadId] : []),
              getRuntimeRecoveryProjection: () => Effect.succeed(projection),
            }),
            Layer.mock(EventSink.EventSinkV2)({
              commitCommand: (input) => {
                const event = input.events.find(
                  (event) => event.type === "thread.metadata-updated",
                );
                if (event?.type === "thread.metadata-updated") updated = event.payload;
                return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
              },
            }),
            Layer.mock(EffectOutbox.EffectOutboxV2)({
              reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
            }),
            Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
              runRecoveryOnce: Effect.succeed(false),
            }),
          ),
        ),
      );
      yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService.pipe(
        Effect.flatMap((service) => service.reconcile("startup")),
        Effect.provide(layer),
      );
      assert.isDefined(updated);
      if (superseded) assert.isUndefined(updated?.recovery);
      else {
        assert.equal(updated?.recovery?.status, "failed");
        assert.equal(updated?.recovery?.runId, runId);
        assert.equal(updated?.recovery?.attemptId, attemptId);
      }
    }),
);
