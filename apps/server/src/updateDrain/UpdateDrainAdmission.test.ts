import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  UpdateActivationTargetDigest,
  UpdateDrainRequestId,
  UpdateDrainTargetVersion,
  type OrchestrationShellSnapshot,
  type TerminalSummary,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { UpdateDrainRepositoryLive } from "../persistence/Layers/UpdateDrainRepository.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { UpdateDrain, layer as updateDrainLayer } from "./UpdateDrain.ts";
import {
  makeUpdateDrainAdmission,
  persistUpdateActivationCommit,
  readUpdateActivationCommit,
  updateActivationCommitRecordPath,
} from "./UpdateDrainAdmission.ts";

const requestId = UpdateDrainRequestId.make("update-1");
const targetVersion = UpdateDrainTargetVersion.make("1.2.3");
const threadId = ThreadId.make("thread-1");
const turnId = TurnId.make("turn-1");
const now = "2026-08-21T00:00:00.000Z";
const decodeActivationCommitRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Unknown),
);

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
      yield* projectionTurns.replacePendingTurnStart({
        threadId,
        messageId: MessageId.make("message-stale-pending-turn"),
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        requestedAt: now,
      });
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

it.effect("keeps a trial closed until the exact activation commit is durable", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const targetDigest = UpdateActivationTargetDigest.make("a".repeat(64));
    const persisted = yield* Ref.make<ReadonlyArray<unknown>>([]);

    yield* Effect.gen(function* () {
      const admission = yield* makeUpdateDrainAdmission({
        trial: { requestId, targetDigest },
        persistCommit: (record) => Ref.update(persisted, (records) => [...records, record]),
      });

      const beforeDrain = yield* Effect.result(admission.admit("thread-turn", Effect.void));
      assert.equal(beforeDrain._tag, "Failure");
      assert.equal(
        beforeDrain._tag === "Failure" && "reason" in beforeDrain.failure
          ? beforeDrain.failure.reason
          : null,
        "no_active_drain",
      );

      yield* admission.dispatch({
        type: "update-drain.start",
        commandId: CommandId.make("trial-start"),
        requestId,
        targetVersion,
        createdAt: now,
      });

      const unclaimed = yield* Effect.result(
        admission.commitUpdateActivation({ requestId, targetDigest }),
      );
      assert.equal(unclaimed._tag, "Failure");
      assert.equal(
        unclaimed._tag === "Failure" ? unclaimed.failure.reason : null,
        "drain_not_claimed",
      );
      yield* admission.claimActivation({ requestId });

      const blocked = yield* Effect.result(admission.admit("terminal-write", Effect.void));
      assert.equal(blocked._tag, "Failure");
      assert.equal((yield* admission.status).admission, "closed");

      const wrongRequest = yield* Effect.result(
        admission.commitUpdateActivation({
          requestId: UpdateDrainRequestId.make("wrong-request"),
          targetDigest,
        }),
      );
      assert.equal(wrongRequest._tag, "Failure");
      assert.equal(
        wrongRequest._tag === "Failure" ? wrongRequest.failure.reason : null,
        "request_mismatch",
      );

      const wrongDigest = yield* Effect.result(
        admission.commitUpdateActivation({
          requestId,
          targetDigest: UpdateActivationTargetDigest.make("b".repeat(64)),
        }),
      );
      assert.equal(wrongDigest._tag, "Failure");
      assert.equal(
        wrongDigest._tag === "Failure" ? wrongDigest.failure.reason : null,
        "digest_mismatch",
      );

      const committed = yield* admission.commitUpdateActivation({ requestId, targetDigest });
      assert.deepStrictEqual(yield* Ref.get(persisted), [committed]);
      assert.deepStrictEqual(yield* admission.status, {
        sequence: 3,
        intent: { requestId, targetVersion, status: "completed" },
        admission: "open",
        blockers: [],
      });

      let workRan = false;
      yield* admission.admit(
        "thread-turn",
        Effect.sync(() => {
          workRan = true;
        }),
      );
      assert.isTrue(workRan);

      const retried = yield* admission.commitUpdateActivation({ requestId, targetDigest });
      assert.deepStrictEqual(retried, committed);
      assert.deepStrictEqual(yield* Ref.get(persisted), [committed]);

      const restarted = yield* makeUpdateDrainAdmission({
        trial: { requestId, targetDigest },
        existingCommit: committed,
        persistCommit: (record) => Ref.update(persisted, (records) => [...records, record]),
      });
      assert.equal((yield* restarted.status).admission, "open");
      assert.deepStrictEqual(
        yield* restarted.commitUpdateActivation({ requestId, targetDigest }),
        committed,
      );
      assert.deepStrictEqual(yield* Ref.get(persisted), [committed]);
    }).pipe(Effect.provide(harness.dependencies));
  }),
);

