import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  OrchestrationV2Command,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  RunId,
  TurnItemId,
  UpdateDrainAdmissionError,
  UpdateDrainRequestId,
  UpdateDrainTargetVersion,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as UpdateDrainAdmission from "../updateDrain/UpdateDrainAdmission.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import {
  archivedShellStreamItemFromThreadShell,
  shellStreamItemFromThreadShell,
} from "./ShellStream.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Metadata does not launch a provider"),
} as ProviderAdapterV2Shape;
const database = SqlitePersistenceMemory;
const testLayer = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "lastcode-metadata" },
    ProviderAdapterRegistry.makeLayer([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

const create = (threadId: ThreadId, projectId: ProjectId) => ({
  type: "thread.create" as const,
  commandId: CommandId.make(`create:${threadId}`),
  threadId,
  projectId,
  title: "Metadata thread",
  modelSelection: { instanceId, model: "gpt-6" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  createdBy: "user" as const,
  creationSource: "web" as const,
});

const decodeCommand = Schema.decodeUnknownSync(OrchestrationV2Command);

it.effect(
  "preserves a question through automatic usage recovery and clears it on a user reply",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("attention:automatic-recovery");
      yield* orchestrator.dispatch(create(threadId, ProjectId.make("attention:project")));
      const send = (suffix: string) => ({
        type: "message.dispatch" as const,
        commandId: CommandId.make(`attention:send:${suffix}`),
        threadId,
        messageId: MessageId.make(`attention:message:${suffix}`),
        text: "Continue working",
        attachments: [],
        createdBy: "user" as const,
        creationSource: "web" as const,
        dispatchMode: { type: "queue_after_active" as const },
      });
      yield* orchestrator.dispatch(send("initial"));
      const run = (yield* projections.getThreadRecords(threadId, ["runs"])).runs[0];
      assert.isDefined(run);
      const now = yield* DateTime.now;
      const resetAt = DateTime.formatIso(DateTime.add(now, { seconds: 1 }));
      yield* sink.write({
        events: [
          {
            id: EventId.make("attention:run-failed"),
            type: "run.updated",
            threadId,
            occurredAt: now,
            payload: { ...run, status: "failed", completedAt: now },
          },
          {
            id: EventId.make("attention:limit-error"),
            type: "turn-item.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make("attention:limit-error"),
              type: "error",
              threadId,
              runId: run.id,
              nodeId: run.rootNodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 2,
              status: "failed",
              title: "Usage limit reached",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              failure: {
                class: "usage_limit",
                message: "Plan limit reached",
                code: "usageLimitExceeded",
                retryable: null,
                resetAt,
              },
            },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("attention:arm-recovery"),
        threadId,
        limitRecovery: { runId: run.id, resetAt, autoResume: true },
      });
      const recovery = (yield* projections.getThread(threadId)).limitRecovery;
      assert.ok(recovery != null);
      yield* orchestrator.dispatch({
        type: "thread.attention.set",
        commandId: CommandId.make("attention:raise-question"),
        threadId,
        attention: { kind: "question", raisedAt: DateTime.formatIso(now) },
      });
      yield* orchestrator.dispatch({
        ...send("stale-recovery"),
        creationSource: "server",
        dispatchMode: { type: "start_immediately" },
        usageLimitContinuationOfRunId: RunId.make("attention:stale-run"),
      });
      assert.equal((yield* projections.getThread(threadId)).attention?.kind, "question");
      yield* TestClock.adjust("1 second");
      yield* orchestrator.dispatch({
        ...send("automatic-recovery"),
        creationSource: "server",
        dispatchMode: { type: "start_immediately" },
        usageLimitContinuationOfRunId: run.id,
        ...(recovery.requestId === undefined
          ? {}
          : { usageLimitRecoveryRequestId: recovery.requestId }),
      });
      assert.equal((yield* projections.getThreadRecords(threadId, ["runs"])).runs.length, 2);
      assert.equal((yield* projections.getThread(threadId)).attention?.kind, "question");
      yield* orchestrator.dispatch(send("human-reply"));
      assert.isNull((yield* projections.getThread(threadId)).attention);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("preserves definite pre-commit projection failures across intake admission", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const failure = yield* Effect.flip(
      orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("intake:missing-thread"),
        threadId: ThreadId.make("missing:intake-thread"),
        messageId: MessageId.make("missing:intake-message"),
        text: "Cannot dispatch",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "queue_after_active" },
      }),
    );
    assert.equal(failure._tag, "OrchestratorProjectionError");
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "keeps failed cleanup visible through Retry and Keep Worktree, then removes its shell",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      for (const archived of [false, true]) {
        const threadId = ThreadId.make(`cleanup:visibility:${archived}`);
        yield* orchestrator.dispatch(
          create(threadId, ProjectId.make("cleanup:visibility-project")),
        );
        if (archived) {
          yield* orchestrator.dispatch({
            type: "thread.archive",
            commandId: CommandId.make(`cleanup:archive:${threadId}`),
            threadId,
          });
          const archive = yield* projections.getShellSnapshot({ location: "archive" });
          assert.include(
            archive.archivedThreads.map(({ id }) => id),
            threadId,
          );
        }
        const now = yield* DateTime.now;
        const deleting = {
          status: "deleting" as const,
          repositoryRoot: "/example/repository",
          worktreePath: "/example/worktree",
          startedAt: DateTime.formatIso(now),
        };
        const [deleted] = yield* sink.write({
          events: [
            {
              id: EventId.make(`cleanup:visibility:deleted:${archived}`),
              type: "thread.deleted",
              threadId,
              occurredAt: now,
              payload: {
                ...(yield* projections.getThread(threadId)),
                deletedAt: now,
                archivedAt: archived ? now : null,
                worktreeCleanup: deleting,
              },
            },
          ],
        });
        assert.isDefined(deleted);
        let shell = yield* projections.getThreadShell(threadId);
        assert.equal(shell?.worktreeCleanup?.status, "deleting");
        assert.equal(
          shellStreamItemFromThreadShell({ stored: deleted, shell }).kind,
          "thread.updated",
        );
        if (archived) {
          assert.deepStrictEqual(shell?.archivedAt, now);
          assert.equal(
            archivedShellStreamItemFromThreadShell({ stored: deleted, shell })?.kind,
            "thread.removed",
          );
        }
        const markFailed = (commandId: string) =>
          Effect.gen(function* () {
            const cleanup = (yield* projections.getThread(threadId)).worktreeCleanup;
            assert.ok(cleanup?.status === "deleting");
            yield* orchestrator.dispatch({
              type: "thread.worktree-cleanup.update",
              commandId: CommandId.make(commandId),
              threadId,
              expectedCleanup: cleanup,
              cleanup: {
                ...cleanup,
                status: "failed",
                failedAt: DateTime.formatIso(now),
                error: "Worktree is busy",
              },
            });
          });
        yield* markFailed(`cleanup:fail:${archived}`);
        shell = yield* projections.getThreadShell(threadId);
        assert.equal(shell?.worktreeCleanup?.status, "failed");
        const snapshot = yield* projections.getShellSnapshot({ location: "active" });
        assert.include(
          snapshot.threads.map(({ id }) => id),
          threadId,
        );
        const archive = yield* projections.getShellSnapshot({ location: "archive" });
        assert.notInclude(
          archive.archivedThreads.map(({ id }) => id),
          threadId,
        );
        yield* orchestrator.dispatch({
          type: "thread.worktree-cleanup.retry",
          commandId: CommandId.make(`cleanup:retry:${archived}`),
          threadId,
        });
        assert.equal(
          (yield* projections.getThreadShell(threadId))?.worktreeCleanup?.status,
          "deleting",
        );
        yield* markFailed(`cleanup:fail-again:${archived}`);
        const abandoned = yield* orchestrator.dispatch({
          type: "thread.worktree-cleanup.abandon",
          commandId: CommandId.make(`cleanup:keep:${archived}`),
          threadId,
        });
        shell = yield* projections.getThreadShell(threadId);
        assert.isNull(shell);
        const cleared = yield* projections.getShellSnapshot();
        assert.notInclude(
          [...cleared.threads, ...cleared.archivedThreads].map(({ id }) => id),
          threadId,
        );
        const stored = abandoned.storedEvents[0];
        assert.isDefined(stored);
        assert.equal(shellStreamItemFromThreadShell({ stored, shell }).kind, "thread.removed");
        assert.deepStrictEqual(
          (yield* projections.getThread(threadId)).archivedAt,
          archived ? now : null,
        );
      }
    }).pipe(Effect.provide(testLayer)),
);

