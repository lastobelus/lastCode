import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  CommandId,
  ComposerContextId,
  EnvironmentId,
  EventId,
  MessageId,
  OrchestratorMcpFailure,
  ScheduledTaskId,
  type AuthMcpClientAccess,
  type PeerLink,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestratorMcpThreadReadResult,
  type ThreadReadRequest,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ActionResume from "../actionResume/ActionResume.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { type McpInvocationScope, McpInvocationContext } from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as OrchestratorHandlers from "./toolkits/orchestrator/handlers.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as ThreadReadBroker from "./ThreadReadBroker.ts";

const decodeFailure = Schema.decodeUnknownSync(OrchestratorMcpFailure);
const decodeJson = Schema.decodeUnknownEffect(Schema.Json);
const decodeReadResult = Schema.decodeUnknownSync(
  OrchestratorToolkit.tools.t3_thread_read.successSchema,
);
const decodeWaitResult = Schema.decodeUnknownSync(
  OrchestratorToolkit.tools.t3_thread_wait.successSchema,
);
const decodeSendResult = Schema.decodeUnknownSync(
  OrchestratorToolkit.tools.t3_thread_send.successSchema,
);

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const localEnvironmentId = EnvironmentId.make("environment-source");
const destinationEnvironmentId = EnvironmentId.make("environment-reference");
const parentProjectId = ProjectId.make("project-parent");
const destinationProjectId = ProjectId.make("project-reference");
const parentThreadId = ThreadId.make("thread-parent");
const destinationThreadId = ThreadId.make("thread-reference");
const sessionId = "authenticated-original-client";

const destination: OrchestratorMcpThreadReadResult = {
  readVia: "client",
  thread: {
    threadId: destinationThreadId,
    environmentId: destinationEnvironmentId,
    link: "[Reference](t3-thread://v1/environment-reference/thread-reference)",
    projectId: destinationProjectId,
    title: "Reference",
    createdBy: "user",
    creationSource: "web",
    status: "idle",
    latestRunId: null,
    activeRunId: null,
    providerInstanceId: instanceId,
    model: modelSelection.model,
    runtimeMode: "full-access",
    interactionMode: "default",
    linkedPullRequest: null,
    titleRegeneration: null,
    branch: null,
    worktreePath: null,
    parentThreadId: null,
    relationshipToParent: null,
    runCount: 0,
    itemCount: 0,
    pendingRequestCount: 0,
    archived: false,
    settled: false,
    settledAt: null,
    snoozed: false,
    snoozedUntil: null,
    createdAt: "2026-08-04T12:00:00.000Z",
    updatedAt: "2026-08-04T12:00:00.000Z",
  },
  recentRuns: [],
  items: [],
  nextPosition: null,
  hasMore: false,
};

