import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  CommandId,
  NodeId,
  ProjectId,
  MessageId,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadShellSnapshot,
  type TerminalSummary,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessions from "../orchestration-v2/ProviderSessionManager.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import * as Pause from "./EnvironmentPause.ts";
import * as Store from "./EnvironmentPauseStore.ts";

const projectId = ProjectId.make("project-example");
const a = ThreadId.make("thread-a");
const b = ThreadId.make("thread-b");
const c = ThreadId.make("thread-c");
const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const instanceId = ProviderInstanceId.make("provider-example");
const modelSelection = { instanceId, model: "model-example" };
const appThread = (id: ThreadId): OrchestrationV2AppThread => ({
  id,
  projectId,
  title: id,
  createdBy: "user",
  creationSource: "web",
  providerInstanceId: instanceId,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  deletedAt: null,
  settledAt: null,
  settledOverride: null,
  lastVisitedAt: null,
});
const message = (
  id: MessageId,
  runId: RunId,
  threadId = a,
): OrchestrationV2ConversationMessage => ({
  id,
  runId,
  threadId,
  nodeId: null,
  role: "user",
  text: "pause to go offline",
  attachments: [],
  streaming: false,
  createdBy: "user",
  creationSource: "server",
  createdAt: now,
  updatedAt: now,
});
const run = (id: RunId, userMessageId: MessageId, threadId = a): OrchestrationV2Run => ({
  id,
  userMessageId,
  threadId,
  ordinal: 1,
  providerInstanceId: instanceId,
  modelSelection,
  providerThreadId: null,
  rootNodeId: null,
  activeAttemptId: null,
  status: "queued",
  requestedAt: now,
  startedAt: null,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
});
const nativeTurn = (nodeId: NodeId): OrchestrationV2ProviderTurn => ({
  id: ProviderTurnId.make("provider-turn-example"),
  providerThreadId: ProviderThreadId.make("provider-thread-example"),
  nodeId,
  runAttemptId: null,
  nativeTurnRef: {
    driver: ProviderDriverKind.make("codex"),
    nativeId: "native-turn-example",
    strength: "strong",
  },
  ordinal: 1,
  status: "running",
  startedAt: now,
  completedAt: null,
});
const providerStartEffect = (
  commandId: CommandId,
  runId: RunId,
): EffectOutbox.OrchestrationEffectV2 => ({
  id: `effect:${commandId}`,
  commandId,
  threadId: a,
  request: { type: "provider-turn.start", runId },
  status: "pending",
  attemptCount: 0,
  availableAt: DateTime.formatIso(now),
  leaseOwner: null,
  leaseExpiresAt: null,
  createdAt: DateTime.formatIso(now),
  updatedAt: DateTime.formatIso(now),
  completedAt: null,
  lastError: null,
});
const projection = (
  threadId: ThreadId,
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
  runs: ReadonlyArray<OrchestrationV2Run>,
  providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>,
): OrchestrationV2ThreadProjection => ({
  thread: appThread(threadId),
  messages,
  runs,
  providerTurns,
  attempts: [],
  nodes: [],
  subagents: [],
  providerSessions: [],
  providerThreads: [],
  runtimeRequests: [],
  plans: [],
  turnItems: [],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  visibleTurnItems: [],
  updatedAt: now,
});
const shell = (
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
): OrchestrationV2ThreadShellSnapshot => ({
  schemaVersion: 2,
  snapshotSequence: 0,
  threads,
  archivedThreads: [],
});
const thread = (
  id: ThreadId,
  status: OrchestrationV2ThreadShell["status"] = "running",
): OrchestrationV2ThreadShell => ({
  ...appThread(id),
  status,
  activityRunStatus: status === "running" ? "running" : null,
  activeRunId: status === "running" ? RunId.make(`run-${id}`) : null,
  pendingRuntimeRequest: null,
  pendingBackgroundTasks: [],
  latestRunId: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  providerInstanceHistory: [],
  itemCount: 0,
  visibleItemCount: 0,
});

const harness = Effect.gen(function* () {
  const store = yield* Store.EnvironmentPauseStore;
  const receiptStore = yield* Ref.make(store);
  const enabled = yield* Ref.make(true);
  const snapshot = yield* Ref.make(shell([thread(a), thread(b), thread(c, "idle")]));
  const runtimeWork = yield* Ref.make<
    ReadonlyArray<{ providerSessionId: ProviderSessionId; status: "running" | "stopping" }>
  >([]);
  const pending = yield* Ref.make<
    Effect.Success<EffectOutbox.EffectOutboxV2Shape["pendingExecution"]>
  >([]);
  const pendingCleanup = yield* Ref.make<ReadonlyArray<{ threadId: ThreadId }>>([]);
  const deferred = yield* Ref.make<ReadonlyArray<{ threadId: ThreadId; runId: RunId }>>([]);
  const gateObservations = yield* Ref.make<ReadonlyArray<Store.StoredSession["phase"] | null>>([]);
  const effects = yield* Ref.make<ReadonlyArray<EffectOutbox.OrchestrationEffectV2>>([]);
  const messages = yield* Ref.make<ReadonlyArray<OrchestrationV2ConversationMessage>>([]);
  const runs = yield* Ref.make<ReadonlyArray<OrchestrationV2Run>>([]);
  const providerTurns = yield* Ref.make<ReadonlyArray<OrchestrationV2ProviderTurn>>([]);
  const queued = yield* Ref.make(false);
  const recipientStates = yield* Ref.make(new Map<ThreadId, "archived" | "deleted" | "missing">());
  const readFailures = yield* Ref.make(new Set<ThreadId>());
  const terminals = yield* Ref.make<ReadonlyArray<TerminalSummary>>([]);
  const calls = yield* Ref.make<ReadonlyArray<Threads.ThreadManagementSendInput>>([]);
  const failures = yield* Ref.make(new Set<ThreadId>());
  const committedFailures = yield* Ref.make(new Set<ThreadId>());
  const evidenceFailuresAfterCommit = yield* Ref.make(new Set<ThreadId>());
  const outboxEvidenceAfterCommit = yield* Ref.make(new Set<ThreadId>());
  const outboxReadFailed = yield* Ref.make(false);
  const receiptFailures = yield* Ref.make(new Set<ThreadId>());
  const receiptGate = yield* Ref.make<Deferred.Deferred<void> | null>(null);
  const receiptEntered = yield* Deferred.make<void>();
  const observationFailed = yield* Ref.make(false);
  const gate = yield* Ref.make<Deferred.Deferred<void> | null>(null);
  const entered = yield* Deferred.make<void>();
  const layers = Layer.mergeAll(
    Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Ref.get(enabled).pipe(
        Effect.map((value) => ({ ...DEFAULT_SERVER_SETTINGS, environmentPauseEnabled: value })),
      ),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getShellSnapshot: () => Ref.get(snapshot),
      getThreadRecords: (threadId, _fields, filter) =>
        Effect.gen(function* () {
          if ((yield* Ref.get(readFailures)).has(threadId))
            return yield* new ProjectionStore.ProjectionStoreReadError({ threadId });
          const state = (yield* Ref.get(recipientStates)).get(threadId);
          if (state === "missing")
            return yield* new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId });
          const now = yield* DateTime.now;
          return {
            ...projection(
              threadId,
              (yield* Ref.get(messages)).filter(
                (message) =>
                  filter?.messageIds === undefined || filter.messageIds.includes(message.id),
              ),
              yield* Ref.get(runs),
              yield* Ref.get(providerTurns),
            ),
            thread: {
              ...appThread(threadId),
              archivedAt: state === "archived" ? now : null,
              deletedAt: state === "deleted" ? now : null,
            },
          };
        }),
    }),
    Layer.mock(EffectOutbox.EffectOutboxV2)({
      pendingCleanup: Ref.get(pendingCleanup),
      pendingExecution: Ref.get(pending),
      pendingAutomaticRelease: Ref.get(deferred),
      deferredAutomaticExecution: Effect.gen(function* () {
        const currentStore = yield* Ref.get(receiptStore);
        const session = yield* currentStore.get;
        yield* Ref.update(gateObservations, (previous) => [...previous, session?.phase ?? null]);
        return yield* Ref.get(deferred);
      }),
      listByCommandId: (commandId) =>
        Ref.get(outboxReadFailed).pipe(
          Effect.flatMap((failed) =>
            failed
              ? Effect.fail(
                  new EffectOutbox.EffectOutboxError({
                    operation: "list-by-command",
                    cause: "Temporary evidence outage.",
                  }),
                )
              : Ref.get(effects),
          ),
          Effect.map((rows) => rows.filter((row) => row.commandId === commandId)),
        ),
    }),
    Layer.mock(ProviderSessions.ProviderSessionManagerV2)({
      pendingExecution: Effect.gen(function* () {
        if (yield* Ref.get(observationFailed))
          return yield* Effect.fail(
            new ProviderSessions.ProviderSessionActivityError({
              providerSessionId: ProviderSessionId.make("provider-example"),
            }),
          );
        return yield* Ref.get(runtimeWork);
      }),
    }),
    Layer.mock(TerminalManager)({ refreshMetadata: Ref.get(terminals) }),
    Layer.mock(Threads.ThreadManagementService)({
      getProjectThreadRecords: (input, _fields, filter) =>
        Effect.gen(function* () {
          return projection(
            input.threadId,
            (yield* Ref.get(messages)).filter(
              (message) =>
                filter?.messageIds === undefined || filter.messageIds.includes(message.id),
            ),
            yield* Ref.get(runs),
            yield* Ref.get(providerTurns),
          );
        }),
      sendToThread: (input) =>
        Effect.gen(function* () {
          yield* Ref.update(calls, (previous) => [...previous, input]);
          yield* Deferred.succeed(entered, undefined);
          const block = yield* Ref.get(gate);
          if (block !== null) yield* Deferred.await(block);
          if ((yield* Ref.get(failures)).has(input.threadId))
            return yield* new Threads.ThreadManagementThreadArchivedError({
              threadId: input.threadId,
            });
          const isQueued = yield* Ref.get(queued);
          const runId = RunId.make(`queued-${input.messageId}`);
          const submittedMessage = message(input.messageId, runId, input.threadId);
          const submittedRun = {
            ...run(runId, input.messageId, input.threadId),
            ordinal:
              Math.max(
                0,
                ...(yield* Ref.get(runs))
                  .filter((run) => run.threadId === input.threadId)
                  .map((run) => run.ordinal),
              ) + 1,
          };
          yield* Ref.update(messages, (previous) => [...previous, submittedMessage]);
          yield* Ref.update(runs, (previous) => [...previous, submittedRun]);
          if ((yield* Ref.get(committedFailures)).has(input.threadId)) {
            if ((yield* Ref.get(outboxEvidenceAfterCommit)).has(input.threadId)) {
              yield* Ref.update(effects, (rows) => [
                ...rows,
                providerStartEffect(input.commandId, runId),
              ]);
              yield* Ref.update(readFailures, (failed) => new Set([...failed, input.threadId]));
            } else if ((yield* Ref.get(evidenceFailuresAfterCommit)).has(input.threadId)) {
              yield* Ref.update(readFailures, (failed) => new Set([...failed, input.threadId]));
              yield* Ref.set(outboxReadFailed, true);
            }
            return yield* new Threads.ThreadManagementProjectionLoadError({
              projectId: input.projectId,
              threadId: input.threadId,
              cause: "Dispatch committed before its projection reload failed.",
            });
          }
          if (!isQueued) {
            const currentStore = yield* Ref.get(receiptStore);
            yield* currentStore
              .recordDelivery(
                input.messageId,
                !(yield* Ref.get(receiptFailures)).has(input.threadId),
              )
              .pipe(Effect.orDie);
          }
          const acceptanceBlock = yield* Ref.get(receiptGate);
          if (acceptanceBlock !== null) {
            yield* Deferred.succeed(receiptEntered, undefined);
            yield* Deferred.await(acceptanceBlock);
          }
          return {
            dispatch: { sequence: 1, storedEvents: [] },
            projection: projection(input.threadId, [submittedMessage], [submittedRun], []),
            message: submittedMessage,
            run: submittedRun,
            turnItem: null,
            delivery: isQueued ? ("queued" as const) : ("started" as const),
          };
        }),
    }),
  );
  const pause = yield* Pause.EnvironmentPause.pipe(
    Effect.provide(
      Pause.layer.pipe(
        Layer.provide(Layer.merge(layers, Layer.succeed(Store.EnvironmentPauseStore, store))),
      ),
    ),
  );
  return {
    store,
    receiptStore,
    pause,
    enabled,
    snapshot,
    runtimeWork,
    terminals,
    calls,
    failures,
    committedFailures,
    evidenceFailuresAfterCommit,
    outboxEvidenceAfterCommit,
    outboxReadFailed,
    receiptFailures,
    receiptGate,
    receiptEntered,
    observationFailed,
    pending,
    pendingCleanup,
    deferred,
    gateObservations,
    effects,
    messages,
    runs,
    providerTurns,
    queued,
    recipientStates,
    readFailures,
    gate,
    entered,
    layers,
  };
});

