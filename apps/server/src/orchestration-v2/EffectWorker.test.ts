import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  NodeId,
  EnvironmentPauseError,
  MessageId,
  ProjectId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  VcsProcessExitError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "./ProviderTurnStartService.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";
import * as ThreadTitleRegenerationService from "./ThreadTitleRegenerationService.ts";
import * as IncomingMessageSummaryService from "./IncomingMessageSummaryService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as SubagentPromotionService from "./SubagentPromotionService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PauseStore from "../environment/EnvironmentPauseStore.ts";

const threadId = ThreadId.make("thread:effect-worker-restart");
const oldSessionId = ProviderSessionId.make("provider-session:effect-worker-restart:old");
const providerThreadId = ProviderThreadId.make("provider-thread:effect-worker-restart");
const providerTurnId = ProviderTurnId.make("provider-turn:effect-worker-restart");
const attemptId = RunAttemptId.make("run-attempt:effect-worker-restart");
const runId = RunId.make("run:effect-worker-restart");

function restartEffect(
  now: DateTime.Utc,
  sessionTransition: NonNullable<
    Extract<
      EffectOutbox.OrchestrationEffectV2["request"],
      { readonly type: "provider-turn.restart" }
    >["sessionTransition"]
  >,
): EffectOutbox.OrchestrationEffectV2 {
  const timestamp = DateTime.formatIso(now);
  return {
    id: `effect:restart:${sessionTransition.type}`,
    commandId: CommandId.make(`command:restart:${sessionTransition.type}`),
    threadId,
    request: {
      type: "provider-turn.restart",
      providerSessionId: oldSessionId,
      providerThreadId,
      providerTurnId,
      interruptedAttemptId: attemptId,
      runId,
      sessionTransition,
    },
    status: "running",
    attemptCount: 1,
    availableAt: timestamp,
    leaseOwner: "test-worker",
    leaseExpiresAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    lastError: null,
  };
}

function layerExecutorFor(input: {
  readonly events: Ref.Ref<ReadonlyArray<string>>;
  readonly failFirstStart?: Ref.Ref<boolean>;
  readonly threads?: Partial<ThreadManagementService.ThreadManagementService["Service"]>;
  readonly continueAfterRestart?: boolean;
  readonly interrupt?: ProviderTurnControlService.ProviderTurnControlServiceV2Shape["interrupt"];
  readonly rollback?: CheckpointRollbackService.CheckpointRollbackServiceV2Shape["execute"];
  readonly respond?: RuntimeRequestService.RuntimeRequestServiceV2["Service"]["respond"];
  readonly steer?: ProviderTurnControlService.ProviderTurnControlServiceV2Shape["steer"];
  readonly outbox?: Partial<EffectOutbox.EffectOutboxV2Shape>;
  readonly start?: ProviderTurnStartService.ProviderTurnStartServiceV2Shape["start"];
}) {
  const record = (event: string) => Ref.update(input.events, (events) => [...events, event]);
  const layerDependencies = Layer.mergeAll(
    Layer.mock(IncomingMessageSummaryService.IncomingMessageSummaryService)({
      execute: () => Effect.void,
    }),
    Layer.mock(SubagentPromotionService.SubagentPromotionService)({ execute: () => Effect.void }),
    Layer.succeed(
      ProviderTurnControlService.ProviderTurnControlServiceV2,
      ProviderTurnControlService.ProviderTurnControlServiceV2.of({
        interrupt: input.interrupt ?? (() => Effect.void),
        steer: input.steer ?? (() => Effect.void),
        interruptAndAwaitTerminal: (request) =>
          record(
            request.replacementProviderSessionId === undefined
              ? "interrupt"
              : `interrupt:${request.replacementProviderSessionId}`,
          ),
      }),
    ),
    Layer.succeed(
      ProviderSessionManager.ProviderSessionManagerV2,
      ProviderSessionManager.ProviderSessionManagerV2.of({
        shutdown: Effect.void,
        open: () => Effect.die("unused open"),
        get: () => Effect.succeed(Option.none()),
        isLive: () => Effect.succeed(false),
        pendingExecution: Effect.succeed([]),
        ownershipRevision: Effect.succeed(0),
        workspaceOwnership: Effect.succeed([]),
        close: () => Effect.void,
        closeInstance: () => Effect.void,
        teardownThread: () => Effect.die("unused teardownThread"),
        release: () => record("release"),
        detach: () => record("detach"),
      }),
    ),
    Layer.succeed(
      ProviderTurnStartService.ProviderTurnStartServiceV2,
      ProviderTurnStartService.ProviderTurnStartServiceV2.of({
        start:
          input.start ??
          (() =>
            Effect.gen(function* () {
              yield* record("start");
              if (
                input.failFirstStart !== undefined &&
                (yield* Ref.getAndSet(input.failFirstStart, false))
              ) {
                return yield* new ProviderTurnStartService.ProviderTurnStartError({
                  runId,
                  cause: "simulated first start failure",
                });
              }
            })),
      }),
    ),
    Layer.succeed(
      RunFinalizationService.RunFinalizationService,
      RunFinalizationService.RunFinalizationService.of({ finalize: () => Effect.void }),
    ),
    Layer.succeed(
      CheckpointRollbackService.CheckpointRollbackServiceV2,
      CheckpointRollbackService.CheckpointRollbackServiceV2.of({
        execute: input.rollback ?? (() => Effect.void),
      }),
    ),
    Layer.succeed(
      RuntimeRequestService.RuntimeRequestServiceV2,
      RuntimeRequestService.RuntimeRequestServiceV2.of({
        respond: input.respond ?? (() => Effect.void),
      }),
    ),
    Layer.succeed(
      ThreadTitleRegenerationService.ThreadTitleRegenerationService,
      ThreadTitleRegenerationService.ThreadTitleRegenerationService.of({
        execute: () => Effect.void,
      }),
    ),
  );
  return EffectWorker.layerExecutor.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerDependencies,
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          enqueue: () => Effect.void,
          notifyAvailable: () => Effect.void,
          ...input.outbox,
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)(input.threads ?? {}),
        ServerSettings.layerTest(
          input.continueAfterRestart === true ? { continueThreadsAfterServerUpdate: true } : {},
        ),
      ),
    ),
  );
}

