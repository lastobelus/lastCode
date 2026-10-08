import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  UpdateDrainRequestId,
  UpdateDrainTargetVersion,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as UpdateDrainRepository from "../persistence/UpdateDrainRepository.ts";
import * as UpdateDrain from "../updateDrain/UpdateDrain.ts";
import * as UpdateDrainAdmission from "../updateDrain/UpdateDrainAdmission.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceipts from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const threadId = ThreadId.make("archive-update:root");
const childId = ThreadId.make("archive-update:child");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "example-model" };
const requestId = UpdateDrainRequestId.make("archive-update:request");
const archive = {
  type: "thread.archive" as const,
  commandId: CommandId.make("archive-update:archive"),
  threadId,
  childDisposition: "stop_and_archive" as const,
  expectedChildThreadIds: [childId],
};
const observedArchiveId = CommandId.make("archive-update:failed-archive");
const teardownCommand = (kind: "archive" | "archive retry" | "delete") =>
  kind === "delete"
    ? {
        type: "thread.delete" as const,
        commandId: CommandId.make("archive-update:delete"),
        threadId,
      }
    : kind === "archive retry"
      ? { ...archive, expectedArchiveCommandId: observedArchiveId }
      : archive;
type Gate = { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> };
const makeGate = Effect.gen(function* () {
  return { entered: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() };
});

const makeHarness = Effect.gen(function* () {
  const database = SqlitePersistence.layerMemory;
  const projections = ProjectionStore.layer.pipe(Layer.provide(database));
  const archiveRequested = yield* Deferred.make<void>();
  const control = { archiveGate: null as Gate | null, snapshotGate: null as Gate | null };
  const admissionLayer = Layer.effect(
    UpdateDrainAdmission.UpdateDrainAdmission,
    Effect.gen(function* () {
      const delegate = yield* ProjectionStore.ProjectionStoreV2;
      const admission = yield* UpdateDrainAdmission.makeUpdateDrainAdmission().pipe(
        Effect.provideService(ProjectionStore.ProjectionStoreV2, {
          ...delegate,
          getShellSnapshot: (options) =>
            delegate.getShellSnapshot(options).pipe(
              Effect.tap(() =>
                Effect.suspend(() => {
                  const gate = control.snapshotGate;
                  control.snapshotGate = null;
                  return gate === null
                    ? Effect.void
                    : Deferred.succeed(gate.entered, undefined).pipe(
                        Effect.andThen(Deferred.await(gate.release)),
                      );
                }),
              ),
            ),
        }),
      );
      return UpdateDrainAdmission.UpdateDrainAdmission.of({
        ...admission,
        admit: (kind, effect) =>
          (kind === "thread-archive" || kind === "thread-delete"
            ? Deferred.succeed(archiveRequested, undefined)
            : Effect.void
          ).pipe(
            Effect.andThen(
              admission.admit(
                kind,
                Effect.suspend(() => {
                  const gate =
                    kind === "thread-archive" || kind === "thread-delete"
                      ? control.archiveGate
                      : null;
                  if (gate !== null) control.archiveGate = null;
                  return gate === null
                    ? effect
                    : Deferred.succeed(gate.entered, undefined).pipe(
                        Effect.andThen(Deferred.await(gate.release)),
                        Effect.andThen(effect),
                      );
                }),
              ),
            ),
          ),
      });
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        projections,
        EffectOutbox.layer.pipe(Layer.provide(database)),
        UpdateDrain.layer.pipe(Layer.provide(UpdateDrainRepository.layer), Layer.provide(database)),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          pendingExecution: Effect.succeed([]),
        }),
        Layer.mock(TerminalManager.TerminalManager)({ refreshMetadata: Effect.succeed([]) }),
      ),
    ),
    Layer.orDie,
  );
  const replay = ProviderReplayHarness.layerWithRegistry(
    { name: "archive-update" },
    ProviderAdapterRegistry.layerFromAdapters([
      {
        instanceId,
        driver: ProviderDriverKind.make("codex"),
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: () => Effect.die("Archive admission tests start no provider"),
      },
    ]),
    { databaseLayer: database, runEffectWorker: false, admissionLayer },
  );
  return {
    control,
    archiveRequested,
    layer: Layer.mergeAll(
      replay,
      admissionLayer,
      projections,
      CommandReceipts.layer.pipe(Layer.provide(database)),
      EffectOutbox.layer.pipe(Layer.provide(database)),
    ),
  };
});

