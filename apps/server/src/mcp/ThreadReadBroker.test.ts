import { describe, expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  CommandId,
  ContextTransferId,
  EventId,
  EnvironmentId,
  ComposerContextId,
  MessageId,
  NodeId,
  RuntimeRequestId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  RunAttemptId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
  type OrchestratorMcpThreadReadInput,
  type OrchestratorMcpThreadReadResult,
  type ThreadReadRequest,
  type ThreadContextRecord,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ContextTransfer,
  type OrchestrationV2ExecutionNode,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { admitAcceptedInput } from "../threadReadAuthority/Admission.ts";
import * as AuthorityStore from "../threadReadAuthority/Store.ts";
import type { ThreadReadIntakeIntent } from "../threadReadAuthority/Types.ts";
import type {
  ProjectionRecordField,
  ProjectionRecordFilter,
  ProjectionRecords,
} from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadReadBroker from "./ThreadReadBroker.ts";
import { referenceReadFailure, threadReadFailure } from "./ThreadReadDiagnostics.ts";

const threadId = ThreadId.make("thread-remote-example");
const sourceThreadId = ThreadId.make("source-thread");
const environmentId = EnvironmentId.make("remote-environment");
const result: OrchestratorMcpThreadReadResult = {
  readVia: "client",
  thread: {
    threadId,
    environmentId,
    link: "[Example](t3-thread://v2/remote-environment/thread-remote-example)",
    projectId: ProjectId.make("example-project"),
    title: "Example",
    createdBy: "user",
    creationSource: "web",
    status: "idle",
    latestRunId: null,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    model: "example-model",
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
    archived: true,
    settled: false,
    settledAt: null,
    snoozed: false,
    snoozedUntil: null,
    createdAt: "2026-10-08T12:00:00Z",
    updatedAt: "2026-10-08T12:00:00Z",
  },
  recentRuns: [],
  items: [],
  nextPosition: 42,
  hasMore: true,
};

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Run = Mutable<OrchestrationV2Run>;
type Message = Mutable<OrchestrationV2ConversationMessage>;
type Spawn = OrchestrationV2ContextTransfer;

const runId = (messageId: MessageId) => RunId.make(`run-${messageId}`);
const sourceRunId = runId(MessageId.make("source-message"));
const providerInstanceId = ProviderInstanceId.make("codex");

const attachedReference: ThreadContextRecord = {
  version: 1,
  contextId: ComposerContextId.make("attached-reference"),
  kind: "thread",
  label: "Reference",
  title: "Reference",
  environmentId,
  threadId,
};
const referenceContext = (authorizationId: MessageId, capturedAt: number): Partial<Message> => ({
  text: "[Reference](t3-context://v1/thread/attached-reference)",
  context: { version: 1, records: [attachedReference] },
  threadReadContext: { authorizationId, capturedAt },
});
const matchingResult = (request: ThreadReadRequest): OrchestratorMcpThreadReadResult => ({
  ...result,
  thread: {
    ...result.thread,
    threadId: request.input.threadId,
    environmentId: request.input.environmentId ?? environmentId,
  },
});

/** Real durable grants; projection records model only the accepted inputs driven by each test. */
const makeHarness = Effect.gen(function* () {
  const services = yield* Layer.build(
    AuthSessions.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)),
  );
  const sql = Context.get(services, SqlClient.SqlClient);
  const sessions = Context.get(services, AuthSessions.AuthSessionRepository);
  const store = yield* AuthorityStore.make.pipe(Effect.provide(services));
  const runs = new Map<ThreadId, Array<Run>>();
  const transfers = new Map<ThreadId, Array<Spawn>>();
  const requests = new Map<ThreadId, OrchestrationV2ThreadProjection["runtimeRequests"]>();
  const nodes = new Map<ThreadId, Array<OrchestrationV2ExecutionNode>>();
  const messages = new Map<ThreadId, Array<Message>>();
  const getThreadRecords = <K extends ProjectionRecordField>(
    id: ThreadId,
    fields: ReadonlyArray<K>,
    filter?: ProjectionRecordFilter,
  ): Effect.Effect<ProjectionRecords<K>> =>
    Effect.sync(() => {
      const records = {
        runs: (runs.get(id) ?? []).filter(
          (run) =>
            (filter?.runIds === undefined || filter.runIds.includes(run.id)) &&
            (filter?.runStatuses === undefined || filter.runStatuses.includes(run.status)),
        ),
        contextTransfers: (transfers.get(id) ?? []).filter(
          (transfer) =>
            filter?.contextTransferStatuses === undefined ||
            filter.contextTransferStatuses.includes(transfer.status),
        ),
        runtimeRequests: (requests.get(id) ?? []).filter(
          (request) =>
            filter?.runtimeRequestStatuses === undefined ||
            filter.runtimeRequestStatuses.includes(request.status),
        ),
        nodes: (nodes.get(id) ?? []).filter(
          (node) => filter?.nodeIds === undefined || filter.nodeIds.includes(node.id),
        ),
        providerThreads: [],
        messages: (messages.get(id) ?? []).filter(
          (message) =>
            (filter?.messageIds === undefined || filter.messageIds.includes(message.id)) &&
            (filter?.messageRunIds === undefined ||
              (message.runId !== null && filter.messageRunIds.includes(message.runId))) &&
            (filter?.messageRoles === undefined || filter.messageRoles.includes(message.role)),
        ),
      };
      return Object.fromEntries(
        fields.map((field) => [field, records[field as keyof typeof records] ?? []]),
      ) as unknown as ProjectionRecords<K>;
    });
  const buildBroker = ThreadReadBroker.ThreadReadBroker.pipe(
    Effect.provide(
      ThreadReadBroker.layer.pipe(
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagementService.ThreadManagementService)({ getThreadRecords }),
        ),
      ),
    ),
    Effect.provide(services),
  );
  const broker = yield* buildBroker;
  const registeredSessions = new Set<string>();
  const ensureSession = Effect.fn("brokerFixture.session")(function* (id: string) {
    if (registeredSessions.has(id)) return;
    const now = yield* DateTime.now;
    yield* sessions.create({
      sessionId: AuthSessionId.make(id),
      subject: "paired-client",
      method: "browser-session-cookie",
      scopes: ["orchestration:read"],
      issuedAt: now,
      expiresAt: DateTime.makeUnsafe(DateTime.toEpochMillis(now) + 30 * 24 * 60 * 60 * 1000),
      client: {
        label: null,
        ipAddress: null,
        userAgent: null,
        deviceType: "unknown",
        os: null,
        browser: null,
      },
    });
    registeredSessions.add(id);
  });
  const message = (
    thread: ThreadId,
    id: MessageId,
    run: RunId | null,
    now: DateTime.Utc,
    extra: Partial<Message> = {},
  ): Message => ({
    id,
    threadId: thread,
    runId: run,
    nodeId: null,
    role: "user",
    text: "Input",
    createdBy: "user",
    creationSource: "web",
    attachments: [],
    streaming: false,
    createdAt: now,
    updatedAt: now,
    ...extra,
  });
  const questionNode = (
    id: NodeId,
    request: RuntimeRequestId,
    now: DateTime.Utc,
  ): OrchestrationV2ExecutionNode => ({
    id,
    threadId: sourceThreadId,
    runId: sourceRunId,
    parentNodeId: null,
    rootNodeId: id,
    kind: "user_input_request",
    status: "completed",
    countsForRun: false,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: request,
    checkpointScopeId: null,
    startedAt: now,
    completedAt: now,
  });
  let sequence = 0;
  const event = (
    thread: ThreadId,
    payload: Message | Run | OrchestrationV2ThreadProjection["runtimeRequests"][number],
    type: "message.updated" | "run.created" | "runtime-request.updated",
    now: DateTime.Utc,
  ) =>
    ({
      id: EventId.make(`fixture-event-${++sequence}`),
      threadId: thread,
      occurredAt: now,
      type,
      payload,
    }) as OrchestrationV2DomainEvent;
  const persist = Effect.fn("brokerFixture.persist")(function* (
    events: ReadonlyArray<OrchestrationV2DomainEvent>,
    commandId: CommandId,
  ) {
    for (const accepted of events) {
      yield* sql`INSERT INTO orchestration_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, actor_kind, payload_json, metadata_json, application_event_version)
        VALUES (${accepted.id}, 'thread', ${accepted.threadId},
          (SELECT COALESCE(MAX(stream_version) + 1, 0) FROM orchestration_events
            WHERE aggregate_kind = 'thread' AND stream_id = ${accepted.threadId}),
          ${accepted.type}, ${DateTime.formatIso(accepted.occurredAt)}, ${commandId},
          'server', ${JSON.stringify(accepted.payload)}, '{}', 2)`;
      if (accepted.type === "message.updated") {
        const row = accepted.payload;
        yield* sql`INSERT OR REPLACE INTO orchestration_v2_projection_messages
          (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
          VALUES (${row.id}, ${row.threadId}, ${row.runId}, ${row.nodeId}, ${row.role}, ${Number(row.streaming)},
            ${DateTime.formatIso(row.createdAt)}, ${DateTime.formatIso(row.updatedAt)}, ${JSON.stringify(row)})`;
      } else if (accepted.type === "run.created") {
        const row = accepted.payload;
        yield* sql`INSERT OR IGNORE INTO orchestration_v2_projection_runs
          (run_id, thread_id, ordinal, provider, provider_instance_id, status, requested_at, payload_json)
          VALUES (${row.id}, ${row.threadId}, ${row.ordinal}, 'codex', ${row.providerInstanceId}, ${row.status},
            ${DateTime.formatIso(row.requestedAt)}, ${JSON.stringify(row)})`;
      }
    }
  });
  /** Authorize has no side effects. Only this explicit accepted-event transaction consumes its result. */
  const accept = (
    intent: ThreadReadIntakeIntent | undefined,
    thread: ThreadId,
    commandType: string,
    events: ReadonlyArray<OrchestrationV2DomainEvent>,
    commandId = CommandId.make(`fixture-command-${++sequence}`),
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const accepted = yield* admitAcceptedInput({
            threadId: thread,
            commandType,
            commandId,
            events,
            ...(intent === undefined ? {} : { threadReadIntent: intent }),
          });
          yield* persist(accepted, commandId);
          return accepted;
        }),
      )
      .pipe(
        Effect.provide(services),
        Effect.tap((accepted) =>
          Effect.sync(() => {
            for (const row of accepted) {
              if (row.type === "message.updated") {
                const existing = messages.get(thread) ?? [];
                messages.set(thread, [
                  ...existing.filter((message) => message.id !== row.payload.id),
                  row.payload,
                ]);
              } else if (row.type === "runtime-request.updated") {
                const existing = requests.get(thread) ?? [];
                requests.set(thread, [
                  ...existing.filter((request) => request.id !== row.payload.id),
                  row.payload,
                ]);
              } else if (
                row.type === "run.created" &&
                !(runs.get(thread) ?? []).some((run) => run.id === row.payload.id)
              ) {
                const existing = runs.get(thread) ?? [];
                if (row.payload.status === "running")
                  for (const run of existing) {
                    run.status = "completed";
                    run.completedAt = row.occurredAt;
                  }
                runs.set(thread, [...existing, row.payload]);
              }
            }
          }),
        ),
      );
  const start = Effect.fn("brokerFixture.start")(function* (
    thread: ThreadId,
    id: MessageId,
    status: Run["status"] = "running",
    intent?: ThreadReadIntakeIntent,
    extra: Partial<Message> = {},
  ) {
    const now = yield* DateTime.now;
    const run: Run = {
      id: runId(id),
      threadId: thread,
      userMessageId: id,
      status,
      ordinal: (runs.get(thread)?.length ?? 0) + 1,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "test-model" },
      providerThreadId: null,
      rootNodeId: null,
      activeAttemptId: null,
      requestedAt: now,
      startedAt: status === "running" ? now : null,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    };
    yield* accept(intent, thread, "message.dispatch", [
      event(thread, message(thread, id, run.id, now, extra), "message.updated", now),
      event(thread, run, "run.created", now),
    ]);
    return run;
  });
  const continueAction = Effect.fn("brokerFixture.action")(function* (
    thread: ThreadId,
    source: RunId,
    actionRunId: string,
  ) {
    const id = MessageId.make(`action-resume:${actionRunId}:follow-up`);
    yield* start(thread, id, "running", undefined, {
      createdBy: "agent",
      creationSource: "server",
    });
    const sourceRun = runs.get(thread)!.find((run) => run.id === source)!;
    sourceRun.actionObligations = [
      ...(sourceRun.actionObligations ?? []),
      {
        actionRunId,
        messageId: id,
        owner: {
          parentEnvironmentId: EnvironmentId.make("parent-environment"),
          parentThreadId: thread,
          taskId: NodeId.make(`task:${thread}`),
          sourceRunId: source,
        },
        state: "transferred",
        continuationRunId: runId(id),
      },
    ];
    return runId(id);
  });
  const send = Effect.fn("brokerFixture.send")(function* (
    session: string,
    thread: ThreadId,
    id: MessageId,
    status: Run["status"] = "running",
    extra: Partial<Message> = {},
  ) {
    yield* ensureSession(session);
    const intent = yield* broker.forSession(session).authorize(thread, id);
    expect(intent).toBeDefined();
    return yield* start(thread, id, status, intent, extra);
  });
  const attach = Effect.fn("brokerFixture.attach")(function* (
    session: string,
    thread: ThreadId,
    id: MessageId,
    row: Message | OrchestrationV2ThreadProjection["runtimeRequests"][number],
    commandType: "message.dispatch" | "queued-run.edit" | "runtime-request.respond",
  ) {
    yield* ensureSession(session);
    const intent = yield* broker.forSession(session).authorize(thread, id);
    expect(intent).toBeDefined();
    const now = yield* DateTime.now;
    const command = CommandId.make(
      id.startsWith("answer-context:")
        ? id.slice("answer-context:".length)
        : id.startsWith("queued-edit-context:")
          ? id.slice("queued-edit-context:".length)
          : `fixture-command-${++sequence}`,
    );
    const accepted = yield* accept(
      intent,
      thread,
      commandType,
      [event(thread, row, "role" in row ? "message.updated" : "runtime-request.updated", now)],
      command,
    );
    return accepted[0]!;
  });
  const spawn = (
    child: ThreadId,
    parent: ThreadId,
    parentRun: RunId,
    now: DateTime.Utc,
  ): Spawn => ({
    id: ContextTransferId.make(`spawn:${child}`),
    type: "subagent_spawn",
    sourceThreadId: parent,
    targetThreadId: child,
    targetRunId: runs.get(child)!.at(-1)!.id,
    sourcePoint: { threadId: parent, runId: parentRun },
    basePoint: null,
    sourceProviderInstanceId: providerInstanceId,
    targetProviderInstanceId: providerInstanceId,
    status: "consumed",
    resolution: null,
    createdBy: "agent",
    error: null,
    createdAt: now,
    updatedAt: now,
    consumedAt: now,
  });
  const answered: string[] = [];
  const answer = (
    sessionId: string,
    reply:
      | OrchestratorMcpThreadReadResult
      | null
      | ((request: ThreadReadRequest) => OrchestratorMcpThreadReadResult | null) = result,
    unavailableEnvironmentIds: () => ReadonlyArray<EnvironmentId> = () => [],
  ) =>
    Effect.flatMap(broker.connect(sessionId), (stream) =>
      stream.pipe(
        Stream.runForEach((request) => {
          answered.push(sessionId);
          return broker.respond(sessionId, {
            connectionId: request.connectionId,
            requestId: request.requestId,
            result: typeof reply === "function" ? reply(request) : reply,
            unavailableEnvironmentIds: unavailableEnvironmentIds(),
          });
        }),
        Effect.forkScoped,
      ),
    );
  const callerRun = (thread: ThreadId) => {
    const loaded = { runs: runs.get(thread) ?? [] } as unknown as OrchestrationV2ThreadProjection;
    return (
      ThreadManagementService.latestActiveRun(loaded) ?? ThreadManagementService.latestRun(loaded)
    )?.id;
  };
  const readFrom = (
    source: ThreadId,
    run: RunId | undefined,
    input: OrchestratorMcpThreadReadInput = { threadId },
  ) =>
    broker.read(source, run, input).pipe(
      Effect.map(() => answered.at(-1)),
      Effect.catch((error) => Effect.succeed(error.code)),
    );
  const reader = (source: ThreadId) => readFrom(source, callerRun(source));
  yield* ensureSession("other-session");
  yield* ensureSession("answering-client");
  yield* ensureSession("editing-client");
  yield* ensureSession("steering-client");
  yield* ensureSession("replay-client");
  yield* send("client-session", sourceThreadId, MessageId.make("source-message"));
  return {
    broker,
    restart: () => buildBroker,
    store,
    sql,
    runs,
    transfers,
    requests,
    nodes,
    messages,
    start,
    continueAction,
    send,
    attach,
    accept,
    event,
    message,
    questionNode,
    spawn,
    answer,
    callerRun,
    readFrom,
    reader,
  };
});

