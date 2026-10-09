import {
  OrchestratorMcpFailure,
  type OrchestratorMcpThreadReadInput,
  type OrchestratorMcpThreadReadResult,
  type ThreadReadRequest,
  type ThreadReadResponse,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
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
    readonly connect: (
      sessionId: string,
    ) => Effect.Effect<Stream.Stream<ThreadReadRequest>, never, Scope.Scope>;
    readonly respond: (
      sessionId: string,
      response: ThreadReadResponse,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly read: (
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

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
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

  const read: ThreadReadBroker["Service"]["read"] = (input) =>
    Effect.gen(function* () {
      if (clients.size === 0) return yield* unavailable();
      const requestId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const result = yield* Deferred.make<
        OrchestratorMcpThreadReadResult,
        OrchestratorMcpFailure
      >();
      const targets = [...clients];
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

  return ThreadReadBroker.of({ connect, respond, read });
});

export const layer = Layer.effect(ThreadReadBroker, make);
