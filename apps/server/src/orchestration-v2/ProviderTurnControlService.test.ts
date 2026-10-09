import { assert, it } from "@effect/vitest";
import {
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2SessionRuntime } from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderAdapterSteerRunError } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";

const driver = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;

it.effect("preserves steering rejection separately from turn completion", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:steer-rejected");
    const providerSessionId = ProviderSessionId.make("session:steer-rejected");
    const providerThreadId = ProviderThreadId.make("provider-thread:steer-rejected");
    const providerTurnId = ProviderTurnId.make("provider-turn:steer-rejected");
    const messageId = MessageId.make("message:steer-rejected");
    const runId = RunId.make("run:steer-rejected");
    const nodeId = NodeId.make("node:steer-rejected");
    const attemptId = RunAttemptId.make("attempt:steer-rejected");
    const providerThread: OrchestrationV2ProviderThread = {
      id: providerThreadId,
      driver,
      providerInstanceId,
      providerSessionId,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "active",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    };
    for (const testCase of [
      { target: "recorded", status: "running", adapterRejected: true, deliveryRejected: true },
      {
        target: "recorded",
        status: "running",
        adapterRejected: undefined,
        deliveryRejected: undefined,
      },
      {
        target: "recorded",
        status: "pending",
        adapterRejected: undefined,
        deliveryRejected: undefined,
      },
      ...(["completed", "interrupted", "failed", "cancelled"] as const).map((status) => ({
        target: "recorded" as const,
        status,
        adapterRejected: undefined,
        deliveryRejected: true,
      })),
      ...(["completed", "interrupted", "failed", "cancelled", "rolled_back"] as const).map(
        (runStatus) => ({
          target: "terminal-run" as const,
          status: "running" as const,
          runStatus,
          adapterRejected: undefined,
          deliveryRejected: true,
        }),
      ),
      ...(
        [
          "detached",
          "retargeted",
          "missing-thread",
          "missing-turn",
          "mismatched-thread",
          "missing-run",
          "missing-message",
        ] as const
      ).map((target) => ({
        target,
        status: "running" as const,
        adapterRejected: undefined,
        deliveryRejected: true,
      })),
      {
        target: "read-failure",
        status: "running",
        adapterRejected: undefined,
        deliveryRejected: undefined,
      },
      {
        target: "missing-run",
        status: "pending",
        adapterRejected: undefined,
        deliveryRejected: undefined,
      },
      ...(["missing-session", "session-read-failure"] as const).map((target) => ({
        target,
        status: "running" as const,
        adapterRejected: undefined,
        deliveryRejected: undefined,
      })),
    ] as const) {
      const runStatus = "runStatus" in testCase ? testCase.runStatus : "running";
      const context = {
        providerThread:
          testCase.target === "missing-thread"
            ? undefined
            : {
                ...providerThread,
                providerSessionId:
                  testCase.target === "detached"
                    ? null
                    : testCase.target === "retargeted"
                      ? ProviderSessionId.make("session:replacement")
                      : providerSessionId,
              },
        providerTurn:
          testCase.target === "missing-turn"
            ? undefined
            : {
                id: providerTurnId,
                providerThreadId:
                  testCase.target === "mismatched-thread"
                    ? ProviderThreadId.make("provider-thread:other")
                    : providerThreadId,
                status: testCase.status,
                nodeId,
                runAttemptId: attemptId,
                nativeTurnRef: null,
                ordinal: 1,
                startedAt: now,
                completedAt:
                  testCase.status === "running" || testCase.status === "pending" ? null : now,
              },
        attempt: undefined,
        message:
          testCase.target === "missing-message"
            ? undefined
            : {
                id: messageId,
                threadId,
                runId,
                nodeId,
                role: "user",
                text: "Pause after the current tool.",
                attachments: [],
                createdBy: "user",
                creationSource: "server",
                streaming: false,
                createdAt: now,
                updatedAt: now,
              },
        run:
          testCase.target === "missing-run"
            ? undefined
            : {
                id: runId,
                threadId,
                ordinal: 1,
                providerInstanceId,
                modelSelection,
                providerThreadId,
                userMessageId: messageId,
                rootNodeId: nodeId,
                activeAttemptId: attemptId,
                status: runStatus,
                requestedAt: now,
                startedAt: now,
                completedAt: null,
                checkpointId: null,
                contextHandoffId: null,
              },
      } satisfies ProjectionStore.ProjectionProviderControlContext;
      const runtime = {
        instanceId: providerInstanceId,
        driver,
        providerSessionId,
        providerSession: {
          id: providerSessionId,
          driver,
          providerInstanceId,
          status: "running",
          cwd: "/workspace",
          model: modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
        events: Stream.empty,
        ensureThread: () => Effect.die("unused ensureThread"),
        resumeThread: () => Effect.die("unused resumeThread"),
        startTurn: () => Effect.die("unused startTurn"),
        steerTurn: () =>
          testCase.target === "recorded" && testCase.status === "running"
            ? Effect.fail(
                new ProviderAdapterSteerRunError({
                  driver,
                  providerThreadId,
                  providerTurnId,
                  ...(testCase.adapterRejected ? { deliveryRejected: true } : {}),
                }),
              )
            : Effect.die("Inactive provider turns must not receive steering"),
        interruptTurn: () => Effect.die("unused interruptTurn"),
        respondToRuntimeRequest: () => Effect.die("unused respondToRuntimeRequest"),
        readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
        rollbackThread: () => Effect.die("unused rollbackThread"),
        forkThread: () => Effect.die("unused forkThread"),
      } satisfies ProviderAdapterV2SessionRuntime;
      const layerControl = ProviderTurnControlService.layer.pipe(
        Layer.provide(
          Layer.merge(
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getProviderControlContext: () =>
                testCase.target === "read-failure"
                  ? Effect.fail(
                      new ProjectionStore.ProjectionStoreReadError({
                        threadId,
                        cause: "storage unavailable",
                      }),
                    )
                  : Effect.succeed(context),
            }),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              get: () =>
                testCase.target === "missing-session"
                  ? Effect.succeed(Option.none())
                  : testCase.target === "session-read-failure"
                    ? Effect.fail(
                        new ProviderSessionManager.ProviderSessionLookupError({
                          providerSessionId,
                          cause: "session unavailable",
                        }),
                      )
                    : testCase.target === "recorded"
                      ? Effect.succeed(Option.some(runtime))
                      : Effect.die("Invalid targets must not reach a live provider session"),
            }),
          ),
        ),
      );
      const error = yield* Effect.gen(function* () {
        const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
        return yield* control
          .steer({
            threadId,
            providerSessionId,
            providerThreadId,
            providerTurnId,
            messageId,
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(layerControl));
      assert.equal(
        error.turnCompleted,
        testCase.status === "pending"
          ? false
          : testCase.target === "recorded"
            ? testCase.status === "completed"
            : testCase.target === "terminal-run"
              ? runStatus === "completed"
              : undefined,
        testCase.target,
      );
      assert.equal(error.deliveryRejected, testCase.deliveryRejected, testCase.target);
      assert.equal(
        context.providerTurn?.status,
        testCase.target === "missing-turn" ? undefined : testCase.status,
      );
    }
  }),
);