const seedFamily = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("archive-update:create"),
    threadId,
    projectId: ProjectId.make("archive-update:project"),
    title: "Archive update ordering",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  const root = yield* projections.getThread(threadId);
  const now = yield* DateTime.now;
  yield* sink.write({
    events: [
      {
        id: EventId.make("archive-update:child-created"),
        type: "thread.created",
        threadId: childId,
        occurredAt: now,
        payload: {
          ...root,
          id: childId,
          title: "Owned child",
          lineage: {
            parentThreadId: threadId,
            rootThreadId: threadId,
            relationshipToParent: "subagent",
          },
        },
      },
      {
        id: EventId.make("archive-update:provider-binding"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: ProviderThreadId.make("archive-update:provider-thread"),
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: instanceId,
          providerSessionId: ProviderSessionId.make("archive-update:provider-session"),
          appThreadId: threadId,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      },
    ],
  });
});

const startDrain = Effect.gen(function* () {
  const admission = yield* UpdateDrainAdmission.UpdateDrainAdmission;
  return yield* admission.dispatch({
    type: "update-drain.start",
    commandId: CommandId.make("archive-update:start-drain"),
    requestId,
    targetVersion: UpdateDrainTargetVersion.make("1.2.3"),
    createdAt: DateTime.formatIso(yield* DateTime.now),
  });
});

it.effect("commits an admitted archive before drain and prevents activation until it settles", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const gate = yield* makeGate;
    harness.control.archiveGate = gate;
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const admission = yield* UpdateDrainAdmission.UpdateDrainAdmission;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      yield* seedFamily;
      const archiving = yield* orchestrator.dispatch(archive).pipe(Effect.forkChild);
      assert.isTrue(
        yield* Effect.race(
          Deferred.await(gate.entered).pipe(Effect.as(true)),
          Fiber.await(archiving).pipe(Effect.as(false)),
        ),
      );
      const drainRequested = yield* Deferred.make<void>();
      const claiming = yield* Deferred.succeed(drainRequested, undefined).pipe(
        Effect.andThen(startDrain),
        Effect.andThen(admission.claimActivation({ requestId })),
        Effect.result,
        Effect.forkChild,
      );
      yield* Deferred.await(drainRequested);
      yield* Deferred.succeed(gate.release, undefined);
      yield* Fiber.join(archiving);
      const claim = yield* Fiber.join(claiming);
      assert.equal(claim._tag, "Failure");
      if (claim._tag === "Failure") assert.equal(claim.failure.reason, "not_quiescent");
      for (const id of [threadId, childId])
        assert.equal((yield* projections.getThread(id)).archivePending?.status, "stopping");
      assert.equal((yield* admission.status).intent?.status, "draining");
      assert.lengthOf(yield* outbox.listByCommandId(archive.commandId), 1);

      // Already admitted teardown can complete during drain; replay starts no new teardown.
      yield* orchestrator.dispatch({
        type: "thread.archive.complete",
        commandId: CommandId.make("archive-update:complete"),
        threadId,
        requestId: archive.commandId,
      });
      assert.deepEqual(
        (yield* admission.status).blockers,
        [
          { type: "thread-cleanup" as const, threadId },
          { type: "thread-cleanup" as const, threadId: childId },
        ].toSorted((a, b) => a.threadId.localeCompare(b.threadId)),
      );
      assert.equal(
        (yield* admission.claimActivation({ requestId }).pipe(Effect.result))._tag,
        "Failure",
      );
      // Drain the durable archive/terminal rows; no runtime is started by this test.
      const durableEffects = [
        ...(yield* outbox.listByCommandId(archive.commandId)),
        ...(yield* outbox.listByCommandId(CommandId.make("archive-update:complete"))),
      ];
      for (const _effect of durableEffects) {
        const next = Option.getOrThrow(
          yield* outbox.claimNext({ workerId: "test-cleanup", leaseDurationMs: 60000 }),
        );
        yield* outbox.succeed({ effectId: next.id, workerId: "test-cleanup" });
      }
      yield* admission.claimActivation({ requestId });
      const sequence = (yield* orchestrator.getShellSnapshot()).snapshotSequence;
      yield* orchestrator.dispatch(archive);
      const conflict = yield* orchestrator
        .dispatch({ ...archive, threadId: childId })
        .pipe(Effect.flip);
      assert.equal(conflict._tag, "OrchestratorCommandIdConflictError");
      assert.equal((yield* orchestrator.getShellSnapshot()).snapshotSequence, sequence);
      assert.lengthOf(yield* outbox.listByCommandId(archive.commandId), 1);
    }).pipe(
      Effect.ensuring(Deferred.succeed(gate.release, undefined)),
      Effect.provide(harness.layer),
    );
  }),
);