it.effect("ignores cleanup planted in generic metadata when deleting with the worktree kept", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("cleanup:planted");
    yield* orchestrator.dispatch({
      ...create(threadId, ProjectId.make("cleanup:project")),
      worktreePath: "/example/shared-worktree",
    });
    const command = {
      type: "thread.metadata.update" as const,
      commandId: CommandId.make("cleanup:plant"),
      threadId,
      title: "Keep this worktree",
      worktreeCleanup: {
        status: "queued" as const,
        repositoryRoot: "/example/repository",
        worktreePath: "/example/shared-worktree",
        queuedAt: "2026-01-01T00:00:00.000Z",
        blockedByThreadId: ThreadId.make("cleanup:owner"),
      },
    };
    assert.notProperty(decodeCommand(command), "worktreeCleanup");
    // Internal callers also cannot bypass the specialized cleanup policy.
    yield* orchestrator.dispatch(command);
    assert.isNull((yield* projections.getThread(threadId)).worktreeCleanup ?? null);
    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("cleanup:keep"),
      threadId,
      deleteWorktree: false,
    });
    assert.isNull((yield* projections.getThread(threadId)).worktreeCleanup ?? null);
    assert.deepStrictEqual(yield* projections.getWorktreeCleanupThreads, []);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("atomically replaces the global persistent owner and rejects destructive commands", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const first = ThreadId.make("persistent:first");
    const second = ThreadId.make("persistent:second");
    yield* orchestrator.dispatch(create(first, ProjectId.make("project:first")));
    yield* orchestrator.dispatch(create(second, ProjectId.make("project:second")));
    yield* orchestrator.dispatch({
      type: "thread.persistence.set",
      commandId: CommandId.make("protect:first"),
      threadId: first,
      persistent: true,
    });
    const before = yield* sql`SELECT * FROM orchestration_v2_effect_outbox ORDER BY effect_id`;
    for (const type of ["thread.archive", "thread.delete"] as const) {
      assert.equal(
        (yield* Effect.exit(
          orchestrator.dispatch({ type, commandId: CommandId.make(type), threadId: first }),
        ))._tag,
        "Failure",
      );
    }
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM orchestration_v2_effect_outbox ORDER BY effect_id`,
      before,
    );
    const replacement = yield* orchestrator.dispatch({
      type: "thread.persistence.set",
      commandId: CommandId.make("protect:second"),
      threadId: second,
      persistent: true,
    });
    assert.deepStrictEqual(
      replacement.storedEvents.map(({ event }) => event.threadId),
      [first, second],
    );
    assert.isFalse((yield* projections.getThread(first)).persistent);
    assert.isTrue((yield* projections.getThread(second)).persistent);
    assert.deepStrictEqual(
      (yield* projections.getPersistentThreads).map(({ id }) => id),
      [second],
    );
    yield* Effect.all(
      [
        orchestrator.dispatch({
          type: "thread.persistence.set",
          commandId: CommandId.make("protect:first:again"),
          threadId: first,
          persistent: true,
        }),
        orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("rename:second"),
          threadId: second,
          title: "Keep concurrent title",
        }),
      ],
      { concurrency: "unbounded" },
    );
    assert.equal((yield* projections.getPersistentThreads).length, 1);
    assert.equal((yield* projections.getThread(second)).title, "Keep concurrent title");
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "retains note anchors and resolution, and keeps explicit attention independent of viewing",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("notes:thread");
      yield* orchestrator.dispatch(create(threadId, ProjectId.make("notes:project")));
      const firstAt = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
      const addMessage = (id: string, at: DateTime.Utc) =>
        sink.write({
          events: [
            {
              id: EventId.make(`event:${id}`),
              type: "message.updated",
              threadId,
              occurredAt: at,
              payload: {
                id: MessageId.make(id),
                threadId,
                runId: null,
                nodeId: null,
                role: "user",
                text: "A user message",
                attachments: [],
                streaming: false,
                createdAt: at,
                updatedAt: at,
                createdBy: "user",
                creationSource: "web",
              },
            },
          ],
        });
      yield* addMessage("note:first", firstAt);
      yield* orchestrator.dispatch({
        type: "thread.annotation.upsert",
        commandId: CommandId.make("note:create"),
        threadId,
        body: "Saved note",
      });
      yield* addMessage("note:second", DateTime.add(firstAt, { seconds: 1 }));
      assert.equal(
        (yield* projections.getThread(threadId)).annotation?.anchorMessageId,
        "note:first",
      );
      yield* orchestrator.dispatch({
        type: "thread.annotation.resolve",
        commandId: CommandId.make("note:resolve"),
        threadId,
      });
      const resolved = (yield* projections.getThread(threadId)).annotation;
      assert.equal(resolved?.anchorMessageId, "note:second");
      assert.isNotNull(resolved?.resolvedAt);
      yield* orchestrator.dispatch({
        type: "thread.annotation.upsert",
        commandId: CommandId.make("note:edit"),
        threadId,
        body: "Edited resolved note",
      });
      assert.equal(
        (yield* projections.getThread(threadId)).annotation?.resolvedAt,
        resolved?.resolvedAt,
      );
      yield* orchestrator.dispatch({
        type: "thread.annotation.reopen",
        commandId: CommandId.make("note:reopen"),
        threadId,
      });
      const raisedAt = "2026-01-02T00:00:00.000Z";
      yield* orchestrator.dispatch({
        type: "thread.attention.set",
        commandId: CommandId.make("question:raise"),
        threadId,
        attention: { kind: "question", raisedAt },
      });
      yield* orchestrator.dispatch({
        type: "thread.visit",
        commandId: CommandId.make("question:view"),
        threadId,
        visitedAt: raisedAt,
      });
      assert.equal((yield* projections.getThreadShell(threadId))?.attention?.raisedAt, raisedAt);
      assert.equal(
        (yield* Effect.exit(
          orchestrator.dispatch({
            type: "thread.auto-settle",
            commandId: CommandId.make("question:auto-settle"),
            threadId,
            snapshotAt: yield* DateTime.now,
          }),
        ))._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.exit(
          orchestrator.dispatch({
            type: "thread.snooze",
            commandId: CommandId.make("question:snooze"),
            threadId,
            snoozedUntil: "2099-01-01T00:00:00.000Z",
          }),
        ))._tag,
        "Failure",
      );
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("question:settle"),
        threadId,
      });
      assert.isNull((yield* projections.getThread(threadId)).attention);
      assert.isNull((yield* projections.getThread(threadId)).annotation?.resolvedAt);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects new message intake while update admission is closed", () => {
  const closed = Layer.mock(UpdateDrainAdmission.UpdateDrainAdmission)({
    admit: () =>
      Effect.fail(
        new UpdateDrainAdmissionError({
          message: "Update pending.",
          reason: "update_draining",
          requestId: UpdateDrainRequestId.make("update:request"),
          targetVersion: UpdateDrainTargetVersion.make("example-version"),
        }),
      ),
  });
  const layer = Layer.mergeAll(
    database,
    ProjectionStore.layer.pipe(Layer.provide(database)),
    makeOrchestratorV2ReplayLayerWithRegistry(
      { name: "closed-update-metadata" },
      ProviderAdapterRegistry.makeLayer([adapter]),
      { databaseLayer: database, runEffectWorker: false, admissionLayer: closed },
    ),
  );
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("closed-update:thread");
    yield* orchestrator.dispatch(create(threadId, ProjectId.make("closed-update:project")));
    assert.equal(
      (yield* Effect.exit(
        orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("closed-update:send"),
          threadId,
          messageId: MessageId.make("closed-update:message"),
          text: "New work",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          dispatchMode: { type: "queue_after_active" },
        }),
      ))._tag,
      "Failure",
    );
    assert.equal(
      (yield* projections.getThreadRecords(threadId, ["messages", "runs"])).messages.length,
      0,
    );
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM orchestration_command_receipts WHERE command_id = 'closed-update:send'`,
      [],
    );
    yield* sql`INSERT INTO orchestration_command_receipts
      (command_id, aggregate_kind, aggregate_id, command_type, accepted_at, result_sequence, status, error)
      VALUES ('closed-update:already-accepted','thread',${threadId},'message.dispatch','2026-01-01T00:00:00.000Z',0,'accepted',NULL)`;
    const replay = yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("closed-update:already-accepted"),
      threadId,
      messageId: MessageId.make("closed-update:existing-message"),
      text: "Accepted work replay",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      dispatchMode: { type: "queue_after_active" },
    });
    assert.equal(replay.sequence, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("allows admitted work to update metadata while a turn waits for intake", () =>
  Effect.gen(function* () {
    const mutex = yield* Semaphore.make(1);
    const setupEntered = yield* Deferred.make<void>();
    const turnWaiting = yield* Deferred.make<void>();
    const admission = Layer.mock(UpdateDrainAdmission.UpdateDrainAdmission)({
      admit: () =>
        Deferred.succeed(turnWaiting, undefined).pipe(
          Effect.andThen(
            mutex.withPermits(1)(
              Effect.fail(
                new UpdateDrainAdmissionError({
                  reason: "update_draining",
                  requestId: UpdateDrainRequestId.make("update:lock-order"),
                  targetVersion: UpdateDrainTargetVersion.make("example-version"),
                  message: "Update pending.",
                }),
              ),
            ),
          ),
        ),
    });
    const layer = Layer.mergeAll(
      database,
      ProjectionStore.layer.pipe(Layer.provide(database)),
      makeOrchestratorV2ReplayLayerWithRegistry(
        { name: "admission-lock-order" },
        ProviderAdapterRegistry.makeLayer([adapter]),
        { databaseLayer: database, runEffectWorker: false, admissionLayer: admission },
      ),
    );
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("admission:lock-order");
      yield* orchestrator.dispatch(create(threadId, ProjectId.make("admission:project")));
      const setup = yield* Effect.forkChild(
        mutex.withPermits(1)(
          Effect.gen(function* () {
            yield* Deferred.succeed(setupEntered, undefined);
            yield* Deferred.await(turnWaiting);
            yield* orchestrator.dispatch({
              type: "thread.metadata.update",
              commandId: CommandId.make("admission:setup-metadata"),
              threadId,
              title: "Setup can finish",
            });
          }),
        ),
      );
      yield* Deferred.await(setupEntered);
      const turn = yield* Effect.forkChild(
        Effect.exit(
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("admission:queued-turn"),
            threadId,
            messageId: MessageId.make("admission:queued-message"),
            text: "Wait for setup",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            dispatchMode: { type: "queue_after_active" },
          }),
        ),
      );
      yield* Fiber.join(setup);
      assert.equal((yield* projections.getThread(threadId)).title, "Setup can finish");
      assert.equal((yield* Fiber.join(turn))._tag, "Failure");
    }).pipe(Effect.provide(layer));
  }),
);
