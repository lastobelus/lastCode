import {
  OrchestratorMcpFailure,
  type MessageId,
  type ThreadId,
  type RunId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ContextTransfer,
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

/** Clients retain their own destination credentials; servers only forward reads. */
export class ThreadReadBroker extends Context.Service<
  ThreadReadBroker,
  {
    readonly authorize: (input: {
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
      readonly sessionId: string;
      readonly alreadyStored: boolean;
    }) => Effect.Effect<void>;
    readonly authorizedSession: (
      threadId: ThreadId,
      messageId: MessageId,
    ) => Effect.Effect<string | undefined>;
    readonly connect: (
      sessionId: string,
    ) => Effect.Effect<Stream.Stream<ThreadReadRequest>, never, Scope.Scope>;
    readonly respond: (
      sessionId: string,
      response: ThreadReadResponse,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly read: (
      threadId: ThreadId,
      messageId: MessageId,
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

const authorizationIdleMillis = 7 * 24 * 60 * 60 * 1000;
const maxAuthorizations = 10_000;

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const authorizations = new Map<string, { sessionId: string; lastUsedAt: number }>();
  const authorizationKey = (threadId: ThreadId, messageId: MessageId) =>
    JSON.stringify([threadId, messageId]);
  // Map order follows valid use, so stale entries and capacity eviction both
  // remove the least recently used authority without extending rejected claims.
  const pruneAuthorizations = (now: number) => {
    for (const [key, entry] of authorizations) {
      if (now - entry.lastUsedAt < authorizationIdleMillis) break;
      authorizations.delete(key);
    }
  };
  const authorizedSession: ThreadReadBroker["Service"]["authorizedSession"] = (
    threadId,
    messageId,
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      pruneAuthorizations(now);
      const key = authorizationKey(threadId, messageId);
      const entry = authorizations.get(key);
      if (entry === undefined) return undefined;
      authorizations.delete(key);
      authorizations.set(key, { ...entry, lastUsedAt: now });
      return entry.sessionId;
    });
  const authorize: ThreadReadBroker["Service"]["authorize"] = (input) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      pruneAuthorizations(now);
      const key = authorizationKey(input.threadId, input.messageId);
      // A replay cannot claim an existing execution, including after eviction,
      // or replace its original requester while the binding remains present.
      if (input.alreadyStored || authorizations.has(key)) return;
      if (authorizations.size >= maxAuthorizations) {
        const oldest = authorizations.keys().next().value;
        if (oldest !== undefined) authorizations.delete(oldest);
      }
      authorizations.set(key, { sessionId: input.sessionId, lastUsedAt: now });
    });
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

  const read: ThreadReadBroker["Service"]["read"] = (threadId, messageId, input) =>
    Effect.gen(function* () {
      const sessionId = yield* authorizedSession(threadId, messageId);
      const targets = [...clients].filter(([, client]) => client.sessionId === sessionId);
      if (sessionId === undefined || targets.length === 0) return yield* unavailable();
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

  return ThreadReadBroker.of({ authorize, authorizedSession, connect, respond, read });
});

export const layer = Layer.effect(ThreadReadBroker, make);

/** Delegation inherits the run that spawned it, even after its parent starts another run. */
type AuthoritySource = {
  readonly thread: Pick<OrchestrationV2ThreadProjection["thread"], "id">;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "userMessageId">>;
  readonly contextTransfers: ReadonlyArray<
    Pick<OrchestrationV2ContextTransfer, "type" | "targetRunId" | "sourceThreadId" | "sourcePoint">
  >;
};

export const resolveAuthority = <E>(
  broker: ThreadReadBroker["Service"],
  source: AuthoritySource,
  run: Pick<OrchestrationV2Run, "id" | "userMessageId"> | undefined,
  readSource: (threadId: ThreadId) => Effect.Effect<AuthoritySource, E>,
  visited = new Set<RunId>(),
): Effect.Effect<
  | { readonly threadId: ThreadId; readonly messageId: MessageId; readonly sessionId: string }
  | undefined,
  E
> =>
  Effect.gen(function* () {
    if (run === undefined || visited.has(run.id)) return undefined;
    visited.add(run.id);
    const sessionId = yield* broker.authorizedSession(source.thread.id, run.userMessageId);
    if (sessionId !== undefined) {
      return { threadId: source.thread.id, messageId: run.userMessageId, sessionId };
    }
    const transfer = source.contextTransfers.find(
      (candidate) => candidate.type === "subagent_spawn" && candidate.targetRunId === run.id,
    );
    if (transfer?.sourcePoint.runId === undefined) return undefined;
    const parent = yield* readSource(transfer.sourceThreadId);
    return yield* resolveAuthority(
      broker,
      parent,
      parent.runs.find((candidate) => candidate.id === transfer.sourcePoint.runId),
      readSource,
      visited,
    );
  });
