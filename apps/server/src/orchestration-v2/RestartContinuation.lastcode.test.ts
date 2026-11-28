import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import { lostBackgroundResultWork } from "./LastCodeLostBackgroundResults.ts";
import { restartCancelledBackgroundWorkNote } from "./RestartBackgroundNote.ts";
import { continueRestartedRun } from "./RestartContinuation.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const layer = ProviderRuntimeRecovery.layer.pipe(
  Layer.provideMerge(
    EventSink.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          EventStore.layer,
          ProjectionStore.layer,
          EffectOutbox.layer,
          IdAllocator.layer,
        ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true })),
);

it("distinguishes an undelivered result from an interrupted command", () => {
  const running = { kind: "shell", label: "Run checks", awaited: true } as const;
  const interrupted = restartCancelledBackgroundWorkNote([running]);
  assert.include(interrupted, "cancelled before it finished");
  assert.include(interrupted, "- shell: Run checks");

  const mixed = restartCancelledBackgroundWorkNote([lostBackgroundResultWork("publish"), running]);
  assert.include(mixed, "- undelivered result: Background command result delivery (id publish)");
  assert.include(mixed, "- shell: Run checks");
  assert.include(mixed, "verify what took effect before reporting success or repeating any work");
  assert.notInclude(mixed, "cancelled before it finished");
});

it.effect.each([
  { trigger: "startup", pending: false },
  { trigger: "shutdown", pending: false },
  { trigger: "startup", pending: true },
] as const)(
  "retains an owed result through $trigger (also listed as pending=$pending)",
  ({ trigger, pending }) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const now = yield* DateTime.now;
      const idleThreadId = ThreadId.make("thread:0:idle");
      const threadId = ThreadId.make("thread:1:owed");
      const runId = RunId.make("run:owed");
      const providerThreadId = ProviderThreadId.make("provider-thread:owed");
      const providerSessionId = ProviderSessionId.make("session:shared");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const driver = ProviderDriverKind.make("codex");
      const modelSelection = { instanceId: providerInstanceId, model: "gpt-6-luna" };
      const taskId = "command:owed";

      for (const id of [idleThreadId, threadId]) {
        yield* store.apply({
          id: EventId.make(`event:${id}:created`),
          type: "thread.created",
          threadId: id,
          occurredAt: now,
          payload: {
            id,
            projectId: ProjectId.make("project:restart"),
            title: "Restart recovery",
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            createdBy: "user",
            creationSource: "web",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: id === threadId ? providerThreadId : null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });
        yield* store.apply({
          id: EventId.make(`event:${id}:attached`),
          type: "provider-session.attached",
          threadId: id,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: {
            id: providerSessionId,
            driver,
            providerInstanceId,
            status: "ready",
            cwd: "/workspace",
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
        });
      }
      yield* store.apply({
        id: EventId.make("event:provider-thread:owed"),
        type: "provider-thread.updated",
        threadId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: providerThreadId,
          appThreadId: threadId,
          ownerNodeId: null,
          driver,
          providerInstanceId,
          providerSessionId,
          nativeThreadRef: { driver, nativeId: "native:owed", strength: "strong" },
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          pendingBackgroundTasks: pending
            ? [{ taskId, kind: "command", description: "Build package", awaited: true, runId }]
            : [],
          owedBackgroundResults: [{ taskId, originRunId: runId }],
        },
      });
      yield* store.apply({
        id: EventId.make(`event:${runId}`),
        type: "run.created",
        threadId,
        runId,
        occurredAt: now,
        payload: {
          id: runId,
          ordinal: 1,
          status: "completed",
          threadId,
          providerInstanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make(`message:${runId}`),
          rootNodeId: null,
          activeAttemptId: null,
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });

      const runtimeCandidates = yield* store.getRecoveryThreadIds("runtime");
      const continuationCandidates = yield* store.getRecoveryThreadIds("restart-continuations");
      if (trigger === "shutdown") yield* recovery.prepareForShutdown;
      yield* recovery.reconcile(trigger);
      const saved = yield* store.getThreadRecords(threadId, ["providerThreads", "runs"]);
      const sourceRunId = runId;
      const expectedLabel = pending
        ? `Build package (id ${taskId})`
        : `Background command result delivery (id ${taskId})`;
      const effect = Option.getOrUndefined(
        yield* outbox.get(`effect:restart-continuation:${sourceRunId}`),
      );
      assert.deepEqual(
        {
          runtimeCandidate: runtimeCandidates.includes(threadId),
          continuationCandidate: continuationCandidates.includes(threadId),
          owed: saved.providerThreads[0]?.owedBackgroundResults,
          lostWork: saved.runs.find((run) => run.id === sourceRunId)
            ?.restartCancelledBackgroundWork,
          continuation: effect?.request,
        },
        {
          runtimeCandidate: true,
          continuationCandidate: true,
          owed: [],
          lostWork: [
            {
              kind: pending ? "shell" : "task",
              label: expectedLabel,
              id: taskId,
              awaited: true,
              resultDeliveryLost: true,
            },
          ],
          continuation: {
            type: "provider-runtime.continue",
            sourceRunId,
            processLossCount: trigger === "startup" ? 1 : 0,
          },
        },
      );
      if (effect?.request.type !== "provider-runtime.continue") return;
      const commands: Parameters<
        ThreadManagementService.ThreadManagementService["Service"]["dispatch"]
      >[0][] = [];
      const dispatch = continueRestartedRun({
        threadId,
        sourceRunId: effect.request.sourceRunId,
      }).pipe(
        Effect.provide(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: (id, fields, filter) =>
              store.getThreadRecords(id, fields, filter).pipe(Effect.orDie),
            recoverDelegatedTask: () => Effect.void,
            dispatch: (command) => {
              commands.push(command);
              return Effect.succeed({} as never);
            },
          }),
        ),
      );
      yield* dispatch;
      assert.lengthOf(commands, 1);
      const command = commands[0]!;
      assert.equal(command.type, "message.dispatch");
      if (command.type === "message.dispatch") {
        assert.equal(command.restartContinuationOfRunId, sourceRunId);
        assert.include(command.text, expectedLabel);
        assert.include(
          command.text,
          "verify what took effect before reporting success or repeating",
        );
        assert.notInclude(command.text, "cancelled before it finished");
      }
      const source = saved.runs.find((run) => run.id === sourceRunId)!;
      yield* store.apply({
        id: EventId.make("event:run:fresh"),
        type: "run.created",
        threadId,
        runId: RunId.make("run:fresh"),
        occurredAt: now,
        payload: {
          ...source,
          id: RunId.make("run:fresh"),
          ordinal: 2,
          status: "completed",
        },
      });
      yield* dispatch;
      assert.lengthOf(commands, 1, "a new turn supersedes the planned restart continuation");
    }).pipe(Effect.provide(layer)),
);
