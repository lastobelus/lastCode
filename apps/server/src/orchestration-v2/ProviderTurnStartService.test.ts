import { expect, it, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import {
  CheckpointScopeId,
  ContextHandoffId,
  MessageId,
  NodeId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSetupError,
  RunAttemptId,
  RunId,
  ThreadId,
  ProjectId,
  type OrchestrationV2ThreadProjection,
  OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  ProviderAdapterEventStreamError,
  ProviderAdapterTurnStartError,
  type ProviderAdapterV2SessionRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as Ref from "effect/Ref";
import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as PauseStore from "../environment/EnvironmentPauseStore.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";
import * as ThreadTitleRegenerationService from "./ThreadTitleRegenerationService.ts";
import * as IncomingMessageSummaryService from "./IncomingMessageSummaryService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as SubagentPromotionService from "./SubagentPromotionService.ts";
import { CommandId } from "@t3tools/contracts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

const isDomainEvent = Schema.is(OrchestrationV2DomainEvent);

it("does not commit running state when inherited background routing cannot be read", async () => {
  const threadId = ThreadId.make("thread_provider_turn_start_projection_failure");
  const runId = RunId.make("run_provider_turn_start_projection_failure");
  const attemptId = RunAttemptId.make("attempt_provider_turn_start_projection_failure");
  const rootNodeId = NodeId.make("node_provider_turn_start_projection_failure");
  const providerThreadId = ProviderThreadId.make(
    "provider_thread_provider_turn_start_projection_failure",
  );
  const providerSessionId = ProviderSessionId.make(
    "provider_session_provider_turn_start_projection_failure",
  );
  const messageId = MessageId.make("message_provider_turn_start_projection_failure");
  const checkpointScopeId = CheckpointScopeId.make(
    "checkpoint_scope_provider_turn_start_projection_failure",
  );
  const projection = {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project_provider_turn_start_projection_failure"),
      branch: "feature/restore",
      worktreePath: "/tmp/missing-provider-turn-start-worktree",
    },
    runs: [
      {
        id: runId,
        status: "starting",
        rootNodeId,
        activeAttemptId: attemptId,
        providerThreadId,
        userMessageId: messageId,
        ordinal: 2,
      },
    ],
    nodes: [{ id: rootNodeId, checkpointScopeId }],
    attempts: [{ id: attemptId }],
    providerThreads: [{ id: providerThreadId, providerSessionId }],
    messages: [{ id: messageId, text: "Continue", attachments: [] }],
    checkpointScopes: [{ id: checkpointScopeId }],
    contextHandoffs: [],
    contextTransfers: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  let projectionReadCount = 0;
  const writeIfRunCurrent = vi.fn(() =>
    Effect.succeed({ committed: true, storedEvents: [] } as never),
  );
  const startRootRun = vi.fn(() => Effect.void);
  const pruneWorktrees = vi.fn(() => Effect.void);
  const createWorktree = vi.fn(() => Effect.succeed({} as never));
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
        Layer.mock(EventSink.EventSinkV2)({ writeIfRunCurrent }),
        IdAllocator.layer,
        Layer.succeed(FileSystem.FileSystem, { exists: () => Effect.succeed(false) } as never),
        Layer.mock(GitWorkflow.GitWorkflowService)({ pruneWorktrees, createWorktree }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({ workspaceRoot: "/tmp/provider-turn-start-project" } as never),
            ),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getTurnStartContext: () => {
            projectionReadCount += 1;
            return Effect.succeed({
              ...projection,
              hasConversation: projection.messages.some(
                (m) =>
                  m.role === "user" &&
                  (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
              ),
            });
          },
          getRuntimeRecoveryProjection: () => {
            projectionReadCount += 1;
            return Effect.fail(
              new ProjectionStore.ProjectionStoreReadError({
                threadId,
                cause: "simulated inherited-background projection failure",
              }),
            );
          },
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
        Layer.mock(ProviderAuthService.ProviderAuthService)({
          tryHandlePromptCommand: () => Effect.succeed(false),
        }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({}),
      ),
    ),
  );

  await Effect.gen(function* () {
    const error = yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2)
      .start({ threadId, runId })
      .pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(projectionReadCount).toBe(2);
    expect(pruneWorktrees).toHaveBeenCalledWith({ cwd: "/tmp/provider-turn-start-project" });
    expect(createWorktree).toHaveBeenCalledWith({
      cwd: "/tmp/provider-turn-start-project",
      refName: "feature/restore",
      path: "/tmp/missing-provider-turn-start-worktree",
    });
    expect(writeIfRunCurrent).not.toHaveBeenCalled();
    expect(startRootRun).not.toHaveBeenCalled();
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

function makeLocalCommandHarness(input: {
  readonly text: string;
  readonly previousNativeSession?: boolean;
  readonly previousMessages?: ReadonlyArray<string>;
  readonly logoutFailure?: string;
  readonly openFailure?: unknown;
  /** Opens the session, then fails loading its provider thread. */
  readonly ensureThreadFailure?: unknown;
  /**
   * Resumes a thread that has a native ref: resume fails, the fresh-thread
   * fallback succeeds, then reading history for its handoff fails.
   */
  readonly historyReadFailureAfterFallback?: unknown;
  readonly interruptOpen?: boolean;
  readonly interruptRunBeforeOpenFailure?: boolean;
  readonly writeFailure?: unknown;
  /** Loads the thread and starts the run, then fails every later state read. */
  readonly failReadsAfterRunning?: boolean;
  readonly nativeStart?: "accepted" | "ack-lost" | "handoff-failure";
  readonly direction?: "pause" | "resume";
  readonly retryThenContextFailure?: boolean;
  readonly initialRunStatus?: OrchestrationV2ThreadProjection["runs"][number]["status"];
  readonly skipStartAt?: "load" | "running-write" | "preparation" | "last-check" | "handoff";
  readonly failFinalization?: boolean;
  readonly onMessageDelivery?: (messageId: MessageId, delivered: boolean) => Effect.Effect<void>;
}) {
  const now = DateTime.makeUnsafe("2026-09-04T12:00:00Z");
  const threadId = ThreadId.make("thread-native-account-command");
  const runId = RunId.make("run-native-account-command");
  const rootNodeId = NodeId.make("root-native-account-command");
  const attemptId = RunAttemptId.make("attempt-native-account-command");
  const providerThreadId = ProviderThreadId.make("new-provider-thread");
  const providerSessionId = ProviderSessionId.make("new-provider-session");
  const oldProviderThreadId = ProviderThreadId.make("existing-native-provider-thread");
  const oldInstanceId = ProviderInstanceId.make("antigravity-personal");
  const newInstanceId = ProviderInstanceId.make("codex-personal");
  const checkpointScopeId = CheckpointScopeId.make("scope-native-account-command");
  const messageId = MessageId.make(
    input.nativeStart === undefined
      ? "message-native-account-command"
      : `environment-pause:fixture:${threadId}:${input.direction ?? "pause"}:0`,
  );
  const run: OrchestrationV2ThreadProjection["runs"][number] = {
    id: runId,
    threadId,
    ordinal: 2,
    providerInstanceId: newInstanceId,
    modelSelection: { instanceId: newInstanceId, model: "gpt-5.4" },
    providerThreadId,
    userMessageId: messageId,
    rootNodeId,
    activeAttemptId: attemptId,
    status: input.initialRunStatus ?? "starting",
    requestedAt: now,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const providerThread: OrchestrationV2ThreadProjection["providerThreads"][number] = {
    id: providerThreadId,
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: newInstanceId,
    providerSessionId,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "not_loaded",
    firstRunOrdinal: 2,
    lastRunOrdinal: 2,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const message: OrchestrationV2ThreadProjection["messages"][number] = {
    id: messageId,
    threadId,
    runId,
    nodeId: rootNodeId,
    role: "user",
    text: input.text,
    attachments: [],
    streaming: false,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
  };
  let projection: OrchestrationV2ThreadProjection = {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project-native-account-command"),
      title: "Example thread",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: newInstanceId,
      modelSelection: run.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      activeProviderThreadId: providerThreadId,
      branch: null,
      worktreePath: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
      settledAt: null,
      settledOverride: null,
      lastVisitedAt: null,
    },
    runs: [
      ...(input.previousNativeSession
        ? [
            {
              ...run,
              id: RunId.make("previous-native-run"),
              ordinal: 1,
              status: "completed" as const,
              providerInstanceId: oldInstanceId,
              providerThreadId: oldProviderThreadId,
            },
          ]
        : []),
      run,
    ],
    attempts: [
      {
        id: attemptId,
        runId,
        rootNodeId,
        attemptOrdinal: 1,
        providerInstanceId: newInstanceId,
        providerThreadId,
        providerTurnId: null,
        reason: "initial",
        status: "pending",
        startedAt: null,
        completedAt: null,
      },
    ],
    nodes: [
      {
        id: rootNodeId,
        threadId,
        runId,
        parentNodeId: null,
        rootNodeId,
        kind: "root_turn",
        status: "pending",
        countsForRun: true,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId,
        startedAt: null,
        completedAt: null,
      },
    ],
    providerThreads: [
      ...(input.previousNativeSession
        ? [
            {
              ...providerThread,
              id: oldProviderThreadId,
              providerInstanceId: oldInstanceId,
              driver: ProviderDriverKind.make("antigravity"),
              lastRunOrdinal: 1,
              nativeThreadRef: {
                driver: ProviderDriverKind.make("antigravity"),
                nativeId: "existing-session",
                strength: "strong" as const,
              },
            },
          ]
        : []),
      providerThread,
    ],
    messages: [
      ...(input.previousMessages ?? []).map((text, index) => ({
        ...message,
        id: MessageId.make(`previous-message-${index}`),
        text,
      })),
      message,
    ],
    checkpointScopes: [
      {
        id: checkpointScopeId,
        threadId,
        runId,
        nodeId: rootNodeId,
        parentScopeId: null,
        providerThreadId,
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/tmp/native-account-command",
        createdAt: now,
      },
    ],
    providerSessions: [],
    providerTurns: [],
    contextHandoffs: [],
    contextTransfers: [],
    turnItems: [],
    visibleTurnItems: [],
    runtimeRequests: [],
    subagents: [],
    plans: [],
    checkpoints: [],
    updatedAt: now,
  };
  if ("historyReadFailureAfterFallback" in input) {
    const nativeThreadRef = {
      driver: providerThread.driver,
      nativeId: "native-resume-thread",
      strength: "strong" as const,
    };
    projection = {
      ...projection,
      providerThreads: projection.providerThreads.map((candidate) =>
        candidate.id === providerThreadId ? { ...candidate, nativeThreadRef } : candidate,
      ),
    };
  }
  if (input.nativeStart === "handoff-failure" || input.skipStartAt === "handoff") {
    projection = {
      ...projection,
      contextHandoffs: [
        {
          id: ContextHandoffId.make("handoff-fixture"),
          threadId,
          targetRunId: runId,
          fromProviderThreadIds: [providerThreadId],
          toProviderThreadId: providerThreadId,
          coveredRunOrdinals: { from: 1, to: 1 },
          strategy: "manual_context",
          status: "ready",
          summaryMessageId: null,
          summaryText: "Example previous context",
          createdByProviderInstanceId: newInstanceId,
          createdAt: now,
          updatedAt: now,
        },
      ],
    };
  }
  const nativePrompts: string[] = [];
  const nativeSession: ProviderAdapterV2SessionRuntime = {
    instanceId: newInstanceId,
    driver: providerThread.driver,
    providerSessionId,
    providerSession: {
      id: providerSessionId,
      driver: providerThread.driver,
      providerInstanceId: newInstanceId,
      status: "ready",
      cwd: "/tmp/native-account-command",
      model: null,
      capabilities: CodexProviderCapabilitiesV2,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    },
    events: Stream.never,
    ensureThread: () =>
      Effect.sync((): OrchestrationV2ThreadProjection["providerThreads"][number] => {
        if (input.skipStartAt === "load") interruptRun();
        return {
          ...providerThread,
          nativeThreadRef: {
            driver: providerThread.driver,
            nativeId: "native-fixture",
            strength: "strong",
          },
        };
      }),
    ...(input.skipStartAt === "last-check"
      ? {
          subscribeEvents: Effect.sync(() => {
            interruptRun();
            return { events: Stream.never, close: Effect.void };
          }),
        }
      : {}),
    resumeThread: () => Effect.die("unused resume"),
    injectHistory: () =>
      input.skipStartAt === "handoff"
        ? Effect.sync(() => {
            interruptRun();
            return true;
          })
        : Effect.fail(
            new ProviderAdapterEventStreamError({
              driver: providerThread.driver,
              providerSessionId,
              cause: "History preparation failed before prompt start",
            }),
          ),
    startTurn: (turn) =>
      Effect.sync(() => {
        nativePrompts.push(turn.message.text);
      }).pipe(
        Effect.andThen(
          input.nativeStart === "ack-lost"
            ? Effect.fail(
                new ProviderAdapterTurnStartError({
                  driver: providerThread.driver,
                  threadId,
                  providerThreadId,
                  runId,
                  cause: "Native prompt received, acknowledgement lost",
                }),
              )
            : Effect.void,
        ),
      ),
    steerTurn: () => Effect.die("unused steer"),
    interruptTurn: () => Effect.die("unused interrupt"),
    respondToRuntimeRequest: () => Effect.die("unused response"),
    readThreadSnapshot: () => Effect.die("unused snapshot"),
    rollbackThread: () => Effect.die("unused rollback"),
    forkThread: () => Effect.die("unused fork"),
  };
  const events: Array<OrchestrationV2DomainEvent> = [];
  const interruptRun = () => {
    projection = {
      ...projection,
      runs: projection.runs.map((candidate) =>
        candidate.id === runId
          ? { ...candidate, status: "interrupted", completedAt: now }
          : candidate,
      ),
    };
  };
  const ensureThread = vi.fn(() =>
    Effect.sync(() => {
      if (input.interruptRunBeforeOpenFailure === true) interruptRun();
    }).pipe(
      Effect.andThen(
        Effect.fail(
          new ProviderAdapterEventStreamError({
            driver: providerThread.driver,
            providerSessionId,
            cause: input.ensureThreadFailure,
          }),
        ),
      ),
    ),
  );
  const resumeFallbackSession = {
    driver: providerThread.driver,
    resumeThread: () =>
      Effect.fail(
        new ProviderAdapterEventStreamError({
          driver: providerThread.driver,
          providerSessionId,
          cause: "native thread is gone",
        }),
      ),
    ensureThread: () => Effect.succeed(providerThread),
  };
  const open = vi.fn(() =>
    input.interruptOpen === true
      ? Effect.interrupt
      : "historyReadFailureAfterFallback" in input
        ? Effect.succeed(resumeFallbackSession as never)
        : "ensureThreadFailure" in input
          ? Effect.succeed({ driver: providerThread.driver, ensureThread } as never)
          : "openFailure" in input
            ? Effect.sync(() => {
                if (input.interruptRunBeforeOpenFailure === true) interruptRun();
              }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new ProviderSessionManager.ProviderSessionOpenError({
                      instanceId: newInstanceId,
                      providerSessionId,
                      cause: input.openFailure,
                    }),
                  ),
                ),
              )
            : input.nativeStart !== undefined
              ? Effect.succeed(nativeSession)
              : input.failReadsAfterRunning === true
                ? Effect.succeed({
                    driver: providerThread.driver,
                    providerSession: {
                      id: providerSessionId,
                      driver: providerThread.driver,
                      providerInstanceId: newInstanceId,
                      status: "ready",
                      cwd: "/tmp/native-account-command",
                      model: null,
                      capabilities: CodexProviderCapabilitiesV2,
                      createdAt: now,
                      updatedAt: now,
                      lastError: null,
                    },
                    ensureThread: () => Effect.succeed(providerThread),
                  } as never)
                : Effect.die("A local command must not open a native session."),
  );
  const startRootRun = vi.fn<
    (input: RunExecutionService.RunExecutionServiceV2StartRootRunInput) => Effect.Effect<void>
  >(() =>
    input.failReadsAfterRunning === true
      ? Effect.void
      : Effect.die("A local command must not start a native turn."),
  );
  const failReadIfRunning = Effect.suspend(() =>
    input.failReadsAfterRunning === true &&
    projection.runs.find((candidate) => candidate.id === runId)?.status === "running"
      ? Effect.fail(
          new ProjectionStore.ProjectionStoreReadError({ threadId, cause: "database unavailable" }),
        )
      : Effect.void,
  );
  const tryHandlePromptCommand = vi.fn(() =>
    input.logoutFailure === undefined
      ? Effect.succeed(true)
      : Effect.fail(
          new ProviderSetupError({
            instanceId: oldInstanceId,
            operation: "logout",
            detail: input.logoutFailure,
          }),
        ),
  );
  const writeIfRunCurrent = vi.fn<EventSink.EventSinkV2Shape["writeIfRunCurrent"]>(
    ({ events: incoming, activeAttemptId, expectedStatus }) =>
      "writeFailure" in input || (input.failFinalization === true && expectedStatus === "running")
        ? Effect.fail(
            new EventSink.EventSinkWriteError({
              eventCount: incoming.length,
              cause: input.writeFailure,
            }),
          )
        : Effect.sync(() => {
            if (input.skipStartAt === "running-write" && expectedStatus === "starting")
              interruptRun();
            const current = projection.runs.find((candidate) => candidate.id === runId);
            const committed =
              current !== undefined &&
              current.activeAttemptId === activeAttemptId &&
              current.status === expectedStatus;
            if (committed) {
              for (const event of incoming) {
                expect(isDomainEvent(event)).toBe(true);
                events.push(event);
                projection = ProjectionStore.applyToProjection(projection, event);
              }
            }
            return { committed, storedEvents: [] };
          }),
  );
  let startContextReads = 0;
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({
          prepareProviderHandoff: () => Effect.die("history read must fail first"),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          writeIfRunCurrent,
          write: ({ events: incoming }) =>
            Effect.sync(() => {
              for (const event of incoming) {
                events.push(event);
                projection = ProjectionStore.applyToProjection(projection, event);
              }
              return [];
            }),
        }),
        IdAllocator.layer,
        FileSystem.layerNoop({}),
        Layer.mock(GitWorkflow.GitWorkflowService)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getTurnStartContext: () =>
            Effect.suspend(() => {
              startContextReads++;
              return input.retryThenContextFailure && startContextReads > 1
                ? Effect.fail(
                    new ProjectionStore.ProjectionStoreReadError({
                      threadId,
                      cause: "Retry context read failed",
                    }),
                  )
                : Effect.succeed({
                    ...projection,
                    hasConversation: projection.messages.some(
                      (m) =>
                        m.role === "user" &&
                        (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
                    ),
                  });
            }),
          getRuntimeRecoveryProjection: () =>
            Effect.as(failReadIfRunning, {
              ...projection,
              hasConversation: projection.messages.some(
                (m) =>
                  m.role === "user" &&
                  (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
              ),
            }),
          getTurnStartHistory: () =>
            Effect.fail(
              new ProjectionStore.ProjectionStoreReadError({
                threadId,
                cause: input.historyReadFailureAfterFallback,
              }),
            ),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ open }),
        Layer.mock(ProviderAuthService.ProviderAuthService)({ tryHandlePromptCommand }),
        input.nativeStart === undefined
          ? Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun })
          : RunExecutionService.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  McpAppModelContext.layerEmpty,
                  Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
                  Layer.mock(CheckpointService.CheckpointServiceV2)({
                    captureBaseline: () =>
                      input.skipStartAt === "preparation" ? Effect.sync(interruptRun) : Effect.void,
                  }),
                  Layer.mock(EventSink.EventSinkV2)({ writeIfRunCurrent }),
                  IdAllocator.layer,
                  Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
                    ingestNormalized: () => Effect.succeed([]),
                  }),
                  ServerSettings.layerTest(),
                ),
              ),
            ),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: () => Effect.succeed({} as never),
        }),
      ),
    ),
  );
  return {
    open,
    writeIfRunCurrent,
    startRootRun,
    tryHandlePromptCommand,
    events,
    oldInstanceId,
    newInstanceId,
    attemptId,
    threadId,
    runId,
    messageId,
    layer,
    nativePrompts,
    projection: () => projection,
    start: Effect.gen(function* () {
      yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({
        threadId,
        runId,
        ...(input.onMessageDelivery === undefined
          ? {}
          : { onMessageDelivery: input.onMessageDelivery }),
      });
    }).pipe(Effect.provide(layer)),
    startWithRetry: Effect.gen(function* () {
      yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({
        threadId,
        runId,
        willRetry: true,
        ...(input.onMessageDelivery === undefined
          ? {}
          : { onMessageDelivery: input.onMessageDelivery }),
      });
    }).pipe(Effect.provide(layer)),
  };
}