it.effect("finishes a claimed drain from an existing durable commit before opening", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const targetDigest = UpdateActivationTargetDigest.make("e".repeat(64));
    const record = {
      requestId,
      schemaVersion: 1,
      status: "committed",
      targetDigest,
    } as const;

    yield* Effect.gen(function* () {
      const initial = yield* makeUpdateDrainAdmission();
      yield* initial.dispatch({
        type: "update-drain.start",
        commandId: CommandId.make("restart-start"),
        requestId,
        targetVersion,
        createdAt: now,
      });
      yield* initial.claimActivation({ requestId });

      const restarted = yield* makeUpdateDrainAdmission({
        trial: { requestId, targetDigest },
        existingCommit: record,
        persistCommit: () => Effect.die("existing commit must not be rewritten"),
      });
      assert.deepStrictEqual(yield* restarted.status, {
        sequence: 3,
        intent: { requestId, targetVersion, status: "completed" },
        admission: "open",
        blockers: [],
      });
      assert.deepStrictEqual(
        yield* restarted.commitUpdateActivation({ requestId, targetDigest }),
        record,
      );
    }).pipe(Effect.provide(harness.dependencies));
  }),
);

it.effect("persists the commit before durable completion and admission reopening", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const targetDigest = UpdateActivationTargetDigest.make("f".repeat(64));
    const timeline = yield* Ref.make<ReadonlyArray<string>>([]);
    const append = (value: string) => Ref.update(timeline, (values) => [...values, value]);

    yield* Effect.gen(function* () {
      const drain = yield* UpdateDrain;
      const admission = yield* makeUpdateDrainAdmission({
        trial: { requestId, targetDigest },
        persistCommit: () =>
          Effect.gen(function* () {
            assert.equal((yield* Effect.orDie(drain.status)).intent?.status, "claimed");
            yield* append("commit-file-durable");
          }),
      });
      yield* admission.dispatch({
        type: "update-drain.start",
        commandId: CommandId.make("ordered-start"),
        requestId,
        targetVersion,
        createdAt: now,
      });
      yield* admission.claimActivation({ requestId });
      yield* admission.commitUpdateActivation({ requestId, targetDigest });
      assert.equal((yield* drain.status).intent?.status, "completed");
      yield* append("drain-completed");
      yield* admission.admit("thread-turn", append("admission-open"));
      assert.deepStrictEqual(yield* Ref.get(timeline), [
        "commit-file-durable",
        "drain-completed",
        "admission-open",
      ]);
    }).pipe(Effect.provide(harness.dependencies));
  }),
);

it.effect("leaves normal startup admission unchanged", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    yield* Effect.gen(function* () {
      const admission = yield* makeUpdateDrainAdmission();
      yield* admission.admit("thread-turn", Effect.void);
      assert.equal((yield* admission.status).admission, "open");

      const result = yield* Effect.result(
        admission.commitUpdateActivation({
          requestId,
          targetDigest: UpdateActivationTargetDigest.make("a".repeat(64)),
        }),
      );
      assert.equal(result._tag, "Failure");
      assert.equal(result._tag === "Failure" ? result.failure.reason : null, "not_trial");
    }).pipe(Effect.provide(harness.dependencies));
  }),
);

it.layer(NodeServices.layer)("update activation commit record", (it) => {
  it.effect("writes the exact external record at the stable runtime path", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "lastcode-activation-" });
        const record = {
          requestId,
          schemaVersion: 1,
          status: "committed",
          targetDigest: UpdateActivationTargetDigest.make("c".repeat(64)),
        } as const;

        yield* persistUpdateActivationCommit(baseDir, record);
        const recordPath = yield* updateActivationCommitRecordPath(baseDir, requestId);
        assert.deepStrictEqual(decodeActivationCommitRecord(yield* fs.readFileString(recordPath)), {
          ...record,
        });
        assert.deepStrictEqual(
          yield* readUpdateActivationCommit(baseDir, {
            requestId,
            targetDigest: record.targetDigest,
          }),
          record,
        );
        assert.equal(
          (yield* Effect.result(
            readUpdateActivationCommit(baseDir, {
              requestId,
              targetDigest: UpdateActivationTargetDigest.make("d".repeat(64)),
            }),
          ))._tag,
          "Failure",
        );
      }),
    ),
  );
});
