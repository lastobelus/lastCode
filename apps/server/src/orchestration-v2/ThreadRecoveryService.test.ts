import { assert, it } from "@effect/vitest";
import {
  RunId,
  NodeId,
  type OrchestrationV2ProviderTurn,
  RunAttemptId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as Recovery from "./ThreadRecoveryService.ts";
import type { ProviderAdapterV2TurnInspection } from "./ProviderAdapter.ts";

const identity = {
  threadId: ThreadId.make("thread:recovery"),
  runId: RunId.make("run:recovery"),
  attemptId: RunAttemptId.make("attempt:recovery"),
};
const terminal: ProviderAdapterV2TurnInspection = {
  status: "terminal",
  event: {
    type: "turn.terminal",
    driver: ProviderDriverKind.make("codex"),
    runOrdinal: 1,
    providerThreadId: ProviderThreadId.make("provider-thread:recovery"),
    providerTurnId: ProviderTurnId.make("provider-turn:recovery"),
    status: "completed",
    failure: null,
    threadDisposition: "reusable",
  },
};

function harness() {
  let thread = { id: identity.threadId } as OrchestrationV2AppThread;
  let run = {
    id: identity.runId,
    activeAttemptId: identity.attemptId,
    status: "running",
    ordinal: 1,
    startedAt: DateTime.makeUnsafe(0),
  } as OrchestrationV2Run;
  let laterRuns: OrchestrationV2Run[] = [];
  let finalizations = 0;
  let inspection: ProviderAdapterV2TurnInspection = { status: "active" };
  let finalizeFails = false;
  let beforeInspect = Effect.void;
  let beforeFinalize = Effect.void;
  let afterRecovering = Effect.void;
  let afterRepairLinked = Effect.void;
  let failedReceiptOutage = false;
  let projectionReads = 0;
  let hasProviderTurn = true;
  const providerTurn: OrchestrationV2ProviderTurn = {
    id: ProviderTurnId.make("provider-turn:recovery"),
    providerThreadId: ProviderThreadId.make("provider-thread:recovery"),
    nodeId: NodeId.make("node:recovery"),
    runAttemptId: identity.attemptId,
    nativeTurnRef: null,
    ordinal: 1,
    status: "running",
    startedAt: DateTime.makeUnsafe(0),
    completedAt: null,
  };
  const statuses: string[] = [];
  const layer = Recovery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        IdAllocator.layer,
        ThreadCommandExecutor.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRuntimeRecoveryProjection: () =>
            Effect.sync(() => {
              projectionReads++;
              return {
                thread,
                runs: [run, ...laterRuns],
                attempts: [],
                nodes: [],
                subagents: [],
                providerSessions: [],
                providerThreads: [],
                providerTurns: hasProviderTurn ? [providerTurn] : [],
                runtimeRequests: [],
                messages: [],
                turnItems: [],
              };
            }),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          writeIfRunCurrent: (input) =>
            Effect.sync(() => {
              const committed =
                input.activeAttemptId === run.activeAttemptId &&
                input.expectedStatus === run.status;
              if (committed)
                for (const event of input.events)
                  if (event.type === "thread.metadata-updated") {
                    if (event.payload.recovery?.status === "failed" && failedReceiptOutage)
                      throw new Error("database unavailable");
                    thread = event.payload;
                    statuses.push(thread.recovery!.status);
                  }
              return { committed, storedEvents: [] };
            }).pipe(
              Effect.flatMap((result) => {
                if (
                  input.events.some(
                    (event) =>
                      event.type === "thread.metadata-updated" &&
                      event.payload.recovery?.repairThreadId !== undefined &&
                      event.payload.recovery.status === "failed",
                  )
                )
                  return afterRepairLinked.pipe(Effect.as(result));
                return input.events.some(
                  (event) =>
                    event.type === "thread.metadata-updated" &&
                    event.payload.recovery?.status === "recovering",
                )
                  ? afterRecovering.pipe(Effect.as(result))
                  : Effect.succeed(result);
              }),
            ),
        }),
      ),
    ),
  );
  return {
    layer,
    statuses,
    get thread() {
      return thread;
    },
    get projectionReads() {
      return projectionReads;
    },
    get finalizations() {
      return finalizations;
    },
    inspect(value: ProviderAdapterV2TurnInspection) {
      inspection = value;
    },
    beforeInspect(effect: Effect.Effect<void>) {
      beforeInspect = effect;
    },
    afterRecovering(effect: Effect.Effect<void>) {
      afterRecovering = effect;
    },
    afterRepairLinked(effect: Effect.Effect<void>) {
      afterRepairLinked = effect;
    },
    beforeFinalize(effect: Effect.Effect<void>) {
      beforeFinalize = effect;
    },
    omitProviderTurn() {
      hasProviderTurn = false;
    },
    failFinalize() {
      finalizeFails = true;
    },
    setFailedReceiptOutage(value: boolean) {
      failedReceiptOutage = value;
    },
    supersede() {
      run = { ...run, activeAttemptId: RunAttemptId.make("attempt:new") };
    },
    addCancelledQueue() {
      laterRuns = [
        {
          ...run,
          id: RunId.make("run:cancelled"),
          ordinal: 2,
          startedAt: null,
          status: "cancelled",
        },
      ];
    },
    register: Effect.gen(function* () {
      const service = yield* Recovery.ThreadRecoveryService;
      yield* service.register({
        ...identity,
        inspect: Effect.suspend(() =>
          beforeInspect.pipe(Effect.andThen(Effect.sync(() => inspection))),
        ),
        finalize: (_terminal, receipt) =>
          beforeFinalize.pipe(
            Effect.andThen(
              Effect.suspend(() => {
                finalizations++;
                return finalizeFails
                  ? Effect.fail(
                      new Recovery.ThreadRecoveryError({
                        threadId: identity.threadId,
                        cause: "write failed",
                      }),
                    )
                  : Effect.sync(() => {
                      run = { ...run, status: "completed" };
                      for (const event of receipt)
                        if (event.type === "thread.metadata-updated") {
                          thread = event.payload;
                          statuses.push(thread.recovery!.status);
                        }
                    });
              }),
            ),
          ),
      });
      return service;
    }),
  };
}