effectIt.effect.each([
  {
    nativeStart: "accepted",
    failFinalization: false,
    expected: [true],
    prompts: 1,
    status: "running",
    fails: false,
  },
  {
    nativeStart: "ack-lost",
    failFinalization: false,
    expected: [],
    prompts: 1,
    status: "failed",
    fails: false,
  },
  {
    nativeStart: "ack-lost",
    failFinalization: true,
    expected: [],
    prompts: 1,
    status: "running",
    fails: true,
  },
  {
    nativeStart: "ack-lost",
    failFinalization: true,
    retryThenContextFailure: true,
    expected: [],
    prompts: 1,
    status: "running",
    fails: true,
  },
  {
    nativeStart: "accepted",
    initialRunStatus: "running",
    failFinalization: false,
    expected: [],
    prompts: 0,
    status: "running",
    fails: false,
  },
  ...(["load", "running-write", "preparation", "last-check", "handoff"] as const).map(
    (skipStartAt) => ({
      nativeStart: "accepted" as const,
      skipStartAt,
      failFinalization: false,
      expected: [false],
      prompts: 0,
      status: "interrupted",
      fails: false,
    }),
  ),
  {
    nativeStart: "ack-lost",
    direction: "resume",
    failFinalization: true,
    expected: [],
    prompts: 1,
    status: "running",
    fails: true,
  },
  {
    nativeStart: "handoff-failure",
    failFinalization: false,
    expected: [false],
    prompts: 0,
    status: "failed",
    fails: false,
  },
  {
    nativeStart: "handoff-failure",
    failFinalization: true,
    expected: [false],
    prompts: 0,
    status: "running",
    fails: true,
  },
  {
    nativeStart: "accepted",
    failFinalization: false,
    writeFailure: new Error("Pre-native write failed"),
    expected: [false],
    prompts: 0,
    status: "starting",
    fails: true,
  },
] as const)(
  "records safe Pause receipts through the worker for $nativeStart (finalization failure: $failFinalization)",
  (scenario) =>
    Effect.gen(function* () {
      const direction = "direction" in scenario ? scenario.direction : "pause";
      const harness = makeLocalCommandHarness({
        text: direction === "pause" ? "pause to go offline" : "resume",
        ...scenario,
      });
      const receipts = yield* Ref.make<ReadonlyArray<boolean>>([]);
      const session: PauseStore.StoredSession = {
        id: "fixture",
        createdAt: "2026-09-04T12:00:00.000Z",
        phase: direction === "pause" ? "pausing" : "resuming",
        targets: [
          {
            threadId: harness.threadId,
            projectId: harness.projection().thread.projectId,
            title: "Example thread",
            pause: direction === "pause" ? "pending" : "sent",
            resume: "pending",
            pauseAccepted: true,
            resumeAccepted: direction === "resume",
            pauseAttempt: 0,
            resumeAttempt: 0,
            error: null,
          },
        ],
      };
      const executorLayer = EffectWorker.layerExecutor.pipe(
        Layer.provide(
          Layer.mergeAll(
            harness.layer,
            Layer.mock(RunFinalizationService.RunFinalizationService)({}),
            Layer.mock(ResourceCleanupService.ResourceCleanupService)({}),
            Layer.mock(CheckpointRollbackService.CheckpointRollbackServiceV2)({}),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
            Layer.mock(ProviderTurnControlService.ProviderTurnControlServiceV2)({}),
            Layer.mock(RuntimeRequestService.RuntimeRequestServiceV2)({}),
            Layer.mock(ThreadTitleRegenerationService.ThreadTitleRegenerationService)({}),
            Layer.mock(IncomingMessageSummaryService.IncomingMessageSummaryService)({}),
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadRecords: () => Effect.succeed(harness.projection()),
            }),
            Layer.mock(SubagentPromotionService.SubagentPromotionService)({}),
            Layer.mock(EffectOutbox.EffectOutboxV2)({
              enqueue: () => Effect.void,
              notifyAvailable: () => Effect.void,
            }),
            ServerSettings.layerTest(),
            Layer.mock(PauseStore.EnvironmentPauseStore)({
              get: Effect.succeed(session),
              recordDelivery: (id, delivered) =>
                Effect.gen(function* () {
                  expect(id).toBe(harness.messageId);
                  yield* Ref.update(receipts, (values) => [...values, delivered]);
                }),
            }),
          ),
        ),
      );
      const timestamp = session.createdAt;
      const effect: EffectOutbox.OrchestrationEffectV2 = {
        id: "effect-pause-start",
        commandId: CommandId.make("command-pause-start"),
        threadId: harness.threadId,
        request: { type: "provider-turn.start", runId: harness.runId },
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
      const result = yield* Effect.gen(function* () {
        const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
        if ("retryThenContextFailure" in scenario) {
          const first = yield* executor.execute(effect, { willRetry: true }).pipe(Effect.exit);
          expect(first._tag).toBe("Failure");
          expect(yield* Ref.get(receipts)).toEqual([]);
          expect(harness.nativePrompts).toHaveLength(1);
          return yield* executor
            .execute({ ...effect, attemptCount: 2 }, { willRetry: false })
            .pipe(Effect.exit);
        }
        return yield* executor.execute(effect).pipe(Effect.exit);
      }).pipe(Effect.provide(executorLayer));
      expect(result._tag).toBe(scenario.fails ? "Failure" : "Success");
      expect(yield* Ref.get(receipts)).toEqual(scenario.expected);
      expect(harness.nativePrompts).toHaveLength(scenario.prompts);
      expect(harness.projection().runs.at(-1)?.status).toBe(scenario.status);
    }),
);

