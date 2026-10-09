import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
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
      listByCommandId: () => Effect.succeed([]),
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
        Effect.succeed({ messages: [] } as unknown as Awaited<
          Effect.Success<
            ReturnType<Threads.ThreadManagementService["Service"]["getProjectThreadRecords"]>
          >
        >),
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
          yield* store.recordDelivery(input.messageId, true);
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
