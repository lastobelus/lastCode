import {
  CommandId,
  ProviderSessionId,
  ThreadId,
  RunId,
  TurnId,
  UpdateDrainRequestId,
  UpdateDrainTargetVersion,
  type OrchestrationV2ThreadShellSnapshot,
  type TerminalSummary,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as UpdateDrainRepositoryPersistence from "../persistence/UpdateDrainRepository.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { UpdateDrain, layer as updateDrainLayer } from "./UpdateDrain.ts";
import { makeOfflineAdmission, makeUpdateDrainAdmission } from "./UpdateDrainAdmission.ts";

const requestId = UpdateDrainRequestId.make("update-1");
const targetVersion = UpdateDrainTargetVersion.make("1.2.3");
const threadId = ThreadId.make("thread-1");
const turnId = RunId.make("run-1");
const now = "2026-08-21T00:00:00.000Z";

const emptyShell = (): OrchestrationV2ThreadShellSnapshot => ({
  schemaVersion: 2,
  snapshotSequence: 0,
  threads: [],
  archivedThreads: [],
});

const busyShell = (): OrchestrationV2ThreadShellSnapshot => ({
  ...emptyShell(),
  snapshotSequence: 1,
  threads: [
    {
      id: threadId,
      activeRunId: turnId,
      status: "running",
      pendingRuntimeRequest: { kind: "approval", id: "approval-1" },
      pendingBackgroundTasks: [{ kind: "command", id: "background-1" }],
    } as unknown as OrchestrationV2ThreadShellSnapshot["threads"][number],
  ],
});

const busyTerminal = (): TerminalSummary => ({
  threadId,
  terminalId: "terminal-1",
  cwd: "/tmp/project",
  worktreePath: null,
  status: "running",
  pid: 123,
  exitCode: null,
  exitSignal: null,
  hasRunningSubprocess: true,
  label: "tests",
  updatedAt: now,
});

const durableLayer = updateDrainLayer.pipe(
  Layer.provide(UpdateDrainRepositoryPersistence.layer),
  Layer.provide(SqlitePersistenceMemory),
);

const makeHarness = Effect.fn("UpdateDrainAdmissionTest.makeHarness")(function* () {
  const shell = yield* Ref.make<OrchestrationV2ThreadShellSnapshot>(emptyShell());
  const terminals = yield* Ref.make<ReadonlyArray<TerminalSummary>>([]);
  const cleanup = yield* Ref.make<ReadonlyArray<{ threadId: ThreadId }>>([]);
  const runtimeWork = yield* Ref.make<
    ReadonlyArray<{
      providerSessionId: ProviderSessionId;
      status: "running" | "stopping";
    }>
  >([]);
  const dependencies = Layer.mergeAll(
    durableLayer,
    Layer.mock(EffectOutbox.EffectOutboxV2)({ pendingCleanup: Ref.get(cleanup) }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getShellSnapshot: () => Ref.get(shell),
      getThreadRecords: () => Effect.die("Drain must not scan per-thread provider history"),
    }),
    Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
      pendingExecution: Ref.get(runtimeWork),
    }),
    Layer.mock(TerminalManager)({
      metadata: Effect.succeed([]),
      refreshMetadata: Ref.get(terminals),
    }),
  );
  return { shell, terminals, runtimeWork, cleanup, dependencies } as const;
});

it.effect.each(["thread-turn", "thread-archive", "thread-delete"] as const)(
  "orders %s admission before closing the drain",
  (kind) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const admission = yield* makeUpdateDrainAdmission();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const timeline = yield* Ref.make<ReadonlyArray<string>>([]);
        const append = (value: string) => Ref.update(timeline, (values) => [...values, value]);

        const work = yield* admission
          .admit(
            kind,
            append("work-start").pipe(
              Effect.andThen(Deferred.succeed(entered, undefined)),
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(append("work-admitted")),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const close = yield* admission
          .dispatch({
            type: "update-drain.start",
            commandId: CommandId.make("start-1"),
            requestId,
            targetVersion,
            createdAt: now,
          })
          .pipe(
            Effect.tap(() => append("drain-closed")),
            Effect.forkChild,
          );

        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(work);
        yield* Fiber.join(close);
        assert.deepStrictEqual(yield* Ref.get(timeline), [
          "work-start",
          "work-admitted",
          "drain-closed",
        ]);
      }).pipe(Effect.provide(harness.dependencies));
    }),
);