effectIt.effect.each(["session-open", "thread-load"] as const)(
  "reports a settled %s failure as undelivered, but leaves an internal retry pending",
  (stage) =>
    Effect.gen(function* () {
      const receipts = yield* Ref.make<ReadonlyArray<boolean>>([]);
      const setup = {
        text: "pause to go offline",
        ...(stage === "session-open"
          ? { openFailure: new Error("Session setup failed") }
          : { ensureThreadFailure: new Error("Thread setup failed") }),
        onMessageDelivery: (_id: MessageId, delivered: boolean) =>
          Ref.update(receipts, (values) => [...values, delivered]),
      };
      const retryHarness = makeLocalCommandHarness(setup);
      const error = yield* retryHarness.startWithRetry.pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "ProviderTurnStartError", deliveryRejected: true });
      expect(yield* Ref.get(receipts)).toEqual([]);
      const finalHarness = makeLocalCommandHarness(setup);
      yield* finalHarness.start;
      expect(yield* Ref.get(receipts)).toEqual([false]);
      expect(finalHarness.projection().runs.at(-1)?.status).toBe("failed");
    }),
);

effectIt.effect("terminalizes a starting run when its provider session cannot open", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("DESCRIPTION is not valid ACP JSON"),
    });

    yield* harness.start;

    expect(harness.open).toHaveBeenCalledOnce();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.writeIfRunCurrent).toHaveBeenCalledWith(
      expect.objectContaining({
        activeAttemptId: harness.attemptId,
        expectedStatus: "starting",
      }),
    );
    const projection = harness.projection();
    expect(projection.runs.at(-1)).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.attempts[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.nodes[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.turnItems).toMatchObject([
      {
        type: "error",
        status: "failed",
        failure: {
          class: "provider_error",
          message: "DESCRIPTION is not valid ACP JSON",
        },
      },
    ]);
  }),
);

