import {
  CommandId,
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

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as UpdateDrainRepositoryPersistence from "../persistence/UpdateDrainRepository.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { layer as updateDrainLayer } from "./UpdateDrain.ts";
import { makeUpdateDrainAdmission } from "./UpdateDrainAdmission.ts";

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
  Layer.provide(SqlitePersistence.layerMemory),
);

const makeHarness = Effect.fn("UpdateDrainAdmissionTest.makeHarness")(function* () {
  const shell = yield* Ref.make<OrchestrationV2ThreadShellSnapshot>(emptyShell());
  const terminals = yield* Ref.make<ReadonlyArray<TerminalSummary>>([]);
  const dependencies = Layer.mergeAll(
    durableLayer,
    Layer.mock(ProjectionStore.ProjectionStoreV2)({ getShellSnapshot: () => Ref.get(shell) }),
    Layer.mock(TerminalManager)({
      metadata: Effect.succeed([]),
      refreshMetadata: Ref.get(terminals),
    }),
  );
  return { shell, terminals, dependencies } as const;
});

it.effect("orders work admission before closing the drain", () =>
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
          "thread-turn",
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

      const blockedWrite = yield* Effect.result(admission.admit("terminal-write", Effect.void));
      assert.equal(blockedWrite._tag, "Failure");
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