const layerReceiptTest = Layer.mergeAll(PauseStore.layer, EffectOutbox.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerConfig),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "pause-receipt-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const receiptHarness = Effect.fnUntraced(function* (
  direction: "pause" | "resume",
  delivered: boolean | null,
) {
  const store = yield* PauseStore.EnvironmentPauseStore;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const now = yield* DateTime.now;
  const timestamp = DateTime.formatIso(now);
  const session: PauseStore.StoredSession = {
    id: "session-example",
    phase: direction === "pause" ? "pausing" : "resuming",
    createdAt: timestamp,
    targets: [
      {
        threadId,
        projectId: ProjectId.make("project-example"),
        title: "Example thread",
        pause: direction === "pause" ? "pending" : "sent",
        resume: "pending",
        pauseAttempt: 0,
        resumeAttempt: 0,
        pauseAccepted: true,
        resumeAccepted: direction === "resume",
        error: null,
      },
    ],
  };
  yield* store.update(() => session);
  const { commandId, messageId } = PauseStore.deliveryIdentity(
    session,
    session.targets[0]!,
    direction,
  );
  const sourceId = "effect:pause-native-start";
  yield* outbox.enqueue([
    {
      id: sourceId,
      commandId,
      threadId,
      request: { type: "provider-turn.start", runId },
    },
  ]);
  const events = yield* Ref.make<ReadonlyArray<string>>([]);
  const outage = yield* Ref.make(true);
  const persistenceFailed = yield* Deferred.make<void>();
  const nativeCalls = yield* Ref.make(0);
  const failingStore = PauseStore.EnvironmentPauseStore.of({
    ...store,
    recordDelivery: (id, received) =>
      Ref.get(outage).pipe(
        Effect.flatMap((failed) =>
          failed
            ? Deferred.succeed(persistenceFailed, undefined).pipe(
                Effect.andThen(
                  Effect.fail(
                    new EnvironmentPauseError({ operation: "persist", reason: "unavailable" }),
                  ),
                ),
              )
            : store.recordDelivery(id, received),
        ),
      ),
  });
  const executorLayer = (receiptStore = failingStore, receiptOutbox = outbox) =>
    layerExecutorFor({
      events,
      outbox: receiptOutbox,
      start: (input) =>
        Effect.gen(function* () {
          yield* Ref.update(nativeCalls, (count) => count + 1);
          if (delivered === null) {
            return yield* new ProviderTurnStartService.ProviderTurnStartError({
              runId,
              cause: "Native acknowledgement was lost.",
            });
          }
          yield* input.onMessageDelivery?.(messageId, delivered) ?? Effect.void;
        }),
    }).pipe(Layer.provide(Layer.succeed(PauseStore.EnvironmentPauseStore, receiptStore)));
  const runOnce = (receiptStore = failingStore, receiptOutbox = outbox) =>
    EffectWorker.OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((worker) => worker.runOnce),
      Effect.provide(
        EffectWorker.layerWithOptions({ workerId: "receipt-worker", maxAttempts: 1 }).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(EffectOutbox.EffectOutboxV2, receiptOutbox),
              Layer.succeed(PauseStore.EnvironmentPauseStore, receiptStore),
              executorLayer(receiptStore, receiptOutbox),
            ),
          ),
        ),
      ),
    );
  return {
    store,
    outbox,
    outage,
    persistenceFailed,
    nativeCalls,
    session,
    messageId,
    commandId,
    sourceId,
    runOnce,
  };
});