effectIt.effect("leaves the run starting when a session-open failure will be retried", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("provider session rejected"),
    });

    const error = yield* harness.startWithRetry.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
  }),
);

effectIt.effect("keeps a session-open failure retryable when terminal persistence fails", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("provider session rejected"),
      writeFailure: new Error("database unavailable"),
    });

    const error = yield* harness.start.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.writeIfRunCurrent).toHaveBeenCalledOnce();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect("does not terminalize a provider-session open interruption", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Continue", interruptOpen: true });

    const exit = yield* Effect.exit(harness.start);

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect("does not overwrite a run interrupted while its provider session opens", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("provider session rejected"),
      interruptRunBeforeOpenFailure: true,
    });

    yield* harness.start;

    expect(harness.writeIfRunCurrent).toHaveBeenCalledOnce();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    const projection = harness.projection();
    expect(projection.runs.at(-1)?.status).toBe("interrupted");
    expect(projection.attempts[0]?.status).toBe("pending");
    expect(projection.nodes[0]?.status).toBe("pending");
    expect(projection.turnItems).toEqual([]);
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect("fails a starting run when its last start attempt cannot load the thread", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      ensureThreadFailure: new Error("Pi RPC read failed: pi process exited with code 1."),
    });

    yield* harness.start;

    expect(harness.startRootRun).not.toHaveBeenCalled();
    const projection = harness.projection();
    expect(projection.runs.at(-1)).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.attempts[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.nodes[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.turnItems).toMatchObject([
      {
        type: "error",
        title: "Provider turn failed to start",
        failure: {
          class: "provider_error",
          message: "Pi RPC read failed: pi process exited with code 1.",
        },
      },
    ]);
  }),
);

