import {
  OrchestratorMcpFailure,
  type MessageId,
  type RunId,
  type ThreadId,
  type OrchestratorMcpThreadReadInput,
  type OrchestratorMcpThreadReadResult,
  type ThreadReadRequest,
  type ThreadReadResponse,
  type ThreadReadFailureReason,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { OrchestratorV2Error } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import {
  ThreadReadAuthorization,
  referencedThreads,
} from "../orchestration-v2/ThreadReadAuthorization.ts";

type Authorization = Context.Service.Shape<typeof ThreadReadAuthorization>;

/**
 * Forwards thread reads that miss locally to the authenticated client that started the calling
 * run. Clients retain their own destination credentials; this server only relays.
 */
export class ThreadReadBroker extends Context.Service<
  ThreadReadBroker,
  {
    /** Binds each new input to the client session that submitted it. */
    readonly forSession: (sessionId: string) => Authorization;
    /**
     * Binds each new input to the session that authorized the caller's captured run. Callers pass
     * the run they already loaded, so a later run on the source never lends its authority.
     */
    readonly inherit: (
      sourceThreadId: ThreadId,
      sourceRunId: RunId | undefined,
    ) => Effect.Effect<Authorization>;
    readonly connect: (
      sessionId: string,
    ) => Effect.Effect<Stream.Stream<ThreadReadRequest>, never, Scope.Scope>;
    readonly respond: (
      sessionId: string,
      response: ThreadReadResponse,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    /** Reads through the clients of the session that authorized the caller's captured run. */
    readonly read: (
      sourceThreadId: ThreadId,
      sourceRunId: RunId | undefined,
      input: OrchestratorMcpThreadReadInput,
    ) => Effect.Effect<OrchestratorMcpThreadReadResult, OrchestratorMcpFailure>;
  }
>()("t3/mcp/ThreadReadBroker") {}

const unavailable = () =>
  new OrchestratorMcpFailure({
    code: "environment_unavailable",
    threadReadReason: "unavailable",
    message:
      "The authorized client could not check the thread; this does not mean it is missing. For an attached reference or exact-source read, report this and ask the user to reconnect that client or send a new message from it if client access expired; do not switch routes. For ID-only discovery, continue through already-authorized discovery routes. Never bypass a permission refusal.",
  });

const bindingIdleMillis = 7 * 24 * 60 * 60 * 1000;
const maxBindings = 10_000;

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const threads = yield* ThreadManagementService.ThreadManagementService;

  // Map order follows valid use, so idle expiry and capacity eviction both remove the least
  // recently used binding without extending rejected claims.
  const bindings = new Map<string, { sessionId: string; lastUsedAt: number }>();
  const bindingKey = (threadId: ThreadId, messageId: MessageId) =>
    JSON.stringify([threadId, messageId]);
  const pruneBindings = Effect.map(Clock.currentTimeMillis, (now) => {
    for (const [key, entry] of bindings) {
      if (now - entry.lastUsedAt < bindingIdleMillis) break;
      bindings.delete(key);
    }
    return now;
  });

  const bind = Effect.fn("ThreadReadBroker.bind")(
    function* (threadId: ThreadId, messageId: MessageId, sessionId: string) {
      const { runs, runtimeRequests, messages } = yield* threads.getThreadRecords(
        threadId,
        ["runs", "runtimeRequests", "messages"],
        { messageRoles: ["user"] },
      );
      const now = yield* pruneBindings;
      const key = bindingKey(threadId, messageId);
      // A replay cannot claim an existing execution, including after eviction,
      // or replace its original requester while the binding remains present.
      if (
        runs.some((run) => run.userMessageId === messageId) ||
        runtimeRequests.some(
          (request) => request.threadReadContext?.authorizationId === messageId,
        ) ||
        messages.some((message) => message.threadReadContext?.authorizationId === messageId) ||
        bindings.has(key)
      )
        return;
      if (bindings.size >= maxBindings) {
        const oldest = bindings.keys().next().value;
        if (oldest !== undefined) bindings.delete(oldest);
      }
      bindings.set(key, { sessionId, lastUsedAt: now });
    },
    // Failure to inspect the target denies remote routing without preventing its turn.
    Effect.ignore(),
  );

  const forSession: ThreadReadBroker["Service"]["forSession"] = (sessionId) => ({
    authorize: (threadId, messageId) => bind(threadId, messageId, sessionId),
  });

  const bindingSession = Effect.fn("ThreadReadBroker.bindingSession")(function* (
    threadId: ThreadId,
    messageId: MessageId,
  ) {
    const now = yield* pruneBindings;
    const key = bindingKey(threadId, messageId);
    const entry = bindings.get(key);
    if (entry === undefined) return undefined;
    bindings.delete(key);
    bindings.set(key, { ...entry, lastUsedAt: now });
    return entry.sessionId;
  });

  // A matched but expired answer grant must never fall back to the run's original client.
  const referenceSession = Effect.fn("ThreadReadBroker.referenceSession")(function* (
    threadId: ThreadId,
    runId: RunId,
    input: OrchestratorMcpThreadReadInput,
    visited: Set<RunId>,
    before?: number,
  ): Effect.fn.Return<{ sessionId: string | undefined } | undefined, OrchestratorV2Error> {
    if (input.environmentId === undefined) return undefined;
    if (visited.has(runId)) return { sessionId: undefined };
    visited.add(runId);
    const source = yield* threads.getThreadRecords(threadId, [
      "runs",
      "runtimeRequests",
      "nodes",
      "contextTransfers",
    ]);
    const run = source.runs.find((candidate) => candidate.id === runId);
    if (run === undefined) return undefined;
    const nodeIds = new Set(
      source.nodes.filter((node) => node.runId === runId).map((node) => node.id),
    );
    const request = source.runtimeRequests
      .filter(
        (request) =>
          request.kind === "user_input" &&
          request.status === "resolved" &&
          request.resolvedAt !== null &&
          (before === undefined || DateTime.toEpochMillis(request.resolvedAt) < before) &&
          (nodeIds.has(request.nodeId) ||
            (request.responseCapability.type === "message" &&
              run.userMessageId === `async-answer:${request.id}`)) &&
          request.threadReadContext?.records.some(
            (record) =>
              record.environmentId === input.environmentId && record.threadId === input.threadId,
          ),
      )
      .sort(
        (a, b) =>
          DateTime.toEpochMillis(b.resolvedAt!) - DateTime.toEpochMillis(a.resolvedAt!) ||
          b.id.localeCompare(a.id),
      )[0];
    if (request?.threadReadContext !== undefined) {
      return {
        sessionId: yield* bindingSession(threadId, request.threadReadContext.authorizationId),
      };
    }
    const { messages } = yield* threads.getThreadRecords(threadId, ["messages"], {
      messageIds: [run.userMessageId],
      messageRoles: ["user"],
    });
    const editedMessage = messages.find((message) => message.id === run.userMessageId);
    const editedContext = editedMessage?.threadReadContext;
    if (
      editedMessage !== undefined &&
      editedContext !== undefined &&
      (before === undefined || editedContext.capturedAt < before) &&
      referencedThreads(editedMessage.text, editedMessage.context).some(
        (record) =>
          record.environmentId === input.environmentId && record.threadId === input.threadId,
      )
    ) {
      return { sessionId: yield* bindingSession(threadId, editedContext.authorizationId) };
    }
    const spawn = source.contextTransfers.find(
      (transfer) => transfer.type === "subagent_spawn" && transfer.targetRunId === runId,
    );
    if (spawn?.sourcePoint.runId === undefined) return undefined;
    // Equal timestamps cannot establish that an answer preceded this captured spawn.
    const cutoff = DateTime.toEpochMillis(spawn.createdAt);
    return yield* referenceSession(
      spawn.sourceThreadId,
      spawn.sourcePoint.runId,
      input,
      visited,
      before === undefined ? cutoff : Math.min(before, cutoff),
    );
  });

  /** A delegated run inherits the exact run that spawned it, even after its parent moves on. */
  const runSession = Effect.fn("ThreadReadBroker.runSession")(function* (
    threadId: ThreadId,
    runId: RunId,
    visited: Set<RunId>,
  ): Effect.fn.Return<string | undefined, OrchestratorV2Error> {
    if (visited.has(runId)) return undefined;
    visited.add(runId);
    const source = yield* threads.getThreadRecords(threadId, ["runs", "contextTransfers"]);
    const run = source.runs.find((candidate) => candidate.id === runId);
    if (run === undefined) return undefined;
    const sessionId = yield* bindingSession(threadId, run.userMessageId);
    if (sessionId !== undefined) return sessionId;
    const spawn = source.contextTransfers.find(
      (transfer) => transfer.type === "subagent_spawn" && transfer.targetRunId === run.id,
    );
    if (spawn?.sourcePoint.runId === undefined) return undefined;
    return yield* runSession(spawn.sourceThreadId, spawn.sourcePoint.runId, visited);
  });
  // Without a captured run there is no authority to inherit.
  const sourceSession = (threadId: ThreadId, runId: RunId | undefined) =>
    runId === undefined
      ? Effect.void
      : runSession(threadId, runId, new Set()).pipe(Effect.orElseSucceed(() => undefined));

  const inherit: ThreadReadBroker["Service"]["inherit"] = (sourceThreadId, sourceRunId) =>
    Effect.map(sourceSession(sourceThreadId, sourceRunId), (sessionId) =>
      sessionId === undefined ? ThreadReadAuthorization.defaultValue() : forSession(sessionId),
    );

  const clients = new Map<
    string,
    { sessionId: string; queue: Queue.Queue<ThreadReadRequest, Cause.Done> }
  >();
  const pending = new Map<
    string,
    {
      input: OrchestratorMcpThreadReadInput;
      clients: Set<string>;
      incomplete: boolean;
      failure?: ThreadReadFailureReason;
      result: Deferred.Deferred<OrchestratorMcpThreadReadResult, OrchestratorMcpFailure>;
    }
  >();

  const finishMiss = Effect.fn("ThreadReadBroker.finishMiss")(function* (
    requestId: string,
    expired = false,
  ) {
    const entry = pending.get(requestId);
    if (entry === undefined || (!expired && entry.clients.size > 0)) return;
    yield* Deferred.fail(
      entry.result,
      entry.failure !== "permission_denied" &&
        (expired || entry.incomplete || entry.failure === "unavailable")
        ? unavailable()
        : entry.failure !== undefined
          ? new OrchestratorMcpFailure({
              code: entry.failure === "permission_denied" ? "capability_denied" : "invalid_request",
              threadReadReason: entry.failure,
              message:
                entry.failure === "permission_denied"
                  ? "The source connection does not permit reading this thread. Report this to the user; do not use another route."
                  : "The source environment needs a server update to read this thread reference. Report this to the user; do not use another route.",
            })
          : new OrchestratorMcpFailure({
              code: "thread_not_found",
              message: `Thread ${entry.input.threadId} was not found in this environment or the client's other connected environments.`,
            }),
    );
  });

  const connect: ThreadReadBroker["Service"]["connect"] = Effect.fn("ThreadReadBroker.connect")(
    function* (sessionId) {
      const queue = yield* Queue.unbounded<ThreadReadRequest, Cause.Done>();
      const key = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      clients.set(key, { sessionId, queue });
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          clients.delete(key);
          for (const [requestId, entry] of pending) {
            if (!entry.clients.delete(key)) continue;
            entry.incomplete = true;
            yield* finishMiss(requestId);
          }
          yield* Queue.end(queue);
        }),
      );
      return Stream.fromQueue(queue);
    },
  );

  const respond: ThreadReadBroker["Service"]["respond"] = Effect.fn("ThreadReadBroker.respond")(
    function* (sessionId, response) {
      const entry = pending.get(response.requestId);
      // A response can arrive after a completed read or cancellation.
      if (entry === undefined) return;
      if (
        !entry.clients.has(response.connectionId) ||
        clients.get(response.connectionId)?.sessionId !== sessionId
      ) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "This client does not own the thread read request.",
        });
      }
      if (
        response.failure !== undefined &&
        (entry.input.environmentId !== response.failure.environmentId || response.result !== null)
      ) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The failure does not match the requested thread environment.",
        });
      }
      if (response.result !== null) {
        if (
          response.result.thread.threadId !== entry.input.threadId ||
          (entry.input.environmentId !== undefined &&
            response.result.thread.environmentId !== entry.input.environmentId)
        ) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "The thread read response does not match the requested thread and environment.",
          });
        }
        yield* Deferred.succeed(entry.result, { ...response.result, readVia: "client" });
        return;
      }
      entry.clients.delete(response.connectionId);
      entry.incomplete ||= response.unavailableEnvironmentIds.length > 0;
      if (response.failure !== undefined) {
        const reason = response.failure.reason;
        if (reason === "unavailable") entry.incomplete = true;
        if (entry.failure === undefined || reason === "permission_denied") entry.failure = reason;
      }
      yield* finishMiss(response.requestId);
    },
  );

  const read: ThreadReadBroker["Service"]["read"] = Effect.fn("ThreadReadBroker.read")(
    function* (sourceThreadId, sourceRunId, input) {
      const reference =
        sourceRunId === undefined
          ? undefined
          : yield* referenceSession(sourceThreadId, sourceRunId, input, new Set()).pipe(
              Effect.orElseSucceed(() => ({ sessionId: undefined })),
            );
      const sessionId =
        reference === undefined
          ? yield* sourceSession(sourceThreadId, sourceRunId)
          : reference.sessionId;
      if (sessionId === undefined) {
        if (reference !== undefined) return yield* unavailable();
        return yield* new OrchestratorMcpFailure({
          code: "environment_unavailable",
          threadReadReason: "unavailable",
          message:
            "This run has no connected client authorized to read other environments. Send a new message from the client connected to those environments and retry.",
        });
      }
      const targets = [...clients].filter(([, client]) => client.sessionId === sessionId);
      if (targets.length === 0) return yield* unavailable();
      const requestId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const result = yield* Deferred.make<
        OrchestratorMcpThreadReadResult,
        OrchestratorMcpFailure
      >();
      pending.set(requestId, {
        input,
        result,
        clients: new Set(targets.map(([key]) => key)),
        incomplete: false,
      });
      return yield* Effect.gen(function* () {
        for (const [connectionId, client] of targets)
          yield* Queue.offer(client.queue, { connectionId, requestId, input });
        return yield* Deferred.await(result).pipe(
          Effect.timeoutOrElse({
            duration: "15 seconds",
            orElse: () => finishMiss(requestId, true).pipe(Effect.andThen(Deferred.await(result))),
          }),
        );
      }).pipe(Effect.ensuring(Effect.sync(() => pending.delete(requestId))));
    },
  );

  return ThreadReadBroker.of({ forSession, inherit, connect, respond, read });
});

export const layer = Layer.effect(ThreadReadBroker, make);
