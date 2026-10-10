import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import {
  CommandId,
  EventId,
  getThreadArchivePlan,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { DispatchModeLimit } from "./DispatchModeLimit.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2 } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderRuntimeRecoveryService from "./ProviderRuntimeRecoveryService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const parentId = ThreadId.make("archive-restart-parent");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const parentSessionId = ProviderSessionId.make("archive-restart-parent-session");
const childSessionId = ProviderSessionId.make("archive-restart-child-session");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Archive recovery must never restart provider execution"),
} as ProviderAdapterV2["Service"];

function runtimeLayer(dbPath: string, workspace: string) {
  const database = SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));
  const stores = Layer.mergeAll(ProjectionStore.layer, EffectOutbox.layer).pipe(
    Layer.provide(database),
  );
  const runtime = ProviderReplayHarness.layerWithRegistry(
    { name: "archive-restart", runtimePolicyOverride: { cwd: workspace } },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  );
  const threads = ThreadManagementService.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(database, stores, runtime)),
  );
  // The replay harness skips startup recovery when its daemon is disabled.
  // Run the real recovery service explicitly, then drain the real worker.
  return ProviderRuntimeRecoveryService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        threads,
        IdAllocator.layer,
        ServerSettings.layerTest({ continueThreadsAfterServerUpdate: false }).pipe(Layer.orDie),
      ),
    ),
  );
}

const createFamily = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("restart-create-parent"),
    threadId: parentId,
    projectId: ProjectId.make("project:archive-restart"),
    title: "Archive restart parent",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("restart-start-parent"),
    threadId: parentId,
    messageId: MessageId.make("restart-parent-message"),
    text: "Start the isolated fixture",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  const run = (yield* orchestrator.getThreadProjection(parentId)).runs[0]!;
  yield* orchestrator.dispatch({
    type: "delegated_task.request",
    commandId: CommandId.make("restart-delegate-child"),
    parentThreadId: parentId,
    parentRunId: run.id,
    parentNodeId: run.rootNodeId!,
    task: "Isolated child work",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    completionWake: "always",
    createdBy: "agent",
    creationSource: "mcp",
  });
  const childId = (yield* orchestrator.getThreadProjection(parentId)).subagents[0]!.childThreadId!;
  for (const [threadId, providerSessionId] of [
    [parentId, parentSessionId],
    [childId, childSessionId],
  ] as const) {
    const providerThread = (yield* orchestrator.getThreadProjection(threadId)).providerThreads[0]!;
    yield* projections.apply({
      id: EventId.make(`restart-binding:${threadId}`),
      type: "provider-thread.updated",
      threadId,
      occurredAt: yield* DateTime.now,
      payload: { ...providerThread, providerSessionId },
    });
    yield* projections.apply({
      id: EventId.make(`restart-session:${threadId}`),
      type: "provider-session.attached",
      threadId,
      occurredAt: yield* DateTime.now,
      payload: {
        id: providerSessionId,
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: instanceId,
        status: "ready",
        cwd: ".",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: yield* DateTime.now,
        updatedAt: yield* DateTime.now,
        lastError: null,
      },
    });
  }
  return childId;
});

const archiveCommand = (childId: ThreadId, childDisposition: "stop_and_archive") => ({
  type: "thread.archive" as const,
  commandId: CommandId.make(`archive-restart:${childDisposition}`),
  threadId: parentId,
  childDisposition,
  expectedChildThreadIds: [childId],
});

const claimArchiveBeforeProcessLoss = Effect.fnUntraced(function* (commandId: CommandId) {
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  // A kept child's earlier start effect can precede the archive. Leave such
  // claims running as well: startup must retire process-bound execution.
  for (let claimed = 0; claimed < 8; claimed++) {
    const next = yield* outbox.claimNext({ workerId: "previous-runtime", leaseDurationMs: 60_000 });
    assert.isTrue(Option.isSome(next));
    if (Option.isNone(next)) return yield* Effect.die("Expected the persisted archive effect");
    if (next.value.request.type === "thread.archive") {
      assert.equal(next.value.commandId, commandId);
      assert.equal(next.value.status, "running");
      return next.value.id;
    }
  }
  return yield* Effect.die("Archive effect was not claimable within the fixture's bounded outbox");
});