effectIt.effect("leaves the run starting when a thread-load failure will be retried", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      ensureThreadFailure: new Error("pi process exited with code 1"),
    });

    const error = yield* harness.startWithRetry.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
  }),
);

effectIt.effect("keeps a thread-load failure retryable when terminal persistence fails", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      ensureThreadFailure: new Error("pi process exited with code 1"),
      writeFailure: new Error("database unavailable"),
    });

    const error = yield* harness.start.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect(
  "keeps a store failure after the provider loaded the thread typed and retryable",
  () =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({
        text: "Continue",
        historyReadFailureAfterFallback: new Error("database unavailable"),
      });

      const error = yield* harness.start.pipe(Effect.flip);

      // The provider succeeded; the failing stage is the projection read, so
      // the run is not failed as a provider error on the last attempt.
      expect(error._tag).toBe("ProviderTurnStartError");
      expect((error.cause as { _tag?: string } | undefined)?._tag).toBe("ProjectionStoreReadError");
      expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
      expect(harness.projection().runs.at(-1)?.status).toBe("starting");
      expect(harness.events).toEqual([]);
    }),
);

effectIt.effect("does not mistake a failed state read for a superseded run", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Continue", failReadsAfterRunning: true });

    yield* harness.start;

    expect(harness.projection().runs.at(-1)?.status).toBe("running");
    const controls = harness.startRootRun.mock.calls[0]?.[0];
    expect(controls).toBeDefined();
    if (controls === undefined) return;
    // "false" would skip the provider turn or the terminal write and leave the
    // run active. A read failure must reach the caller instead.
    const startCheck = yield* Effect.flip(controls.shouldStartProviderTurn!());
    const finalizeCheck = yield* Effect.flip(controls.shouldFinalizeRun!());
    expect(startCheck._tag).toBe("ProjectionStoreReadError");
    expect(finalizeCheck._tag).toBe("ProjectionStoreReadError");
  }),
);