it.effect.each([
  { direction: "pause" as const, delivered: true },
  { direction: "resume" as const, delivered: true },
  { direction: "pause" as const, delivered: false },
  { direction: "resume" as const, delivered: false },
])(
  "recovers $direction receipt ($delivered) after persistence failure and restart without another send",
  (input) =>
    Effect.gen(function* () {
      const h = yield* receiptHarness(input.direction, input.delivered);
      assert.isTrue(yield* h.runOnce());
      assert.equal((yield* h.store.get)?.targets[0]?.[input.direction], "pending");
      const journal = (yield* h.outbox.listByCommandId(h.commandId)).find(
        (row) => row.request.type === "environment-pause.record-delivery",
      );
      assert.isDefined(journal);
      assert.equal((yield* h.outbox.get(h.sourceId)).pipe(Option.getOrThrow).status, "succeeded");
      // Even the final ordinary attempt must leave receipt-only work recoverable.
      assert.isTrue(yield* h.runOnce());
      const retry = (yield* h.outbox.get(journal!.id)).pipe(Option.getOrThrow);
      assert.equal(retry.status, "pending");
      assert.equal(retry.attemptCount, 1);
      yield* TestClock.adjust("100 millis");
      const claimed = yield* h.outbox.claimNext({
        workerId: "ended-process",
        leaseDurationMs: 30_000,
      });
      assert.equal(Option.getOrThrow(claimed).id, journal!.id);
      // Construct fresh services from persisted state and reconcile the old lease.
      yield* Effect.gen(function* () {
        const restartedOutbox = yield* EffectOutbox.EffectOutboxV2;
        const restartedStore = yield* PauseStore.EnvironmentPauseStore;
        assert.equal((yield* restartedStore.get)?.targets[0]?.[input.direction], "pending");
        assert.deepEqual(yield* restartedOutbox.reconcileAfterProcessLoss, {
          requeued: 1,
          cancelled: 0,
        });
        assert.isTrue(yield* h.runOnce(restartedStore, restartedOutbox));
        assert.equal(
          (yield* restartedStore.get)?.targets[0]?.[input.direction],
          input.delivered ? "sent" : "failed",
        );
        assert.isFalse(yield* h.runOnce(restartedStore, restartedOutbox));
      }).pipe(Effect.provide(Layer.fresh(Layer.mergeAll(PauseStore.layer, EffectOutbox.layer))));
      const finalStore = yield* PauseStore.EnvironmentPauseStore.pipe(
        Effect.provide(Layer.fresh(PauseStore.layer)),
      );
      assert.equal(
        (yield* finalStore.get)?.targets[0]?.[input.direction],
        input.delivered ? "sent" : "failed",
      );
      assert.equal(yield* Ref.get(h.nativeCalls), 1);
    }).pipe(Effect.provide(layerReceiptTest)),
);

it.effect("does not turn an ambiguous native outcome into a durable receipt", () =>
  Effect.gen(function* () {
    const h = yield* receiptHarness("pause", null);
    assert.isTrue(yield* h.runOnce());
    yield* Ref.set(h.outage, false);
    assert.isFalse(yield* h.runOnce());
    assert.equal((yield* h.store.get)?.targets[0]?.pause, "pending");
    assert.deepEqual(
      (yield* h.outbox.listByCommandId(h.commandId)).map((row) => row.request.type),
      ["provider-turn.start"],
    );
    assert.equal(yield* Ref.get(h.nativeCalls), 1);
  }).pipe(Effect.provide(layerReceiptTest)),
);

