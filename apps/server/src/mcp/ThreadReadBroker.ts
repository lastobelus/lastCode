import {
  OrchestratorMcpFailure,
  type MessageId,
  type RunId,
  type ThreadId,
  type OrchestratorMcpThreadReadInput,
  type OrchestratorMcpThreadReadResult,
  type ThreadReadRequest,
  type ThreadReadResponse,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { OrchestratorV2Error } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { ThreadReadAuthorization } from "../orchestration-v2/ThreadReadAuthorization.ts";

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
    /** Binds each new input to the session that authorized the source thread's current run. */
    readonly inherit: (sourceThreadId: ThreadId) => Effect.Effect<Authorization>;
    readonly connect: (
      sessionId: string,
    ) => Effect.Effect<Stream.Stream<ThreadReadRequest>, never, Scope.Scope>;
    readonly respond: (
      sessionId: string,
      response: ThreadReadResponse,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    /** Reads through the clients of the session that authorized the source thread's current run. */
    readonly read: (
      sourceThreadId: ThreadId,
      input: OrchestratorMcpThreadReadInput,
    ) => Effect.Effect<OrchestratorMcpThreadReadResult, OrchestratorMcpFailure>;
  }
>()("t3/mcp/ThreadReadBroker") {}

const unavailable = () =>
  new OrchestratorMcpFailure({
    code: "environment_unavailable",
    message:
      "The local thread was not found, and the other environments could not all be checked. Keep a T3 client connected to the environments and retry; this does not mean the thread is missing.",
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

  const bind = (threadId: ThreadId, messageId: MessageId, sessionId: string) =>
    Effect.gen(function* () {
      const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
      const now = yield* pruneBindings;
      const key = bindingKey(threadId, messageId);
      // A replay cannot claim an existing execution, including after eviction,
      // or replace its original requester while the binding remains present.
      if (runs.some((run) => run.userMessageId === messageId) || bindings.has(key)) return;
      if (bindings.size >= maxBindings) {
        const oldest = bindings.keys().next().value;
        if (oldest !== undefined) bindings.delete(oldest);
      }
      bindings.set(key, { sessionId, lastUsedAt: now });
    }).pipe(
      // Failure to inspect the target denies remote routing without preventing its turn.
      Effect.catch(() => Effect.void),
    );

  const forSession: ThreadReadBroker["Service"]["forSession"] = (sessionId) => ({
    authorize: (threadId, messageId) => bind(threadId, messageId, sessionId),
  });

  /** A delegated run inherits the exact run that spawned it, even after its parent moves on. */
  const runSession = (
    threadId: ThreadId,
    runId: RunId | undefined,
    visited: Set<RunId>,
  ): Effect.Effect<string | undefined, OrchestratorV2Error> =>
    Effect.gen(function* () {
      const source = yield* threads.getThreadRecords(threadId, ["runs", "contextTransfers"]);
      const run =
        runId === undefined
          ? (ThreadManagementService.latestActiveRun(source) ??
            ThreadManagementService.latestRun(source))
          : source.runs.find((candidate) => candidate.id === runId);
      if (run === undefined || visited.has(run.id)) return undefined;
      visited.add(run.id);
      const now = yield* pruneBindings;
      const key = bindingKey(threadId, run.userMessageId);
      const entry = bindings.get(key);
      if (entry !== undefined) {
        bindings.delete(key);
        bindings.set(key, { ...entry, lastUsedAt: now });
        return entry.sessionId;
      }
      const spawn = source.contextTransfers.find(
        (transfer) => transfer.type === "subagent_spawn" && transfer.targetRunId === run.id,
      );
      if (spawn?.sourcePoint.runId === undefined) return undefined;
      return yield* runSession(spawn.sourceThreadId, spawn.sourcePoint.runId, visited);
    });
  const currentSession = (threadId: ThreadId) =>
    runSession(threadId, undefined, new Set()).pipe(Effect.orElseSucceed(() => undefined));

  const inherit: ThreadReadBroker["Service"]["inherit"] = (sourceThreadId) =>
    Effect.map(currentSession(sourceThreadId), (sessionId) =>
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
      result: Deferred.Deferred<OrchestratorMcpThreadReadResult, OrchestratorMcpFailure>;
    }
  >();

  const finishMiss = (requestId: string) =>
    Effect.gen(function* () {
      const entry = pending.get(requestId);
      if (entry === undefined || entry.clients.size > 0) return;
      yield* Deferred.fail(
        entry.result,
        entry.incomplete
          ? unavailable()
          : new OrchestratorMcpFailure({
              code: "thread_not_found",
              message: `Thread ${entry.input.threadId} was not found in this environment or the client's other connected environments.`,
            }),
      );
    });

  const connect: ThreadReadBroker["Service"]["connect"] = (sessionId) =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<ThreadReadRequest, Cause.Done>();
      const key = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
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
    });

  const respond: ThreadReadBroker["Service"]["respond"] = (sessionId, response) =>
    Effect.gen(function* () {
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
        yield* Deferred.succeed(entry.result, response.result);
        return;
      }
      entry.clients.delete(response.connectionId);
      entry.incomplete ||= response.unavailableEnvironmentIds.length > 0;
      yield* finishMiss(response.requestId);
    });

  const read: ThreadReadBroker["Service"]["read"] = (sourceThreadId, input) =>
    Effect.gen(function* () {
      const sessionId = yield* currentSession(sourceThreadId);
      if (sessionId === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "environment_unavailable",
          message:
            "This run has no connected client authorized to read other environments. Send a new message from the client connected to those environments and retry.",
        });
      }
      const targets = [...clients].filter(([, client]) => client.sessionId === sessionId);
      if (targets.length === 0) return yield* unavailable();
      const requestId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
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
            orElse: () => Effect.fail(unavailable()),
          }),
        );
      }).pipe(Effect.ensuring(Effect.sync(() => pending.delete(requestId))));
    });

  return ThreadReadBroker.of({ forSession, inherit, connect, respond, read });
});

export const layer = Layer.effect(ThreadReadBroker, make);