effectIt.effect("does not overwrite a run interrupted while its thread loads", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      ensureThreadFailure: new Error("pi process exited with code 1"),
      interruptRunBeforeOpenFailure: true,
    });

    yield* harness.start;

    expect(harness.projection().runs.at(-1)?.status).toBe("interrupted");
    expect(harness.projection().turnItems).toEqual([]);
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect(
  "signs out the existing native provider before opening the newly selected provider",
  () =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({ text: "/logout", previousNativeSession: true });

      yield* harness.start;
      yield* harness.start;

      expect(harness.tryHandlePromptCommand).toHaveBeenCalledExactlyOnceWith({
        instanceId: harness.oldInstanceId,
        text: "/logout",
        hasAttachments: false,
      });
      expect(harness.open).not.toHaveBeenCalled();
      expect(harness.startRootRun).not.toHaveBeenCalled();
      const projection = harness.projection();
      expect(projection.runs.at(-1)?.status).toBe("completed");
      expect(projection.attempts[0]?.status).toBe("completed");
      expect(projection.nodes[0]?.status).toBe("completed");
      expect(projection.turnItems).toMatchObject([
        {
          type: "command_execution",
          title: "Provider signed out",
          output: "Provider signed out",
          status: "completed",
        },
      ]);
      expect(projection.providerTurns).toEqual([]);
      expect(projection.checkpoints).toEqual([]);
    }),
);