it.effect("ignores a recovered receipt for an older pause attempt", () =>
  Effect.gen(function* () {
    const h = yield* receiptHarness("pause", true);
    yield* h.runOnce();
    yield* h.store.update((session) =>
      session === null
        ? session
        : {
            ...session,
            targets: session.targets.map((target) => ({
              ...target,
              pauseAttempt: 1,
              pauseAccepted: false,
            })),
          },
    );
    const restartedStore = yield* PauseStore.EnvironmentPauseStore.pipe(
      Effect.provide(Layer.fresh(PauseStore.layer)),
    );
    yield* h.runOnce(restartedStore);
    assert.equal((yield* restartedStore.get)?.targets[0]?.pause, "pending");
    assert.isFalse((yield* restartedStore.get)?.targets[0]?.pauseAccepted);
    assert.equal(yield* Ref.get(h.nativeCalls), 1);
  }).pipe(Effect.provide(layerReceiptTest)),
);

it.effect("retries a failed receipt journal write without repeating the native start", () =>
  Effect.gen(function* () {
    const h = yield* receiptHarness("pause", true);
    const failed = yield* Deferred.make<void>();
    const attempts = yield* Ref.make(0);
    const receiptOutbox = EffectOutbox.EffectOutboxV2.of({
      ...h.outbox,
      enqueue: (effects) =>
        Effect.gen(function* () {
          if ((yield* Ref.updateAndGet(attempts, (count) => count + 1)) === 1) {
            yield* Deferred.succeed(failed, undefined);
            return yield* new EffectOutbox.EffectOutboxError({
              operation: "enqueue",
              cause: "Temporary journal outage.",
            });
          }
          yield* h.outbox.enqueue(effects);
        }),
    });
    const running = yield* h.runOnce(undefined, receiptOutbox).pipe(Effect.forkChild);
    yield* Deferred.await(failed);
    yield* Deferred.await(h.persistenceFailed);
    assert.equal((yield* h.store.get)?.targets[0]?.pause, "pending");
    yield* Ref.set(h.outage, false);
    yield* TestClock.adjust("1 second");
    assert.isTrue(yield* Fiber.join(running));
    assert.equal((yield* h.store.get)?.targets[0]?.pause, "sent");
    assert.equal(yield* Ref.get(h.nativeCalls), 1);
    assert.equal(yield* Ref.get(attempts), 2);
  }).pipe(Effect.provide(layerReceiptTest)),
);

it.effect("persists the native receipt directly when only the journal write fails", () =>
  Effect.gen(function* () {
    const h = yield* receiptHarness("pause", true);
    const receiptOutbox = EffectOutbox.EffectOutboxV2.of({
      ...h.outbox,
      enqueue: () =>
        Effect.fail(
          new EffectOutbox.EffectOutboxError({
            operation: "enqueue",
            cause: "Temporary journal outage.",
          }),
        ),
    });
    assert.isTrue(yield* h.runOnce(h.store, receiptOutbox));
    const restartedStore = yield* PauseStore.EnvironmentPauseStore.pipe(
      Effect.provide(Layer.fresh(PauseStore.layer)),
    );
    assert.equal((yield* restartedStore.get)?.targets[0]?.pause, "sent");
    assert.equal(yield* Ref.get(h.nativeCalls), 1);
  }).pipe(Effect.provide(layerReceiptTest)),
);

it.effect.each([
  { label: "the target completes", fields: { turnCompleted: true } },
  {
    label: "the active target rejects steering",
    fields: { turnCompleted: false, deliveryRejected: true },
  },
])("settles native-only steering without a follow-up when $label", (rejection) =>
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const layerExecutor = layerExecutorFor({
      events,
      steer: () =>
        Effect.fail(
          new ProviderTurnControlService.ProviderTurnControlError({
            threadId,
            operation: "steer",
            providerTurnId,
            ...rejection.fields,
          }),
        ),
      threads: {
        getThreadRecords: () => Effect.die("strict steering must not read follow-up state"),
        dispatch: () => Effect.die("strict steering must not dispatch a follow-up"),
      },
    });
    const now = yield* DateTime.now;
    const effect: EffectOutbox.OrchestrationEffectV2 = {
      ...restartEffect(now, { type: "detach" }),
      request: {
        type: "provider-turn.steer",
        nativeOnly: true,
        providerSessionId: oldSessionId,
        providerThreadId,
        providerTurnId,
        messageId: MessageId.make("native-only-steer"),
      },
    };
    const layerOutbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
      claimNext: () => Effect.succeed(Option.some(effect)),
      get: () => Effect.succeed(Option.some(effect)),
      awaitCancellation: () => Effect.never,
      clearCancellation: () => Effect.void,
      succeed: () =>
        Ref.update(events, (existing) => [...existing, "succeeded"]).pipe(Effect.as(true)),
      retry: () => Effect.die("a terminal non-delivery must not retry"),
      fail: () => Effect.die("a terminal non-delivery must not leave a failed outbox row"),
    });
    yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((worker) => worker.runOnce),
      Effect.provide(
        EffectWorker.layerWithOptions({ workerId: "test-worker" }).pipe(
          Layer.provide(Layer.merge(layerOutbox, layerExecutor)),
        ),
      ),
    );
    assert.deepEqual(yield* Ref.get(events), ["succeeded"]);
  }),
);