function makeProjection(input: {
  readonly now: DateTime.Utc;
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly providerTurnId: ProviderTurnId;
  readonly attemptId: RunAttemptId;
}): OrchestrationV2ThreadProjection {
  const runId = RunId.make("run:restart-session");
  const nodeId = NodeId.make("node:restart-session");
  return {
    thread: {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId: ProjectId.make("project:restart-session"),
      title: "Restart session",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: "/workspace",
      activeProviderThreadId: input.providerThread.id,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: input.threadId,
      },
      forkedFrom: null,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    runs: [],
    attempts: [
      {
        id: input.attemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId: nodeId,
        providerInstanceId,
        providerThreadId: input.providerThread.id,
        providerTurnId: input.providerTurnId,
        reason: "initial",
        status: "superseded",
        startedAt: input.now,
        completedAt: input.now,
      },
    ],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [input.providerThread],
    providerTurns: [
      {
        id: input.providerTurnId,
        providerThreadId: input.providerThread.id,
        nodeId,
        runAttemptId: input.attemptId,
        nativeTurnRef: {
          driver,
          nativeId: "native-turn:restart-session",
          strength: "strong",
        },
        ordinal: 1,
        status: "running",
        startedAt: input.now,
        completedAt: null,
      },
    ],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: input.now,
  };
}