effectIt.effect("persists a failed sign-out without starting a provider turn", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "/logout",
      logoutFailure: "Could not stop all sessions for this provider. Try again.",
    });

    yield* harness.start;

    expect(harness.open).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
    expect(harness.projection().turnItems).toMatchObject([
      {
        type: "error",
        title: "Provider sign-out failed",
        failure: {
          class: "permission_error",
          message: "Could not stop all sessions for this provider. Try again.",
        },
      },
    ]);
  }),
);

for (const previousMessages of [[], ["/compact", " /COMPACT "]]) {
  effectIt.effect(
    `rejects compaction without conversation context after ${previousMessages.length} prior compactions`,
    () =>
      Effect.gen(function* () {
        const harness = makeLocalCommandHarness({ text: "/compact", previousMessages });

        yield* harness.start;

        expect(harness.open).not.toHaveBeenCalled();
        expect(harness.tryHandlePromptCommand).not.toHaveBeenCalled();
        expect(harness.startRootRun).not.toHaveBeenCalled();
        expect(harness.projection().runs.at(-1)?.status).toBe("failed");
        expect(harness.projection().turnItems).toMatchObject([
          {
            type: "error",
            failure: {
              class: "validation_error",
              message: "Start a conversation before compacting this thread.",
            },
          },
        ]);
      }),
  );
}