it.effect("preserves an unclassified native steering failure", () =>
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const executor = yield* EffectWorker.OrchestrationEffectExecutorV2.pipe(
      Effect.provide(
        layerExecutorFor({
          events,
          steer: () =>
            Effect.fail(
              new ProviderTurnControlService.ProviderTurnControlError({
                threadId,
                operation: "steer",
                providerTurnId,
                turnCompleted: false,
                cause: "transient connection failure",
              }),
            ),
        }),
      ),
    );
    const error = yield* executor
      .execute({
        ...restartEffect(yield* DateTime.now, { type: "detach" }),
        request: {
          type: "provider-turn.steer",
          nativeOnly: true,
          providerSessionId: oldSessionId,
          providerThreadId,
          providerTurnId,
          messageId: MessageId.make("native-transient-steer"),
        },
      })
      .pipe(Effect.flip);
    assert.instanceOf(error, EffectWorker.OrchestrationEffectExecutionError);
    assert.deepEqual(yield* Ref.get(events), []);
  }),
);

it.effect("settles a stopped run when its adapter has already lost the native turn", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const layer = layerExecutorFor({
      events,
      interrupt: () =>
        new ProviderTurnControlService.ProviderTurnControlError({
          threadId,
          operation: "interrupt",
          providerTurnId,
          cause: "Provider turn is not active.",
        }),
      threads: {
        dispatch: (command) =>
          Ref.update(events, (current) => [...current, command.type]).pipe(
            Effect.as({ sequence: 1, storedEvents: [] }),
          ),
      },
    });
    yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      yield* executor.execute({
        ...restartEffect(now, { type: "detach" }),
        request: {
          type: "provider-turn.interrupt",
          providerSessionId: oldSessionId,
          providerThreadId,
          providerTurnId,
        },
      });
    }).pipe(Effect.provide(layer));
    assert.deepEqual(yield* Ref.get(events), ["thread.background-work.settle"]);
  }),
);

const lockedIndexMessage =
  "Git's index is locked. Wait for other Git operations to finish, then try again.";
const rollbackCheckpointId = CheckpointId.make("checkpoint:effect-worker-rollback");
const rollbackScopeId = CheckpointScopeId.make("checkpoint-scope:effect-worker-rollback");
const restoreFailure = (detail: string) =>
  new CheckpointRollbackService.CheckpointRollbackExecutionError({
    reason: "unexpected-failure",
    threadId,
    providerThreadId,
    checkpointId: rollbackCheckpointId,
    cause: new CheckpointService.CheckpointRestoreError({
      scopeId: rollbackScopeId,
      checkpointId: rollbackCheckpointId,
      cause: new VcsProcessExitError({
        operation: "GitVcsDriverCore.restoreCheckpoint",
        command: "git",
        cwd: "/private/repo",
        exitCode: 128,
        detail,
        failureKind: "command-failed",
      }),
    }),
  });

it.effect.each([
  {
    name: "a held Git index lock",
    failure: restoreFailure(lockedIndexMessage),
    message: lockedIndexMessage,
  },
  {
    name: "raw Git output",
    failure: restoreFailure("error: could not clean /private/repo/secret.txt"),
    message: CheckpointRollbackService.ROLLBACK_FAILED_MESSAGE,
  },
])("reports a rollback blocked by $name only after the last attempt", ({ failure, message }) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const failures = yield* Ref.make<ReadonlyArray<string>>([]);
    const layer = layerExecutorFor({
      events: yield* Ref.make<ReadonlyArray<string>>([]),
      rollback: () => Effect.fail(failure),
      threads: {
        dispatch: (command) =>
          Ref.update(failures, (current) =>
            command.type === "checkpoint.rollback.fail" ? [...current, command.message] : current,
          ).pipe(Effect.as({ sequence: 1, storedEvents: [] })),
      },
    });
    yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      const rollback: EffectOutbox.OrchestrationEffectV2 = {
        ...restartEffect(now, { type: "detach" }),
        request: {
          type: "provider-thread.rollback",
          providerThreadId,
          checkpointId: rollbackCheckpointId,
          scopeId: rollbackScopeId,
          restoreFiles: true,
        },
      };
      yield* Effect.flip(executor.execute(rollback, { willRetry: true }));
      assert.deepEqual(yield* Ref.get(failures), []);
      yield* Effect.flip(executor.execute(rollback, { willRetry: false }));
    }).pipe(Effect.provide(layer));
    assert.deepEqual(yield* Ref.get(failures), [message]);
  }),
);