it.effect.each(["archive", "archive retry", "delete"] as const)(
  "refuses %s between the activation snapshot and claim without side effects",
  (kind) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const gate = yield* makeGate;
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const admission = yield* UpdateDrainAdmission.UpdateDrainAdmission;
        const receipts = yield* CommandReceipts.CommandReceiptStoreV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        yield* seedFamily;
        if (kind === "archive retry") {
          const root = yield* projections.getThread(threadId);
          const now = yield* DateTime.now;
          const sink = yield* EventSink.EventSinkV2;
          yield* sink.write({
            events: [
              {
                id: EventId.make("archive-update:failed"),
                type: "thread.metadata-updated",
                threadId,
                occurredAt: now,
                payload: {
                  ...root,
                  archivePending: {
                    threadId,
                    commandId: observedArchiveId,
                    status: "failed",
                    childDisposition: "stop_and_archive",
                    childThreadIds: [childId],
                    archiveThreadIds: [threadId, childId],
                    promoteThreadIds: [],
                    error: "Controlled failure",
                  },
                },
              },
            ],
          });
        }
        const command = teardownCommand(kind);
        const before = yield* Effect.forEach([threadId, childId], (id) =>
          projections.getThreadProjection(id),
        );
        const sequence = (yield* orchestrator.getShellSnapshot()).snapshotSequence;
        yield* startDrain;
        harness.control.snapshotGate = gate;
        const claiming = yield* admission.claimActivation({ requestId }).pipe(Effect.forkChild);
        yield* Deferred.await(gate.entered);
        const archiving = yield* orchestrator
          .dispatch(command)
          .pipe(Effect.result, Effect.forkChild);
        assert.isTrue(
          yield* Effect.race(
            Deferred.await(harness.archiveRequested).pipe(Effect.as(true)),
            Fiber.await(archiving).pipe(Effect.as(false)),
          ),
        );
        yield* Deferred.succeed(gate.release, undefined);
        assert.equal((yield* Fiber.join(claiming)).commandType, "update-drain.claim");
        const rejected = yield* Fiber.join(archiving);
        assert.equal(rejected._tag, "Failure");
        if (rejected._tag === "Failure") {
          assert.equal(rejected.failure._tag, "OrchestratorDispatchError");
          if (rejected.failure._tag === "OrchestratorDispatchError")
            assert.equal(
              (rejected.failure.cause as { _tag: string })._tag,
              "UpdateDrainAdmissionError",
            );
        }
        const afterClaim = { ...command, commandId: CommandId.make("archive-update:after-claim") };
        assert.equal(
          (yield* orchestrator.dispatch(afterClaim).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal((yield* admission.status).intent?.status, "claimed");
        assert.equal((yield* orchestrator.getShellSnapshot()).snapshotSequence, sequence);
        assert.deepEqual(
          yield* Effect.forEach([threadId, childId], (id) => projections.getThreadProjection(id)),
          before,
        );
        for (const command of [teardownCommand(kind), afterClaim]) {
          assert.isTrue(Option.isNone(yield* receipts.getByCommandId(command.commandId)));
          assert.isEmpty(yield* outbox.listByCommandId(command.commandId));
        }
      }).pipe(
        Effect.ensuring(Deferred.succeed(gate.release, undefined)),
        Effect.provide(harness.layer),
      );
    }),
);