const restart = (h: Effect.Success<typeof harness>) =>
  Effect.gen(function* () {
    const store = yield* Store.EnvironmentPauseStore.pipe(Effect.provide(Layer.fresh(Store.layer)));
    yield* Ref.set(h.receiptStore, store);
    const pause = yield* Pause.EnvironmentPause.pipe(
      Effect.provide(
        Pause.layer.pipe(
          Layer.provide(Layer.merge(h.layers, Layer.succeed(Store.EnvironmentPauseStore, store))),
        ),
      ),
    );
    return { store, pause };
  });

it.effect.each(["archive-pending", "provider-running"] as const)(
  "waits for archived %s work without enrolling it as a pause recipient",
  (scenario) =>
    Effect.gen(function* () {
      const h = yield* harness;
      const archived = {
        ...thread(b, scenario === "provider-running" ? "running" : "idle"),
        archivedAt: now,
      };
      yield* Ref.set(h.snapshot, { ...shell([thread(a)]), archivedThreads: [archived] });
      yield* Ref.set(h.failures, new Set([b]));
      if (scenario === "archive-pending")
        yield* Ref.set(h.pending, [{ threadId: b, providerMessage: false }]);
      const started = yield* h.pause.start;
      assert.deepEqual(
        started.session?.targets.map((target) => target.threadId),
        [a],
      );
      assert.deepEqual(
        (yield* Ref.get(h.calls)).map((call) => call.threadId),
        [a],
      );
      yield* Ref.set(h.snapshot, { ...shell([thread(a, "idle")]), archivedThreads: [archived] });
      const waiting = yield* h.pause.retry;
      assert.isFalse(waiting.quiet);
      assert.equal(waiting.activeThreadCount, 1);
      assert.deepEqual(
        waiting.session?.targets.map((target) => target.threadId),
        [a],
      );
      assert.deepEqual(
        (yield* Ref.get(h.calls)).map((call) => call.threadId),
        [a],
      );
      yield* Ref.set(h.pending, []);
      yield* Ref.set(h.snapshot, {
        ...shell([thread(a, "idle")]),
        archivedThreads: [{ ...thread(b, "idle"), archivedAt: now }],
      });
      const quiet = yield* h.pause.status;
      assert.isTrue(quiet.quiet);
      assert.equal(quiet.activeThreadCount, 0);
      assert.isNull((yield* h.pause.resume).session);
      assert.deepEqual(
        (yield* Ref.get(h.calls)).map(({ threadId, text }) => ({ threadId, text })),
        [
          { threadId: a, text: "pause to go offline" },
          { threadId: a, text: "resume" },
        ],
      );
    }).pipe(Effect.provide(testLayer)),
);

const testLayer = Store.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "environment-pause-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.effect.each(["archived", "deleted", "missing"] as const)(
  "retires an enrolled %s recipient after non-delivery while retaining cleanup blockers",
  (state) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness;
        yield* Ref.set(h.snapshot, shell([thread(a)]));
        const gate = yield* Deferred.make<void>();
        yield* Ref.set(h.gate, gate);
        const starting = yield* h.pause.start.pipe(Effect.forkChild);
        yield* Deferred.await(h.entered);
        yield* Ref.set(h.recipientStates, new Map([[a, state]]));
        yield* Ref.set(h.failures, new Set([a]));
        // The command admission is still in flight, so unavailability alone
        // cannot retire its enrolled recipient.
        const inFlight = yield* h.pause.status;
        assert.strictEqual(inFlight.session?.targets[0]?.pause, "pending");
        assert.isFalse(inFlight.quiet);
        yield* Deferred.succeed(gate, undefined);
        assert.strictEqual((yield* Fiber.join(starting)).session?.targets[0]?.pause, "failed");
        yield* Ref.set(h.snapshot, {
          ...shell([]),
          archivedThreads: state === "archived" ? [{ ...thread(a, "idle"), archivedAt: now }] : [],
        });
        yield* Ref.set(h.pendingCleanup, [{ threadId: a }]);
        const waiting = yield* h.pause.status;
        assert.strictEqual(waiting.session?.targets[0]?.pause, "unavailable");
        assert.strictEqual(waiting.observation, "known");
        assert.strictEqual(waiting.activeThreadCount, 1);
        assert.isTrue(waiting.blockers.some((blocker) => blocker.type === "thread-cleanup"));
        assert.isFalse(waiting.quiet);
        yield* Ref.set(h.pendingCleanup, []);
        const recovered = yield* restart(h);
        const quiet = yield* recovered.pause.status;
        assert.strictEqual(quiet.session?.targets[0]?.pause, "unavailable");
        assert.isTrue(quiet.quiet);
        yield* recovered.pause.retry;
        assert.strictEqual((yield* Ref.get(h.calls)).length, 1);
        assert.isNull((yield* recovered.pause.resume).session);
        assert.isEmpty((yield* Ref.get(h.calls)).filter((call) => call.text === "resume"));
      }),
    ).pipe(Effect.provide(testLayer)),
);