const respondTo = (
  broker: ThreadReadBroker.ThreadReadBroker["Service"],
  sessionId: string,
  request: ThreadReadRequest,
  reply: OrchestratorMcpThreadReadResult | null = result,
) =>
  broker.respond(sessionId, {
    connectionId: request.connectionId,
    requestId: request.requestId,
    result: reply,
    unavailableEnvironmentIds: [],
  });

describe("ThreadReadBroker", () => {
  it.effect(
    "retains an existing grant when its original client reconnects after broker restart",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeHarness;
          yield* h.answer("client-session");
          const input = { environmentId, threadId, via: "client" as const };
          expect(yield* h.readFrom(sourceThreadId, sourceRunId, input)).toBe("client-session");

          const restarted = yield* h.restart();
          yield* (yield* restarted.connect("client-session")).pipe(
            Stream.runForEach((request) => respondTo(restarted, "client-session", request)),
            Effect.forkScoped,
          );
          const outcome = yield* restarted.read(sourceThreadId, sourceRunId, input).pipe(
            Effect.as("success"),
            Effect.catch((error) => Effect.succeed(error.code)),
          );
          expect(outcome).toBe("success");
        }),
      ),
  );

  it.effect("retains an attached reference when a delegate completion starts the next turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        const source = h.messages.get(sourceThreadId)![0]!;
        const attachedThread = ThreadId.make("attached-source");
        const attachedMessage = MessageId.make("attached-input");
        yield* h.send("client-session", attachedThread, attachedMessage, "running", {
          ...referenceContext(attachedMessage, DateTime.toEpochMillis(source.createdAt)),
        });
        yield* h.answer("client-session");
        const exact = { environmentId, threadId, via: "client" as const };
        expect(yield* h.readFrom(attachedThread, runId(attachedMessage), exact)).toBe(
          "client-session",
        );
        // Capacity can remove a general row while retaining its separate reference row.
        // The accepted original reference still precedes a same-tick continuation.
        yield* h.sql`DELETE FROM lastcode_thread_read_grants WHERE thread_id = ${attachedThread} AND kind = 'run'`;
        const wakeMessage = MessageId.make("delegate-completion-message");
        yield* h.start(attachedThread, wakeMessage, "running", undefined, {
          createdBy: "agent",
          creationSource: "server",
          text: "The delegated task completed.",
          delegatedCompletion: {
            parentRunId: runId(attachedMessage),
            generation: 1,
            taskIds: [NodeId.make("completed-task")],
          },
        });
        expect(yield* h.readFrom(attachedThread, runId(wakeMessage), exact)).toBe("client-session");
      }),
    ),
  );

  it.effect(
    "scopes live answer references to the answering client and captured continuation cutoff",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeHarness;
          const authorizationId = MessageId.make("answer-context:answer-command");
          const now = yield* DateTime.now;
          const request = {
            id: RuntimeRequestId.make("question-request"),
            nodeId: NodeId.make("question-node"),
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input" as const,
            status: "resolved" as const,
            responseCapability: {
              type: "live" as const,
              providerSessionId: ProviderSessionId.make("live-provider"),
            },
            createdAt: now,
            resolvedAt: now,
            threadReadContext: {
              authorizationId,
              records: [attachedReference],
            },
          };
          yield* h.attach(
            "answering-client",
            sourceThreadId,
            authorizationId,
            request,
            "runtime-request.respond",
          );
          h.nodes.set(sourceThreadId, [h.questionNode(request.nodeId, request.id, now)]);
          yield* h.answer("client-session", matchingResult);
          yield* h.answer("answering-client");
          const exact = { threadId, environmentId, via: "client" as const };
          expect(yield* h.readFrom(sourceThreadId, sourceRunId, exact)).toBe("answering-client");
          const unrelated = { ...exact, environmentId: EnvironmentId.make("other-environment") };
          expect(yield* h.readFrom(sourceThreadId, sourceRunId, unrelated)).toBe("client-session");
          expect(
            yield* h.readFrom(sourceThreadId, sourceRunId, {
              ...exact,
              threadId: ThreadId.make("unmentioned"),
            }),
          ).toBe("client-session");
          expect(yield* h.readFrom(sourceThreadId, sourceRunId, { threadId })).toBe(
            "client-session",
          );

          // Equal-time answers cannot be proven to precede a child's capture boundary.
          const earlyChild = ThreadId.make("child-before-answer");
          const earlyMessage = MessageId.make("child-before-answer-message");
          yield* h.start(earlyChild, earlyMessage, "running", undefined, {
            createdBy: "agent",
            creationSource: "server",
          });
          h.transfers.set(earlyChild, [h.spawn(earlyChild, sourceThreadId, sourceRunId, now)]);
          expect(yield* h.readFrom(earlyChild, runId(earlyMessage), exact)).toBe("client-session");
          yield* TestClock.adjust("1 millis");
          const lateChild = ThreadId.make("child-after-answer");
          const lateMessage = MessageId.make("child-after-answer-message");
          yield* h.start(lateChild, lateMessage, "running", undefined, {
            createdBy: "agent",
            creationSource: "server",
          });
          h.transfers.set(lateChild, [
            h.spawn(lateChild, sourceThreadId, sourceRunId, yield* DateTime.now),
          ]);
          expect(yield* h.readFrom(lateChild, runId(lateMessage), exact)).toBe("answering-client");
          const earlyContinuation = yield* h.continueAction(
            earlyChild,
            runId(earlyMessage),
            "early-child-action",
          );
          expect(yield* h.readFrom(earlyChild, earlyContinuation, exact)).toBe("client-session");
          const first = yield* h.continueAction(lateChild, runId(lateMessage), "late-child-action");
          const continuation = yield* h.continueAction(lateChild, first, "second-child-action");
          expect(yield* h.readFrom(lateChild, continuation, exact)).toBe("answering-client");
          const descendant = ThreadId.make("child-after-action");
          const descendantMessage = MessageId.make("child-after-action-message");
          yield* h.start(descendant, descendantMessage, "running", undefined, {
            createdBy: "agent",
            creationSource: "server",
          });
          h.transfers.set(descendant, [
            h.spawn(descendant, lateChild, continuation, yield* DateTime.now),
          ]);
          expect(yield* h.readFrom(descendant, runId(descendantMessage), exact)).toBe(
            "answering-client",
          );
          // Without its own retained grant, an async trigger can use only the matching
          // accepted message-capable answer; a live answer belongs to the original run.
          const unboundAnswer = MessageId.make(`async-answer:${request.id}`);
          yield* h.start(sourceThreadId, unboundAnswer);
          expect(yield* h.readFrom(sourceThreadId, runId(unboundAnswer), exact)).toBe(
            "environment_unavailable",
          );
          const acceptedAnswer = h.requests.get(sourceThreadId)![0]!;
          h.requests.set(sourceThreadId, [
            { ...acceptedAnswer, responseCapability: { type: "message" } },
          ]);
          expect(yield* h.readFrom(sourceThreadId, runId(unboundAnswer), exact)).toBe(
            "answering-client",
          );
          expect(
            yield* h.readFrom(sourceThreadId, runId(unboundAnswer), {
              ...exact,
              threadId: ThreadId.make("unmentioned"),
            }),
          ).toBe("environment_unavailable");
          yield* TestClock.adjust("6 days");
          expect(yield* h.readFrom(sourceThreadId, sourceRunId, unrelated)).toBe("client-session");
          yield* TestClock.adjust("2 days");
          // A new proposal, even from a connected client, cannot revive this accepted nonce.
          yield* h.broker.forSession("replay-client").authorize(sourceThreadId, authorizationId);
          yield* h.answer("replay-client");
          for (const [source, run] of [
            [sourceThreadId, sourceRunId],
            [sourceThreadId, runId(unboundAnswer)],
            [lateChild, runId(lateMessage)],
            [lateChild, continuation],
            [descendant, runId(descendantMessage)],
          ] as const) {
            expect(yield* h.readFrom(source, run, exact)).toBe("environment_unavailable");
          }
          expect(yield* h.readFrom(sourceThreadId, sourceRunId, unrelated)).toBe("client-session");
        }),
      ),
  );

  it.effect.each([false, true])(
    "gives an accepted async answer its own general grant (attached: %s)",
    (attached) =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeHarness;
          const now = yield* DateTime.now;
          const requestId = RuntimeRequestId.make("async-question");
          const authorizationId = MessageId.make("answer-context:async-command");
          const id = MessageId.make(`async-answer:${requestId}`);
          const intent = yield* h.broker
            .forSession("answering-client")
            .authorize(sourceThreadId, authorizationId);
          const request = {
            id: requestId,
            nodeId: NodeId.make("async-node"),
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input" as const,
            status: "resolved" as const,
            responseCapability: { type: "message" as const },
            createdAt: now,
            resolvedAt: now,
            ...(attached
              ? {
                  threadReadContext: {
                    authorizationId,
                    records: [attachedReference],
                  },
                }
              : {}),
          };
          const prior = h.runs.get(sourceThreadId)![0]!;
          const next: Run = {
            ...prior,
            id: runId(id),
            userMessageId: id,
            ordinal: 2,
            requestedAt: now,
            startedAt: now,
          };
          yield* h.accept(
            intent,
            sourceThreadId,
            "runtime-request.respond",
            [
              h.event(sourceThreadId, request, "runtime-request.updated", now),
              h.event(
                sourceThreadId,
                h.message(sourceThreadId, id, next.id, now, {
                  createdBy: "user",
                  creationSource: "web",
                }),
                "message.updated",
                now,
              ),
              h.event(sourceThreadId, next, "run.created", now),
            ],
            CommandId.make("async-command"),
          );
          yield* h.answer("client-session", matchingResult);
          yield* h.answer("answering-client", matchingResult);
          expect(yield* h.readFrom(sourceThreadId, next.id, { threadId })).toBe("answering-client");
          expect(
            yield* h.readFrom(sourceThreadId, next.id, {
              threadId: ThreadId.make("unmentioned"),
              environmentId,
            }),
          ).toBe("answering-client");
          expect(yield* h.readFrom(sourceThreadId, next.id, { threadId, environmentId })).toBe(
            "answering-client",
          );
          expect(yield* h.readFrom(sourceThreadId, sourceRunId, { threadId })).toBe(
            "client-session",
          );
        }),
      ),
  );

  it.effect("scopes edited queued references to their editor without replacing run authority", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        const id = MessageId.make("edited-queue-message");
        const authorizationId = MessageId.make("queued-edit-context:edit-command");
        yield* h.send("client-session", sourceThreadId, id, "queued");
        yield* TestClock.adjust("1 millis");
        const now = yield* DateTime.now;
        yield* h.attach(
          "editing-client",
          sourceThreadId,
          authorizationId,
          h.message(
            sourceThreadId,
            id,
            runId(id),
            now,
            referenceContext(authorizationId, DateTime.toEpochMillis(now)),
          ),
          "queued-run.edit",
        );
        yield* h.answer("editing-client");
        yield* h.answer("client-session", matchingResult);
        const exact = { threadId, environmentId, via: "client" as const };
        const unrelated = { ...exact, threadId: ThreadId.make("unmentioned-reference") };
        expect(yield* h.readFrom(sourceThreadId, runId(id), exact)).toBe("editing-client");
        expect(yield* h.readFrom(sourceThreadId, runId(id), unrelated)).toBe("client-session");
        expect(yield* h.readFrom(sourceThreadId, runId(id), { threadId })).toBe("client-session");
        // Promotion preserves the accepted override and original general grant.
        h.runs.get(sourceThreadId)![0]!.status = "completed";
        h.runs.get(sourceThreadId)![1]!.status = "running";
        expect(yield* h.reader(sourceThreadId)).toBe("client-session");
        expect(yield* h.readFrom(sourceThreadId, runId(id), exact)).toBe("editing-client");
        yield* TestClock.adjust("1 millis");
        const child = ThreadId.make("edited-queue-child");
        const childMessage = MessageId.make("edited-queue-child-message");
        yield* h.start(child, childMessage, "running", undefined, {
          createdBy: "agent",
          creationSource: "server",
        });
        h.transfers.set(child, [h.spawn(child, sourceThreadId, runId(id), yield* DateTime.now)]);
        expect(yield* h.readFrom(child, runId(childMessage), exact)).toBe("editing-client");
        yield* TestClock.adjust("6 days");
        expect(yield* h.readFrom(sourceThreadId, runId(id), unrelated)).toBe("client-session");
        yield* TestClock.adjust("2 days");
        yield* h.broker.forSession("replay-client").authorize(sourceThreadId, authorizationId);
        yield* h.answer("replay-client");
        expect(yield* h.readFrom(sourceThreadId, runId(id), exact)).toBe("environment_unavailable");
        expect(yield* h.readFrom(child, runId(childMessage), exact)).toBe(
          "environment_unavailable",
        );
        const edited = h.messages.get(sourceThreadId)!.find((row) => row.id === id)!;
        h.messages.set(sourceThreadId, [
          h.message(sourceThreadId, id, runId(id), edited.createdAt, { text: "Reference removed" }),
        ]);
        expect(yield* h.readFrom(sourceThreadId, runId(id), exact)).toBe("client-session");
      }),
    ),
  );

  it.effect("uses the sending client for exact references steered into an existing run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        const priorAuthorization = MessageId.make("answer-context:prior-question");
        const now = yield* DateTime.now;
        const priorQuestion = {
          id: RuntimeRequestId.make("prior-question"),
          nodeId: NodeId.make("prior-question-node"),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input" as const,
          status: "resolved" as const,
          responseCapability: {
            type: "live" as const,
            providerSessionId: ProviderSessionId.make("live-provider"),
          },
          createdAt: now,
          resolvedAt: now,
          threadReadContext: {
            authorizationId: priorAuthorization,
            records: [attachedReference],
          },
        };
        yield* h.attach(
          "answering-client",
          sourceThreadId,
          priorAuthorization,
          priorQuestion,
          "runtime-request.respond",
        );
        const acceptedQuestion = h.requests.get(sourceThreadId)![0]!;
        h.nodes.set(sourceThreadId, [h.questionNode(priorQuestion.nodeId, priorQuestion.id, now)]);
        yield* h.answer("answering-client");
        yield* TestClock.adjust("1 millis");
        const id = MessageId.make("steered-reference-message");
        const capturedAt = yield* DateTime.now;
        yield* h.attach(
          "steering-client",
          sourceThreadId,
          id,
          h.message(
            sourceThreadId,
            id,
            sourceRunId,
            capturedAt,
            referenceContext(id, DateTime.toEpochMillis(capturedAt)),
          ),
          "message.dispatch",
        );
        yield* h.answer("steering-client");
        yield* h.answer("client-session", matchingResult);
        const exact = { threadId, environmentId, via: "client" as const };
        expect(yield* h.readFrom(sourceThreadId, sourceRunId, exact)).toBe("steering-client");
        expect(
          yield* h.readFrom(sourceThreadId, sourceRunId, {
            ...exact,
            threadId: ThreadId.make("unmentioned"),
          }),
        ).toBe("client-session");
        expect(yield* h.readFrom(sourceThreadId, sourceRunId, { threadId })).toBe("client-session");
        yield* TestClock.adjust("1 millis");
        // A later accepted answer wins over a steered message's older exact override.
        const laterId = MessageId.make("answer-context:later-question");
        yield* h.attach(
          "answering-client",
          sourceThreadId,
          laterId,
          {
            ...acceptedQuestion,
            resolvedAt: yield* DateTime.now,
            threadReadContext: { ...acceptedQuestion.threadReadContext!, authorizationId: laterId },
          },
          "runtime-request.respond",
        );
        expect(yield* h.readFrom(sourceThreadId, sourceRunId, exact)).toBe("answering-client");
      }),
    ),
  );

  it.effect("keeps running and queued inputs bound to their own authenticated clients", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, start, send, answer, callerRun, readFrom, reader, runs } =
          yield* makeHarness;
        const queued = MessageId.make("queued-message");
        yield* send("other-session", sourceThreadId, queued, "queued");
        yield* answer("client-session");
        yield* answer("other-session");
        const captured = callerRun(sourceThreadId);
        expect(yield* reader(sourceThreadId)).toBe("client-session");
        // The queued input starts once the running one finishes.
        const [running, waiting] = runs.get(sourceThreadId)!;
        running!.status = "completed";
        waiting!.status = "running";
        expect(yield* reader(sourceThreadId)).toBe("other-session");
        // A caller that captured the earlier run keeps its authority after the source advances.
        expect(yield* readFrom(sourceThreadId, captured)).toBe("client-session");
        const launchedThreadId = ThreadId.make("launched-thread");
        const launched = MessageId.make("launched-message");
        const inherited = yield* (yield* broker.inherit(sourceThreadId, captured)).authorize(
          launchedThreadId,
          launched,
        );
        yield* start(launchedThreadId, launched, "running", inherited);
        expect(yield* reader(launchedThreadId)).toBe("client-session");
        // Without a captured run there is no authority, even while the source is running.
        expect(yield* readFrom(sourceThreadId, undefined)).toBe("environment_unavailable");
        const unbound = MessageId.make("unbound-message");
        const unaccepted = yield* (yield* broker.inherit(sourceThreadId, undefined)).authorize(
          launchedThreadId,
          unbound,
        );
        yield* start(launchedThreadId, unbound, "running", unaccepted);
        expect(yield* reader(launchedThreadId)).toBe("environment_unavailable");
      }),
    ),
  );

  it.effect("refuses replay claims and preserves the original input's authority", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { start, send, answer, reader } = yield* makeHarness;
        yield* send("other-session", sourceThreadId, MessageId.make("source-message"));
        const replayedThreadId = ThreadId.make("replayed-thread");
        const replayed = MessageId.make("existing-unassociated-message");
        yield* start(replayedThreadId, replayed);
        yield* send("other-session", replayedThreadId, replayed);
        yield* answer("client-session");
        yield* answer("other-session");
        expect(yield* reader(sourceThreadId)).toBe("client-session");
        expect(yield* reader(replayedThreadId)).toBe("environment_unavailable");
      }),
    ),
  );

  it.effect("uses the accepted submitter after another client's unaccepted claim", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        const target = ThreadId.make("competing-submissions");
        const message = MessageId.make("shared-submission-id");
        // The first submission never commits an input. The other client then submits it.
        const discarded = yield* h.broker.forSession("client-session").authorize(target, message);
        expect(discarded).toBeDefined();
        expect(yield* h.store.lookupGrant(target, "run", runId(message))).toBeUndefined();
        yield* h.send("other-session", target, message);
        yield* h.answer("client-session");
        yield* h.answer("other-session");
        expect(yield* h.reader(target)).toBe("other-session");
      }),
    ),
  );

  it.effect("refreshes valid authority use while expiring idle bindings", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { send, answer, reader } = yield* makeHarness;
        const idleThreadId = ThreadId.make("idle-thread");
        yield* send("other-session", idleThreadId, MessageId.make("idle-message"));
        yield* answer("client-session");
        yield* answer("other-session");
        yield* TestClock.adjust("6 days");
        expect(yield* reader(sourceThreadId)).toBe("client-session");
        yield* TestClock.adjust("6 days");
        expect(yield* reader(idleThreadId)).toBe("environment_unavailable");
        expect(yield* reader(sourceThreadId)).toBe("client-session");
        yield* TestClock.adjust("7 days");
        expect(yield* reader(sourceThreadId)).toBe("environment_unavailable");
      }),
    ),
  );

  it.effect(
    "does not let a replay claim expired authority or refresh another requester's binding",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { send, answer, reader, store } = yield* makeHarness;
          yield* TestClock.adjust("6 days");
          yield* send("other-session", sourceThreadId, MessageId.make("source-message"));
          yield* TestClock.adjust("1 day");
          yield* store.prune(DateTime.toEpochMillis(yield* DateTime.now));
          expect(yield* store.lookupGrant(sourceThreadId, "run", sourceRunId)).toBeUndefined();
          yield* send("other-session", sourceThreadId, MessageId.make("source-message"));
          yield* answer("other-session");
          expect(yield* store.lookupGrant(sourceThreadId, "run", sourceRunId)).toBeUndefined();
          expect(yield* reader(sourceThreadId)).toBe("environment_unavailable");
        }),
      ),
  );

  it.effect(
    "evicts the oldest recorded use at capacity and rejects its accepted-input replay",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeHarness;
          const evictedThread = ThreadId.make("capacity-thread-0");
          const evictedMessage = MessageId.make("capacity-message-0");
          yield* h.send("other-session", evictedThread, evictedMessage);
          // Seed accepted historical grants in one statement; exercising 10,000 intakes would
          // duplicate admission coverage and dominate this broker capacity control.
          yield* h.sql`WITH RECURSIVE series(n) AS (VALUES (1) UNION ALL SELECT n + 1 FROM series WHERE n < 9998)
        INSERT INTO lastcode_thread_read_grants
          (thread_id, kind, grant_id, session_id, proof_key, subject, method, scopes, family_id,
            key_generation, family_generation, last_used_at)
        SELECT 'capacity-thread-' || n, kind, 'run-capacity-message-' || n, session_id, proof_key,
          subject, method, scopes, family_id, key_generation, family_generation, last_used_at
        FROM series CROSS JOIN lastcode_thread_read_grants
        WHERE thread_id = ${evictedThread} AND kind = 'run' AND grant_id = ${runId(evictedMessage)}`;
          expect(yield* h.sql`SELECT COUNT(*) AS count FROM lastcode_thread_read_grants`).toEqual([
            { count: 10_000 },
          ]);
          yield* h.answer("client-session");
          yield* h.answer("other-session");
          yield* TestClock.adjust("1 minute");
          expect(yield* h.reader(sourceThreadId)).toBe("client-session");
          const newestThread = ThreadId.make("newest-thread");
          yield* h.send("other-session", newestThread, MessageId.make("newest-message"));
          expect(yield* h.reader(evictedThread)).toBe("environment_unavailable");
          expect(yield* h.reader(sourceThreadId)).toBe("client-session");
          expect(yield* h.reader(newestThread)).toBe("other-session");
          yield* h.send("client-session", evictedThread, evictedMessage);
          expect(yield* h.reader(evictedThread)).toBe("environment_unavailable");
          expect(yield* h.sql`SELECT COUNT(*) AS count FROM lastcode_thread_read_grants`).toEqual([
            { count: 10_000 },
          ]);
        }),
      ),
  );

  it.effect(
    "inherits the exact delegated parent run and fails closed for absent or cyclic ancestry",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const {
            broker,
            start,
            spawn,
            continueAction,
            send,
            answer,
            callerRun,
            readFrom,
            reader,
            transfers,
            runs,
          } = yield* makeHarness;
          const spawned = Effect.fn("brokerFixture.spawned")(function* (
            child: ThreadId,
            parent: ThreadId,
            parentRunId: RunId,
          ) {
            const message = MessageId.make(`${child}-message`);
            yield* start(child, message, "running", undefined, {
              createdBy: "agent",
              creationSource: "server",
            });
            transfers.set(child, [spawn(child, parent, parentRunId, yield* DateTime.now)]);
          });
          const childThreadId = ThreadId.make("delegated-child");
          yield* spawned(childThreadId, sourceThreadId, runId(MessageId.make("source-message")));
          // The parent's next run belongs to another client.
          yield* send("other-session", sourceThreadId, MessageId.make("later-message"));
          yield* answer("client-session");
          yield* answer("other-session");
          expect(yield* reader(childThreadId)).toBe("client-session");
          const originalRun = runs.get(childThreadId)![0]!;
          const continuation = yield* continueAction(
            childThreadId,
            originalRun.id,
            "delegated-action",
          );
          expect(yield* reader(childThreadId)).toBe("client-session");

          // Threads launched by the child inherit the same requester.
          const launchedThreadId = ThreadId.make("launched-thread");
          const launched = MessageId.make("launched-message");
          const inherited = yield* (yield* broker.inherit(
            childThreadId,
            callerRun(childThreadId),
          )).authorize(launchedThreadId, launched);
          yield* start(launchedThreadId, launched, "running", inherited);
          expect(yield* reader(launchedThreadId)).toBe("client-session");
          const obligation = originalRun.actionObligations![0]!;
          for (const state of ["waiting", "disposed"] as const) {
            originalRun.actionObligations = [{ ...obligation, state }];
            expect(yield* readFrom(childThreadId, continuation)).toBe("environment_unavailable");
          }
          originalRun.actionObligations = [
            { ...obligation, messageId: MessageId.make("unrelated-message") },
          ];
          expect(yield* readFrom(childThreadId, continuation)).toBe("environment_unavailable");
          originalRun.actionObligations = [
            {
              ...obligation,
              owner: { ...obligation.owner, sourceRunId: RunId.make("unrelated-run") },
            },
          ];
          expect(yield* readFrom(childThreadId, continuation)).toBe("environment_unavailable");
          originalRun.actionObligations = [];
          const watch = {
            generation: "read-authority-watch",
            owner: obligation.owner,
            sourceAttemptId: RunAttemptId.make("read-authority-attempt"),
            key: { host: "github.com", repository: "example/project", number: 1 },
            state: "ended" as const,
          };
          originalRun.pullRequestWatchObligations = [watch];
          const wake = runs.get(childThreadId)!.find((row) => row.id === continuation)!;
          const marker = {
            generation: watch.generation,
            owner: watch.owner,
            messageId: wake.userMessageId,
          };
          wake.pullRequestWatchContinuation = marker;
          expect(yield* readFrom(childThreadId, continuation)).toBe("client-session");
          for (const forged of [
            { ...marker, generation: "other-generation" },
            { ...marker, messageId: MessageId.make("other-message") },
            { ...marker, owner: { ...marker.owner, taskId: NodeId.make("other-task") } },
            {
              ...marker,
              owner: {
                ...marker.owner,
                parentEnvironmentId: EnvironmentId.make("other-environment"),
              },
            },
          ]) {
            wake.pullRequestWatchContinuation = forged;
            expect(yield* readFrom(childThreadId, continuation)).toBe("environment_unavailable");
          }
          wake.pullRequestWatchContinuation = marker;
          originalRun.pullRequestWatchObligations = [
            { ...watch, state: "disposed", disposalReason: "owner_unwatch" },
          ];
          expect(yield* readFrom(childThreadId, continuation)).toBe("client-session");
          originalRun.pullRequestWatchObligations = [];
          expect(yield* readFrom(childThreadId, continuation)).toBe("environment_unavailable");
          originalRun.actionObligations = [obligation];

          const orphanThreadId = ThreadId.make("orphan-child");
          yield* spawned(orphanThreadId, sourceThreadId, RunId.make("missing-run"));
          expect(yield* reader(orphanThreadId)).toBe("environment_unavailable");
          const cyclicThreadId = ThreadId.make("cyclic-child");
          yield* spawned(
            cyclicThreadId,
            cyclicThreadId,
            runId(MessageId.make("cyclic-child-message")),
          );
          yield* continueAction(cyclicThreadId, callerRun(cyclicThreadId)!, "cyclic-action");
          expect(yield* reader(cyclicThreadId)).toBe("environment_unavailable");
        }),
      ),
  );

  it.effect("reports unavailable routing instead of falsely claiming the thread is missing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { reader } = yield* makeHarness;
        for (const source of [sourceThreadId, ThreadId.make("unbound-thread")]) {
          expect(yield* reader(source)).toBe("environment_unavailable");
        }
      }),
    ),
  );

  it.effect("returns a remote result and preserves every paging option", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker } = yield* makeHarness;
        const input: OrchestratorMcpThreadReadInput = {
          threadId,
          environmentId,
          via: "client",
          itemId: TurnItemId.make("example-item"),
          textOffset: 5000,
          afterPosition: 40,
          view: "activity",
          limit: 2,
          runLimit: 1,
          maxCharsPerItem: 1000,
        };
        const forwarded: Array<OrchestratorMcpThreadReadInput> = [];
        yield* (yield* broker.connect("client-session")).pipe(
          Stream.runForEach((request) => {
            forwarded.push(request.input);
            return respondTo(broker, "client-session", request);
          }),
          Effect.forkScoped,
        );
        expect(yield* broker.read(sourceThreadId, sourceRunId, input)).toEqual(result);
        expect(yield* broker.readReference(sourceThreadId, sourceRunId, input)).toEqual(result);
        expect(forwarded).toEqual([input, input]);
      }),
    ),
  );

  it.effect(
    "returns recovery failures before dispatch when authority or a connected owner is absent",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeHarness;
          const exact = { threadId, environmentId, via: "client" as const };
          expect(yield* h.broker.readReference(sourceThreadId, undefined, exact)).toMatchObject(
            referenceReadFailure("noGrant", true),
          );
          expect(
            yield* h.broker.readReference(ThreadId.make("unbound"), RunId.make("missing"), exact),
          ).toMatchObject(referenceReadFailure("noGrant", true));
          expect(yield* h.broker.readReference(sourceThreadId, sourceRunId, exact)).toMatchObject(
            referenceReadFailure("disconnected", true),
          );
        }),
      ),
  );

  it.effect.each([
    { denialReason: "revoked" as const, diagnostic: "revoked" as const },
    { denialReason: "expired" as const, diagnostic: "revoked" as const },
    { denialReason: "reauth-required" as const, diagnostic: "reauthenticate" as const },
    { denialReason: "fence-unavailable" as const, diagnostic: "fence" as const },
  ])(
    "preserves accepted $denialReason recovery as a no-attempt failure value",
    ({ denialReason, diagnostic }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeHarness;
          const source = ThreadId.make("accepted-denied-input");
          const id = MessageId.make("accepted-denied-message");
          // This models the trusted denial intent already captured at intake; admission persists
          // it with the accepted run. An ambient connected client must not replace it.
          yield* h.start(source, id, "running", { threadId: source, inputId: id, denialReason });
          const dispatched: ThreadReadRequest[] = [];
          yield* (yield* h.broker.connect("client-session")).pipe(
            Stream.runForEach((request) =>
              Effect.sync(() => {
                dispatched.push(request);
              }),
            ),
            Effect.forkScoped,
          );
          expect(
            yield* h.broker.readReference(source, runId(id), {
              threadId,
              environmentId,
              via: "client",
            }),
          ).toMatchObject(referenceReadFailure(diagnostic, true));
          expect(dispatched).toEqual([]);
          expect(
            yield* h.broker
              .read(source, runId(id), { threadId, environmentId, via: "client" })
              .pipe(Effect.flip),
          ).toMatchObject(threadReadFailure(diagnostic));
        }),
      ),
  );

  it.effect.each(["unavailable", "unsupported"] as const)(
    "falls back only when all selected clients prove catalog-only %s",
    (reason) =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeHarness;
          const responded: string[] = [];
          const before = yield* h.store.lookupGrant(sourceThreadId, "run", sourceRunId);
          yield* TestClock.adjust("1 minute");
          for (const label of ["first-tab", "second-tab"]) {
            yield* (yield* h.broker.connect("client-session")).pipe(
              Stream.runForEach((request) => {
                responded.push(label);
                return h.broker.respond("client-session", {
                  connectionId: request.connectionId,
                  requestId: request.requestId,
                  result: null,
                  unavailableEnvironmentIds: [environmentId],
                  noDestinationAttempt: true,
                  failure: { environmentId, reason },
                });
              }),
              Effect.forkScoped,
            );
          }
          expect(
            yield* h.broker.readReference(sourceThreadId, sourceRunId, {
              threadId,
              environmentId,
              via: "client",
            }),
          ).toMatchObject(referenceReadFailure("noDestination", true));
          expect(responded.sort()).toEqual(["first-tab", "second-tab"]);
          expect(
            yield* h.broker
              .read(sourceThreadId, sourceRunId, { threadId, environmentId, via: "client" })
              .pipe(Effect.flip),
          ).toMatchObject({ code: "environment_unavailable" });
          expect(yield* h.store.lookupGrant(sourceThreadId, "run", sourceRunId)).toEqual(before);
        }),
      ),
  );

  it.effect.each([
    { label: "unknown miss", response: {}, code: "thread_not_found" },
    {
      label: "unknown unavailable",
      response: { unavailableEnvironmentIds: [environmentId] },
      code: "environment_unavailable",
    },
    {
      label: "attempted unsupported",
      response: {
        failure: { environmentId, reason: "unsupported" as const },
      },
      code: "environment_unavailable",
    },
    {
      label: "attempted unavailable",
      response: {
        failure: { environmentId, reason: "unavailable" as const },
      },
      code: "environment_unavailable",
    },
    {
      label: "denial",
      response: { failure: { environmentId, reason: "permission_denied" as const } },
      code: "capability_denied",
    },
  ])("fails the exact reference for catalog-only mixed with $label", ({ response, code }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        for (const part of [
          {
            unavailableEnvironmentIds: [environmentId],
            noDestinationAttempt: true as const,
            failure: { environmentId, reason: "unavailable" as const },
          },
          response,
        ]) {
          yield* (yield* h.broker.connect("client-session")).pipe(
            Stream.runForEach((request) =>
              h.broker.respond("client-session", {
                connectionId: request.connectionId,
                requestId: request.requestId,
                result: null,
                unavailableEnvironmentIds: [],
                ...part,
              }),
            ),
            Effect.forkScoped,
          );
        }
        expect(
          yield* h.broker
            .readReference(sourceThreadId, sourceRunId, { threadId, environmentId, via: "client" })
            .pipe(Effect.flip),
        ).toMatchObject({ code });
      }),
    ),
  );

  it.effect.each([false, true])(
    "keeps denial final beside unavailable responses (denial first: %s)",
    (denialFirst) =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeHarness;
          const reasons = denialFirst
            ? (["permission_denied", "unavailable"] as const)
            : (["unavailable", "permission_denied"] as const);
          const firstResponded = yield* Deferred.make<void>();
          for (const [index, reason] of reasons.entries()) {
            yield* (yield* h.broker.connect("client-session")).pipe(
              Stream.runForEach((request) =>
                Effect.gen(function* () {
                  if (index === 1) yield* Deferred.await(firstResponded);
                  yield* h.broker.respond("client-session", {
                    connectionId: request.connectionId,
                    requestId: request.requestId,
                    result: null,
                    unavailableEnvironmentIds: reason === "unavailable" ? [environmentId] : [],
                    failure: { environmentId, reason },
                  });
                  if (index === 0) yield* Deferred.succeed(firstResponded, undefined);
                }),
              ),
              Effect.forkScoped,
            );
          }
          expect(
            yield* h.broker
              .readReference(sourceThreadId, sourceRunId, {
                threadId,
                environmentId,
                via: "client",
              })
              .pipe(Effect.flip),
          ).toMatchObject({ code: "capability_denied", threadReadReason: "permission_denied" });
        }),
      ),
  );

  it.effect("continues past a miss from another tab sharing the same client session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { answer, reader } = yield* makeHarness;
        yield* answer("client-session", null);
        yield* answer("client-session");
        expect(yield* reader(sourceThreadId)).toBe("client-session");
      }),
    ),
  );

  it.effect("releases a pending reference read when its client disconnects", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker } = yield* makeHarness;
        const connected = yield* Deferred.make<void>();
        const received = yield* Deferred.make<ThreadReadRequest>();
        const consumer = yield* Effect.scoped(
          Effect.gen(function* () {
            const stream = yield* broker.connect("client-session");
            yield* Deferred.succeed(connected, undefined);
            yield* stream.pipe(Stream.runForEach((request) => Deferred.succeed(received, request)));
          }),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(connected);
        const reading = yield* broker
          .readReference(sourceThreadId, sourceRunId, { threadId, environmentId, via: "client" })
          .pipe(Effect.flip, Effect.forkScoped);
        yield* Deferred.await(received);
        yield* Fiber.interrupt(consumer);
        expect(yield* Fiber.join(reading)).toMatchObject({ code: "environment_unavailable" });
      }),
    ),
  );

  it.effect("distinguishes an exhausted search from an unreachable destination", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { answer, reader } = yield* makeHarness;
        let unavailableEnvironmentIds: EnvironmentId[] = [];
        yield* answer("client-session", null, () => unavailableEnvironmentIds);
        expect(yield* reader(sourceThreadId)).toBe("thread_not_found");
        unavailableEnvironmentIds = [environmentId];
        expect(yield* reader(sourceThreadId)).toBe("environment_unavailable");
      }),
    ),
  );

  it.effect("rejects unrelated sessions and mismatched results", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker } = yield* makeHarness;
        const received = yield* Deferred.make<ThreadReadRequest>();
        yield* (yield* broker.connect("client-session")).pipe(
          Stream.runForEach((request) => Deferred.succeed(received, request)),
          Effect.forkScoped,
        );
        const reading = yield* broker
          .read(sourceThreadId, sourceRunId, { threadId, environmentId })
          .pipe(Effect.forkScoped);
        const request = yield* Deferred.await(received);
        expect(
          yield* respondTo(broker, "unrelated-session", request).pipe(Effect.flip),
        ).toMatchObject({ code: "capability_denied" });
        const wrongEnvironment = {
          ...result,
          thread: { ...result.thread, environmentId: EnvironmentId.make("wrong-environment") },
        };
        expect(
          yield* respondTo(broker, "client-session", request, wrongEnvironment).pipe(Effect.flip),
        ).toMatchObject({ code: "invalid_request" });
        expect(
          yield* broker
            .respond("client-session", {
              connectionId: request.connectionId,
              requestId: request.requestId,
              result: null,
              unavailableEnvironmentIds: [],
              failure: {
                environmentId: wrongEnvironment.thread.environmentId,
                reason: "permission_denied",
              },
            })
            .pipe(Effect.flip),
        ).toMatchObject({ code: "invalid_request" });
        for (const invalid of [
          { result, noDestinationAttempt: true as const },
          {
            result: null,
            noDestinationAttempt: true as const,
            failure: { environmentId, reason: "permission_denied" as const },
          },
          {
            result: {
              ...result,
              thread: { ...result.thread, threadId: ThreadId.make("wrong-thread") },
            },
          },
        ]) {
          expect(
            yield* broker
              .respond("client-session", {
                connectionId: request.connectionId,
                requestId: request.requestId,
                unavailableEnvironmentIds: [],
                ...invalid,
              })
              .pipe(Effect.flip),
          ).toMatchObject({ code: "invalid_request" });
        }
        yield* respondTo(broker, "client-session", request);
        expect(yield* Fiber.join(reading)).toEqual(result);
      }),
    ),
  );

  it.effect("preserves revocation on the exact client route without changing authority", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker } = yield* makeHarness;
        yield* (yield* broker.connect("client-session")).pipe(
          Stream.runForEach((request) =>
            broker.respond("client-session", {
              connectionId: request.connectionId,
              requestId: request.requestId,
              result: null,
              unavailableEnvironmentIds: [environmentId],
            }),
          ),
          Effect.forkScoped,
        );
        yield* (yield* broker.connect("client-session")).pipe(
          Stream.runForEach((request) =>
            broker.respond("client-session", {
              connectionId: request.connectionId,
              requestId: request.requestId,
              result: null,
              unavailableEnvironmentIds: [],
              failure: { environmentId, reason: "permission_denied" },
            }),
          ),
          Effect.forkScoped,
        );
        expect(
          yield* broker
            .read(sourceThreadId, sourceRunId, {
              threadId,
              environmentId,
              via: "client",
            })
            .pipe(Effect.flip),
        ).toMatchObject({
          code: "capability_denied",
          threadReadReason: "permission_denied",
        });
      }),
    ),
  );

  it.effect("bounds an unanswered read and discards a late response", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker } = yield* makeHarness;
        const received = yield* Deferred.make<ThreadReadRequest>();
        yield* (yield* broker.connect("client-session")).pipe(
          Stream.runForEach((request) => Deferred.succeed(received, request)),
          Effect.forkScoped,
        );
        const reading = yield* broker
          .readReference(sourceThreadId, sourceRunId, { threadId, environmentId, via: "client" })
          .pipe(Effect.flip, Effect.forkScoped);
        const request = yield* Deferred.await(received);
        yield* TestClock.adjust("15 seconds");
        expect(yield* Fiber.join(reading)).toMatchObject({ code: "environment_unavailable" });
        yield* respondTo(broker, "client-session", request);

        const denied = yield* Deferred.make<void>();
        yield* (yield* broker.connect("client-session")).pipe(
          Stream.runForEach((next) =>
            broker
              .respond("client-session", {
                connectionId: next.connectionId,
                requestId: next.requestId,
                result: null,
                unavailableEnvironmentIds: [],
                failure: { environmentId, reason: "permission_denied" },
              })
              .pipe(Effect.andThen(Deferred.succeed(denied, undefined))),
          ),
          Effect.forkScoped,
        );
        const revoked = yield* broker
          .readReference(sourceThreadId, sourceRunId, {
            threadId,
            environmentId,
            via: "client",
          })
          .pipe(Effect.flip, Effect.forkScoped);
        yield* Deferred.await(denied);
        yield* TestClock.adjust("15 seconds");
        expect(yield* Fiber.join(revoked)).toMatchObject({
          code: "capability_denied",
          threadReadReason: "permission_denied",
        });
      }),
    ),
  );
});