it.effect(
  "refuses new archive during drain and leaves its identity retryable after cancellation",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const admission = yield* UpdateDrainAdmission.UpdateDrainAdmission;
        const receipts = yield* CommandReceipts.CommandReceiptStoreV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        yield* seedFamily;
        const before = yield* Effect.forEach([threadId, childId], (id) =>
          projections.getThreadProjection(id),
        );
        yield* startDrain;
        assert.equal((yield* orchestrator.dispatch(archive).pipe(Effect.result))._tag, "Failure");
        assert.deepEqual(
          yield* Effect.forEach([threadId, childId], (id) => projections.getThreadProjection(id)),
          before,
        );
        assert.isTrue(Option.isNone(yield* receipts.getByCommandId(archive.commandId)));
        assert.isEmpty(yield* outbox.listByCommandId(archive.commandId));
        yield* admission.dispatch({
          type: "update-drain.cancel",
          commandId: CommandId.make("archive-update:cancel"),
          requestId,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });
        yield* orchestrator.dispatch(archive);
        assert.equal((yield* projections.getThread(threadId)).archivePending?.status, "stopping");
        assert.equal(
          Option.getOrThrow(yield* receipts.getByCommandId(archive.commandId)).status,
          "accepted",
        );
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect("keeps an accepted idle deletion blocked through pending and running cleanup", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const admission = yield* UpdateDrainAdmission.UpdateDrainAdmission;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* seedFamily;
      const command = teardownCommand("delete");
      yield* orchestrator.dispatch(command);
      assert.isNotNull((yield* projections.getThread(threadId)).deletedAt);
      yield* startDrain;
      assert.isNotEmpty(yield* outbox.pendingCleanup);
      assert.equal(
        (yield* admission.claimActivation({ requestId }).pipe(Effect.result))._tag,
        "Failure",
      );
      const pending = yield* outbox.listByCommandId(command.commandId);
      for (let count = 0; count < pending.length; count += 1) {
        const running = Option.getOrThrow(
          yield* outbox.claimNext({ workerId: "delete-cleanup", leaseDurationMs: 60000 }),
        );
        assert.equal(
          (yield* admission.claimActivation({ requestId }).pipe(Effect.result))._tag,
          "Failure",
        );
        yield* outbox.succeed({ effectId: running.id, workerId: "delete-cleanup" });
      }
      yield* admission.claimActivation({ requestId });
      const sequence = (yield* orchestrator.getShellSnapshot()).snapshotSequence;
      yield* orchestrator.dispatch(command);
      assert.equal((yield* orchestrator.getShellSnapshot()).snapshotSequence, sequence);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect(
  "allows settlement during drain and replays it after activation, while refusing new teardown producers",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const admission = yield* UpdateDrainAdmission.UpdateDrainAdmission;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const receipts = yield* CommandReceipts.CommandReceiptStoreV2;
        yield* seedFamily;
        yield* startDrain;
        const settle = {
          type: "thread.settle" as const,
          commandId: CommandId.make("settle-during-drain"),
          threadId,
        };
        yield* orchestrator.dispatch(settle);
        const pending = yield* outbox.listByCommandId(settle.commandId);
        for (let count = 0; count < pending.length; count += 1) {
          const effect = Option.getOrThrow(
            yield* outbox.claimNext({ workerId: "settle-cleanup", leaseDurationMs: 60000 }),
          );
          yield* outbox.succeed({ effectId: effect.id, workerId: "settle-cleanup" });
        }
        yield* admission.claimActivation({ requestId });
        yield* orchestrator.dispatch(settle);
        const before = (yield* orchestrator.getShellSnapshot()).snapshotSequence;
        const commands = [
          { type: "thread.settle" as const },
          { type: "thread.auto-settle" as const, snapshotAt: yield* DateTime.now },
          {
            type: "provider-session.detach" as const,
            providerSessionId: ProviderSessionId.make("archive-update:provider-session"),
          },
          { type: "thread.worktree-cleanup.retry" as const },
          { type: "thread.runtime-mode.set" as const, runtimeMode: "approval-required" as const },
          {
            type: "thread.model-selection.set" as const,
            modelSelection: { ...modelSelection, model: "other-model" },
          },
          { type: "provider.switch" as const, modelSelection },
          { type: "thread.metadata.update" as const, worktreePath: "/work/other" },
        ].map((command) => ({
          ...command,
          threadId,
          commandId: CommandId.make(`claimed:${command.type}`),
        }));
        for (const command of commands) {
          const failure = yield* orchestrator.dispatch(command).pipe(Effect.flip);
          assert.equal(failure._tag, "OrchestratorDispatchError");
          if (failure._tag === "OrchestratorDispatchError")
            assert.equal((failure.cause as { _tag: string })._tag, "UpdateDrainAdmissionError");
          assert.isTrue(Option.isNone(yield* receipts.getByCommandId(command.commandId)));
          assert.isEmpty(yield* outbox.listByCommandId(command.commandId));
        }
        assert.equal((yield* orchestrator.getShellSnapshot()).snapshotSequence, before);
        // Unrelated metadata is still available for work that has already finished.
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("claimed:title"),
          threadId,
          title: "Finished",
        });
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect.each(["queued", "deleting"] as const)(
  "retains real deleted-thread %s worktree cleanup and accepts its completion during drain",
  (status) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const admission = yield* UpdateDrainAdmission.UpdateDrainAdmission;
        const sink = yield* EventSink.EventSinkV2;
        yield* seedFamily;
        const thread = yield* projections.getThread(threadId);
        const now = yield* DateTime.now;
        const iso = DateTime.formatIso(now);
        const paths = { repositoryRoot: "/work/example", worktreePath: "/work/example-child" };
        const cleanup =
          status === "queued"
            ? { ...paths, status, queuedAt: iso, blockedByThreadId: childId }
            : { ...paths, status, startedAt: iso };
        yield* sink.write({
          events: [
            {
              id: EventId.make(`cleanup:${status}`),
              type: "thread.deleted",
              threadId,
              occurredAt: now,
              payload: { ...thread, deletedAt: now, worktreeCleanup: cleanup },
            },
          ],
        });
        const shell = yield* projections.getShellSnapshot();
        assert.equal(
          shell.threads.find((thread) => thread.id === threadId)?.worktreeCleanup?.status,
          status,
        );
        yield* startDrain;
        assert.deepEqual((yield* admission.status).blockers, [
          { type: "thread-cleanup", threadId },
        ]);
        assert.equal(
          (yield* admission.claimActivation({ requestId }).pipe(Effect.result))._tag,
          "Failure",
        );
        const deleting = { ...paths, status: "deleting" as const, startedAt: iso };
        if (status === "queued") {
          yield* orchestrator.dispatch({
            type: "thread.worktree-cleanup.update",
            commandId: CommandId.make("cleanup:start"),
            threadId,
            expectedCleanup: cleanup,
            cleanup: deleting,
          });
          assert.equal(
            (yield* admission.claimActivation({ requestId }).pipe(Effect.result))._tag,
            "Failure",
          );
        }
        yield* orchestrator.dispatch({
          type: "thread.worktree-cleanup.update",
          commandId: CommandId.make("cleanup:finish"),
          threadId,
          expectedCleanup: deleting,
          cleanup: null,
        });
        assert.isNull(yield* projections.getThreadShell(threadId));
        yield* admission.claimActivation({ requestId });
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect("allows activation with failed worktree history and refuses a fresh retry", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const admission = yield* UpdateDrainAdmission.UpdateDrainAdmission;
      const sink = yield* EventSink.EventSinkV2;
      const receipts = yield* CommandReceipts.CommandReceiptStoreV2;
      yield* seedFamily;
      const thread = yield* projections.getThread(threadId);
      const now = yield* DateTime.now;
      const iso = DateTime.formatIso(now);
      yield* sink.write({
        events: [
          {
            id: EventId.make("cleanup:failed"),
            type: "thread.deleted",
            threadId,
            occurredAt: now,
            payload: {
              ...thread,
              deletedAt: now,
              worktreeCleanup: {
                repositoryRoot: "/work/example",
                worktreePath: "/work/example-child",
                status: "failed",
                startedAt: iso,
                failedAt: iso,
                error: "Controlled failure",
              },
            },
          },
        ],
      });
      yield* startDrain;
      const retry = {
        type: "thread.worktree-cleanup.retry" as const,
        threadId,
        commandId: CommandId.make("cleanup:retry"),
      };
      assert.equal((yield* orchestrator.dispatch(retry).pipe(Effect.result))._tag, "Failure");
      assert.equal((yield* projections.getThread(threadId)).worktreeCleanup?.status, "failed");
      assert.isTrue(Option.isNone(yield* receipts.getByCommandId(retry.commandId)));
      assert.isEmpty((yield* admission.status).blockers);
      yield* admission.claimActivation({ requestId });
      assert.equal((yield* orchestrator.dispatch(retry).pipe(Effect.result))._tag, "Failure");
    }).pipe(Effect.provide(harness.layer));
  }),
);