it.effect(
  "retains successful Pause recipients for Resume while retiring an unavailable failure",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* Ref.set(h.failures, new Set([b]));
      yield* h.pause.start;
      yield* Ref.set(h.recipientStates, new Map([[b, "archived"]]));
      yield* Ref.set(h.snapshot, shell([]));
      const quiet = yield* h.pause.status;
      assert.deepEqual(
        quiet.session?.targets.map((target) => target.pause),
        ["sent", "unavailable"],
      );
      assert.isTrue(quiet.quiet);
      const saved = (yield* h.store.get)!;
      yield* h.store.recordDelivery(
        Store.deliveryIdentity(saved, saved.targets[1]!, "pause").messageId,
        true,
      );
      assert.strictEqual((yield* h.store.get)?.targets[1]?.pause, "unavailable");
      assert.isNull((yield* h.pause.resume).session);
      assert.deepEqual(
        (yield* Ref.get(h.calls))
          .filter((call) => call.text === "resume")
          .map((call) => call.threadId),
        [a],
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect("re-enrolls a restored active recipient with a fresh Pause delivery identity", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Ref.set(h.snapshot, shell([thread(a)]));
    yield* Ref.set(h.failures, new Set([a]));
    yield* h.pause.start;
    const enrolled = (yield* h.store.get)!;
    const oldIdentity = Store.deliveryIdentity(enrolled, enrolled.targets[0]!, "pause");
    yield* Ref.set(h.recipientStates, new Map([[a, "archived"]]));
    yield* Ref.set(h.snapshot, shell([]));
    assert.strictEqual((yield* h.pause.status).session?.targets[0]?.pause, "unavailable");
    yield* Ref.set(h.recipientStates, new Map<ThreadId, "archived" | "deleted" | "missing">());
    yield* Ref.set(h.failures, new Set<ThreadId>());
    yield* Ref.set(h.snapshot, shell([{ ...thread(a), title: "Restored example" }]));
    const restored = yield* h.pause.retry;
    assert.lengthOf(restored.session!.targets, 1);
    assert.strictEqual(restored.session?.targets[0]?.pause, "sent");
    assert.strictEqual(restored.session?.targets[0]?.title, "Restored example");
    const saved = (yield* h.store.get)!;
    assert.strictEqual(saved.targets[0]?.pauseAttempt, 1);
    const calls = yield* Ref.get(h.calls);
    assert.lengthOf(calls, 2);
    assert.notStrictEqual(calls[1]?.messageId, oldIdentity.messageId);
    assert.notStrictEqual(calls[1]?.commandId, oldIdentity.commandId);
    yield* h.store.recordDelivery(oldIdentity.messageId, false);
    assert.strictEqual((yield* h.store.get)?.targets[0]?.pause, "sent");
    yield* Ref.set(h.snapshot, shell([]));
    assert.isTrue((yield* h.pause.status).quiet);
    assert.isNull((yield* h.pause.resume).session);
    assert.deepEqual(
      (yield* Ref.get(h.calls))
        .filter((call) => call.text === "resume")
        .map((call) => call.threadId),
      [a],
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect.each(["start", "retry"] as const)(
  "explicit %s re-pauses a distinct later run with durable identities and one Resume",
  (operation) =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* Ref.set(h.snapshot, shell([thread(a)]));
      yield* h.pause.start;
      const initial = (yield* h.store.get)!;
      const oldIdentity = Store.deliveryIdentity(initial, initial.targets[0]!, "pause");
      const firstRun = (yield* Ref.get(h.runs))[0]!;
      const laterRun = {
        ...run(RunId.make("later-manual-run"), MessageId.make("later-manual-message")),
        ordinal: firstRun.ordinal + 1,
        status: "running" as const,
        startedAt: now,
      };
      yield* Ref.update(h.runs, (runs) => [
        ...runs.map((run) => ({ ...run, status: "completed" as const })),
        laterRun,
      ]);
      yield* Ref.update(h.messages, (messages) => [
        ...messages,
        {
          ...message(laterRun.userMessageId, laterRun.id),
          text: "Continue the ordinary task",
          creationSource: "web" as const,
        },
      ]);
      yield* Ref.set(
        h.snapshot,
        shell([{ ...thread(a), activeRunId: laterRun.id, latestRunId: laterRun.id }]),
      );
      yield* h.pause.status;
      assert.lengthOf(yield* Ref.get(h.calls), 1);
      yield* Ref.set(h.queued, true);
      const repausing = yield* h.pause[operation];
      assert.strictEqual(repausing.session?.targets[0]?.pause, "pending");
      assert.notProperty(repausing.session!.targets[0]!, "resumeRequired");
      const saved = (yield* h.store.get)!;
      assert.strictEqual(saved.targets[0]?.pauseAttempt, 1);
      assert.isTrue(saved.targets[0]?.resumeRequired);
      const fresh = Store.deliveryIdentity(saved, saved.targets[0]!, "pause");
      assert.notStrictEqual(fresh.messageId, oldIdentity.messageId);
      assert.notStrictEqual(fresh.commandId, oldIdentity.commandId);
      yield* h.store.recordDelivery(oldIdentity.messageId, false);
      assert.strictEqual((yield* h.store.get)?.targets[0]?.pause, "pending");
      yield* h.pause.start;
      yield* h.pause.retry;
      assert.lengthOf(yield* Ref.get(h.calls), 2);
      const recovered = yield* restart(h);
      assert.isTrue((yield* recovered.store.get)?.targets[0]?.resumeRequired);
      yield* recovered.pause.retry;
      assert.lengthOf(yield* Ref.get(h.calls), 2);
      yield* recovered.store.recordDelivery(fresh.messageId, true);
      yield* recovered.pause.retry;
      assert.lengthOf(yield* Ref.get(h.calls), 2);
      yield* Ref.set(h.snapshot, shell([thread(a, "idle")]));
      yield* Ref.set(h.queued, false);
      assert.isNull((yield* recovered.pause.resume).session);
      assert.lengthOf(
        (yield* Ref.get(h.calls)).filter((call) => call.text === "resume"),
        1,
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each([
  "same-control",
  "same-original",
  "checkpoint",
  "idle",
  "deferred",
  "missing-message",
] as const)("does not re-pause %s activity without a proved later active run", (scenario) =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Ref.set(h.snapshot, shell([thread(a)]));
    yield* h.pause.start;
    const original = (yield* Ref.get(h.runs))[0]!;
    const candidate = {
      ...run(RunId.make("candidate-run"), MessageId.make("candidate-message")),
      ordinal: original.ordinal + 1,
      status:
        scenario === "checkpoint"
          ? ("completed" as const)
          : scenario === "deferred"
            ? ("queued" as const)
            : ("running" as const),
    };
    yield* Ref.update(h.runs, (runs) => [...runs, candidate]);
    if (scenario === "same-original")
      yield* Ref.update(h.messages, (messages) =>
        messages.map((message) => ({ ...message, runId: candidate.id })),
      );
    if (scenario === "missing-message") yield* Ref.set(h.messages, []);
    if (scenario === "deferred") yield* Ref.set(h.deferred, [{ threadId: a, runId: candidate.id }]);
    yield* Ref.set(
      h.snapshot,
      shell([
        {
          ...thread(
            a,
            scenario === "idle" ? "idle" : scenario === "deferred" ? "queued" : "running",
          ),
          activeRunId:
            scenario === "idle" || scenario === "deferred"
              ? null
              : scenario === "same-control"
                ? original.id
                : candidate.id,
          latestRunId: candidate.id,
        },
      ]),
    );
    yield* h.pause.retry;
    yield* h.pause.start;
    assert.lengthOf(yield* Ref.get(h.calls), 1);
    assert.strictEqual((yield* h.store.get)?.targets[0]?.pauseAttempt, 0);
    assert.strictEqual((yield* h.store.get)?.targets[0]?.pause, "sent");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("retains the original Resume obligation after a failed re-Pause and restart", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Ref.set(h.snapshot, shell([thread(a)]));
    yield* h.pause.start;
    const original = (yield* Ref.get(h.runs))[0]!;
    const laterRun = {
      ...run(RunId.make("later-failure-run"), MessageId.make("later-failure-message")),
      ordinal: original.ordinal + 1,
      status: "running" as const,
    };
    yield* Ref.update(h.runs, (runs) => [...runs, laterRun]);
    yield* Ref.update(h.messages, (messages) => [
      ...messages,
      {
        ...message(laterRun.userMessageId, laterRun.id),
        text: "Continue the ordinary task",
        creationSource: "web" as const,
      },
    ]);
    yield* Ref.set(h.snapshot, shell([{ ...thread(a), activeRunId: laterRun.id }]));
    yield* Ref.set(h.receiptFailures, new Set([a]));
    assert.strictEqual((yield* h.pause.retry).session?.targets[0]?.pause, "failed");
    const recovered = yield* restart(h);
    assert.isTrue((yield* recovered.store.get)?.targets[0]?.resumeRequired);
    assert.strictEqual((yield* recovered.pause.status).session?.targets[0]?.pause, "failed");
    yield* Ref.set(h.receiptFailures, new Set<ThreadId>());
    assert.isNull((yield* recovered.pause.resume).session);
    assert.lengthOf(
      (yield* Ref.get(h.calls)).filter((call) => call.text === "resume"),
      1,
    );
    assert.isNull((yield* recovered.pause.status).session);
  }).pipe(Effect.provide(testLayer)),
);

it.effect.each(["queued", "starting", "running"] as const)(
  "re-pauses a lower-ordinal held run only after promotion to %s",
  (status) =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* Ref.set(h.snapshot, shell([thread(a)]));
      yield* h.pause.start;
      const containing = (yield* Ref.get(h.runs))[0]!;
      const held = {
        ...run(RunId.make("earlier-held-run"), MessageId.make("earlier-held-message")),
        ordinal: 2,
        status,
        queueHeld: status === "queued",
        startedAt: status === "running" ? now : null,
      };
      yield* Ref.set(h.runs, [
        held,
        {
          ...containing,
          ordinal: 3,
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      ]);
      yield* Ref.set(
        h.snapshot,
        shell([
          {
            ...thread(a, status),
            activeRunId: status === "queued" ? null : held.id,
            latestRunId: held.id,
          },
        ]),
      );
      yield* h.pause.retry;
      yield* h.pause.retry;
      const expected = status === "queued" ? 1 : 2;
      assert.lengthOf(yield* Ref.get(h.calls), expected);
      assert.strictEqual((yield* h.store.get)?.targets[0]?.pauseAttempt, expected - 1);
      assert.strictEqual(
        (yield* h.store.get)?.targets[0]?.resumeRequired,
        status === "queued" ? undefined : true,
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect("keeps a committed Pause with uncertain failure bookkeeping pending after deletion", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Ref.set(h.snapshot, shell([thread(a)]));
    yield* Ref.set(h.queued, true);
    yield* h.pause.start;
    const session = (yield* h.store.get)!;
    const identity = Store.deliveryIdentity(session, session.targets[0]!, "pause");
    const submitted = (yield* Ref.get(h.runs))[0]!;
    yield* h.store.update((current) =>
      current === null
        ? null
        : {
            ...current,
            targets: current.targets.map((target) => ({
              ...target,
              pause: "failed" as const,
              pauseAccepted: false,
            })),
          },
    );
    yield* Ref.set(h.effects, [
      {
        ...providerStartEffect(identity.commandId, submitted.id),
        status: "succeeded",
        attemptCount: 1,
      },
    ]);
    yield* Ref.set(h.recipientStates, new Map([[a, "deleted"]]));
    yield* Ref.set(h.snapshot, shell([]));
    const recovered = yield* restart(h);
    const status = yield* recovered.pause.retry;
    assert.strictEqual(status.session?.targets[0]?.pause, "pending");
    assert.strictEqual(status.observation, "unknown");
    assert.isFalse(status.quiet);
    assert.strictEqual((yield* Ref.get(h.calls)).length, 1);
    assert.isTrue((yield* recovered.store.get)?.targets[0]?.pauseAccepted);
  }).pipe(Effect.provide(testLayer)),
);

it.effect.each([
  {
    scenario: "cancelled before start",
    attemptCount: null,
    nativeAccepted: false,
    delivery: "unavailable",
    observation: "known",
  },
  {
    scenario: "cancelled before claim",
    attemptCount: 0,
    nativeAccepted: false,
    delivery: "unavailable",
    observation: "known",
  },
  {
    scenario: "cancelled after claim",
    attemptCount: 1,
    nativeAccepted: false,
    delivery: "pending",
    observation: "unknown",
  },
  {
    scenario: "native acceptance",
    attemptCount: null,
    nativeAccepted: true,
    delivery: "pending",
    observation: "unknown",
  },
] as const)(
  "recovers unavailable queued Pause with $scenario without duplicating admission",
  (scenario) =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* Ref.set(h.snapshot, shell([thread(a)]));
      yield* Ref.set(h.queued, true);
      yield* h.pause.start;
      const submitted = (yield* Ref.get(h.runs))[0]!;
      const rootNodeId = NodeId.make("queued-root-example");
      yield* Ref.update(h.runs, (runs) =>
        runs.map((run) => ({
          ...run,
          status: "cancelled",
          rootNodeId: scenario.nativeAccepted ? rootNodeId : null,
        })),
      );
      if (scenario.attemptCount !== null)
        yield* Ref.set(h.effects, [
          {
            ...providerStartEffect(
              CommandId.make(`command:system:start-queued:${submitted.id}`),
              submitted.id,
            ),
            status: "cancelled",
            attemptCount: scenario.attemptCount,
          },
        ]);
      if (scenario.nativeAccepted) yield* Ref.set(h.providerTurns, [nativeTurn(rootNodeId)]);
      yield* Ref.set(h.recipientStates, new Map([[a, "deleted"]]));
      yield* Ref.set(h.snapshot, shell([]));
      const recovered = yield* restart(h);
      const status = yield* recovered.pause.retry;
      assert.strictEqual(status.session?.targets[0]?.pause, scenario.delivery);
      assert.strictEqual(status.observation, scenario.observation);
      assert.strictEqual(status.quiet, scenario.delivery === "unavailable");
      yield* recovered.pause.retry;
      assert.strictEqual((yield* Ref.get(h.calls)).length, 1);
      if (scenario.delivery === "unavailable") {
        assert.isNull((yield* recovered.pause.resume).session);
        assert.isEmpty((yield* Ref.get(h.calls)).filter((call) => call.text === "resume"));
      }
    }).pipe(Effect.provide(testLayer)),
);

it.effect("retires a definitive native rejection even when its committed command remains", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Ref.set(h.snapshot, shell([thread(a)]));
    yield* Ref.set(h.receiptFailures, new Set([a]));
    yield* h.pause.start;
    const saved = (yield* h.store.get)!;
    assert.strictEqual(saved.targets[0]?.pause, "failed");
    assert.isTrue(saved.targets[0]!.pauseAccepted);
    const identity = Store.deliveryIdentity(saved, saved.targets[0]!, "pause");
    const run = (yield* Ref.get(h.runs))[0]!;
    const rootNodeId = NodeId.make("existing-root-example");
    yield* Ref.update(h.runs, (runs) => runs.map((run) => ({ ...run, rootNodeId })));
    yield* Ref.set(h.providerTurns, [nativeTurn(rootNodeId)]);
    yield* Ref.set(h.effects, [
      {
        ...providerStartEffect(identity.commandId, run.id),
        status: "succeeded",
        attemptCount: 1,
        request: {
          type: "provider-turn.steer",
          providerSessionId: ProviderSessionId.make("provider-session-example"),
          providerThreadId: ProviderThreadId.make("provider-thread-example"),
          providerTurnId: ProviderTurnId.make("provider-turn-example"),
          messageId: identity.messageId,
        },
      },
    ]);
    yield* Ref.set(h.recipientStates, new Map([[a, "archived"]]));
    yield* Ref.set(h.snapshot, shell([]));
    const recovered = yield* restart(h);
    const quiet = yield* recovered.pause.status;
    assert.strictEqual(quiet.session?.targets[0]?.pause, "unavailable");
    assert.isTrue(quiet.quiet);
    assert.isNull((yield* recovered.pause.resume).session);
    assert.strictEqual((yield* Ref.get(h.calls)).length, 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "keeps an unavailable recipient retryable while its authoritative records cannot be read",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* Ref.set(h.snapshot, shell([thread(a)]));
      yield* Ref.set(h.failures, new Set([a]));
      yield* h.pause.start;
      yield* Ref.set(h.recipientStates, new Map([[a, "deleted"]]));
      yield* Ref.set(h.readFailures, new Set([a]));
      yield* Ref.set(h.snapshot, shell([]));
      const unknown = yield* h.pause.status;
      assert.strictEqual(unknown.session?.targets[0]?.pause, "pending");
      assert.strictEqual(unknown.observation, "unknown");
      assert.isFalse(unknown.quiet);
      yield* Ref.set(h.readFailures, new Set());
      assert.strictEqual((yield* h.pause.status).session?.targets[0]?.pause, "unavailable");
      assert.strictEqual((yield* Ref.get(h.calls)).length, 1);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("keeps live queued acceptance pending while fanout bookkeeping is outstanding", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      yield* Ref.set(h.snapshot, shell([thread(a)]));
      yield* Ref.set(h.queued, true);
      const gate = yield* Deferred.make<void>();
      yield* Ref.set(h.receiptGate, gate);
      const starting = yield* h.pause.start.pipe(Effect.forkChild);
      yield* Deferred.await(h.receiptEntered);
      assert.lengthOf(yield* Ref.get(h.messages), 1);
      assert.strictEqual((yield* h.store.get)?.targets[0]?.pauseAccepted, false);
      const status = yield* h.pause.status;
      assert.strictEqual(status.session?.targets[0]?.pause, "pending");
      assert.strictEqual(status.observation, "known");
      assert.strictEqual(status.activeThreadCount, 1);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(starting);
      yield* h.pause.retry;
      assert.lengthOf(yield* Ref.get(h.calls), 1);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("retains Resume intent across recovery until held automatic work starts", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Ref.set(h.snapshot, shell([]));
    assert.isTrue((yield* h.pause.start).quiet);
    yield* Ref.set(h.deferred, [{ threadId: a, runId: RunId.make("held-automatic-example") }]);
    assert.strictEqual((yield* h.pause.resume).session?.phase, "resuming");
    const recovered = yield* Pause.EnvironmentPause.pipe(
      Effect.provide(
        Pause.layer.pipe(
          Layer.provide(Layer.merge(h.layers, Layer.succeed(Store.EnvironmentPauseStore, h.store))),
        ),
      ),
    );
    assert.strictEqual((yield* recovered.status).session?.phase, "resuming");
    assert.isEmpty(yield* Ref.get(h.calls));
    yield* Ref.set(h.deferred, []);
    assert.isNull((yield* recovered.status).session);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("can pause again while released automatic work waits for a thread", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Ref.set(h.snapshot, shell([]));
    const first = yield* h.pause.start;
    yield* Ref.set(h.deferred, [{ threadId: b, runId: RunId.make("held-automatic-example") }]);
    assert.strictEqual((yield* h.pause.resume).session?.phase, "resuming");
    yield* Ref.set(h.snapshot, shell([thread(a)]));
    const again = yield* h.pause.start;
    assert.notStrictEqual(again.session?.id, first.session?.id);
    assert.strictEqual(again.session?.phase, "pausing");
    assert.deepEqual(
      again.session?.targets.map((target) => target.threadId),
      [a],
    );
    assert.strictEqual((yield* h.store.get)?.phase, "pausing");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("closes the gate before scanning and excludes deferred automatic turns from quiet", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const queuedRun = RunId.make("automatic-queued-example");
    const startingRun = RunId.make("automatic-starting-example");
    yield* Ref.set(
      h.snapshot,
      shell([
        { ...thread(a, "queued"), latestRunId: queuedRun },
        {
          ...thread(b, "starting"),
          activeRunId: startingRun,
          activityRunStatus: "starting",
          latestRunId: startingRun,
        },
      ]),
    );
    yield* Ref.set(h.deferred, [
      { threadId: a, runId: queuedRun },
      { threadId: b, runId: startingRun },
    ]);
    const paused = yield* h.pause.start;
    assert.isEmpty(paused.session?.targets ?? []);
    assert.isEmpty(yield* Ref.get(h.calls));
    assert.strictEqual(paused.activeThreadCount, 0);
    assert.isTrue(paused.quiet);
    assert.deepEqual(yield* Ref.get(h.gateObservations), ["pausing", "pausing"]);
    const resumed = yield* h.pause.resume;
    assert.strictEqual(resumed.session?.phase, "resuming");
    assert.strictEqual(resumed.activeThreadCount, 2);
    yield* Ref.set(h.deferred, []);
    assert.isNull((yield* h.pause.status).session);
  }).pipe(Effect.provide(testLayer)),
);

it.effect.each([
  { taskId: "native-monitor-example", kind: "monitor" as const },
  { taskId: "pull-request-watch:github.com/example/project#7", kind: "command" as const },
  { taskId: "pull-request-watch:github.com/example/project#8", kind: "monitor" as const },
])("keeps an unsuspended background task active while PR polling is held: %s", (task) =>
  Effect.gen(function* () {
    const h = yield* harness;
    const link: ThreadPullRequestLink = {
      host: "github.com",
      repository: "example/project",
      number: 7,
      url: "https://github.com/example/project/pull/7",
      source: "agent",
      linkedAt: DateTime.formatIso(now),
      snapshot: null,
      stack: null,
      watch: {
        startedAt: DateTime.formatIso(now),
        headSha: null,
        failedChecks: [],
        passed: false,
        passedChecks: [],
        remarksThrough: DateTime.formatIso(now),
        remarkIds: [],
        conflicting: false,
        wakes: 0,
      },
    };
    yield* Ref.set(
      h.snapshot,
      shell([
        {
          ...thread(a, "idle"),
          pullRequests: [link],
          pendingBackgroundTasks: [
            { taskId: "pull-request-watch:github.com/example/project#7", kind: "monitor" },
            task,
          ],
        },
      ]),
    );
    const paused = yield* h.pause.start;
    assert.isFalse(paused.quiet);
    assert.equal(paused.activeThreadCount, 1);
    assert.deepEqual(
      paused.session?.targets.map((target) => target.threadId),
      [a],
    );
    assert.isTrue(paused.blockers.some((blocker) => blocker.type === "thread-background"));
    assert.deepEqual((yield* Ref.get(h.snapshot)).threads[0]?.pullRequests, [link]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "keeps running providers, requests, and background work active beside deferred runs",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const queuedRun = RunId.make("automatic-queued-example");
      yield* Ref.set(
        h.snapshot,
        shell([
          thread(a),
          {
            ...thread(b, "queued"),
            latestRunId: queuedRun,
            pendingRuntimeRequest: {
              id: RuntimeRequestId.make("request-example"),
              kind: "permission",
              createdAt: now,
            },
          },
          {
            ...thread(c, "queued"),
            latestRunId: queuedRun,
            pendingBackgroundTasks: [{ taskId: "background-example", kind: "command" }],
          },
        ]),
      );
      yield* Ref.set(h.deferred, [
        { threadId: a, runId: RunId.make(`run-${a}`) },
        { threadId: b, runId: queuedRun },
        { threadId: c, runId: queuedRun },
      ]);
      yield* Ref.set(h.runtimeWork, [
        { providerSessionId: ProviderSessionId.make("provider-example"), status: "running" },
      ]);
      const paused = yield* h.pause.start;
      assert.deepEqual(
        paused.session?.targets.map((target) => target.threadId),
        [a, b, c],
      );
      assert.strictEqual(paused.activeThreadCount, 3);
      assert.isFalse(paused.quiet);
      assert.isTrue(paused.blockers.some((blocker) => blocker.type === "provider-runtime"));
      assert.isTrue(paused.blockers.some((blocker) => blocker.type === "thread-background"));
    }).pipe(Effect.provide(testLayer)),
);

it.effect("recovers a durable pause saved before message submission after restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      yield* Ref.set(h.snapshot, shell([thread(a)]));
      const gate = yield* Deferred.make<void>();
      yield* Ref.set(h.gate, gate);
      const starting = yield* h.pause.start.pipe(Effect.forkChild);
      yield* Deferred.await(h.entered);
      yield* Fiber.interrupt(starting);
      assert.strictEqual((yield* h.store.get)?.targets[0]?.pauseAccepted, false);
      assert.isEmpty(yield* Ref.get(h.messages));
      const recovered = yield* restart(h);
      const status = yield* recovered.pause.status;
      assert.strictEqual(status.observation, "known");
      assert.strictEqual(status.session?.targets[0]?.pause, "failed");
      yield* Ref.set(h.gate, null);
      const retried = yield* recovered.pause.retry;
      assert.strictEqual(retried.session?.targets[0]?.pause, "sent");
      assert.lengthOf(yield* Ref.get(h.messages), 1);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("recovers a committed queued pause without resubmitting after restart", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Ref.set(h.snapshot, shell([thread(a)]));
    yield* Ref.set(h.queued, true);
    yield* h.pause.start;
    yield* h.store.update((session) =>
      session === null
        ? session
        : {
            ...session,
            targets: session.targets.map((target) => ({ ...target, pauseAccepted: false })),
          },
    );
    const recovered = yield* restart(h);
    const waiting = yield* recovered.pause.status;
    assert.strictEqual(waiting.observation, "known");
    assert.strictEqual(waiting.session?.targets[0]?.pause, "pending");
    assert.strictEqual((yield* recovered.store.get)?.targets[0]?.pauseAccepted, true);
    yield* recovered.pause.retry;
    assert.lengthOf(yield* Ref.get(h.calls), 1);
    assert.lengthOf(yield* Ref.get(h.messages), 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect.each(["pause", "resume"] as const)(
  "keeps committed %s pending after the send response fails and sends no duplicate",
  (direction) =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* Ref.set(h.snapshot, shell([thread(a)]));
      if (direction === "resume") yield* h.pause.start;
      yield* Ref.set(h.committedFailures, new Set([a]));
      const waiting = yield* direction === "pause" ? h.pause.start : h.pause.resume;
      assert.strictEqual(waiting.session?.targets[0]?.[direction], "pending");
      const saved = (yield* h.store.get)!;
      assert.isTrue(saved.targets[0]![`${direction}Accepted`]);
      const original = Store.deliveryIdentity(saved, saved.targets[0]!, direction);
      yield* h.pause.retry;
      assert.lengthOf(
        (yield* Ref.get(h.calls)).filter(
          (call) => call.text === (direction === "pause" ? "pause to go offline" : "resume"),
        ),
        1,
      );
      if (direction === "pause") {
        assert.strictEqual((yield* Effect.result(h.pause.resume))._tag, "Failure");
        assert.strictEqual((yield* h.store.get)?.phase, "pausing");
      }
      const recovered = yield* restart(h);
      yield* recovered.pause.retry;
      assert.strictEqual(
        Store.deliveryIdentity(
          (yield* recovered.store.get)!,
          (yield* recovered.store.get)!.targets[0]!,
          direction,
        ).messageId,
        original.messageId,
      );
      yield* recovered.store.recordDelivery(original.messageId, true);
      yield* Ref.set(h.committedFailures, new Set());
      yield* Ref.set(h.snapshot, shell([]));
      if (direction === "pause") {
        assert.isTrue((yield* recovered.pause.status).quiet);
        assert.isNull((yield* recovered.pause.resume).session);
      } else {
        assert.isNull((yield* recovered.pause.status).session);
      }
      assert.lengthOf(
        (yield* Ref.get(h.calls)).filter((call) => call.text === "pause to go offline"),
        1,
      );
      assert.lengthOf(
        (yield* Ref.get(h.calls)).filter((call) => call.text === "resume"),
        1,
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each(["pause", "resume"] as const)(
  "recovers committed %s after evidence reads fail and restart without a second submission",
  (direction) =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* Ref.set(h.snapshot, shell([thread(a)]));
      if (direction === "resume") yield* h.pause.start;
      yield* Ref.set(h.committedFailures, new Set([a]));
      yield* Ref.set(h.evidenceFailuresAfterCommit, new Set([a]));
      const unknown = yield* direction === "pause" ? h.pause.start : h.pause.resume;
      assert.strictEqual(unknown.session?.targets[0]?.[direction], "pending");
      assert.strictEqual(unknown.observation, "unknown");
      assert.isFalse((yield* h.store.get)?.targets[0]?.[`${direction}Accepted`]);
      yield* h.pause.retry;
      const recovered = yield* restart(h);
      yield* recovered.pause.retry;
      if (direction === "pause") {
        assert.strictEqual((yield* Effect.result(recovered.pause.resume))._tag, "Failure");
        assert.strictEqual((yield* recovered.store.get)?.phase, "pausing");
      }
      yield* Ref.set(h.readFailures, new Set());
      yield* Ref.set(h.outboxReadFailed, false);
      yield* recovered.pause.retry;
      const saved = (yield* recovered.store.get)!;
      assert.isTrue(saved.targets[0]![`${direction}Accepted`]);
      assert.strictEqual(saved.targets[0]![`${direction}Attempt`], 0);
      yield* recovered.store.recordDelivery(
        Store.deliveryIdentity(saved, saved.targets[0]!, direction).messageId,
        true,
      );
      yield* Ref.set(h.committedFailures, new Set());
      yield* Ref.set(h.snapshot, shell([]));
      if (direction === "pause") assert.isNull((yield* recovered.pause.resume).session);
      else assert.isNull((yield* recovered.pause.status).session);
      assert.lengthOf(
        (yield* Ref.get(h.calls)).filter((call) => call.text === "pause to go offline"),
        1,
      );
      assert.lengthOf(
        (yield* Ref.get(h.calls)).filter((call) => call.text === "resume"),
        1,
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect("holds a failed unaccepted Pause during an evidence outage before Retry or Cancel", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Ref.set(h.snapshot, shell([thread(a)]));
    yield* Ref.set(h.committedFailures, new Set([a]));
    yield* h.pause.start;
    const saved = (yield* h.store.get)!;
    const identity = Store.deliveryIdentity(saved, saved.targets[0]!, "pause");
    // Simulate saved failure bookkeeping after a committed dispatch.
    yield* h.store.update((session) =>
      session === null
        ? session
        : {
            ...session,
            targets: session.targets.map((target) => ({
              ...target,
              pause: "failed" as const,
              pauseAccepted: false,
            })),
          },
    );
    yield* Ref.set(h.readFailures, new Set([a]));
    yield* Ref.set(h.outboxReadFailed, true);
    const recovered = yield* restart(h);
    const waiting = yield* recovered.pause.retry;
    assert.strictEqual(waiting.session?.targets[0]?.pause, "pending");
    assert.strictEqual(waiting.observation, "unknown");
    assert.strictEqual((yield* Effect.result(recovered.pause.resume))._tag, "Failure");
    assert.strictEqual((yield* recovered.store.get)?.targets[0]?.pauseAttempt, 0);
    assert.lengthOf(yield* Ref.get(h.calls), 1);
    yield* Ref.set(h.readFailures, new Set());
    yield* Ref.set(h.outboxReadFailed, false);
    yield* recovered.pause.retry;
    yield* recovered.store.recordDelivery(identity.messageId, true);
    yield* Ref.set(h.committedFailures, new Set());
    assert.isNull((yield* recovered.pause.resume).session);
    assert.lengthOf(
      (yield* Ref.get(h.calls)).filter((call) => call.text === "resume"),
      1,
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("does not submit Pause when its pre-send evidence cannot be read", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Ref.set(h.snapshot, shell([thread(a)]));
    yield* Ref.set(h.readFailures, new Set([a]));
    const waiting = yield* h.pause.start;
    assert.strictEqual(waiting.observation, "unknown");
    assert.strictEqual(waiting.session?.targets[0]?.pause, "pending");
    assert.isEmpty(yield* Ref.get(h.calls));
    yield* Ref.set(h.readFailures, new Set());
    yield* h.pause.retry;
    assert.lengthOf(yield* Ref.get(h.calls), 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("uses a committed command outbox when the post-dispatch projection is unreadable", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Ref.set(h.snapshot, shell([thread(a)]));
    yield* Ref.set(h.committedFailures, new Set([a]));
    yield* Ref.set(h.outboxEvidenceAfterCommit, new Set([a]));
    const waiting = yield* h.pause.start;
    assert.strictEqual(waiting.session?.targets[0]?.pause, "pending");
    assert.isTrue((yield* h.store.get)?.targets[0]?.pauseAccepted);
    assert.strictEqual(waiting.observation, "known");
    assert.isFalse(waiting.quiet);
    yield* h.pause.retry;
    const recovered = yield* restart(h);
    yield* recovered.pause.retry;
    assert.lengthOf(yield* Ref.get(h.calls), 1);
    assert.strictEqual((yield* Effect.result(recovered.pause.resume))._tag, "Failure");
    assert.strictEqual((yield* recovered.store.get)?.phase, "pausing");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("retries proven pre-dispatch failure with a fresh identity", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Ref.set(h.snapshot, shell([thread(a)]));
    yield* Ref.set(h.failures, new Set([a]));
    assert.strictEqual((yield* h.pause.start).session?.targets[0]?.pause, "failed");
    const saved = (yield* h.store.get)!;
    assert.isFalse(saved.targets[0]?.pauseAccepted);
    assert.isEmpty(yield* Ref.get(h.messages));
    const original = Store.deliveryIdentity(saved, saved.targets[0]!, "pause");
    yield* Ref.set(h.failures, new Set());
    assert.strictEqual((yield* h.pause.retry).session?.targets[0]?.pause, "sent");
    const retried = (yield* h.store.get)!;
    const current = Store.deliveryIdentity(retried, retried.targets[0]!, "pause");
    assert.notStrictEqual(current.messageId, original.messageId);
    assert.lengthOf(yield* Ref.get(h.messages), 1);
    assert.lengthOf(yield* Ref.get(h.calls), 2);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("keeps a definitive failed Resume receipt through fanout, status, and restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness;
      yield* Ref.set(h.snapshot, shell([thread(a)]));
      yield* h.pause.start;
      yield* Ref.set(h.receiptFailures, new Set([a]));
      const gate = yield* Deferred.make<void>();
      yield* Ref.set(h.receiptGate, gate);
      const resuming = yield* h.pause.resume.pipe(Effect.forkChild);
      yield* Deferred.await(h.receiptEntered);
      const during = yield* h.pause.status;
      assert.strictEqual(during.session?.targets[0]?.resume, "failed");
      assert.strictEqual((yield* h.store.get)?.targets[0]?.resumeAccepted, true);
      const recovered = yield* restart(h);
      assert.strictEqual((yield* recovered.pause.status).session?.targets[0]?.resume, "failed");
      yield* Fiber.interrupt(resuming);
      yield* Ref.set(h.receiptGate, null);
      yield* Ref.set(h.receiptFailures, new Set());
      assert.isNull((yield* recovered.pause.retry).session);
      const resumes = (yield* Ref.get(h.calls)).filter((call) => call.text === "resume");
      assert.lengthOf(resumes, 2);
      assert.notStrictEqual(resumes[0]!.messageId, resumes[1]!.messageId);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect(
  "pauses every active thread, counts all environment work, and recovers when disabled",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const started = yield* h.pause.start;
      assert.deepEqual(
        started.session?.targets.map((target) => target.threadId),
        [a, b],
      );
      assert.deepEqual(
        (yield* Ref.get(h.calls)).map(({ text, mode }) => ({ text, mode })),
        [
          { text: "pause to go offline", mode: "cooperative" },
          { text: "pause to go offline", mode: "cooperative" },
        ],
      );
      assert.strictEqual(started.activeThreadCount, 2);
      assert.isFalse(started.quiet);
      yield* Ref.set(h.enabled, false);
      yield* Ref.set(h.snapshot, shell([]));
      yield* Ref.set(h.runtimeWork, [
        { providerSessionId: ProviderSessionId.make("provider-example"), status: "running" },
      ]);
      assert.isFalse((yield* h.pause.status).quiet);
      yield* Ref.set(h.runtimeWork, []);
      yield* Ref.set(h.pending, [{ threadId: a, providerMessage: true }]);
      assert.isFalse((yield* h.pause.status).quiet);
      yield* Ref.set(h.pending, []);
      assert.isTrue((yield* h.pause.status).quiet);
      const recovered = yield* Store.EnvironmentPauseStore.pipe(
        Effect.provide(Layer.fresh(Store.layer)),
      );
      assert.deepEqual(
        (yield* recovered.get)?.targets.map((target) => target.threadId),
        [a, b],
      );
      yield* h.pause.resume;
      assert.deepEqual(
        (yield* Ref.get(h.calls))
          .filter((call) => call.text === "resume")
          .map((call) => call.threadId),
        [a, b],
      );
      assert.isNull((yield* h.pause.status).session);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("retries only failed targets and retains partial resume across a new active turn", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Ref.set(h.failures, new Set([b]));
    const first = yield* h.pause.start;
    assert.strictEqual(
      first.session?.targets.find((target) => target.threadId === b)?.pause,
      "failed",
    );
    yield* Ref.set(h.failures, new Set());
    yield* h.pause.retry;
    assert.strictEqual((yield* Ref.get(h.calls)).filter((call) => call.threadId === a).length, 1);
    assert.strictEqual((yield* Ref.get(h.calls)).filter((call) => call.threadId === b).length, 2);
    yield* Ref.set(h.snapshot, shell([]));
    yield* Ref.set(h.failures, new Set([b]));
    const partial = yield* h.pause.resume;
    assert.strictEqual(partial.session?.phase, "resuming");
    assert.strictEqual(
      partial.session?.targets.find((target) => target.threadId === a)?.resume,
      "sent",
    );
    yield* Ref.set(h.snapshot, shell([thread(a)]));
    yield* Ref.set(h.failures, new Set());
    assert.isNull((yield* h.pause.resume).session);
    const resumeCalls = (yield* Ref.get(h.calls)).filter((call) => call.text === "resume");
    assert.strictEqual(resumeCalls.filter((call) => call.threadId === a).length, 1);
    assert.strictEqual(resumeCalls.filter((call) => call.threadId === b).length, 2);
  }).pipe(Effect.provide(testLayer)),
);

it.effect.each([
  { state: "archived" as const },
  { state: "deleted" as const },
  { state: "missing" as const },
])("finishes unavailable $state recipients without duplicating completed resumes", ({ state }) =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Ref.set(h.snapshot, shell([thread(a), thread(b), thread(c)]));
    const original = yield* h.pause.start;
    yield* Ref.set(h.recipientStates, new Map([[b, state]]));
    yield* Ref.set(h.readFailures, new Set([c]));
    const partial = yield* h.pause.resume;
    assert.strictEqual(partial.session?.phase, "resuming");
    assert.strictEqual(
      partial.session?.targets.find((target) => target.threadId === a)?.resume,
      "sent",
    );
    assert.strictEqual(
      partial.session?.targets.find((target) => target.threadId === b)?.resume,
      "unavailable",
    );
    assert.strictEqual(
      partial.session?.targets.find((target) => target.threadId === c)?.resume,
      "pending",
    );
    const persisted = yield* Store.EnvironmentPauseStore.pipe(
      Effect.provide(Layer.fresh(Store.layer)),
    );
    const recovered = (yield* persisted.get)!;
    const unavailable = recovered.targets.find((target) => target.threadId === b)!;
    assert.strictEqual(unavailable.resume, "unavailable");
    // A late callback cannot rewrite a terminal non-delivery as sent or failed.
    yield* h.store.recordDelivery(
      Store.deliveryIdentity(recovered, unavailable, "resume").messageId,
      true,
    );
    assert.strictEqual(
      (yield* h.store.get)?.targets.find((target) => target.threadId === b)?.resume,
      "unavailable",
    );
    yield* Ref.set(h.readFailures, new Set());
    assert.isNull((yield* h.pause.retry).session);
    const resumed = (yield* Ref.get(h.calls)).filter((call) => call.text === "resume");
    assert.deepEqual(
      resumed.map((call) => call.threadId),
      [a, c],
    );
    yield* Ref.set(h.snapshot, shell([thread(a)]));
    const next = yield* h.pause.start;
    assert.notStrictEqual(next.session?.id, original.session?.id);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("clears an unconfirmed unsent resume when its recipient is later archived", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.pause.start;
    yield* Ref.set(h.readFailures, new Set([b]));
    assert.strictEqual(
      (yield* h.pause.resume).session?.targets.find((target) => target.threadId === b)?.resume,
      "pending",
    );
    yield* Ref.set(h.readFailures, new Set());
    yield* Ref.set(h.recipientStates, new Map([[b, "archived"]]));
    assert.isNull((yield* h.pause.status).session);
    assert.deepEqual(
      (yield* Ref.get(h.calls))
        .filter((call) => call.text === "resume")
        .map((call) => call.threadId),
      [a],
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("recovers an accepted queued resume cancelled by deletion", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Ref.set(h.snapshot, shell([thread(a)]));
    yield* h.pause.start;
    yield* Ref.set(h.queued, true);
    yield* h.pause.resume;
    yield* Ref.set(h.recipientStates, new Map([[a, "deleted"]]));
    yield* Ref.update(h.runs, (runs) => runs.map((run) => ({ ...run, status: "cancelled" })));
    assert.strictEqual((yield* h.pause.status).session?.targets[0]?.resume, "failed");
    assert.isNull((yield* h.pause.status).session);
    assert.strictEqual(
      (yield* Ref.get(h.calls)).filter((call) => call.text === "resume").length,
      1,
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("keeps an ambiguously accepted resume pending after its recipient is deleted", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Ref.set(h.snapshot, shell([thread(a)]));
    yield* h.pause.start;
    yield* Ref.set(h.queued, true);
    yield* h.pause.resume;
    const rootNodeId = NodeId.make("resume-node-example");
    yield* Ref.update(h.runs, (runs) =>
      runs.map((run) => ({ ...run, status: "failed", rootNodeId })),
    );
    yield* Ref.set(h.providerTurns, [nativeTurn(rootNodeId)]);
    yield* Ref.set(h.recipientStates, new Map([[a, "deleted"]]));
    const observed = yield* h.pause.retry;
    assert.strictEqual(observed.observation, "unknown");
    assert.strictEqual(observed.session?.targets[0]?.resume, "pending");
    assert.strictEqual(
      (yield* Ref.get(h.calls)).filter((call) => call.text === "resume").length,
      1,
    );
    yield* Ref.set(h.recipientStates, new Map([[a, "missing"]]));
    assert.strictEqual((yield* h.pause.status).session?.targets[0]?.resume, "pending");
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "checks the same resume identity after a read outage before retrying a deleted recipient",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* Ref.set(h.snapshot, shell([thread(a)]));
      yield* h.pause.start;
      yield* Ref.set(h.readFailures, new Set([a]));
      yield* h.pause.resume;
      const session = (yield* h.store.get)!;
      const target = session.targets[0]!;
      assert.strictEqual(target.resume, "pending");
      yield* h.pause.retry;
      assert.strictEqual((yield* h.store.get)?.targets[0]?.resumeAttempt, target.resumeAttempt);
      const identity = Store.deliveryIdentity(session, target, "resume");
      const runId = RunId.make("committed-resume-example");
      yield* Ref.set(h.messages, [message(identity.messageId, runId)]);
      yield* Ref.set(h.runs, [run(runId, identity.messageId)]);
      yield* Ref.set(h.recipientStates, new Map([[a, "deleted"]]));
      yield* Ref.set(h.readFailures, new Set());
      const result = yield* h.pause.retry;
      assert.strictEqual(result.session?.targets[0]?.resume, "pending");
      assert.strictEqual((yield* h.store.get)?.targets[0]?.resumeAttempt, target.resumeAttempt);
      assert.isEmpty((yield* Ref.get(h.calls)).filter((call) => call.text === "resume"));
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "status remains live during message fanout and never treats unknown observations as quiet",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness;
        const release = yield* Deferred.make<void>();
        yield* Ref.set(h.gate, release);
        const start = yield* h.pause.start.pipe(Effect.forkChild);
        yield* Deferred.await(h.entered);
        const current = yield* h.pause.status;
        assert.strictEqual(current.session?.targets.length, 2);
        assert.isFalse(current.quiet);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(start);
        yield* Ref.set(h.snapshot, shell([]));
        yield* Ref.set(h.observationFailed, true);
        const unavailable = yield* h.pause.status;
        assert.strictEqual(unavailable.observation, "unknown");
        assert.isFalse(unavailable.quiet);
      }),
    ).pipe(Effect.provide(testLayer)),
);

it.effect("collects newly active threads on retry without repeating successful pause sends", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.pause.start;
    yield* Ref.set(h.snapshot, shell([thread(c, "idle")]));
    yield* Ref.set(h.pending, [{ threadId: c, providerMessage: true }]);
    const result = yield* h.pause.retry;
    assert.deepEqual(
      result.session?.targets.map((target) => target.threadId),
      [a, b, c],
    );
    assert.deepEqual(
      (yield* Ref.get(h.calls)).map((call) => call.threadId),
      [a, b, c],
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect.each(["checkpoint", "cleanup"] as const)(
  "waits for idle %s work without sending Pause or enrolling Resume on rescans",
  (work) =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* Ref.set(h.snapshot, shell([thread(a, "idle")]));
      if (work === "checkpoint")
        yield* Ref.set(h.pending, [{ threadId: a, providerMessage: false }]);
      else yield* Ref.set(h.pendingCleanup, [{ threadId: a }]);
      const waiting = yield* h.pause.start;
      assert.isFalse(waiting.quiet);
      assert.strictEqual(waiting.activeThreadCount, 1);
      assert.isEmpty(waiting.session?.targets ?? []);
      assert.isTrue(
        waiting.blockers.some(
          (blocker) => blocker.type === (work === "checkpoint" ? "thread-turn" : "thread-cleanup"),
        ),
      );
      for (const rescan of [h.pause.retry, h.pause.start]) {
        const status = yield* rescan;
        assert.isFalse(status.quiet);
        assert.isEmpty(status.session?.targets ?? []);
      }
      assert.isEmpty(yield* Ref.get(h.calls));
      yield* Ref.set(h.pending, []);
      yield* Ref.set(h.pendingCleanup, []);
      assert.isTrue((yield* h.pause.status).quiet);
      assert.isNull((yield* h.pause.resume).session);
      assert.isEmpty(yield* Ref.get(h.calls));
    }).pipe(Effect.provide(testLayer)),
);

it.effect("pauses a pending provider send even when its shell is idle", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Ref.set(h.snapshot, shell([thread(a, "idle")]));
    yield* Ref.set(h.pending, [{ threadId: a, providerMessage: true }]);
    const waiting = yield* h.pause.start;
    assert.isFalse(waiting.quiet);
    assert.deepEqual(
      waiting.session?.targets.map((target) => target.threadId),
      [a],
    );
    yield* h.pause.retry;
    yield* h.pause.start;
    assert.lengthOf(yield* Ref.get(h.calls), 1);
    yield* Ref.set(h.pending, []);
    assert.isTrue((yield* h.pause.status).quiet);
    assert.isNull((yield* h.pause.resume).session);
    assert.deepEqual(
      (yield* Ref.get(h.calls)).map((call) => call.text),
      ["pause to go offline", "resume"],
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("defaults off and refuses starting a pause while preserving recovery operations", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    assert.isFalse(DEFAULT_SERVER_SETTINGS.environmentPauseEnabled);
    yield* Ref.set(h.enabled, false);
    assert.strictEqual((yield* h.pause.start.pipe(Effect.flip)).reason, "disabled");
    assert.isNull((yield* h.pause.status).session);
    assert.isEmpty(yield* Ref.get(h.calls));
  }).pipe(Effect.provide(testLayer)),
);

it.effect.each([{ terminalStatus: "cancelled" as const }, { terminalStatus: "failed" as const }])(
  "keeps queued pause work known and retries a $terminalStatus run before delivery",
  ({ terminalStatus }) =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* Ref.set(h.snapshot, shell([thread(a)]));
      yield* Ref.set(h.queued, true);
      const waiting = yield* h.pause.start;
      assert.strictEqual(waiting.observation, "known");
      assert.strictEqual(waiting.activeThreadCount, 1);
      assert.strictEqual(waiting.session?.targets[0]?.pause, "pending");
      assert.isFalse(waiting.quiet);
      const first = (yield* Ref.get(h.calls))[0]!;
      yield* Ref.update(h.runs, (runs) => runs.map((run) => ({ ...run, status: terminalStatus })));
      // Retry itself discovers the terminal queued run, without an intervening status read.
      const retried = yield* h.pause.retry;
      const calls = yield* Ref.get(h.calls);
      assert.strictEqual(calls.length, 2);
      assert.notStrictEqual(calls[1]!.messageId, first.messageId);
      assert.strictEqual(retried.observation, "known");
      assert.strictEqual(retried.session?.targets[0]?.pause, "pending");
      assert.strictEqual((yield* h.store.get)?.targets[0]?.pauseAttempt, 1);
      yield* Ref.update(h.runs, (runs) => runs.map((run) => ({ ...run, status: terminalStatus })));
      assert.strictEqual((yield* h.pause.status).session?.targets[0]?.pause, "failed");
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "follows a queued pause's later start effect and preserves an ambiguous native receipt",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* Ref.set(h.snapshot, shell([thread(a)]));
      yield* Ref.set(h.queued, true);
      yield* h.pause.start;
      const run = (yield* Ref.get(h.runs))[0]!;
      const startEffect = providerStartEffect(
        CommandId.make(`command:system:start-queued:${run.id}`),
        run.id,
      );
      yield* Ref.update(h.runs, (runs) => runs.map((run) => ({ ...run, status: "starting" })));
      yield* Ref.set(h.snapshot, shell([]));
      yield* Ref.set(h.pending, [{ threadId: a, providerMessage: true }]);
      yield* Ref.set(h.effects, [startEffect]);
      const starting = yield* h.pause.status;
      assert.strictEqual(starting.observation, "known");
      assert.strictEqual(starting.activeThreadCount, 1);
      yield* Ref.set(h.pending, []);
      yield* Ref.set(h.effects, [{ ...startEffect, status: "succeeded", attemptCount: 1 }]);
      const ambiguous = yield* h.pause.retry;
      assert.strictEqual(ambiguous.observation, "unknown");
      assert.isFalse(ambiguous.quiet);
      assert.strictEqual((yield* Ref.get(h.calls)).length, 1);
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each([
  { attemptCount: 0, observation: "known", delivery: "failed" },
  { attemptCount: 1, observation: "unknown", delivery: "pending" },
])("reconciles a cancelled queued start that was claimed $attemptCount times", (scenario) =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Ref.set(h.snapshot, shell([thread(a)]));
    yield* Ref.set(h.queued, true);
    yield* h.pause.start;
    const run = (yield* Ref.get(h.runs))[0]!;
    yield* Ref.update(h.runs, (runs) => runs.map((run) => ({ ...run, status: "cancelled" })));
    yield* Ref.set(h.effects, [
      {
        ...providerStartEffect(CommandId.make(`command:system:start-queued:${run.id}`), run.id),
        status: "cancelled" as const,
        attemptCount: scenario.attemptCount,
      },
    ]);
    const observed = yield* h.pause.status;
    assert.strictEqual(observed.observation, scenario.observation);
    assert.strictEqual(observed.session?.targets[0]?.pause, scenario.delivery);
    assert.isFalse(observed.quiet);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("does not resend a terminal queued run with durable native acceptance evidence", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Ref.set(h.snapshot, shell([thread(a)]));
    yield* Ref.set(h.queued, true);
    yield* h.pause.start;
    const rootNodeId = NodeId.make("node-example");
    yield* Ref.update(h.runs, (runs) =>
      runs.map((run) => ({ ...run, status: "failed", rootNodeId })),
    );
    yield* Ref.set(h.providerTurns, [nativeTurn(rootNodeId)]);
    const observed = yield* h.pause.retry;
    assert.strictEqual(observed.observation, "unknown");
    assert.strictEqual(observed.session?.targets[0]?.pause, "pending");
    assert.strictEqual((yield* Ref.get(h.calls)).length, 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("waits for provider-owned children but sends only to messageable threads", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const nativeChild = {
      ...thread(b),
      creationSource: "provider" as const,
      lineage: { ...thread(b).lineage, relationshipToParent: "subagent" as const },
    };
    const delegatedChild = {
      ...thread(c),
      creationSource: "mcp" as const,
      lineage: { ...thread(c).lineage, relationshipToParent: "subagent" as const },
    };
    yield* Ref.set(h.snapshot, shell([thread(a), nativeChild, delegatedChild]));
    const started = yield* h.pause.start;
    assert.deepEqual(
      started.session?.targets.map((target) => target.threadId),
      [a, c],
    );
    assert.deepEqual(
      (yield* Ref.get(h.calls)).map((call) => call.threadId),
      [a, c],
    );
    yield* Ref.set(h.snapshot, shell([nativeChild]));
    const waiting = yield* h.pause.status;
    assert.strictEqual(waiting.activeThreadCount, 1);
    assert.isFalse(waiting.quiet);
    yield* Ref.set(h.snapshot, shell([]));
    assert.isTrue((yield* h.pause.status).quiet);
  }).pipe(Effect.provide(testLayer)),
);