const makeHarness = (
  name: string,
  peer?: {
    readonly getLink: PeerLinks.PeerLinks["Service"]["get"];
    readonly call: PeerMcpClient.PeerMcpClient["Service"]["call"];
  },
  providerDriver = driver,
) =>
  Effect.gen(function* () {
    const driver = providerDriver;
    const capabilities =
      driver === "claudeAgent" ? ClaudeProviderCapabilitiesV2 : CodexProviderCapabilitiesV2;
    const cwd = yield* checkpointWorkspace(name);
    const started = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2TurnInput>();
    const sessionEvents = new Map<ThreadId, Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>>();
    const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
      instanceId,
      driver,
      getCapabilities: () => Effect.succeed(capabilities),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: (input) =>
        Effect.gen(function* () {
          const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
          const now = yield* DateTime.now;
          return {
            instanceId,
            driver,
            providerSessionId: input.providerSessionId,
            providerSession: {
              id: input.providerSessionId,
              driver,
              providerInstanceId: instanceId,
              status: "ready",
              cwd,
              model: modelSelection.model,
              capabilities,
              createdAt: now,
              updatedAt: now,
              lastError: null,
            },
            events: Stream.fromQueue(events),
            ensureThread: ({ threadId }) => {
              sessionEvents.set(threadId, events);
              return Effect.succeed({
                id: ProviderThreadId.make(`provider-thread:${threadId}`),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: threadId,
                ownerNodeId: null,
                nativeThreadRef: { driver, nativeId: String(threadId), strength: "strong" },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
              });
            },
            resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
            startTurn: (turn) =>
              Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                  providerThreadId: turn.providerThread.id,
                  nodeId: turn.rootNodeId,
                  runAttemptId: turn.attemptId,
                  nativeTurnRef: {
                    driver,
                    nativeId: String(turn.attemptId),
                    strength: "strong",
                  },
                  ordinal: turn.providerTurnOrdinal,
                  status: "running",
                  startedAt: now,
                  completedAt: null,
                },
              }).pipe(Effect.andThen(Queue.offer(started, turn)), Effect.asVoid),
            steerTurn: () => Effect.die("The completion must start a new parent run"),
            interruptTurn: () => Effect.void,
            respondToRuntimeRequest: () => Effect.die("unused"),
            readThreadSnapshot: () => Effect.die("unused"),
            rollbackThread: () => Effect.die("unused"),
            forkThread: () => Effect.die("unused"),
          };
        }),
    };
    const registry = ProviderAdapterRegistry.layerSingle(adapter);
    const database = Sqlite.layerMemory;
    const runtime = ProviderReplayHarness.layerWithRegistry({ name }, registry, {
      runEffectWorker: false,
      runContinuationWorker: true,
      databaseLayer: database,
    });
    const threads = ThreadManagementService.layer.pipe(Layer.provideMerge(runtime));
    const broker = ThreadReadBroker.layer.pipe(
      Layer.provideMerge(threads),
      Layer.provideMerge(database),
      Layer.provide(NodeCrypto.layer),
    );
    const links = Layer.mock(PeerLinks.PeerLinks)({
      get: peer?.getLink ?? (() => Effect.succeedNone),
      enabled: Effect.succeed(true),
    });
    const forwarding = PeerForwarding.layer.pipe(
      Layer.provide(threads),
      Layer.provide(links),
      Layer.provide(NodeCrypto.layer),
      Layer.provide(
        Layer.mock(PeerMcpClient.PeerMcpClient)(peer === undefined ? {} : { call: peer.call }),
      ),
    );
    const dueWork = new Map<string, Effect.Effect<void>>();
    const scheduled = ScheduledTaskService.layer.pipe(
      Layer.provideMerge(broker),
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: cwd }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.succeed(Scheduler.Scheduler, {
            register: (source, work) =>
              Effect.gen(function* () {
                const context = yield* Effect.context<Effect.Services<typeof work>>();
                dueWork.set(source, work.pipe(Effect.provideContext(context), Effect.orDie));
              }),
          }),
          NodeCrypto.layer,
        ),
      ),
    );
    const layer = OrchestratorMcpService.layer.pipe(
      Layer.provideMerge(scheduled),
      Layer.provide(registry),
      Layer.provideMerge(
        Layer.mergeAll(
          forwarding,
          links,
          Layer.mock(RemoteDelegation.RemoteDelegation)({
            followUp: (_scope, _environmentId, _request, sent) => Effect.succeed(sent),
          }),
          Layer.mock(ActionResume.ActionResume)({ readLatestSummary: () => Effect.succeed(null) }),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(GitVcsDriver.GitVcsDriver)({}),
          Layer.mock(ProjectService.ProjectService)({}),
          ProviderRegistryMock.layer([
            {
              instanceId,
              driver,
              enabled: true,
              installed: true,
              version: "test",
              status: "ready",
              auth: { status: "authenticated" },
              checkedAt: DateTime.formatIso(yield* DateTime.now),
              models: [
                {
                  slug: modelSelection.model,
                  name: "Test model",
                  isCustom: false,
                  capabilities: null,
                },
              ],
              slashCommands: [],
              skills: [],
            },
          ]),
          Layer.mock(SecretRequests.SecretRequests)({}),
          NodeCrypto.layer,
        ),
      ),
    );

    const context = yield* Layer.build(layer);
    return yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const broker = yield* ThreadReadBroker.ThreadReadBroker;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const sql = yield* SqlClient.SqlClient;
      const scheduled = yield* ScheduledTaskService.ScheduledTaskService;
      const handlers = yield* OrchestratorToolkit.pipe(
        Effect.provide(McpToolAccess.HandlersLayer.layer(OrchestratorHandlers.layer)),
      );
      const call = (
        scope: McpInvocationScope,
        name: "t3_thread_read" | "t3_thread_wait" | "t3_thread_send",
        input: Schema.Json,
      ) =>
        handlers.handle(name, input).pipe(
          Effect.flatMap(Stream.runCollect),
          Effect.map((results) => {
            assert.lengthOf(results, 1);
            return results[0]!;
          }),
          Effect.provideService(McpInvocationContext, scope),
          Effect.provideContext(context),
        );
      const awaitEvent = (
        threadId: ThreadId,
        predicate: (event: OrchestrationV2DomainEvent) => boolean,
      ) =>
        orchestrator.streamStoredEventsFrom({ threadId, afterSequence: 0 }).pipe(
          Stream.filter(({ event }) => predicate(event)),
          Stream.take(1),
          Stream.runDrain,
        );
      const awaitStarted = (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
        awaitEvent(
          turn.threadId,
          (event) =>
            event.type === "provider-turn.updated" &&
            event.payload.runAttemptId === turn.attemptId &&
            event.payload.status === "running",
        );
      const finish = (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
        Effect.gen(function* () {
          const projection = yield* orchestrator.getThreadProjection(turn.threadId);
          const providerTurn = projection.providerTurns.find(
            (candidate) => candidate.runAttemptId === turn.attemptId,
          )!;
          const events = sessionEvents.get(turn.threadId)!;
          const now = yield* DateTime.now;
          yield* Queue.offer(events, {
            type: "message.updated",
            driver,
            message: {
              id: MessageId.make(`result:${turn.runId}`),
              threadId: turn.threadId,
              runId: turn.runId,
              nodeId: turn.rootNodeId,
              role: "assistant",
              text: "Delegated work finished.",
              attachments: [],
              streaming: false,
              createdBy: "agent",
              creationSource: "provider",
              createdAt: now,
              updatedAt: now,
            },
          });
          yield* Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: {
              ...providerTurn,
              status: "completed",
              completedAt: yield* DateTime.now,
            },
          });
          yield* Queue.offer(events, {
            type: "turn.terminal",
            driver,
            providerThreadId: providerTurn.providerThreadId,
            providerTurnId: providerTurn.id,
            runOrdinal: turn.runOrdinal,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          });
          yield* awaitEvent(
            turn.threadId,
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === turn.runId &&
              (event.payload.status === "completed" || event.payload.status === "waiting"),
          );
          yield* worker.drain();
        });

      const createThread = (threadId: ThreadId, projectId = parentProjectId) =>
        orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create:${threadId}`),
          threadId,
          projectId,
          title: String(threadId),
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
      return {
        cwd,
        orchestrator,
        worker,
        broker,
        service,
        sql,
        started,
        eventSink,
        awaitEvent,
        awaitStarted,
        finish,
        scheduled,
        call,
        dueWork,
        createThread,
      };
    }).pipe(Effect.provideContext(context));
  });

it.effect("retains the exact client reference when real delegate completion wakes the parent", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness("thread-communication-delegate-completion");
    const {
      cwd,
      orchestrator,
      worker,
      broker,
      service,
      sql,
      started,
      awaitEvent,
      awaitStarted,
      finish,
    } = h;
    const issuedAt = yield* DateTime.now;
    yield* sql`INSERT INTO auth_sessions
        (session_id, subject, method, scopes, issued_at, expires_at)
        VALUES (${sessionId}, 'test-user', 'browser-session-cookie', '["orchestration:read"]',
          ${DateTime.formatIso(issuedAt)}, ${DateTime.formatIso(DateTime.add(issuedAt, { days: 1 }))})`;
    // The authenticated WebSocket handler binds the session before dispatching user input.
    const requests = yield* broker.connect(sessionId);
    const forwarded: ThreadReadRequest["input"][] = [];
    yield* requests.pipe(
      Stream.runForEach((request) => {
        forwarded.push(request.input);
        assert.equal(request.input.environmentId, destinationEnvironmentId);
        assert.equal(request.input.threadId, destinationThreadId);
        return broker.respond(sessionId, {
          connectionId: request.connectionId,
          requestId: request.requestId,
          result: destination,
          unavailableEnvironmentIds: [],
        });
      }),
      Effect.forkScoped,
    );
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-parent"),
      threadId: parentThreadId,
      projectId: parentProjectId,
      title: "Parent",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "user",
      creationSource: "web",
    });
    const messageId = MessageId.make("original-user-reference");
    const threadReadIntent = yield* broker
      .forSession(sessionId)
      .authorize(parentThreadId, messageId);
    yield* orchestrator.dispatch(
      {
        type: "message.dispatch",
        commandId: CommandId.make("original-user-reference"),
        threadId: parentThreadId,
        messageId,
        text: "Read [Reference](t3-context://v1/thread/attached-reference), then delegate work.",
        context: {
          version: 1,
          records: [
            {
              version: 1,
              contextId: ComposerContextId.make("attached-reference"),
              kind: "thread",
              label: "Reference",
              title: "Reference",
              environmentId: destinationEnvironmentId,
              threadId: destinationThreadId,
            },
          ],
        },
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      },
      threadReadIntent === undefined ? {} : { threadReadIntent },
    );
    yield* worker.drain();
    const original = yield* Queue.take(started);
    yield* awaitStarted(original);
    const scope: McpInvocationScope = {
      environmentId: localEnvironmentId,
      capabilities: new Set(["orchestration"]),
      issuedAt: 1,
      requestNamespace: "provider-thread-communication",
      thread: {
        threadId: parentThreadId,
        providerSessionId: String(original.providerThread.providerSessionId),
        providerInstanceId: instanceId,
        execution: { runId: original.runId, attemptId: original.attemptId },
      },
      client: undefined,
    };
    const exact = {
      environmentId: destinationEnvironmentId,
      threadId: destinationThreadId,
      via: "client" as const,
    };
    const originalRead = yield* service.readThread(scope, exact);
    assert.deepEqual(originalRead, destination);
    assert.notEqual(originalRead.thread.projectId, parentProjectId);
    const before = yield* orchestrator.getThreadProjection(parentThreadId);
    assert.deepEqual(
      before.messages.find((message) => message.id === messageId)?.context?.records,
      [
        {
          version: 1,
          contextId: ComposerContextId.make("attached-reference"),
          kind: "thread",
          label: "Reference",
          title: "Reference",
          environmentId: destinationEnvironmentId,
          threadId: destinationThreadId,
        },
      ],
    );

    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("delegate-work"),
      parentThreadId,
      parentRunId: original.runId,
      parentNodeId: original.rootNodeId,
      task: "Finish the delegated work.",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
      createdBy: "agent",
      creationSource: "mcp",
    });
    yield* worker.drain();
    const child = yield* Queue.take(started);
    assert.notEqual(child.threadId, parentThreadId);
    yield* awaitStarted(child);
    yield* finish(original);
    yield* finish(child);
    yield* awaitEvent(
      parentThreadId,
      (event) => event.type === "run.created" && event.payload.ordinal === 2,
    );
    yield* worker.drain();
    const wake = yield* Queue.take(started);
    assert.equal(wake.threadId, parentThreadId);
    assert.notEqual(wake.runId, original.runId);
    yield* awaitStarted(wake);

    const completed = yield* orchestrator.getThreadProjection(parentThreadId);
    const task = completed.subagents.find(
      (candidate) => candidate.childThreadId === child.threadId,
    )!;
    assert.equal(task.status, "completed");
    assert.equal(task.result, "Delegated work finished.");
    assert.equal(completed.runs.find((run) => run.id === original.runId)?.status, "completed");
    assert.equal(completed.runs.find((run) => run.id === wake.runId)?.status, "running");
    const wakeMessage = completed.messages.find(
      (message) => message.id === wake.message.messageId,
    )!;
    assert.equal(wakeMessage.createdBy, "agent");
    assert.equal(wakeMessage.creationSource, "server");
    assert.equal(wakeMessage.delegatedCompletion?.parentRunId, original.runId);
    assert.deepEqual(wakeMessage.delegatedCompletion?.taskIds, [task.id]);
    assert.isTrue(
      completed.contextTransfers.some(
        (transfer) =>
          transfer.type === "subagent_result" && transfer.sourceThreadId === child.threadId,
      ),
    );
    assert.lengthOf(completed.runs, 2);
    assert.lengthOf(forwarded, 1);

    // No user input, reauthorization, or client reconnect occurs between these reads.
    const wakeRead = yield* service
      .readThread(
        {
          ...scope,
          thread: {
            ...scope.thread!,
            execution: { runId: wake.runId, attemptId: wake.attemptId },
          },
        },
        exact,
      )
      .pipe(
        Effect.map((result) => ({ code: "success", result })),
        Effect.catch((error) => Effect.succeed({ code: error.code, result: null })),
      );
    assert.equal(
      wakeRead.code,
      "success",
      "delegate-completion wake must retain the original client grant",
    );
    assert.deepEqual(wakeRead.result, originalRead);
    const expectedForwardedRead = { ...exact, beforePosition: Number.MAX_SAFE_INTEGER };
    assert.deepEqual(forwarded, [expectedForwardedRead, expectedForwardedRead]);

    yield* finish(wake);
    yield* sql`INSERT INTO auth_sessions
      (session_id, subject, method, scopes, issued_at, expires_at)
      VALUES ('other-client', 'other-user', 'browser-session-cookie', '["orchestration:read"]',
        ${DateTime.formatIso(issuedAt)}, ${DateTime.formatIso(DateTime.add(issuedAt, { days: 1 }))})`;
    const otherInput = MessageId.make("other-client-input");
    const otherIntent = yield* broker
      .forSession("other-client")
      .authorize(parentThreadId, otherInput);
    yield* orchestrator.dispatch(
      {
        type: "message.dispatch",
        commandId: CommandId.make("other-client-command"),
        threadId: parentThreadId,
        messageId: otherInput,
        text: "Another client's later run.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      },
      otherIntent === undefined ? {} : { threadReadIntent: otherIntent },
    );
    yield* worker.drain();
    const later = yield* Queue.take(started);
    yield* awaitStarted(later);
    assert.notEqual(later.runId, original.runId);
    const laterOwner = yield* sql<{ sessionId: string }>`SELECT session_id AS sessionId
      FROM lastcode_thread_read_grants WHERE thread_id = ${parentThreadId}
      AND kind = 'run' AND grant_id = ${later.runId}`;
    assert.equal(laterOwner[0]?.sessionId, "other-client");
    // A still-live native child keeps A while another client's run is active.
    const nativeSessions = yield* McpProviderSessions.McpProviderSessions.pipe(
      Effect.provide(McpProviderSessions.layer),
    );
    yield* nativeSessions.set({
      environmentId: localEnvironmentId,
      threadId: parentThreadId,
      providerSessionId: scope.thread!.providerSessionId,
      providerInstanceId: instanceId,
      endpoint: "http://localhost/mcp",
      authorizationHeader: "Bearer native-test",
      browserToolsAvailable: true,
    });
    yield* nativeSessions.registerExecution(
      parentThreadId,
      { provider: "claude", toolUseId: "background-call" },
      scope.thread!.execution!,
      "live-child",
    );
    const lookupNative = () =>
      nativeSessions.resolveExecution({
        threadId: parentThreadId,
        providerSessionId: scope.thread!.providerSessionId,
        authorizationHeader: "Bearer native-test",
        metadata: { "claudecode/toolUseId": "background-call" },
      });
    const nativeExecution = yield* lookupNative();
    assert.deepEqual(nativeExecution, scope.thread!.execution);
    const nativeBackground: McpInvocationScope = {
      ...scope,
      thread: {
        ...scope.thread!,
        attribution: "resolved",
        execution: nativeExecution,
      },
    };
    const nativeSent = yield* service.sendToThread(nativeBackground, {
      threadId: child.threadId,
      message: "Live native background callback.",
      mode: "queue",
      clientRequestId: "native-background-callback",
    });
    assert.equal(nativeSent.threadId, child.threadId);
    const inheritedOwner = yield* sql<{ sessionId: string }>`SELECT session_id AS sessionId
      FROM lastcode_thread_read_grants WHERE thread_id = ${child.threadId}
      AND kind = 'run' AND grant_id = ${nativeSent.runId}`;
    assert.equal(inheritedOwner[0]?.sessionId, sessionId);
    yield* nativeSessions.endExecution(parentThreadId, scope.thread!.execution!, "live-child");
    assert.isUndefined(yield* lookupNative());

    const unresolved: McpInvocationScope = {
      ...scope,
      thread: {
        threadId: parentThreadId,
        providerSessionId: scope.thread!.providerSessionId,
        providerInstanceId: instanceId,
        attribution: "unresolved",
      },
    };
    const unownedSent = yield* service.sendToThread(unresolved, {
      threadId: child.threadId,
      message: "Ended child must not borrow the wake.",
      mode: "queue",
      clientRequestId: "ended-native-background-control",
    });
    assert.equal(unownedSent.threadId, child.threadId);
    const unownedGrant = yield* sql`SELECT grant_id FROM lastcode_thread_read_grants
      WHERE thread_id = ${child.threadId} AND kind = 'run' AND grant_id = ${unownedSent.runId}`;
    assert.lengthOf(unownedGrant, 0);
    const unownedCreated = yield* service.createThreads(unresolved, {
      clientRequestId: "unattributed-structural-child",
      threads: [
        { title: "Unattributed structural child", prompt: "Do not inherit client access." },
      ],
    });
    const structuralChild = unownedCreated.threads[0]!;
    const structuralGrant = yield* sql`SELECT grant_id FROM lastcode_thread_read_grants
      WHERE thread_id = ${structuralChild.threadId} AND kind = 'run'
      AND grant_id = ${structuralChild.runId}`;
    assert.lengthOf(structuralGrant, 0);
    const structuralProjection = yield* orchestrator.getThreadProjection(structuralChild.threadId);
    assert.isFalse(
      structuralProjection.contextTransfers.some((transfer) => transfer.type === "subagent_spawn"),
    );
    const deniedDelegation = yield* service
      .delegateTask(unresolved, { task: "Cannot borrow a parent run." })
      .pipe(Effect.flip);
    assert.equal(deniedDelegation.code, "parent_not_active");
    const unownedRead = yield* service.readThread(unresolved, exact).pipe(
      Effect.as("unexpected-read"),
      Effect.catch((error) => Effect.succeed(error.code)),
    );
    assert.equal(unownedRead, "environment_unavailable");
    assert.lengthOf(forwarded, 2);
  }),
);

const scopeOf = (
  turn: ProviderAdapter.ProviderAdapterV2TurnInput,
  environmentId = localEnvironmentId,
): McpInvocationScope => ({
  environmentId,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
  requestNamespace: `provider:${turn.threadId}`,
  thread: {
    threadId: turn.threadId,
    providerSessionId: String(turn.providerThread.providerSessionId),
    providerInstanceId: instanceId,
    execution: { runId: turn.runId, attemptId: turn.attemptId },
  },
  client: undefined,
});

it.effect("a registered provider-result wake sends with its accepted origin's authority", () =>
  Effect.gen(function* () {
    const driver = ProviderDriverKind.make("claudeAgent");
    const h = yield* makeHarness("thread-communication-provider-result", undefined, driver);
    const now = yield* DateTime.now;
    yield* h.sql`INSERT INTO auth_sessions
      (session_id, subject, method, scopes, issued_at, expires_at)
      VALUES (${sessionId}, 'test-user', 'browser-session-cookie', '["orchestration:read"]',
        ${DateTime.formatIso(now)}, ${DateTime.formatIso(DateTime.add(now, { days: 1 }))})`;
    const _connection = yield* h.broker.connect(sessionId);
    yield* h.createThread(parentThreadId);
    const target = ThreadId.make("provider-wake-recipient");
    yield* h.createThread(target, destinationProjectId);
    const messageId = MessageId.make("provider-wake-original-input");
    const threadReadIntent = yield* h.broker
      .forSession(sessionId)
      .authorize(parentThreadId, messageId);
    assert.isDefined(threadReadIntent);
    yield* h.orchestrator.dispatch(
      {
        type: "message.dispatch",
        commandId: CommandId.make("provider-wake-original-command"),
        threadId: parentThreadId,
        messageId,
        text: "Continue after the native background result.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      },
      { threadReadIntent },
    );
    yield* h.worker.drain();
    const origin = yield* Queue.take(h.started);
    yield* h.awaitStarted(origin);
    yield* h.finish(origin);
    const projection = yield* h.orchestrator.getThreadProjection(parentThreadId);
    const provider = projection.providerThreads.find((row) => row.id === origin.providerThread.id)!;
    const taskId = "provider-wake-task";
    // Provider transport is a fixture here; persist its owed result before real wake admission.
    yield* h.eventSink.write({
      commandId: CommandId.make("command:runtime-reconcile:provider-wake-owed"),
      events: [
        {
          id: EventId.make("event:provider-wake-owed"),
          type: "provider-thread.updated",
          threadId: parentThreadId,
          occurredAt: now,
          payload: {
            ...provider,
            owedBackgroundResults: [{ taskId, originRunId: origin.runId }],
            updatedAt: now,
          },
        },
      ],
    });
    yield* h.orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("provider-wake-command"),
      threadId: parentThreadId,
      messageId: MessageId.make("provider-wake-message"),
      text: "Native background result is ready.",
      backgroundResultContinuation: {
        providerThreadId: provider.id,
        originRunId: origin.runId,
        taskIds: [taskId],
      },
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "provider",
    });
    yield* h.worker.drain();
    const wake = yield* Queue.take(h.started);
    yield* h.awaitStarted(wake);
    assert.notEqual(wake.runId, origin.runId);
    const registry = yield* McpProviderSessions.McpProviderSessions.pipe(
      Effect.provide(McpProviderSessions.layer),
    );
    const scope = scopeOf(wake);
    yield* registry.set({
      environmentId: localEnvironmentId,
      threadId: parentThreadId,
      providerSessionId: scope.thread!.providerSessionId,
      providerInstanceId: instanceId,
      endpoint: "http://localhost/mcp",
      authorizationHeader: "Bearer native-wake-test",
      browserToolsAvailable: true,
    });
    yield* registry.registerExecution(
      parentThreadId,
      {
        provider: "claude",
        toolUseId: "provider-wake-call",
      },
      { runId: wake.runId, attemptId: wake.attemptId },
    );
    const execution = yield* registry.resolveExecution({
      threadId: parentThreadId,
      providerSessionId: scope.thread!.providerSessionId,
      authorizationHeader: "Bearer native-wake-test",
      metadata: { "claudecode/toolUseId": "provider-wake-call" },
    });
    assert.isDefined(execution);
    const sent = yield* h.service.sendToThread(
      {
        ...scope,
        thread: { ...scope.thread!, attribution: "resolved", execution },
      },
      {
        threadId: target,
        message: "Registered native wake result.",
        mode: "queue",
        clientRequestId: "provider-wake-send",
      },
    );
    const owners = yield* h.sql<{ sessionId: string }>`SELECT session_id AS sessionId
      FROM lastcode_thread_read_grants WHERE thread_id = ${target}
        AND kind = 'run' AND grant_id = ${sent.runId}`;
    assert.deepEqual(owners, [{ sessionId }]);
    const directWakeGrant = yield* h.sql`SELECT 1 FROM lastcode_thread_read_grants
      WHERE thread_id = ${parentThreadId} AND kind = 'run' AND grant_id = ${wake.runId}`;
    assert.lengthOf(directWakeGrant, 0);
    const unregistered = yield* h.service.sendToThread(
      {
        ...scope,
        thread: { ...scope.thread!, attribution: "unresolved", execution: undefined },
      },
      {
        threadId: target,
        message: "Unregistered calls must not borrow the wake.",
        mode: "queue",
        clientRequestId: "provider-wake-unresolved-control",
      },
    );
    const unregisteredGrants = yield* h.sql`SELECT 1 FROM lastcode_thread_read_grants
      WHERE thread_id = ${target} AND kind = 'run' AND grant_id = ${unregistered.runId}`;
    assert.lengthOf(unregisteredGrants, 0);
  }),
);

it.effect.each(["scheduled", "callback"] as const)(
  "%s intake cannot borrow the recipient's client grant and can use an independent peer",
  (origin) =>
    Effect.gen(function* () {
      // Independent database, orchestrator, broker and tool permissions. The MCP
      // transport and authenticated link scope are supplied here, without HTTP/OAuth.
      const peer = yield* makeHarness(`thread-communication-${origin}-peer`);
      yield* peer.createThread(destinationThreadId, destinationProjectId);
      let access: AuthMcpClientAccess = "read-only";
      const now = yield* DateTime.now;
      const link = (): PeerLink => ({
        environmentId: destinationEnvironmentId,
        label: "Independent peer",
        urls: ["https://peer.example.invalid"],
        access,
        linkedAt: now,
        expiresAt: DateTime.add(now, { days: 1 }),
        lastReachedAt: null,
        lastError: null,
      });
      const peerCalls: Array<{ tool: string; senderThreadId: ThreadId | undefined }> = [];
      const h = yield* makeHarness(`thread-communication-${origin}`, {
        getLink: (environmentId) =>
          Effect.succeed(
            environmentId === destinationEnvironmentId ? Option.some(link()) : Option.none(),
          ),
        call: <S extends Schema.Decoder<unknown>>(
          input: Parameters<PeerMcpClient.PeerMcpClient["Service"]["call"]>[0] & {
            readonly success: S;
          },
        ) =>
          Effect.gen(function* (): Effect.fn.Return<S["Type"], OrchestratorMcpFailure> {
            assert.equal(input.environmentId, destinationEnvironmentId);
            assert.isTrue(
              ["t3_thread_read", "t3_thread_wait", "t3_thread_send"].includes(input.tool),
            );
            peerCalls.push({ tool: input.tool, senderThreadId: input.sender?.threadId });
            const scope: McpInvocationScope = {
              environmentId: destinationEnvironmentId,
              capabilities: new Set(["orchestration"]),
              issuedAt: 1,
              requestNamespace: "independent-peer-link",
              thread: undefined,
              client: {
                sessionId: "independent-peer-session",
                label: "Independent peer link",
                access,
                linked: true,
                narrowedTo: input.limits,
                ...(input.sender === undefined ? {} : { senderThread: input.sender }),
              },
            };
            const argumentsJson = yield* decodeJson(input.arguments).pipe(Effect.orDie);
            const result = yield* peer
              .call(
                scope,
                input.tool as "t3_thread_read" | "t3_thread_wait" | "t3_thread_send",
                argumentsJson,
              )
              .pipe(Effect.orDie);
            if (result.isFailure) return yield* decodeFailure(result.result);
            return result.result as S["Type"];
          }),
      });
      yield* h.createThread(parentThreadId);
      yield* h.sql`INSERT INTO auth_sessions
        (session_id, subject, method, scopes, issued_at, expires_at)
        VALUES (${sessionId}, 'test-user', 'browser-session-cookie', '["orchestration:read"]',
          ${DateTime.formatIso(now)}, ${DateTime.formatIso(DateTime.add(now, { days: 1 }))})`;
      const requests = yield* h.broker.connect(sessionId);
      const clientReads: ThreadReadRequest["input"][] = [];
      yield* requests.pipe(
        Stream.runForEach((request) => {
          clientReads.push(request.input);
          return h.broker.respond(sessionId, {
            connectionId: request.connectionId,
            requestId: request.requestId,
            result: destination,
            unavailableEnvironmentIds: [],
          });
        }),
        Effect.forkScoped,
      );
      const originalMessageId = MessageId.make("recipient-client-reference");
      const threadReadIntent = yield* h.broker
        .forSession(sessionId)
        .authorize(parentThreadId, originalMessageId);
      yield* h.orchestrator.dispatch(
        {
          type: "message.dispatch",
          commandId: CommandId.make("recipient-client-reference"),
          threadId: parentThreadId,
          messageId: originalMessageId,
          text: "Read [Reference](t3-context://v1/thread/attached-reference).",
          context: {
            version: 1,
            records: [
              {
                version: 1,
                contextId: ComposerContextId.make("attached-reference"),
                kind: "thread",
                label: "Reference",
                title: "Reference",
                environmentId: destinationEnvironmentId,
                threadId: destinationThreadId,
              },
            ],
          },
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        },
        threadReadIntent === undefined ? {} : { threadReadIntent },
      );
      yield* h.worker.drain();
      const original = yield* Queue.take(h.started);
      yield* h.awaitStarted(original);
      const exact = {
        environmentId: destinationEnvironmentId,
        threadId: destinationThreadId,
        via: "client" as const,
      };
      assert.deepEqual(yield* h.service.readThread(scopeOf(original), exact), destination);
      assert.lengthOf(clientReads, 1);

      let queuedMessageId: MessageId;
      const scheduledTaskId = ScheduledTaskId.make("communication-schedule");
      if (origin === "scheduled") {
        yield* h.scheduled.upsert({
          id: scheduledTaskId,
          title: "Scheduled communication",
          prompt: "Follow the existing reference.",
          enabled: true,
          schedule: { type: "interval", everyMs: 60_000 },
          projectId: parentProjectId,
          threadId: parentThreadId,
          threadMode: "continue",
          workspaceStrategy: { type: "root" },
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdBy: "user",
          creationSource: "web",
        });
        yield* TestClock.adjust("1 minute");
        // Run the real registered due-task dispatch once; no synthetic message origin.
        yield* h.dueWork.get("scheduled-tasks")!;
        const { tasks } = yield* h.scheduled.list();
        assert.equal(tasks[0]?.lastRunStatus, "succeeded");
        assert.equal(tasks[0]?.runCount, 1);
        const projection = yield* h.orchestrator.getThreadProjection(parentThreadId);
        queuedMessageId = projection.messages.find(
          (message) => message.scheduledTaskId === scheduledTaskId,
        )!.id;
      } else {
        const senderThreadId = ThreadId.make("callback-sender");
        yield* h.createThread(senderThreadId, ProjectId.make("callback-project"));
        yield* h.orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("start-callback-sender"),
          threadId: senderThreadId,
          messageId: MessageId.make("start-callback-sender"),
          text: "Return a callback when done.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "agent",
          creationSource: "mcp",
        });
        yield* h.worker.drain();
        const sender = yield* Queue.take(h.started);
        yield* h.awaitStarted(sender);
        const sent = yield* h.call(scopeOf(sender), "t3_thread_send", {
          threadId: parentThreadId,
          mode: "queue",
          message: "The ordinary callback is ready.",
          clientRequestId: "ordinary-callback",
        });
        assert.isFalse(sent.isFailure, JSON.stringify(sent.result));
        const result = decodeSendResult(sent.result);
        assert.equal(result.delivery, "queued");
        queuedMessageId = result.messageId;
      }
      const queued = yield* h.orchestrator.getThreadProjection(parentThreadId);
      const queuedRun = queued.runs.find((run) => run.userMessageId === queuedMessageId)!;
      assert.equal(queuedRun.status, "queued");
      assert.equal(queued.runs.find((run) => run.id === original.runId)?.status, "running");
      yield* h.finish(original);
      // The terminal event and the queue promotion are committed by separate fibers.
      yield* h.awaitEvent(
        parentThreadId,
        (event) =>
          event.type === "run.updated" &&
          event.payload.id === queuedRun.id &&
          event.payload.status === "starting",
      );
      yield* h.worker.drain();
      const admitted = yield* Queue.take(h.started);
      yield* h.awaitStarted(admitted);
      assert.equal(admitted.threadId, parentThreadId);
      assert.equal(admitted.runId, queuedRun.id);
      const current = yield* h.orchestrator.getThreadProjection(parentThreadId);
      const message = current.messages.find((message) => message.id === queuedMessageId)!;
      assert.equal(
        current.runs.find((run) => run.id === admitted.runId)?.userMessageId,
        queuedMessageId,
      );
      if (origin === "scheduled") assert.equal(message.scheduledTaskId, scheduledTaskId);
      else {
        assert.equal(message.senderThreadId, ThreadId.make("callback-sender"));
        assert.equal(message.createdBy, "agent");
        assert.equal(message.creationSource, "mcp");
        assert.isUndefined(message.delegatedCompletion);
        assert.isUndefined(message.scheduledTaskId);
      }
      const scope = scopeOf(admitted);
      const deniedClient = yield* h.call(scope, "t3_thread_read", exact);
      assert.isTrue(deniedClient.isFailure);
      assert.equal(decodeFailure(deniedClient.result).code, "environment_unavailable");
      assert.lengthOf(
        clientReads,
        1,
        "the recipient's prior client must not receive the new run's read",
      );
      assert.isEmpty(peerCalls, "an explicit client failure must not fall back to a peer");

      const peerRead = yield* h.call(scope, "t3_thread_read", { ...exact, via: "reference" });
      assert.isFalse(peerRead.isFailure, JSON.stringify(peerRead.result));
      const read = decodeReadResult(peerRead.result);
      assert.equal(read.thread.environmentId, destinationEnvironmentId);
      assert.equal(read.thread.threadId, destinationThreadId);
      assert.equal(read.thread.projectId, destinationProjectId);
      assert.notEqual(read.thread.projectId, parentProjectId);
      const waited = yield* h.call(scope, "t3_thread_wait", {
        environmentId: destinationEnvironmentId,
        threadId: destinationThreadId,
      });
      assert.isFalse(waited.isFailure, JSON.stringify(waited.result));
      const wait = decodeWaitResult(waited.result);
      assert.equal(wait.threadId, destinationThreadId);
      assert.equal(wait.status, "idle");
      assert.isFalse(wait.timedOut);
      const sendInput = {
        environmentId: destinationEnvironmentId,
        threadId: destinationThreadId,
        message: "Continue the permitted linked task.",
        mode: "queue",
        clientRequestId: `linked-${origin}`,
      };
      const deniedSend = yield* h.call(scope, "t3_thread_send", sendInput);
      assert.isTrue(deniedSend.isFailure);
      assert.equal(decodeFailure(deniedSend.result).code, "capability_denied");
      assert.isEmpty((yield* peer.orchestrator.getThreadProjection(destinationThreadId)).messages);
      access = "full-access";
      const sent = yield* h.call(scope, "t3_thread_send", sendInput);
      assert.isFalse(sent.isFailure, JSON.stringify(sent.result));
      const send = decodeSendResult(sent.result);
      yield* peer.worker.drain();
      const remoteTurn = yield* Queue.take(peer.started);
      yield* peer.awaitStarted(remoteTurn);
      assert.equal(send.runId, remoteTurn.runId);
      const remote = yield* peer.orchestrator.getThreadProjection(destinationThreadId);
      assert.equal(
        remote.messages.find((message) => message.id === send.messageId)?.text,
        sendInput.message,
      );
      assert.deepEqual(
        remote.messages.find((message) => message.id === send.messageId)?.linkedSender,
        {
          environmentId: localEnvironmentId,
          threadId: parentThreadId,
          title: String(parentThreadId),
        },
      );
      assert.deepEqual(
        peerCalls,
        ["t3_thread_read", "t3_thread_wait", "t3_thread_send", "t3_thread_send"].map((tool) => ({
          tool,
          senderThreadId: parentThreadId,
        })),
      );
      assert.lengthOf(clientReads, 1);
    }),
);