it.effect("does not report an answer whose last delivery attempt is interrupted", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const reported = yield* Ref.make(0);
    const layer = layerExecutorFor({
      events: yield* Ref.make<ReadonlyArray<string>>([]),
      respond: () => Effect.interrupt,
      threads: {
        dispatch: (command) =>
          Ref.update(reported, (count) =>
            command.type === "runtime-request.delivery.fail" ? count + 1 : count,
          ).pipe(Effect.as({ sequence: 1, storedEvents: [] })),
      },
    });
    const exit = yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      return yield* Effect.exit(
        executor.execute(
          {
            ...restartEffect(now, { type: "detach" }),
            request: {
              type: "runtime-request.respond",
              providerSessionId: oldSessionId,
              requestId: RuntimeRequestId.make("runtime-request:effect-worker-interrupted"),
              answers: { next: "Ship it" },
            },
          },
          { willRetry: false },
        ),
      );
    }).pipe(Effect.provide(layer));
    assert.isTrue(Exit.hasInterrupts(exit));
    assert.equal(yield* Ref.get(reported), 0);
  }),
);

it.effect("requeues a claim when a pre-execution worker check fails", () =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const effectId = "effect:worker-pre-execution-failure";
    const workerId = "worker-pre-execution-failure";
    const claimedEffect: EffectOutbox.OrchestrationEffectV2 = {
      id: effectId,
      commandId: CommandId.make("command:worker-pre-execution-failure"),
      threadId: ThreadId.make("thread:worker-pre-execution-failure"),
      request: { type: "terminal.cleanup" },
      status: "running",
      attemptCount: 1,
      availableAt: now,
      leaseOwner: workerId,
      leaseExpiresAt: now,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };
    const retries = yield* Ref.make<
      ReadonlyArray<{
        readonly effectId: string;
        readonly workerId: string;
        readonly error: string;
        readonly delayMs: number;
      }>
    >([]);
    const executionCount = yield* Ref.make(0);
    const layerOutbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
      claimNext: () => Effect.succeed(Option.some(claimedEffect)),
      get: () =>
        Effect.fail(
          new EffectOutbox.EffectOutboxError({
            operation: "get",
            effectId,
            cause: "simulated cancellation-state read failure",
          }),
        ),
      retry: (input) =>
        Ref.update(retries, (existing) => [...existing, input]).pipe(Effect.as(true)),
    });
    const layerExecutor = Layer.succeed(
      EffectWorker.OrchestrationEffectExecutorV2,
      EffectWorker.OrchestrationEffectExecutorV2.of({
        execute: () => Ref.update(executionCount, (count) => count + 1),
      }),
    );
    const layerWorker = EffectWorker.layerWithOptions({ workerId }).pipe(
      Layer.provide(Layer.merge(layerOutbox, layerExecutor)),
    );

    const exit = yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((worker) => worker.runOnce),
      Effect.provide(layerWorker),
      Effect.exit,
    );

    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      assert.include(Cause.pretty(exit.cause), "simulated cancellation-state read failure");
    }
    assert.equal(yield* Ref.get(executionCount), 0);
    const retry = (yield* Ref.get(retries))[0];
    assert.isDefined(retry);
    assert.equal(retry.effectId, effectId);
    assert.equal(retry.workerId, workerId);
    assert.equal(retry.delayMs, 0);
    assert.include(retry.error, "simulated cancellation-state read failure");
  }),
);

