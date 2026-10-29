import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ComposerContextId,
  MessageId,
  NodeId,
  RuntimeRequestId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
  type OrchestratorMcpThreadReadInput,
  type OrchestratorMcpThreadReadResult,
  type ThreadReadRequest,
  type OrchestrationMessageContext,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadReadBroker from "./ThreadReadBroker.ts";

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

type Run = { id: RunId; userMessageId: MessageId; status: string; ordinal: number };
type Spawn = {
  type: "subagent_spawn";
  createdAt?: DateTime.Utc;
  targetRunId: RunId;
  sourceThreadId: ThreadId;
  sourcePoint: { threadId: ThreadId; runId: RunId };
};

const runId = (messageId: MessageId) => RunId.make(`run-${messageId}`);
const sourceRunId = runId(MessageId.make("source-message"));

/** A broker over in-memory thread records, with `source-thread` running for `client-session`. */
const makeHarness = Effect.gen(function* () {
  const runs = new Map<ThreadId, Array<Run>>();
  const transfers = new Map<ThreadId, Array<Spawn>>();
  const requests = new Map<ThreadId, OrchestrationV2ThreadProjection["runtimeRequests"]>();
  const nodes = new Map<ThreadId, Array<{ id: string; runId: RunId }>>();
  const messages = new Map<
    ThreadId,
    Array<{
      id: MessageId;
      text: string;
      runId?: RunId;
      context?: OrchestrationMessageContext;
      threadReadContext?: {
        authorizationId: MessageId;
        capturedAt: number;
      };
    }>
  >();
  const broker = yield* ThreadReadBroker.ThreadReadBroker.pipe(
    Effect.provide(
      ThreadReadBroker.layer.pipe(
        Layer.provide(NodeCrypto.layer),
        Layer.provide(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: (id) =>
              Effect.sync(
                () =>
                  ({
                    thread: { id },
                    runs: runs.get(id) ?? [],
                    contextTransfers: transfers.get(id) ?? [],
                    runtimeRequests: requests.get(id) ?? [],
                    nodes: nodes.get(id) ?? [],
                    messages: messages.get(id) ?? [],
                  }) as unknown as OrchestrationV2ThreadProjection,
              ),
          }),
        ),
      ),
    ),
  );
  /** Commits an input's run; earlier runs in the thread finish. */
  const start = (thread: ThreadId, messageId: MessageId, status = "running") => {
    const existing = runs.get(thread) ?? [];
    if (status === "running") for (const run of existing) run.status = "completed";
    existing.push({
      id: runId(messageId),
      userMessageId: messageId,
      status,
      ordinal: existing.length + 1,
    });
    runs.set(thread, existing);
  };
  /** A client submits an input: bind it, then commit its run. */
  const send = (sessionId: string, thread: ThreadId, messageId: MessageId, status = "running") =>
    broker
      .forSession(sessionId)
      .authorize(thread, messageId)
      .pipe(Effect.andThen(Effect.sync(() => start(thread, messageId, status))));
  const answered: string[] = [];
  /** Connects a client of `sessionId` that answers every forwarded request. */
  const answer = (
    sessionId: string,
    reply:
      | OrchestratorMcpThreadReadResult
      | null
      | ((request: ThreadReadRequest) => OrchestratorMcpThreadReadResult | null) = result,
    unavailableEnvironmentIds: () => ReadonlyArray<EnvironmentId> = () => [],
  ) =>
    Effect.flatMap(broker.connect(sessionId), (requests) =>
      requests.pipe(
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
  /** The run a caller loading `thread` now would act from. */
  const callerRun = (thread: ThreadId) => {
    const loaded = { runs: runs.get(thread) ?? [] } as unknown as OrchestrationV2ThreadProjection;
    return (
      ThreadManagementService.latestActiveRun(loaded) ?? ThreadManagementService.latestRun(loaded)
    )?.id;
  };
  /** The session a read acting from `run` of `source` reached, or the failure code. */
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
  yield* send("client-session", sourceThreadId, MessageId.make("source-message"));
  return {
    broker,
    runs,
    transfers,
    requests,
    nodes,
    messages,
    start,
    send,
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
    "scopes question reference authority to the answering client across live and resumed runs",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeHarness;
          const authorizationId = MessageId.make("answer-context:answer-command");
          const requestId = RuntimeRequestId.make("question-request");
          const nodeId = NodeId.make("question-node");
          const now = yield* DateTime.now;
          yield* h.broker.forSession("answering-client").authorize(sourceThreadId, authorizationId);
          h.requests.set(sourceThreadId, [
            {
              id: requestId,
              nodeId,
              providerTurnId: null,
              nativeRequestRef: null,
              kind: "user_input",
              status: "resolved",
              responseCapability: { type: "message" },
              createdAt: now,
              resolvedAt: now,
              threadReadContext: {
                authorizationId,
                records: [
                  {
                    version: 1,
                    contextId: ComposerContextId.make("answer-reference"),
                    kind: "thread",
                    label: "Reference",
                    title: "Reference",
                    environmentId,
                    threadId,
                  },
                ],
              },
            },
          ]);
          h.nodes.set(sourceThreadId, [{ id: nodeId, runId: sourceRunId }]);
          const otherEnvironment = EnvironmentId.make("other-environment");
          yield* h.answer("client-session", (request) => ({
            ...result,
            thread: {
              ...result.thread,
              threadId: request.input.threadId,
              environmentId: request.input.environmentId ?? otherEnvironment,
            },
          }));
          yield* h.answer("answering-client");
          const exact = { threadId, environmentId, via: "client" as const };
          expect(yield* h.readFrom(sourceThreadId, sourceRunId, exact)).toBe("answering-client");
          expect(
            yield* h.readFrom(sourceThreadId, sourceRunId, {
              threadId,
              environmentId: otherEnvironment,
              via: "client",
            }),
          ).toBe("client-session");
          expect(
            yield* h.readFrom(sourceThreadId, sourceRunId, {
              threadId: ThreadId.make("unmentioned-thread"),
              environmentId,
              via: "client",
            }),
          ).toBe("client-session");
          const earlyChild = ThreadId.make("child-before-answer");
          const earlyMessage = MessageId.make("child-before-answer-message");
          h.start(earlyChild, earlyMessage);
          h.transfers.set(earlyChild, [
            {
              type: "subagent_spawn",
              createdAt: now,
              targetRunId: runId(earlyMessage),
              sourceThreadId,
              sourcePoint: { threadId: sourceThreadId, runId: sourceRunId },
            },
          ]);
          expect(yield* h.readFrom(earlyChild, runId(earlyMessage), exact)).toBe("client-session");
          yield* TestClock.adjust("1 millis");
          const lateChild = ThreadId.make("child-after-answer");
          const lateMessage = MessageId.make("child-after-answer-message");
          h.start(lateChild, lateMessage);
          h.transfers.set(lateChild, [
            {
              type: "subagent_spawn",
              createdAt: yield* DateTime.now,
              targetRunId: runId(lateMessage),
              sourceThreadId,
              sourcePoint: { threadId: sourceThreadId, runId: sourceRunId },
            },
          ]);
          expect(yield* h.readFrom(lateChild, runId(lateMessage), exact)).toBe("answering-client");
          const answerMessageId = MessageId.make(`async-answer:${requestId}`);
          h.start(sourceThreadId, answerMessageId);
          const messageRequest = h.requests.get(sourceThreadId)![0]!;
          h.requests.set(sourceThreadId, [
            {
              ...messageRequest,
              responseCapability: {
                type: "live",
                providerSessionId: ProviderSessionId.make("live-provider"),
              },
            },
          ]);
          expect(yield* h.readFrom(sourceThreadId, runId(answerMessageId), exact)).toBe(
            "environment_unavailable",
          );
          h.requests.set(sourceThreadId, [messageRequest]);
          expect(yield* h.readFrom(sourceThreadId, runId(answerMessageId), exact)).toBe(
            "answering-client",
          );
          expect(
            yield* h.readFrom(sourceThreadId, runId(answerMessageId), {
              threadId: ThreadId.make("unmentioned-thread"),
              environmentId,
              via: "client",
            }),
          ).toBe("environment_unavailable");
          yield* TestClock.adjust("6 days");
          expect(
            yield* h.readFrom(sourceThreadId, sourceRunId, {
              threadId,
              environmentId: otherEnvironment,
              via: "client",
            }),
          ).toBe("client-session");
          yield* TestClock.adjust("2 days");
          yield* h.broker.forSession("replay-client").authorize(sourceThreadId, authorizationId);
          yield* h.answer("replay-client");
          expect(yield* h.readFrom(sourceThreadId, runId(answerMessageId), exact)).toBe(
            "environment_unavailable",
          );
          expect(yield* h.readFrom(sourceThreadId, sourceRunId, exact)).toBe(
            "environment_unavailable",
          );
          expect(yield* h.readFrom(lateChild, runId(lateMessage), exact)).toBe(
            "environment_unavailable",
          );
          expect(
            yield* h.readFrom(sourceThreadId, sourceRunId, {
              threadId,
              environmentId: otherEnvironment,
              via: "client",
            }),
          ).toBe("client-session");
        }),
      ),
  );

  it.effect(
    "scopes edited queued references to their editing client without replacing run authority",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeHarness;
          const messageId = MessageId.make("edited-queue-message");
          const authorizationId = MessageId.make("queued-edit-context:edit-command");
          yield* h.send("client-session", sourceThreadId, messageId, "queued");
          yield* h.broker.forSession("editing-client").authorize(sourceThreadId, authorizationId);
          const capturedAt = DateTime.toEpochMillis(yield* DateTime.now);
          h.messages.set(sourceThreadId, [
            {
              id: messageId,
              text: "[Reference](t3-context://v1/thread/edited-reference)",
              context: {
                version: 1,
                records: [
                  {
                    version: 1,
                    contextId: ComposerContextId.make("edited-reference"),
                    kind: "thread",
                    label: "Reference",
                    title: "Reference",
                    environmentId,
                    threadId,
                  },
                ],
              },
              threadReadContext: { authorizationId, capturedAt },
            },
          ]);
          yield* h.answer("editing-client");
          yield* h.answer("client-session", (request) => ({
            ...result,
            thread: {
              ...result.thread,
              threadId: request.input.threadId,
              environmentId: request.input.environmentId ?? environmentId,
            },
          }));
          const exact = { threadId, environmentId, via: "client" as const };
          expect(yield* h.readFrom(sourceThreadId, runId(messageId), exact)).toBe("editing-client");
          const unrelated = { ...exact, threadId: ThreadId.make("unmentioned-reference") };
          expect(yield* h.readFrom(sourceThreadId, runId(messageId), unrelated)).toBe(
            "client-session",
          );
          expect(yield* h.readFrom(sourceThreadId, runId(messageId), { threadId })).toBe(
            "client-session",
          );
          const childThread = ThreadId.make("edited-queue-child");
          const childMessage = MessageId.make("edited-queue-child-message");
          h.start(childThread, childMessage);
          yield* TestClock.adjust("1 millis");
          h.transfers.set(childThread, [
            {
              type: "subagent_spawn",
              createdAt: yield* DateTime.now,
              targetRunId: runId(childMessage),
              sourceThreadId,
              sourcePoint: { threadId: sourceThreadId, runId: runId(messageId) },
            },
          ]);
          expect(yield* h.readFrom(childThread, runId(childMessage), exact)).toBe("editing-client");
          yield* TestClock.adjust("6 days");
          expect(yield* h.readFrom(sourceThreadId, runId(messageId), unrelated)).toBe(
            "client-session",
          );
          yield* TestClock.adjust("2 days");
          yield* h.broker.forSession("replay-client").authorize(sourceThreadId, authorizationId);
          yield* h.answer("replay-client");
          expect(yield* h.readFrom(sourceThreadId, runId(messageId), exact)).toBe(
            "environment_unavailable",
          );
          expect(yield* h.readFrom(childThread, runId(childMessage), exact)).toBe(
            "environment_unavailable",
          );
          h.messages.set(sourceThreadId, [{ id: messageId, text: "Reference removed" }]);
          expect(yield* h.readFrom(sourceThreadId, runId(messageId), exact)).toBe("client-session");
        }),
      ),
  );

  it.effect("uses the sending client for exact references steered into an existing run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        const priorAuthorization = MessageId.make("answer-context:prior-question");
        const questionNode = NodeId.make("prior-question-node");
        const priorQuestion = {
          id: RuntimeRequestId.make("prior-question"),
          nodeId: questionNode,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input" as const,
          status: "resolved" as const,
          responseCapability: { type: "message" as const },
          createdAt: yield* DateTime.now,
          resolvedAt: yield* DateTime.now,
          threadReadContext: {
            authorizationId: priorAuthorization,
            records: [
              {
                version: 1 as const,
                contextId: ComposerContextId.make("question-reference"),
                kind: "thread" as const,
                title: "Reference",
                label: "Reference",
                environmentId,
                threadId,
              },
            ],
          },
        };
        yield* h.broker
          .forSession("answering-client")
          .authorize(sourceThreadId, priorAuthorization);
        h.requests.set(sourceThreadId, [priorQuestion]);
        h.nodes.set(sourceThreadId, [{ id: questionNode, runId: sourceRunId }]);
        yield* h.answer("answering-client");
        yield* TestClock.adjust("1 millis");
        const messageId = MessageId.make("steered-reference-message");
        yield* h.broker.forSession("steering-client").authorize(sourceThreadId, messageId);
        h.messages.set(sourceThreadId, [
          {
            id: messageId,
            runId: sourceRunId,
            text: "[Reference](t3-context://v1/thread/steered-reference)",
            context: {
              version: 1,
              records: [
                {
                  version: 1,
                  contextId: ComposerContextId.make("steered-reference"),
                  kind: "thread",
                  label: "Reference",
                  title: "Reference",
                  environmentId,
                  threadId,
                },
              ],
            },
            threadReadContext: {
              authorizationId: messageId,
              capturedAt: DateTime.toEpochMillis(yield* DateTime.now),
            },
          },
        ]);
        yield* h.answer("steering-client");
        yield* h.answer("client-session", (request) => ({
          ...result,
          thread: {
            ...result.thread,
            threadId: request.input.threadId,
            environmentId: request.input.environmentId ?? environmentId,
          },
        }));
        expect(
          yield* h.readFrom(sourceThreadId, sourceRunId, {
            threadId,
            environmentId,
            via: "client",
          }),
        ).toBe("steering-client");
        expect(
          yield* h.readFrom(sourceThreadId, sourceRunId, {
            threadId: ThreadId.make("unmentioned"),
            environmentId,
            via: "client",
          }),
        ).toBe("client-session");
        expect(yield* h.readFrom(sourceThreadId, sourceRunId, { threadId })).toBe("client-session");
        yield* TestClock.adjust("1 millis");
        h.requests.set(sourceThreadId, [{ ...priorQuestion, resolvedAt: yield* DateTime.now }]);
        expect(
          yield* h.readFrom(sourceThreadId, sourceRunId, {
            threadId,
            environmentId,
            via: "client",
          }),
        ).toBe("answering-client");
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
        yield* (yield* broker.inherit(sourceThreadId, captured)).authorize(
          launchedThreadId,
          launched,
        );
        start(launchedThreadId, launched);
        expect(yield* reader(launchedThreadId)).toBe("client-session");
        // Without a captured run there is no authority, even while the source is running.
        expect(yield* readFrom(sourceThreadId, undefined)).toBe("environment_unavailable");
        const unbound = MessageId.make("unbound-message");
        yield* (yield* broker.inherit(sourceThreadId, undefined)).authorize(
          launchedThreadId,
          unbound,
        );
        start(launchedThreadId, unbound);
        expect(yield* reader(launchedThreadId)).toBe("environment_unavailable");
      }),
    ),
  );

  it.effect("refuses replay claims and preserves the original input's authority", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, start, answer, reader } = yield* makeHarness;
        yield* broker
          .forSession("other-session")
          .authorize(sourceThreadId, MessageId.make("source-message"));
        const replayedThreadId = ThreadId.make("replayed-thread");
        const replayed = MessageId.make("existing-unassociated-message");
        start(replayedThreadId, replayed);
        yield* broker.forSession("other-session").authorize(replayedThreadId, replayed);
        yield* answer("client-session");
        yield* answer("other-session");
        expect(yield* reader(sourceThreadId)).toBe("client-session");
        expect(yield* reader(replayedThreadId)).toBe("environment_unavailable");
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
          const { broker, answer, reader } = yield* makeHarness;
          const replay = broker.forSession("other-session");
          yield* TestClock.adjust("6 days");
          yield* replay.authorize(sourceThreadId, MessageId.make("source-message"));
          yield* TestClock.adjust("1 day");
          yield* replay.authorize(sourceThreadId, MessageId.make("source-message"));
          yield* answer("other-session");
          expect(yield* reader(sourceThreadId)).toBe("environment_unavailable");
        }),
      ),
  );

  it.effect("evicts the least recently used binding at capacity and rejects its replay", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, start, send, answer, reader } = yield* makeHarness;
        const other = broker.forSession("other-session");
        for (let index = 0; index < 9_999; index++) {
          yield* other.authorize(
            ThreadId.make(`capacity-thread-${index}`),
            MessageId.make(`capacity-message-${index}`),
          );
        }
        yield* answer("client-session");
        yield* answer("other-session");
        expect(yield* reader(sourceThreadId)).toBe("client-session");
        const newestThreadId = ThreadId.make("newest-thread");
        yield* send("other-session", newestThreadId, MessageId.make("newest-message"));
        const evictedThreadId = ThreadId.make("capacity-thread-0");
        const evicted = MessageId.make("capacity-message-0");
        start(evictedThreadId, evicted);
        expect(yield* reader(evictedThreadId)).toBe("environment_unavailable");
        expect(yield* reader(sourceThreadId)).toBe("client-session");
        expect(yield* reader(newestThreadId)).toBe("other-session");
        yield* broker.forSession("client-session").authorize(evictedThreadId, evicted);
        expect(yield* reader(evictedThreadId)).toBe("environment_unavailable");
      }),
    ),
  );

  it.effect(
    "inherits the exact delegated parent run and fails closed for absent or cyclic ancestry",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { broker, start, send, answer, callerRun, reader, transfers } = yield* makeHarness;
          const spawned = (child: ThreadId, parent: ThreadId, parentRunId: RunId) => {
            const message = MessageId.make(`${child}-message`);
            start(child, message);
            transfers.set(child, [
              {
                type: "subagent_spawn",
                targetRunId: runId(message),
                sourceThreadId: parent,
                sourcePoint: { threadId: parent, runId: parentRunId },
              },
            ]);
          };
          const childThreadId = ThreadId.make("delegated-child");
          spawned(childThreadId, sourceThreadId, runId(MessageId.make("source-message")));
          // The parent's next run belongs to another client.
          yield* send("other-session", sourceThreadId, MessageId.make("later-message"));
          yield* answer("client-session");
          yield* answer("other-session");
          expect(yield* reader(childThreadId)).toBe("client-session");

          // Threads launched by the child inherit the same requester.
          const launchedThreadId = ThreadId.make("launched-thread");
          const launched = MessageId.make("launched-message");
          yield* (yield* broker.inherit(childThreadId, callerRun(childThreadId))).authorize(
            launchedThreadId,
            launched,
          );
          start(launchedThreadId, launched);
          expect(yield* reader(launchedThreadId)).toBe("client-session");

          const orphanThreadId = ThreadId.make("orphan-child");
          spawned(orphanThreadId, sourceThreadId, RunId.make("missing-run"));
          expect(yield* reader(orphanThreadId)).toBe("environment_unavailable");
          const cyclicThreadId = ThreadId.make("cyclic-child");
          spawned(cyclicThreadId, cyclicThreadId, runId(MessageId.make("cyclic-child-message")));
          expect(yield* reader(cyclicThreadId)).toBe("environment_unavailable");
        }),
      ),
  );

  it.effect("reports unavailable routing instead of falsely claiming the thread is missing", () =>
    Effect.gen(function* () {
      const { reader } = yield* makeHarness;
      for (const source of [sourceThreadId, ThreadId.make("unbound-thread")]) {
        expect(yield* reader(source)).toBe("environment_unavailable");
      }
    }),
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
        expect(forwarded).toEqual([input]);
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

  it.effect("releases a pending read when its client disconnects", () =>
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
          .read(sourceThreadId, sourceRunId, { threadId })
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
          .read(sourceThreadId, sourceRunId, { threadId })
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
          .read(sourceThreadId, sourceRunId, {
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