it.effect("holds activation until a family archive settles even after its runs are cancelled", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const shell = busyShell();
    yield* Ref.set(harness.shell, {
      ...shell,
      threads: shell.threads.map((thread) => ({
        ...thread,
        status: "cancelled" as const,
        activeRunId: null,
        pendingBackgroundTasks: [],
        archivePending: {
          threadId,
          commandId: CommandId.make("archive-for-update"),
          status: "stopping" as const,
        },
      })),
    });
    yield* Effect.gen(function* () {
      const admission = yield* makeUpdateDrainAdmission();
      yield* admission.dispatch({
        type: "update-drain.start",
        commandId: CommandId.make("start-archive-update"),
        requestId,
        targetVersion,
        createdAt: now,
      });
      assert.deepEqual((yield* admission.status).blockers, [
        { type: "provider-teardown", threadId },
      ]);
      assert.equal(
        (yield* Effect.result(admission.claimActivation({ requestId })))._tag,
        "Failure",
      );
      yield* Ref.update(harness.shell, (shell) => ({
        ...shell,
        threads: shell.threads.map((thread) => ({ ...thread, archivePending: null })),
      }));
      assert.equal(
        (yield* admission.claimActivation({ requestId })).commandType,
        "update-drain.claim",
      );
    }).pipe(Effect.provide(harness.dependencies));
  }),
);

it.effect("retains provider execution blockers after a failed archive is dismissed", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const providerSessionId = ProviderSessionId.make("failed-family-session");
    const shell = busyShell();
    yield* Ref.set(harness.shell, {
      ...shell,
      threads: shell.threads.map((thread) => ({
        ...thread,
        status: "cancelled" as const,
        activeRunId: null,
        pendingBackgroundTasks: [],
        archivePending: {
          threadId,
          commandId: CommandId.make("failed-archive"),
          status: "failed" as const,
          error: "Controlled stop failure",
        },
      })),
    });
    yield* Ref.set(harness.runtimeWork, [{ providerSessionId, status: "running" }]);
    yield* Effect.gen(function* () {
      const admission = yield* makeUpdateDrainAdmission();
      yield* admission.dispatch({
        type: "update-drain.start",
        commandId: CommandId.make("start-failed-archive-update"),
        requestId,
        targetVersion,
        createdAt: now,
      });
      const expected = [
        { type: "provider-runtime", providerSessionId, status: "running" },
      ] as const;
      assert.deepEqual((yield* admission.status).blockers, expected);
      assert.equal(
        (yield* Effect.result(admission.claimActivation({ requestId })))._tag,
        "Failure",
      );
      yield* Ref.update(harness.shell, (shell) => ({
        ...shell,
        threads: shell.threads.map((thread) => ({ ...thread, archivePending: null })),
      }));
      assert.deepEqual((yield* admission.status).blockers, expected);
      assert.equal(
        (yield* Effect.result(admission.claimActivation({ requestId })))._tag,
        "Failure",
      );
      yield* Ref.set(harness.runtimeWork, []);
      assert.equal(
        (yield* admission.claimActivation({ requestId })).commandType,
        "update-drain.claim",
      );
    }).pipe(Effect.provide(harness.dependencies));
  }),
);

it.effect("ignores terminal runs after V2 restart recovery marks them interrupted", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const shell = busyShell();
    yield* Ref.set(harness.shell, {
      ...shell,
      threads: shell.threads.map((thread) => ({
        ...thread,
        status: "interrupted" as const,
        activeRunId: null,
        pendingBackgroundTasks: [],
      })),
    });
    yield* Effect.gen(function* () {
      const admission = yield* makeUpdateDrainAdmission();
      yield* admission.dispatch({
        type: "update-drain.start",
        commandId: CommandId.make("start-after-restart"),
        requestId,
        targetVersion,
        createdAt: now,
      });
      assert.deepStrictEqual((yield* admission.status).blockers, []);
      assert.equal(
        (yield* admission.claimActivation({ requestId })).commandType,
        "update-drain.claim",
      );
    }).pipe(Effect.provide(harness.dependencies));
  }),
);

it.effect("ignores deleted cleanup tombstone runs while still checking live terminals", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const shell = busyShell();
    yield* Ref.set(harness.shell, {
      ...shell,
      threads: shell.threads.map((thread) => ({ ...thread, deletedAt: now as never })),
    });
    yield* Ref.set(harness.terminals, [busyTerminal()]);
    yield* Effect.gen(function* () {
      const admission = yield* makeUpdateDrainAdmission();
      yield* admission.dispatch({
        type: "update-drain.start",
        commandId: CommandId.make("deleted-cleanup:start"),
        requestId,
        targetVersion,
        createdAt: now,
      });
      assert.deepStrictEqual(
        (yield* admission.status).blockers.map((blocker) => blocker.type),
        ["terminal-process"],
      );
      yield* Ref.set(harness.terminals, []);
      assert.deepStrictEqual((yield* admission.status).blockers, []);
    }).pipe(Effect.provide(harness.dependencies));
  }),
);