it.effect("reconciles a confirmed terminal once and preserves cancelled queued runs", () => {
  const test = harness();
  test.inspect(terminal);
  test.addCancelledQueue();
  return Effect.gen(function* () {
    const service = yield* test.register;
    yield* service.suspect(identity);
    yield* service.reconcile;
    yield* service.reconcile;
    assert.equal(test.finalizations, 1);
    assert.deepEqual(test.statuses, ["suspect", "recovering", "recovered"]);
    assert.include(test.thread.recovery!.detail, "Some output may be missing");
  }).pipe(Effect.provide(test.layer));
});
it.effect("does not recover active or unknown turns automatically", () => {
  const test = harness();
  return Effect.gen(function* () {
    const service = yield* test.register;
    yield* service.suspect(identity);
    yield* service.reconcile;
    test.inspect({ status: "unknown" });
    yield* service.reconcile;
    assert.equal(test.finalizations, 0);
    assert.deepEqual(test.statuses, ["suspect", "failed"]);
    yield* service.recover(identity);
    assert.equal(test.thread.recovery?.status, "failed");
  }).pipe(Effect.provide(test.layer));
});
it.effect("leaves a superseding attempt untouched", () => {
  const test = harness();
  test.inspect(terminal);
  return Effect.gen(function* () {
    const service = yield* test.register;
    test.supersede();
    yield* service.reconcile;
    assert.equal(test.finalizations, 0);
    assert.deepEqual(test.statuses, []);
  }).pipe(Effect.provide(test.layer));
});
it.effect("exhausts deterministic recovery without repeatedly finalizing", () => {
  const test = harness();
  test.inspect(terminal);
  test.failFinalize();
  return Effect.gen(function* () {
    const service = yield* test.register;
    yield* service.reconcile;
    yield* service.reconcile;
    assert.equal(test.finalizations, 1);
    assert.equal(test.thread.recovery?.status, "failed");
    yield* service.withRepairableIncident(identity, (recordRepairThread) =>
      recordRepairThread(ThreadId.make("thread:repair")),
    );
    assert.equal(test.thread.recovery?.repairThreadId, "thread:repair");
  }).pipe(Effect.provide(test.layer));
});