it.effect("arms cancellation before the durable pre-execution check", () =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const effectId = "effect:worker-cancellation-registration-race";
    const workerId = "worker-cancellation-registration-race";
    const claimedEffect: EffectOutbox.OrchestrationEffectV2 = {
      id: effectId,
      commandId: CommandId.make("command:worker-cancellation-registration-race"),
      threadId: ThreadId.make("thread:worker-cancellation-registration-race"),
      request: { type: "terminal.cleanup" },
      status: "running",
      attemptCount: 1,
      availableAt: now,
      leaseOwner: workerId,
      leaseExpiresAt: now,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };
    const signal = yield* Deferred.make<void>();
    let cancellationArmed = false;
    const executionCount = yield* Ref.make(0);
    const settlementCount = yield* Ref.make(0);
    const layerOutbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
      claimNext: () => Effect.succeed(Option.some(claimedEffect)),
      awaitCancellation: () => {
        cancellationArmed = true;
        return Deferred.await(signal);
      },
      get: () =>
        Effect.gen(function* () {
          if (cancellationArmed) {
            yield* Deferred.succeed(signal, undefined);
          }
          return Option.some(claimedEffect);
        }),
      clearCancellation: () => Effect.void,
      succeed: () => Ref.update(settlementCount, (count) => count + 1).pipe(Effect.as(true)),
    });
    const layerExecutor = Layer.succeed(
      EffectWorker.OrchestrationEffectExecutorV2,
      EffectWorker.OrchestrationEffectExecutorV2.of({
        execute: () =>
          Effect.yieldNow.pipe(Effect.andThen(Ref.update(executionCount, (count) => count + 1))),
      }),
    );
    const layerWorker = EffectWorker.layerWithOptions({ workerId }).pipe(
      Layer.provide(Layer.merge(layerOutbox, layerExecutor)),
    );

    const exit = yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((worker) => worker.runOnce),
      Effect.provide(layerWorker),
      Effect.exit,
    );

    if (Exit.isFailure(exit)) {
      assert.fail(Cause.pretty(exit.cause));
    }
    assert.equal(yield* Ref.get(executionCount), 0);
    assert.equal(yield* Ref.get(settlementCount), 0);
  }),
);

it.effect("terminalizes a process-bound claim when success settlement fails", () =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const effectId = "effect:worker-process-bound-settlement-failure";
    const workerId = "worker-process-bound-settlement-failure";
    const claimedEffect: EffectOutbox.OrchestrationEffectV2 = {
      id: effectId,
      commandId: CommandId.make("command:worker-process-bound-settlement-failure"),
      threadId: ThreadId.make("thread:worker-process-bound-settlement-failure"),
      request: {
        type: "provider-turn.start",
        runId: RunId.make("run:worker-process-bound-settlement-failure"),
      },
      status: "running",
      attemptCount: 1,
      availableAt: now,
      leaseOwner: workerId,
      leaseExpiresAt: now,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };
    const retries = yield* Ref.make(0);
    const terminalErrors = yield* Ref.make<ReadonlyArray<string>>([]);
    const executionCount = yield* Ref.make(0);
    const layerOutbox = Layer.mock(EffectOutbox.EffectOutboxV2)({
      claimNext: () => Effect.succeed(Option.some(claimedEffect)),
      get: () => Effect.succeed(Option.some(claimedEffect)),
      awaitCancellation: () => Effect.never,
      clearCancellation: () => Effect.void,
      succeed: () =>
        Effect.fail(
          new EffectOutbox.EffectOutboxError({
            operation: "succeed",
            effectId,
            cause: "simulated success settlement failure",
          }),
        ),
      retry: () => Ref.update(retries, (count) => count + 1).pipe(Effect.as(true)),
      fail: ({ error }) =>
        Ref.update(terminalErrors, (existing) => [...existing, error]).pipe(Effect.as(true)),
    });
    const layerExecutor = Layer.succeed(
      EffectWorker.OrchestrationEffectExecutorV2,
      EffectWorker.OrchestrationEffectExecutorV2.of({
        execute: () => Ref.update(executionCount, (count) => count + 1),
      }),
    );
    const layerWorker = EffectWorker.layerWithOptions({ workerId }).pipe(
      Layer.provide(Layer.merge(layerOutbox, layerExecutor)),
    );

    const exit = yield* EffectWorker.OrchestrationEffectWorkerV2.pipe(
      Effect.flatMap((worker) => worker.runOnce),
      Effect.provide(layerWorker),
      Effect.exit,
    );

    assert.isTrue(Exit.isFailure(exit));
    assert.equal(yield* Ref.get(executionCount), 1);
    assert.equal(yield* Ref.get(retries), 0);
    const terminalError = (yield* Ref.get(terminalErrors))[0];
    assert.isDefined(terminalError);
    assert.include(terminalError, "after execution started");
    assert.include(terminalError, "simulated success settlement failure");
  }),
);

