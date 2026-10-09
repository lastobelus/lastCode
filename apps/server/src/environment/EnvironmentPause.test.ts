import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  CommandId,
  NodeId,
  ProjectId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  ProviderSessionId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadShellSnapshot,
  type TerminalSummary,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
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
const shell = (
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
): OrchestrationV2ThreadShellSnapshot => ({
  schemaVersion: 2,
  snapshotSequence: 0,
  threads,
  archivedThreads: [],
});
const thread = (id: ThreadId, status = "running"): OrchestrationV2ThreadShell =>
  ({
    id,
    projectId,
    title: id,
    status,
    activityRunStatus: status === "running" ? "running" : null,
    activeRunId: status === "running" ? RunId.make(`run-${id}`) : null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    creationSource: "web",
    lineage: { relationshipToParent: null },
    archivedAt: null,
    deletedAt: null,
  }) as OrchestrationV2ThreadShell;

const harness = Effect.gen(function* () {
  const store = yield* Store.EnvironmentPauseStore;
  const enabled = yield* Ref.make(true);
  const snapshot = yield* Ref.make(shell([thread(a), thread(b), thread(c, "idle")]));
  const runtimeWork = yield* Ref.make<
    ReadonlyArray<{ providerSessionId: ProviderSessionId; status: "running" | "stopping" }>
  >([]);
  const pending = yield* Ref.make<ReadonlyArray<{ threadId: ThreadId }>>([]);
  const effects = yield* Ref.make<ReadonlyArray<EffectOutbox.OrchestrationEffectV2>>([]);
  const messages = yield* Ref.make<ReadonlyArray<OrchestrationV2ConversationMessage>>([]);
  const runs = yield* Ref.make<ReadonlyArray<OrchestrationV2Run>>([]);
  const providerTurns = yield* Ref.make<ReadonlyArray<OrchestrationV2ProviderTurn>>([]);
  const queued = yield* Ref.make(false);
  const terminals = yield* Ref.make<ReadonlyArray<TerminalSummary>>([]);
  const calls = yield* Ref.make<ReadonlyArray<Threads.ThreadManagementSendInput>>([]);
  const failures = yield* Ref.make(new Set<ThreadId>());
  const observationFailed = yield* Ref.make(false);
  const gate = yield* Ref.make<Deferred.Deferred<void> | null>(null);
  const entered = yield* Deferred.make<void>();
  const layers = Layer.mergeAll(
    Layer.succeed(Store.EnvironmentPauseStore, store),
    Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Ref.get(enabled).pipe(
        Effect.map((value) => ({ ...DEFAULT_SERVER_SETTINGS, environmentPauseEnabled: value })),
      ),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({ getShellSnapshot: () => Ref.get(snapshot) }),
    Layer.mock(EffectOutbox.EffectOutboxV2)({
      pendingCleanup: Effect.succeed([]),
      pendingExecution: Ref.get(pending),
      listByCommandId: (commandId) =>
        Ref.get(effects).pipe(
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
      getProjectThreadRecords: () =>
        Effect.gen(function* () {
          return {
            messages: yield* Ref.get(messages),
            runs: yield* Ref.get(runs),
            providerTurns: yield* Ref.get(providerTurns),
          } as Awaited<
            Effect.Success<
              ReturnType<Threads.ThreadManagementService["Service"]["getProjectThreadRecords"]>
            >
          >;
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
          if (yield* Ref.get(queued)) {
            const runId = RunId.make(`queued-${input.messageId}`);
            yield* Ref.update(messages, (previous) => [
              ...previous,
              { id: input.messageId, runId } as OrchestrationV2ConversationMessage,
            ]);
            yield* Ref.update(runs, (previous) => [
              ...previous,
              {
                id: runId,
                threadId: input.threadId,
                userMessageId: input.messageId,
                status: "queued",
                rootNodeId: null,
                activeAttemptId: null,
              } as OrchestrationV2Run,
            ]);
          } else yield* store.recordDelivery(input.messageId, true);
          return {} as Threads.ThreadManagementSendResult;
        }),
    }),
  );
  const pause = yield* Pause.EnvironmentPause.pipe(
    Effect.provide(Pause.layer.pipe(Layer.provide(layers))),
  );
  return {
    store,
    pause,
    enabled,
    snapshot,
    runtimeWork,
    terminals,
    calls,
    failures,
    observationFailed,
    pending,
    effects,
    messages,
    runs,
    providerTurns,
    queued,
    gate,
    entered,
    layers,
  };
});

const testLayer = Store.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "environment-pause-test-" })),
  Layer.provideMerge(NodeServices.layer),
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
      yield* Ref.set(h.pending, [{ threadId: a }]);
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
    yield* Ref.set(h.pending, [{ threadId: c }]);
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
      const startEffect = {
        commandId: CommandId.make(`command:system:start-queued:${run.id}`),
        request: { type: "provider-turn.start", runId: run.id },
        status: "pending",
        attemptCount: 0,
      } as EffectOutbox.OrchestrationEffectV2;
      yield* Ref.update(h.runs, (runs) => runs.map((run) => ({ ...run, status: "starting" })));
      yield* Ref.set(h.snapshot, shell([]));
      yield* Ref.set(h.pending, [{ threadId: a }]);
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
        commandId: CommandId.make(`command:system:start-queued:${run.id}`),
        request: { type: "provider-turn.start", runId: run.id },
        status: "cancelled",
        attemptCount: scenario.attemptCount,
      } as EffectOutbox.OrchestrationEffectV2,
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
    yield* Ref.set(h.providerTurns, [
      {
        nodeId: rootNodeId,
        nativeTurnRef: { driver: "codex", id: "native-turn-example" },
      } as OrchestrationV2ProviderTurn,
    ]);
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