const temporaryDatabase = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspace = yield* Effect.acquireRelease(
    fs.makeTempDirectory({ prefix: "archive-family-restart-" }),
    (directory) => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
  );
  return { workspace, dbPath: path.join(workspace, "state.sqlite") };
});

it.effect(
  "recovers a claimed pending archive and shuts down its saved family without restarting work",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { workspace, dbPath } = yield* temporaryDatabase;
        const staged = yield* Effect.scoped(
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const childId = yield* createFamily;
            const command = archiveCommand(childId, "stop_and_archive");
            const result = yield* orchestrator.dispatch(command);
            const effectId = yield* claimArchiveBeforeProcessLoss(command.commandId);
            const pending = (yield* orchestrator.getThreadProjection(parentId)).thread
              .archivePending;
            assert.equal(pending?.status, "stopping");
            assert.deepEqual(getThreadArchivePlan(pending)?.archiveThreadIds, [parentId, childId]);
            return { childId, command, effectId, sequence: result.sequence };
          }).pipe(Effect.provide(runtimeLayer(dbPath, workspace))),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const outbox = yield* EffectOutbox.EffectOutboxV2;
            const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
            const shutdown = vi.spyOn(manager, "teardownThread");
            try {
              const persisted = (yield* orchestrator.getThreadProjection(parentId)).thread;
              assert.equal(persisted.archivePending?.commandId, staged.command.commandId);
              assert.isNull(persisted.archivedAt);
              const recovered =
                yield* (yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService)
                  .recover;
              assert.isAtLeast(recovered.requeuedEffects, 1);
              assert.equal(Option.getOrThrow(yield* outbox.get(staged.effectId)).status, "pending");
              yield* orchestrator.recoverDelegatedTasks;
              yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
              const completed = Option.getOrThrow(yield* outbox.get(staged.effectId));
              assert.equal(completed.status, "succeeded");
              assert.equal(completed.attemptCount, 2);
              const shutdownCalls = shutdown.mock.calls.map(([input]) => input);
              assert.deepEqual(shutdownCalls[0], {
                threadId: staged.childId,
                providerSessionId: childSessionId,
              });
              assert.deepInclude(shutdownCalls, {
                threadId: parentId,
                providerSessionId: parentSessionId,
              });
              const archived = yield* orchestrator
                .streamStoredEventsFrom({
                  threadId: parentId,
                  afterSequence: staged.sequence,
                })
                .pipe(
                  Stream.filter((stored) => stored.event.type === "thread.archived"),
                  Stream.runHead,
                );
              assert.isTrue(Option.isSome(archived));
              for (const id of [parentId, staged.childId]) {
                const projection = yield* orchestrator.getThreadProjection(id);
                assert.isNotNull(projection.thread.archivedAt);
                assert.equal(projection.thread.archivedWith?.commandId, staged.command.commandId);
                assert.isNull(projection.thread.archivePending);
                assert.isEmpty(projection.providerSessions);
                assert.lengthOf(projection.runs, 1);
                assert.equal(projection.runs[0]?.status, "cancelled");
              }
            } finally {
              shutdown.mockRestore();
            }
          }).pipe(Effect.provide(runtimeLayer(dbPath, workspace))),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            for (const id of [parentId, staged.childId])
              assert.isEmpty((yield* orchestrator.getThreadProjection(id)).providerSessions);
            yield* orchestrator.dispatch({
              type: "thread.unarchive",
              commandId: CommandId.make("restart-restore-detached-family"),
              threadId: parentId,
            });
            for (const id of [parentId, staged.childId]) {
              const projection = yield* orchestrator.getThreadProjection(id);
              assert.isNull(projection.thread.archivedAt);
              assert.isEmpty(projection.providerSessions);
              assert.equal(projection.runs[0]?.status, "cancelled");
            }
          }).pipe(Effect.provide(runtimeLayer(dbPath, workspace))),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps a dismissed failure clear after SQLite reopen and archive effect recovery", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { workspace, dbPath } = yield* temporaryDatabase;
      const staged = yield* Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const childId = yield* createFamily;
          const command = archiveCommand(childId, "stop_and_archive");
          yield* orchestrator.dispatch(command);
          const effectId = yield* claimArchiveBeforeProcessLoss(command.commandId);
          yield* orchestrator.dispatch({
            type: "thread.archive.fail",
            commandId: CommandId.make(`${command.commandId}:failed`),
            threadId: parentId,
            requestId: command.commandId,
            error: "Isolated shutdown failure before dismissal",
          });
          const before = yield* Effect.forEach([parentId, childId], (id) =>
            orchestrator.getThreadProjection(id),
          );
          const dismissal = {
            type: "thread.unarchive" as const,
            commandId: CommandId.make("restart-dismiss-failure"),
            threadId: parentId,
            expectedArchiveCommandId: command.commandId,
          };
          yield* orchestrator.dispatch(dismissal);
          assert.isEmpty(
            yield* (yield* EffectOutbox.EffectOutboxV2).listByCommandId(dismissal.commandId),
          );
          for (const previous of before) {
            const current = yield* orchestrator.getThreadProjection(previous.thread.id);
            assert.isNull(current.thread.archivePending);
            assert.deepEqual({ ...current, thread: previous.thread }, previous);
          }
          return { childId, command, effectId };
        }).pipe(Effect.provide(runtimeLayer(dbPath, workspace))),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const outbox = yield* EffectOutbox.EffectOutboxV2;
          for (const id of [parentId, staged.childId]) {
            const thread = (yield* orchestrator.getThreadProjection(id)).thread;
            assert.isNull(thread.archivePending);
            assert.isNull(thread.archivedAt);
          }
          yield* (yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService).recover;
          yield* orchestrator.recoverDelegatedTasks;
          yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
          assert.equal(Option.getOrThrow(yield* outbox.get(staged.effectId)).status, "succeeded");
          for (const id of [parentId, staged.childId]) {
            const projection = yield* orchestrator.getThreadProjection(id);
            assert.isNull(projection.thread.archivePending);
            assert.isNull(projection.thread.archivedAt);
            assert.lengthOf(projection.runs, 1);
            assert.equal(projection.runs[0]?.status, "cancelled");
            assert.isUndefined(projection.thread.lineage.independent);
          }
          const originalFailure = yield* (yield* ThreadManagementService.ThreadManagementService)
            .dispatch(staged.command)
            .pipe(Effect.flip);
          assert.equal(originalFailure._tag, "OrchestratorDispatchError");
          if (originalFailure._tag === "OrchestratorDispatchError")
            assert.equal(originalFailure.cause, "Isolated shutdown failure before dismissal");
        }).pipe(Effect.provide(runtimeLayer(dbPath, workspace))),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { runtimeMode: "approval-required", interactionMode: "default", mode: "runtime" },
  { runtimeMode: "full-access", interactionMode: "plan", mode: "interaction" },
] as const)(
  "preserves a legacy pending operation's $mode ceiling after restart and permits a fresh family retry",
  (limit) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { workspace, dbPath } = yield* temporaryDatabase;
        const staged = yield* Effect.scoped(
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const projections = yield* ProjectionStore.ProjectionStoreV2;
            const childId = yield* createFamily;
            for (const id of [parentId, childId]) {
              const thread = (yield* orchestrator.getThreadProjection(id)).thread;
              yield* projections.apply({
                id: EventId.make(`restart-limited:${id}`),
                type: "thread.metadata-updated",
                threadId: id,
                occurredAt: yield* DateTime.now,
                payload: {
                  ...thread,
                  runtimeMode: limit.runtimeMode,
                  interactionMode: limit.interactionMode,
                },
              });
            }
            const command = archiveCommand(childId, "stop_and_archive");
            const result = yield* orchestrator
              .dispatch(command)
              .pipe(Effect.provideService(DispatchModeLimit, limit));
            // Simulate the durable shape emitted by the retired archive-promotion path.
            // New commands use family archive, while already pending operations still recover.
            const root = yield* projections.getThread(parentId);
            const legacyPending = { ...getThreadArchivePlan(root.archivePending)! };
            delete legacyPending.familyVersion;
            const child = yield* projections.getThread(childId);
            const now = yield* DateTime.now;
            yield* projections.apply({
              id: EventId.make("restart-legacy-pending-owner"),
              type: "thread.metadata-updated",
              threadId: parentId,
              occurredAt: now,
              payload: {
                ...root,
                archivePending: {
                  ...legacyPending,
                  childDisposition: "promote",
                  archiveThreadIds: [parentId],
                  promoteThreadIds: [childId],
                },
              },
            });
            yield* projections.apply({
              id: EventId.make("restart-legacy-pending-child"),
              type: "thread.metadata-updated",
              threadId: childId,
              occurredAt: now,
              payload: { ...child, archivePending: null },
            });
            const effectId = yield* claimArchiveBeforeProcessLoss(command.commandId);
            return { childId, command, effectId, sequence: result.sequence };
          }).pipe(Effect.provide(runtimeLayer(dbPath, workspace))),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const outbox = yield* EffectOutbox.EffectOutboxV2;
            const pending = (yield* orchestrator.getThreadProjection(parentId)).thread
              .archivePending;
            assert.deepEqual(getThreadArchivePlan(pending)?.modeLimit, {
              runtimeMode: limit.runtimeMode,
              interactionMode: limit.interactionMode,
            });
            yield* (yield* ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService).recover;
            yield* orchestrator.recoverDelegatedTasks;
            yield* orchestrator.dispatch(
              limit.mode === "runtime"
                ? {
                    type: "thread.runtime-mode.set",
                    commandId: CommandId.make("restart-raise-runtime"),
                    threadId: staged.childId,
                    runtimeMode: "full-access",
                  }
                : {
                    type: "thread.interaction-mode.set",
                    commandId: CommandId.make("restart-raise-interaction"),
                    threadId: staged.childId,
                    interactionMode: "default",
                  },
            );
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            yield* worker.drain();
            const root = (yield* orchestrator.getThreadProjection(parentId)).thread;
            assert.isNull(root.archivedAt);
            assert.equal(root.archivePending?.status, "failed");
            assert.include(root.archivePending?.error, "Permissions changed while stopping");
            assert.isEmpty((yield* orchestrator.getThreadProjection(parentId)).providerSessions);
            const failed = yield* orchestrator
              .streamStoredEventsFrom({ threadId: parentId, afterSequence: staged.sequence })
              .pipe(
                Stream.filter(
                  (stored) =>
                    stored.event.type === "thread.metadata-updated" &&
                    stored.event.payload.archivePending?.status === "failed",
                ),
                Stream.runHead,
              );
            assert.isTrue(Option.isSome(failed));
            const originalEffect = Option.getOrThrow(yield* outbox.get(staged.effectId));
            assert.equal(originalEffect.status, "succeeded");
            assert.equal(originalEffect.attemptCount, 2);
            const child = (yield* orchestrator.getThreadProjection(staged.childId)).thread;
            assert.isNull(child.archivedAt);
            assert.isUndefined(child.lineage.independent);
            assert.isUndefined(
              (yield* orchestrator.getThreadProjection(parentId)).subagents[0]?.ownershipReleased,
            );
            const threads = yield* ThreadManagementService.ThreadManagementService;
            const refusal = yield* threads.dispatch(staged.command).pipe(Effect.flip);
            assert.ok(refusal._tag === "OrchestratorDispatchError");
            assert.equal(refusal.cause, root.archivePending?.error);
            const retry = {
              ...staged.command,
              commandId: CommandId.make(`${staged.command.commandId}:fresh-retry`),
            };
            yield* orchestrator.dispatch(retry);
            assert.isUndefined(
              getThreadArchivePlan(
                (yield* orchestrator.getThreadProjection(parentId)).thread.archivePending,
              )?.modeLimit,
            );
            yield* worker.drain();
            assert.isNotNull((yield* orchestrator.getThreadProjection(parentId)).thread.archivedAt);
            const released = yield* orchestrator.getThreadProjection(staged.childId);
            assert.isNotNull(released.thread.archivedAt);
            assert.isUndefined(released.thread.lineage.independent);
            assert.lengthOf(released.runs, 1);
            assert.equal(released.runs[0]?.status, "cancelled");
            assert.isAbove((yield* threads.dispatch(retry)).sequence, staged.sequence);
          }).pipe(Effect.provide(runtimeLayer(dbPath, workspace))),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
