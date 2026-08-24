import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  UpdateDrainRequestId,
  UpdateDrainTargetVersion,
  type OrchestrationShellSnapshot,
  type TerminalSummary,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRequestCorrelationRepositoryLive } from "../persistence/Layers/ProjectionTurnRequestCorrelations.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { UpdateDrainRepositoryLive } from "../persistence/Layers/UpdateDrainRepository.ts";
import { ProjectionTurnRequestCorrelationRepository } from "../persistence/Services/ProjectionTurnRequestCorrelations.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { layer as updateDrainLayer } from "./UpdateDrain.ts";
import { makeUpdateDrainAdmission } from "./UpdateDrainAdmission.ts";

const requestId = UpdateDrainRequestId.make("update-1");
const targetVersion = UpdateDrainTargetVersion.make("1.2.3");
const threadId = ThreadId.make("thread-1");
const turnId = TurnId.make("turn-1");
const now = "2026-08-21T00:00:00.000Z";

const emptyShell = (): OrchestrationShellSnapshot => ({
  snapshotSequence: 0,
  projects: [],
  threads: [],
  updatedAt: now,
});

const busyShell = (): OrchestrationShellSnapshot => ({
  snapshotSequence: 1,
  projects: [],
  updatedAt: now,
  threads: [
    {
      id: threadId,
      projectId: ProjectId.make("project-1"),
      title: "Busy thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: {
        turnId,
        state: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        assistantMessageId: null,
      },
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      session: {
        threadId,
        status: "running",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: turnId,
        lastError: null,
        updatedAt: now,
      },
      latestUserMessageAt: now,
      hasPendingApprovals: true,
      hasPendingUserInput: true,
      hasActionableProposedPlan: false,
      backgroundLiveness: "working",
    },
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
  Layer.provide(UpdateDrainRepositoryLive),
  Layer.provide(SqlitePersistenceMemory),
);

const makeHarness = Effect.fn("UpdateDrainAdmissionTest.makeHarness")(function* () {
  const shell = yield* Ref.make<OrchestrationShellSnapshot>(emptyShell());
  const terminals = yield* Ref.make<ReadonlyArray<TerminalSummary>>([]);
  const dependencies = Layer.mergeAll(
    durableLayer,
    ProjectionTurnRequestCorrelationRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory)),
    ProjectionTurnRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory)),
    Layer.mock(ProjectionSnapshotQuery)({ getShellSnapshot: () => Ref.get(shell) }),
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

it.effect("ignores pending starts left behind by a previous server lifetime", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();

    yield* Effect.gen(function* () {
      const projectionTurns = yield* ProjectionTurnRepository;
      const correlations = yield* ProjectionTurnRequestCorrelationRepository;
      const messageId = MessageId.make("message-stale-pending-turn");
      yield* projectionTurns.replacePendingTurnStart({
        threadId,
        messageId,
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        requestedAt: now,
      });
      yield* correlations.insertPending({ threadId, messageId, requestedAt: now });
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
      const correlation = yield* correlations.get({ threadId, messageId });
      assert.equal(correlation._tag, "Some");
      if (correlation._tag === "Some") {
        assert.equal(correlation.value.state, "interrupted");
      }
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

it.effect("keeps accepted provider starts blocking until they reach the session projection", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();

    yield* Effect.gen(function* () {
      const admission = yield* makeUpdateDrainAdmission();
      const projectionTurns = yield* ProjectionTurnRepository;
      yield* projectionTurns.replacePendingTurnStart({
        threadId,
        messageId: MessageId.make("message-pending-turn"),
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        requestedAt: now,
      });
      yield* admission.dispatch({
        type: "update-drain.start",
        commandId: CommandId.make("start-pending-turn"),
        requestId,
        targetVersion,
        createdAt: now,
      });

      assert.deepStrictEqual((yield* admission.status).blockers, [
        {
          type: "thread-turn",
          threadId,
          turnId: null,
          status: "starting",
        },
      ]);
      assert.equal(
        (yield* Effect.result(admission.claimActivation({ requestId })))._tag,
        "Failure",
      );

      yield* projectionTurns.deletePendingTurnStartByThreadId({ threadId });
      assert.equal(
        (yield* admission.claimActivation({ requestId })).commandType,
        "update-drain.claim",
      );
    }).pipe(Effect.provide(harness.dependencies));
  }),
);
