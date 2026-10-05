import { assert, it } from "@effect/vitest";
import {
  RunId,
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
  let beforeFinalize = Effect.void;
  let failedReceiptOutage = false;
  let projectionReads = 0;
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
                providerTurns: [],
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
            }),
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
    beforeFinalize(effect: Effect.Effect<void>) {
      beforeFinalize = effect;
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
        inspect: Effect.sync(() => inspection),
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
    yield* service.recordRepairThread({
      ...identity,
      repairThreadId: ThreadId.make("thread:repair"),
    });
    assert.equal(test.thread.recovery?.repairThreadId, "thread:repair");
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
    assert.isUndefined(test.thread.recovery);
    yield* service.reconcile;
    assert.equal(test.finalizations, 0);
    assert.equal(test.thread.recovery?.status, "failed");
    yield* service.assertRepairable(identity);
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