it.effect("reports only execution blockers and atomically claims when they clear", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    yield* Ref.set(harness.shell, busyShell());
    yield* Ref.set(harness.terminals, [busyTerminal()]);

    yield* Effect.gen(function* () {
      const admission = yield* makeUpdateDrainAdmission();
      yield* admission.dispatch({
        type: "update-drain.start",
        commandId: CommandId.make("start-2"),
        requestId,
        targetVersion,
        createdAt: now,
      });

      const status = yield* admission.status;
      assert.deepStrictEqual(
        status.blockers.map((blocker) => blocker.type),
        ["terminal-process", "thread-background", "thread-turn"],
      );
      assert.ok(!status.blockers.some((blocker) => "approval" in blocker));
      assert.equal(
        (yield* Effect.result(admission.claimActivation({ requestId })))._tag,
        "Failure",
      );

      yield* Ref.set(harness.shell, emptyShell());
      yield* Ref.set(harness.terminals, []);
      const claimed = yield* admission.claimActivation({ requestId });
      assert.equal(claimed.commandType, "update-drain.claim");
      assert.deepStrictEqual(yield* admission.status, {
        sequence: 2,
        intent: { requestId, targetVersion, status: "claimed" },
        admission: "closed",
        blockers: [],
      });

      for (const kind of ["terminal-write", "thread-archive", "thread-delete"] as const) {
        const blocked = yield* Effect.result(admission.admit(kind, Effect.void));
        assert.equal(blocked._tag, "Failure");
      }
    }).pipe(Effect.provide(harness.dependencies));
  }),
);

it.effect.each(["preparing", "queued", "starting", "waiting"] as const)(
  "keeps a durable %s V2 run blocking activation",
  (status) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const shell = busyShell();
      yield* Ref.set(harness.shell, {
        ...shell,
        threads: shell.threads.map((thread) => ({
          ...thread,
          status,
          pendingBackgroundTasks: [],
        })),
      });
      yield* Effect.gen(function* () {
        const admission = yield* makeUpdateDrainAdmission();
        yield* admission.dispatch({
          type: "update-drain.start",
          commandId: CommandId.make(`start-${status}`),
          requestId,
          targetVersion,
          createdAt: now,
        });
        assert.deepStrictEqual((yield* admission.status).blockers, [
          {
            type: "thread-turn",
            threadId,
            turnId: TurnId.make(turnId),
            status: status === "waiting" ? "running" : "starting",
          },
        ]);
        assert.equal(
          (yield* Effect.result(admission.claimActivation({ requestId })))._tag,
          "Failure",
        );
        yield* Ref.set(harness.shell, emptyShell());
        assert.equal(
          (yield* admission.claimActivation({ requestId })).commandType,
          "update-drain.claim",
        );
      }).pipe(Effect.provide(harness.dependencies));
    }),
);

it.effect("reads durable-to-runtime cleanup evidence in handoff order and fails closed", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    yield* Effect.gen(function* () {
      const order: string[] = [];
      const observed = <A, E>(name: string, effect: Effect.Effect<A, E>) =>
        Effect.sync(() => order.push(name)).pipe(Effect.andThen(effect));
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const providers = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const terminals = yield* TerminalManager;
      const admission = yield* makeUpdateDrainAdmission().pipe(
        Effect.provideService(ProjectionStore.ProjectionStoreV2, {
          ...projections,
          getShellSnapshot: () => observed("shell", Ref.get(harness.shell)),
        }),
        Effect.provideService(EffectOutbox.EffectOutboxV2, {
          ...outbox,
          pendingCleanup: observed("outbox", Ref.get(harness.cleanup)),
        }),
        Effect.provideService(ProviderSessionManager.ProviderSessionManagerV2, {
          ...providers,
          pendingExecution: observed("provider", Ref.get(harness.runtimeWork)),
        }),
        Effect.provideService(TerminalManager, {
          ...terminals,
          refreshMetadata: observed("terminal", Ref.get(harness.terminals)),
        }),
      );
      yield* admission.dispatch({
        type: "update-drain.start",
        commandId: CommandId.make("ordered-start"),
        requestId,
        targetVersion,
        createdAt: now,
      });
      yield* admission.status;
      assert.deepEqual(order, ["shell", "provider", "outbox", "provider", "terminal"]);
      const unavailable = yield* makeUpdateDrainAdmission().pipe(
        Effect.provideService(EffectOutbox.EffectOutboxV2, {
          ...outbox,
          pendingCleanup: Effect.fail(
            new EffectOutbox.EffectOutboxError({ operation: "pending-cleanup" }),
          ),
        }),
      );
      const failure = yield* unavailable.claimActivation({ requestId }).pipe(Effect.flip);
      assert.equal(failure.reason, "internal_error");
      assert.equal((yield* admission.status).intent?.status, "draining");
    }).pipe(Effect.provide(harness.dependencies));
  }),
);