it.effect(
  "interrupts the historical session only for the exact committed restart replacement",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:restart-session");
      const oldSessionId = ProviderSessionId.make("provider-session:restart-session:old");
      const replacementSessionId = ProviderSessionId.make(
        "provider-session:restart-session:replacement",
      );
      const unrelatedSessionId = ProviderSessionId.make(
        "provider-session:restart-session:unrelated",
      );
      const providerThreadId = ProviderThreadId.make("provider-thread:restart-session");
      const providerTurnId = ProviderTurnId.make("provider-turn:restart-session");
      const attemptId = RunAttemptId.make("run-attempt:restart-session");
      const providerThread: OrchestrationV2ProviderThread = {
        id: providerThreadId,
        driver,
        providerInstanceId,
        // The restart command has already projected this replacement binding
        // before the process-bound restart effect executes.
        providerSessionId: replacementSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: {
          driver,
          nativeId: "native-thread:restart-session",
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "not_loaded",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const projection = yield* Ref.make(
        makeProjection({ now, threadId, providerThread, providerTurnId, attemptId }),
      );
      const interruptedThread = yield* Ref.make<OrchestrationV2ProviderThread | null>(null);
      const providerSession = {
        id: oldSessionId,
        driver,
        providerInstanceId,
        status: "running" as const,
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const runtime: ProviderAdapterV2SessionRuntime = {
        instanceId: providerInstanceId,
        driver,
        providerSessionId: oldSessionId,
        providerSession,
        events: Stream.empty,
        ensureThread: () => Effect.die("unused ensureThread"),
        resumeThread: () => Effect.die("unused resumeThread"),
        startTurn: () => Effect.die("unused startTurn"),
        steerTurn: () => Effect.die("unused steerTurn"),
        interruptTurn: ({ providerThread: target }) =>
          Effect.all(
            [
              Ref.set(interruptedThread, target),
              Ref.update(projection, (current) => ({
                ...current,
                providerTurns: current.providerTurns.map((turn) =>
                  turn.id === providerTurnId
                    ? { ...turn, status: "interrupted" as const, completedAt: now }
                    : turn,
                ),
              })),
            ],
            { discard: true },
          ),
        respondToRuntimeRequest: () => Effect.die("unused respondToRuntimeRequest"),
        readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
        rollbackThread: () => Effect.die("unused rollbackThread"),
        forkThread: () => Effect.die("unused forkThread"),
      };
      const layerProjection = Layer.succeed(
        ProjectionStore.ProjectionStoreV2,
        ProjectionStore.ProjectionStoreV2.of({
          apply: () => Effect.void,
          getLimitRecoveryCandidates: () => Effect.die("unused getLimitRecoveryCandidates"),
          getOwnedThreadIds: () => Effect.die("not used by turn control tests"),
          getGroupedCreatorThreadIds: () => Effect.die("not used by turn control tests"),
          getShellSnapshot: () => Effect.die("unused getShellSnapshot"),
          readShellSnapshot: () => Effect.die("unused readShellSnapshot"),
          getThreadShell: () => Effect.die("unused getThreadShell"),
          getWorktreeCleanupThreads: Effect.die("unused getWorktreeCleanupThreads"),
          getPersistentThreads: Effect.die("unused getPersistentThreads"),
          getThread: () => Ref.get(projection).pipe(Effect.map((state) => state.thread)),
          getSettlementCandidates: () => Effect.die("unused getSettlementCandidates"),
          getThreadsWithPullRequests: () => Effect.die("unused getThreadsWithPullRequests"),
          getThreadProjection: () => Effect.die("control effects must not load transcript"),
          getTurnStartContext: () => Effect.die("unused"),
          getTurnStartHistory: () => Effect.die("unused"),
          getRuntimeRecoveryProjection: () => Effect.die("unused getRuntimeRecoveryProjection"),
          getPlan: () => Effect.die("unused"),
          hasUnpairedRunInterruptRequest: () => Effect.die("unused interrupt read"),
          getThreadAttachmentIds: () => Effect.die("Unused attachment lookup"),
          searchThread: () => Effect.die("unused"),
          searchThreadStream: () => Stream.empty,
          getThreadHistoryPage: () => Effect.die("unused"),
          getTimelinePage: () => Effect.die("Unused timeline read"),
          getInheritedPublications: () => Effect.die("Unused inherited publication read"),
          getMessageCount: () => Effect.die("unused message count"),
          getNextTurnItemOrdinal: () => Effect.die("unused ordinal read"),
          getTurnItem: () => Effect.die("unused turn item read"),
          getThreadRecords: () => Effect.die("unused record read"),
          getRuntimeRequest: () => Effect.die("unused getRuntimeRequest"),
          getRunningTurnContext: () => Effect.die("unused getRunningTurnContext"),
          getThreadProviderContext: () => Effect.die("unused getThreadProviderContext"),
          getRuntimeResponseContext: () => Effect.die("unused getRuntimeResponseContext"),
          getPendingNativeUserInputs: () => Effect.die("unused getPendingNativeUserInputs"),
          getProviderControlContext: (_threadId, target) =>
            Ref.get(projection).pipe(
              Effect.map((current) => ({
                providerThread: current.providerThreads.find(
                  (thread) => thread.id === target.providerThreadId,
                ),
                providerTurn: current.providerTurns.find(
                  (turn) => turn.id === target.providerTurnId,
                ),
                attempt: current.attempts.find((attempt) => attempt.id === target.attemptId),
                message: undefined,
                run: undefined,
              })),
            ),
          getCheckpointContext: () => Effect.die("not used"),
          getCheckpointCaptureContext: () => Effect.die("not used"),
          getRunMessage: () => Effect.die("not used"),
          canStartQueuedRun: () => Effect.die("not used"),
          getRecoveryThreadIds: () => Effect.die("unused getRecoveryThreadIds"),
          getUnreadableThreadIds: () => Effect.die("unused getUnreadableThreadIds"),
          getThreadSnapshot: () => Effect.die("unused getThreadSnapshot"),
          getThreadSnapshotWindow: () => Effect.die("unused getThreadSnapshotWindow"),
        }),
      );
      const layerSessionManager = Layer.succeed(
        ProviderSessionManager.ProviderSessionManagerV2,
        ProviderSessionManager.ProviderSessionManagerV2.of({
          shutdown: Effect.void,
          open: () => Effect.die("unused open"),
          isLive: (providerSessionId) => Effect.succeed(providerSessionId === oldSessionId),
          pendingExecution: Effect.succeed([]),
          ownershipRevision: Effect.succeed(0),
          get: (providerSessionId) =>
            Effect.succeed(
              providerSessionId === oldSessionId ? Option.some(runtime) : Option.none(),
            ),
          close: () => Effect.void,
          closeInstance: () => Effect.void,
          teardownThread: () => Effect.die("unused teardownThread"),
          release: () => Effect.void,
          detach: () => Effect.void,
        }),
      );
      const layerControl = ProviderTurnControlService.layer.pipe(
        Layer.provide(Layer.merge(layerProjection, layerSessionManager)),
      );

      const [ordinaryInterrupt, unrelatedRestart] = yield* Effect.gen(function* () {
        const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
        const ordinary = yield* Effect.exit(
          control.interrupt({
            threadId,
            providerSessionId: oldSessionId,
            providerThreadId,
            providerTurnId,
          }),
        );
        const unrelated = yield* Effect.exit(
          control.interruptAndAwaitTerminal({
            threadId,
            providerSessionId: oldSessionId,
            replacementProviderSessionId: unrelatedSessionId,
            providerThreadId,
            providerTurnId,
            interruptedAttemptId: attemptId,
          }),
        );
        return [ordinary, unrelated] as const;
      }).pipe(Effect.provide(layerControl));

      assert.isTrue(Exit.isFailure(ordinaryInterrupt));
      assert.isTrue(Exit.isFailure(unrelatedRestart));
      assert.isNull(yield* Ref.get(interruptedThread));

      yield* Effect.gen(function* () {
        const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
        yield* control.interruptAndAwaitTerminal({
          threadId,
          providerSessionId: oldSessionId,
          replacementProviderSessionId: replacementSessionId,
          providerThreadId,
          providerTurnId,
          interruptedAttemptId: attemptId,
        });
      }).pipe(Effect.provide(layerControl));

      const interrupted = yield* Ref.get(interruptedThread);
      assert.isNotNull(interrupted);
      assert.equal(interrupted?.providerSessionId, oldSessionId);
      assert.equal(interrupted?.id, providerThreadId);
      assert.equal(interrupted?.nativeThreadRef?.nativeId, "native-thread:restart-session");
    }),
);