it.effect("shares thread health checks across worker lanes without blocking effect work", () =>
  Effect.gen(function* () {
    const checks = yield* Ref.make(0);
    const attempts = yield* Ref.make(0);
    const checkStarted = yield* Deferred.make<void>();
    const releaseCheck = yield* Deferred.make<void>();
    const worker = EffectWorker.OrchestrationEffectWorkerV2.of({
      awaitWork: Effect.never,
      runRecoveryOnce: Effect.succeed(false),
      runOnce: Ref.update(attempts, (count) => count + 1).pipe(Effect.as(false)),
      awaitIncomingSummaryWork: Effect.never,
      runIncomingSummaryOnce: Effect.succeed(false),
      nextIncomingSummaryClaimableAt: Effect.succeed(Option.none()),
      nextClaimableAt: Effect.succeed(Option.none()),
      drain: () => Effect.succeed(0),
    });
    yield* EffectWorker.runDaemonWithOptions({
      concurrency: 4,
      livenessPollIntervalMs: 1_000,
      reconcileThreadHealth: Ref.update(checks, (count) => count + 1).pipe(
        Effect.andThen(Deferred.succeed(checkStarted, undefined)),
        Effect.andThen(Deferred.await(releaseCheck)),
      ),
    }).pipe(
      Effect.provideService(EffectWorker.OrchestrationEffectWorkerV2, worker),
      Effect.forkScoped,
    );
    yield* Deferred.await(checkStarted);
    yield* TestClock.adjust("2 seconds");
    assert.equal(yield* Ref.get(checks), 1);
    assert.isAtLeast(yield* Ref.get(attempts), 8);
    yield* Deferred.succeed(releaseCheck, undefined);
    yield* TestClock.adjust("1 second");
    assert.equal(yield* Ref.get(checks), 2);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("settles a delegated child once its restart continuation fails for good", () =>
  Effect.gen(function* () {
    const timestamp = DateTime.formatIso(yield* DateTime.now);
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const recovered = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
    const layer = layerExecutorFor({
      events,
      continueAfterRestart: true,
      threads: {
        getThreadRecords: () => Effect.fail(new Error("provider instance removed") as never),
        recoverDelegatedTask: (childThreadId) =>
          Ref.update(recovered, (ids) => [...ids, childThreadId]),
      },
    });
    const effect: EffectOutbox.OrchestrationEffectV2 = {
      id: `effect:restart-continuation:${runId}`,
      commandId: CommandId.make("command:restart-continuation-failure"),
      threadId,
      request: { type: "provider-runtime.continue", sourceRunId: runId },
      status: "running",
      attemptCount: 1,
      availableAt: timestamp,
      leaseOwner: "test-worker",
      leaseExpiresAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
      lastError: null,
    };
    yield* Effect.gen(function* () {
      const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(executor.execute(effect, { willRetry: true }))),
      );
      assert.deepEqual(yield* Ref.get(recovered), []);
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(executor.execute(effect, { willRetry: false }))),
      );
      assert.deepEqual(yield* Ref.get(recovered), [threadId]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect.each(["confirmed", "unconfirmed", "failed"] as const)(
  "a native subagent stop only repairs %s provider evidence",
  (outcome) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const events = yield* Ref.make<ReadonlyArray<string>>([]);
      const layer = layerExecutorFor({
        events,
        interrupt: (input) => {
          assert.equal(input.subagent?.nativeTaskId, "native-task");
          return Ref.update(events, (current) => [...current, "stop-child"]).pipe(
            Effect.andThen(
              outcome === "failed"
                ? new ProviderTurnControlService.ProviderTurnControlError({
                    threadId,
                    providerTurnId,
                    operation: "interrupt",
                    cause: "SDK stop failed",
                  })
                : Effect.succeed(
                    outcome === "confirmed"
                      ? {
                          status: "cancelled" as const,
                          completedAt: now,
                          result: "Stopped by Claude",
                        }
                      : undefined,
                  ),
            ),
          );
        },
        threads: {
          dispatch: (command) => {
            assert.equal(command.type, "thread.background-work.settle");
            if (command.type === "thread.background-work.settle") {
              assert.equal(command.subagent?.id, "subagent");
              assert.deepEqual(command.subagent?.outcome, {
                status: "cancelled",
                completedAt: now,
                result: "Stopped by Claude",
              });
            }
            return Ref.update(events, (current) => [...current, "settle-child"]).pipe(
              Effect.as({ sequence: 1, storedEvents: [] }),
            );
          },
        },
      });
      const execution = yield* Effect.gen(function* () {
        const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
        yield* executor.execute({
          ...restartEffect(now, { type: "detach" }),
          request: {
            type: "provider-turn.interrupt",
            providerSessionId: oldSessionId,
            providerThreadId,
            providerTurnId,
            subagent: { id: NodeId.make("subagent"), nativeTaskId: "native-task" },
          },
        });
      }).pipe(Effect.provide(layer), Effect.exit);
      assert.equal(Exit.isFailure(execution), outcome === "failed");
      assert.deepEqual(
        yield* Ref.get(events),
        outcome === "confirmed" ? ["stop-child", "settle-child"] : ["stop-child"],
      );
    }),
);