it.effect.each(["unknown", "failed", "recovered"] as const)(
  "preserves the repair conversation when manual recovery returns %s",
  (outcome) => {
    const test = harness();
    test.inspect({ status: "unknown" });
    return Effect.gen(function* () {
      const service = yield* test.register;
      yield* service.reconcile;
      const repairThreadId = ThreadId.make("thread:existing-repair");
      yield* service.withRepairableIncident(identity, (recordRepairThread) =>
        recordRepairThread(repairThreadId),
      );
      if (outcome !== "unknown") test.inspect(terminal);
      if (outcome === "failed") test.failFinalize();
      const result = yield* Effect.exit(service.recover(identity));
      assert.equal(Exit.isFailure(result), outcome === "failed");
      assert.equal(test.thread.recovery?.status, outcome === "recovered" ? "recovered" : "failed");
      assert.equal(test.thread.recovery?.repairThreadId, repairThreadId);
      assert.equal(test.finalizations, outcome === "unknown" ? 0 : 1);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect("does not carry the repair conversation into a superseding incident", () => {
  const test = harness();
  test.inspect({ status: "unknown" });
  return Effect.gen(function* () {
    const service = yield* test.register;
    yield* service.reconcile;
    yield* service.withRepairableIncident(identity, (recordRepairThread) =>
      recordRepairThread(ThreadId.make("thread:old-repair")),
    );
    test.supersede();
    const successor = { ...identity, attemptId: RunAttemptId.make("attempt:new") };
    yield* service.register({
      ...successor,
      inspect: Effect.succeed({ status: "unknown" }),
      finalize: () => Effect.void,
    });
    yield* service.reconcile;
    assert.equal(test.thread.recovery?.attemptId, successor.attemptId);
    assert.isUndefined(test.thread.recovery?.repairThreadId);
  }).pipe(Effect.provide(test.layer));
});

it.effect("does not launch repair when manual recovery takes the incident first", () => {
  const test = harness();
  test.inspect({ status: "unknown" });
  return Effect.gen(function* () {
    const service = yield* test.register;
    yield* service.reconcile;
    const inspecting = yield* Deferred.make<void>();
    const finishInspection = yield* Deferred.make<void>();
    const launchStarted = yield* Deferred.make<void>();
    test.inspect(terminal);
    test.beforeInspect(
      Deferred.succeed(inspecting, undefined).pipe(
        Effect.andThen(Deferred.await(finishInspection)),
      ),
    );
    const recovery = yield* service.recover(identity).pipe(Effect.forkChild);
    yield* Deferred.await(inspecting);
    assert.equal(test.thread.recovery?.status, "failed");
    const repair = yield* service
      .withRepairableIncident(identity, (recordRepairThread) =>
        Deferred.succeed(launchStarted, undefined).pipe(
          Effect.andThen(recordRepairThread(ThreadId.make("thread:late-repair"))),
        ),
      )
      .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
    assert.isFalse(yield* Deferred.isDone(launchStarted));
    yield* Deferred.succeed(finishInspection, undefined);
    yield* Fiber.join(recovery);
    const result = yield* Fiber.join(repair);
    assert.isTrue(Exit.isFailure(result));
    assert.isFalse(yield* Deferred.isDone(launchStarted));
    assert.equal(test.finalizations, 1);
    assert.equal(test.thread.recovery?.status, "recovered");
    assert.isUndefined(test.thread.recovery?.repairThreadId);
  }).pipe(Effect.provide(test.layer));
});

it.effect("keeps manual recovery waiting until repair launch and linking finish", () => {
  const test = harness();
  test.inspect({ status: "unknown" });
  return Effect.gen(function* () {
    const service = yield* test.register;
    yield* service.reconcile;
    const launchStarted = yield* Deferred.make<void>();
    const finishLaunch = yield* Deferred.make<void>();
    const linking = yield* Deferred.make<void>();
    const finishLink = yield* Deferred.make<void>();
    const inspecting = yield* Deferred.make<void>();
    const repairThreadId = ThreadId.make("thread:serialized-repair");
    test.inspect(terminal);
    test.beforeInspect(
      Effect.sync(() => {
        assert.equal(test.thread.recovery?.repairThreadId, repairThreadId);
      }).pipe(Effect.andThen(Deferred.succeed(inspecting, undefined))),
    );
    test.afterRepairLinked(
      Deferred.succeed(linking, undefined).pipe(Effect.andThen(Deferred.await(finishLink))),
    );
    const repair = yield* service
      .withRepairableIncident(identity, (recordRepairThread) =>
        Deferred.succeed(launchStarted, undefined).pipe(
          Effect.andThen(Deferred.await(finishLaunch)),
          Effect.andThen(recordRepairThread(repairThreadId)),
        ),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(launchStarted);
    const recovery = yield* service
      .recover(identity)
      .pipe(Effect.forkChild({ startImmediately: true }));
    assert.isFalse(yield* Deferred.isDone(inspecting));
    assert.equal(test.finalizations, 0);
    yield* Deferred.succeed(finishLaunch, undefined);
    yield* Deferred.await(linking);
    assert.isFalse(yield* Deferred.isDone(inspecting));
    assert.equal(test.thread.recovery?.status, "failed");
    yield* Deferred.succeed(finishLink, undefined);
    yield* Fiber.join(repair);
    yield* Fiber.join(recovery);
    assert.isTrue(yield* Deferred.isDone(inspecting));
    assert.equal(test.finalizations, 1);
    assert.equal(test.thread.recovery?.status, "recovered");
    assert.equal(test.thread.recovery?.repairThreadId, repairThreadId);
  }).pipe(Effect.provide(test.layer));
});

it.effect("rejects a stale repair before launching against a newer failed incident", () => {
  const test = harness();
  test.inspect({ status: "unknown" });
  return Effect.gen(function* () {
    const service = yield* test.register;
    yield* service.reconcile;
    test.supersede();
    const successor = { ...identity, attemptId: RunAttemptId.make("attempt:new") };
    yield* service.register({
      ...successor,
      inspect: Effect.succeed({ status: "unknown" }),
      finalize: () => Effect.void,
    });
    yield* service.reconcile;
    let launched = false;
    const result = yield* Effect.exit(
      service.withRepairableIncident(identity, () =>
        Effect.sync(() => {
          launched = true;
        }),
      ),
    );
    assert.isTrue(Exit.isFailure(result));
    assert.isFalse(launched);
    assert.equal(test.thread.recovery?.attemptId, successor.attemptId);
    assert.isUndefined(test.thread.recovery?.repairThreadId);
  }).pipe(Effect.provide(test.layer));
});

it.effect(
  "retries a failed receipt after a database outage without repeating deterministic recovery",
  () => {
    const test = harness();
    test.inspect(terminal);
    test.failFinalize();
    test.setFailedReceiptOutage(true);
    return Effect.gen(function* () {
      const service = yield* test.register;
      yield* service.reconcile;
      assert.equal(test.finalizations, 1);
      assert.equal(test.thread.recovery?.status, "recovering");
      test.setFailedReceiptOutage(false);
      yield* service.reconcile;
      assert.equal(test.finalizations, 1);
      assert.equal(test.thread.recovery?.status, "failed");
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect("does not query projections for a healthy active consumer", () => {
  const test = harness();
  return Effect.gen(function* () {
    const service = yield* test.register;
    const reads = test.projectionReads;
    yield* service.reconcile;
    yield* service.reconcile;
    assert.equal(test.projectionReads, reads);
    assert.equal(test.finalizations, 0);
  }).pipe(Effect.provide(test.layer));
});

it.effect("publishes exhaustion even when the initial suspect receipt was never saved", () => {
  const test = harness();
  test.inspect({ status: "unknown" });
  return Effect.gen(function* () {
    const service = yield* test.register;
    const initialRecovery = test.thread.recovery;
    assert.isUndefined(initialRecovery);
    yield* service.reconcile;
    assert.equal(test.finalizations, 0);
    assert.equal(test.thread.recovery?.status, "failed");
    yield* service.withRepairableIncident(identity, () => Effect.void);
  }).pipe(Effect.provide(test.layer));
});

it.effect(
  "does not overwrite recovery with a suspect publication queued behind finalization",
  () => {
    const test = harness();
    test.inspect(terminal);
    return Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      test.beforeFinalize(
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      );
      const service = yield* test.register;
      const recovery = yield* service.reconcile.pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const suspect = yield* service.suspect(identity).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(recovery);
      yield* Fiber.join(suspect);
      assert.deepEqual(test.statuses, ["recovering", "recovered"]);
      assert.equal(test.thread.recovery?.status, "recovered");
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect(
  "keeps exhausted recovery when a suspect publication is queued behind failed finalization",
  () => {
    const test = harness();
    test.inspect(terminal);
    test.failFinalize();
    return Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      test.beforeFinalize(
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      );
      const service = yield* test.register;
      const recovery = yield* service.reconcile.pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const suspect = yield* service.suspect(identity).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(recovery);
      yield* Fiber.join(suspect);
      assert.deepEqual(test.statuses, ["recovering", "failed"]);
      yield* service.reconcile;
      assert.equal(test.finalizations, 1);
      assert.equal(test.thread.recovery?.status, "failed");
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect("does not report recovery when the matching provider turn was never saved", () => {
  const test = harness();
  test.inspect(terminal);
  test.omitProviderTurn();
  return Effect.gen(function* () {
    const service = yield* test.register;
    yield* service.reconcile;
    assert.equal(test.finalizations, 0);
    assert.deepEqual(test.statuses, ["failed"]);
    assert.include(test.thread.recovery!.detail, "provider-turn record is missing");
    yield* service.withRepairableIncident(identity, () => Effect.void);
  }).pipe(Effect.provide(test.layer));
});

it.effect(
  "keeps a successor registered when it supersedes recovery before finalization rechecks ownership",
  () => {
    const test = harness();
    test.inspect(terminal);
    return Effect.gen(function* () {
      const published = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      test.afterRecovering(
        Deferred.succeed(published, undefined).pipe(Effect.andThen(Deferred.await(release))),
      );
      const service = yield* test.register;
      const oldRecovery = yield* service.reconcile.pipe(Effect.forkChild);
      yield* Deferred.await(published);
      test.supersede();
      const successor = { ...identity, attemptId: RunAttemptId.make("attempt:new") };
      yield* service.register({
        ...successor,
        inspect: Effect.succeed({ status: "unknown" }),
        finalize: () => Effect.void,
      });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(oldRecovery);
      yield* service.reconcile;
      assert.equal(test.finalizations, 0);
      assert.equal(test.thread.recovery?.status, "failed");
      assert.equal(test.thread.recovery?.attemptId, successor.attemptId);
      yield* service.withRepairableIncident(successor, () => Effect.void);
    }).pipe(Effect.provide(test.layer));
  },
);