it.effect(
  "allows serialized settlement during drain, then refuses new settlement after claim",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const admission = yield* makeUpdateDrainAdmission();
        yield* admission.dispatch({
          type: "update-drain.start",
          commandId: CommandId.make("settle-start"),
          requestId,
          targetVersion,
          createdAt: now,
        });
        yield* admission.admit("thread-settle", Ref.set(harness.cleanup, [{ threadId }]));
        assert.equal(
          (yield* admission.claimActivation({ requestId }).pipe(Effect.result))._tag,
          "Failure",
        );
        yield* Ref.set(harness.cleanup, []);
        yield* admission.claimActivation({ requestId });
        assert.equal(
          (yield* admission
            .admit("thread-settle", Ref.set(harness.cleanup, [{ threadId }]))
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.isEmpty(yield* Ref.get(harness.cleanup));
      }).pipe(Effect.provide(harness.dependencies));
    }),
);

it.effect(
  "offline admission uses durable intake while refusing live status and activation claims",
  () =>
    Effect.gen(function* () {
      const admission = yield* makeOfflineAdmission;
      let admitted = 0;
      yield* admission.admit(
        "thread-delete",
        Effect.sync(() => (admitted += 1)),
      );
      assert.equal(admitted, 1);
      for (const operation of [
        admission.status.pipe(Effect.asVoid),
        admission.claimActivation({ requestId }).pipe(Effect.asVoid),
      ]) {
        const error = yield* operation.pipe(Effect.flip);
        assert.equal(error.reason, "internal_error");
        assert.include(error.message, "unavailable in offline mode");
      }
    }).pipe(Effect.provide(durableLayer)),
);

it.effect.each(["draining", "claimed"] as const)(
  "offline deletion respects real durable %s intent",
  (status) =>
    Effect.gen(function* () {
      const admission = yield* makeOfflineAdmission;
      const drain = yield* UpdateDrain;
      yield* admission.dispatch({
        type: "update-drain.start",
        commandId: CommandId.make("offline:start"),
        requestId,
        targetVersion,
        createdAt: now,
      });
      if (status === "claimed")
        yield* drain.dispatch({
          type: "update-drain.claim",
          commandId: CommandId.make("offline:claim"),
          requestId,
          createdAt: now,
        });
      let admitted = false;
      const error = yield* admission
        .admit(
          "thread-delete",
          Effect.sync(() => (admitted = true)),
        )
        .pipe(Effect.flip);
      assert.equal(error._tag, "UpdateDrainAdmissionError");
      assert.isFalse(admitted);
    }).pipe(Effect.provide(durableLayer)),
);

it.effect("retains both runtime handoff snapshots and deduplicates stopping evidence", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    yield* Effect.gen(function* () {
      const providers = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const firstOnly = ProviderSessionId.make("runtime-first-only");
      const lastOnly = ProviderSessionId.make("runtime-last-only");
      const firstStopping = ProviderSessionId.make("runtime-first-stopping");
      const lastStopping = ProviderSessionId.make("runtime-last-stopping");
      let reads = 0;
      const admission = yield* makeUpdateDrainAdmission().pipe(
        Effect.provideService(ProviderSessionManager.ProviderSessionManagerV2, {
          ...providers,
          pendingExecution: Effect.sync(() =>
            ++reads === 1
              ? [
                  { providerSessionId: firstOnly, status: "running" as const },
                  { providerSessionId: firstStopping, status: "stopping" as const },
                  { providerSessionId: lastStopping, status: "running" as const },
                ]
              : [
                  { providerSessionId: lastOnly, status: "stopping" as const },
                  { providerSessionId: firstStopping, status: "running" as const },
                  { providerSessionId: lastStopping, status: "stopping" as const },
                ],
          ),
        }),
      );
      yield* admission.dispatch({
        type: "update-drain.start",
        commandId: CommandId.make("runtime-handoff-start"),
        requestId,
        targetVersion,
        createdAt: now,
      });
      assert.deepEqual((yield* admission.status).blockers, [
        { type: "provider-runtime", providerSessionId: firstOnly, status: "running" },
        { type: "provider-runtime", providerSessionId: firstStopping, status: "stopping" },
        { type: "provider-runtime", providerSessionId: lastOnly, status: "stopping" },
        { type: "provider-runtime", providerSessionId: lastStopping, status: "stopping" },
      ]);
      assert.equal(reads, 2);
    }).pipe(Effect.provide(harness.dependencies));
  }),
);
