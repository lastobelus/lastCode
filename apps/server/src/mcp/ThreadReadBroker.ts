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
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as SqlError from "effect/sql/SqlError";
import * as Stream from "effect/Stream";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { ThreadReadAuthorization } from "../orchestration-v2/ThreadReadAuthorization.ts";
import * as ThreadReadAuthority from "../threadReadAuthority/Store.ts";
import type {
  AuthorityFailureReason,
  GrantCheck,
  ThreadReadGrant,
} from "../threadReadAuthority/Types.ts";
import { resolveThreadReadContinuation } from "./ThreadReadContinuation.ts";
import { referenceReadFailure, threadReadFailure } from "./ThreadReadDiagnostics.ts";
import { makeOriginalReferenceCheck } from "./ThreadReadOriginalReference.ts";
import { unavailable } from "./threadAccess.ts";

type Authorization = Context.Service.Shape<typeof ThreadReadAuthorization>;

/** Clients retain destination credentials. Only accepted, captured authority selects a stream. */
export class ThreadReadBroker extends Context.Service<
  ThreadReadBroker,
  {
    readonly forSession: (sessionId: string) => Authorization;
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
    readonly read: (
      sourceThreadId: ThreadId,
      sourceRunId: RunId | undefined,
      input: OrchestratorMcpThreadReadInput,
    ) => Effect.Effect<OrchestratorMcpThreadReadResult, OrchestratorMcpFailure>;
    /** A failure value means no destination was attempted; a thrown failure is final. */
    readonly readReference: (
      sourceThreadId: ThreadId,
      sourceRunId: RunId | undefined,
      input: OrchestratorMcpThreadReadInput,
    ) => Effect.Effect<
      OrchestratorMcpThreadReadResult | OrchestratorMcpFailure,
      OrchestratorMcpFailure
    >;
  }
>()("t3/mcp/ThreadReadBroker") {}

const unavailableFor = (check: GrantCheck, reference = false) => {
  const failure = (
    reason: "disconnected" | "reauthenticate" | "fence" | "revoked" | "expiredGrant",
  ) =>
    reference
      ? referenceReadFailure(reason, true)
      : threadReadFailure(reason, reason === "disconnected");
  switch (check.status) {
    case "disconnected":
      return failure("disconnected");
    case "reauth-required":
      return failure("reauthenticate");
    case "fence-unavailable":
      return failure("fence");
    case "expired":
      return failure("expiredGrant");
    default:
      return failure("revoked");
  }
};

const deniedGrant = (reason: AuthorityFailureReason, reference = false) => {
  const diagnostic =
    reason === "reauth-required"
      ? "reauthenticate"
      : reason === "fence-unavailable"
        ? "fence"
        : reason === "expired"
          ? "expiredGrant"
          : "revoked";
  return reference ? referenceReadFailure(diagnostic, true) : threadReadFailure(diagnostic);
};
type ReadAuthority = ThreadReadGrant | { readonly denialReason: AuthorityFailureReason };
const isFailure = Schema.is(OrchestratorMcpFailure);

const make = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const authority = yield* ThreadReadAuthority.make;
  const isOriginalInputReference = yield* makeOriginalReferenceCheck;
  const clients = new Map<
    string,
    { sessionId: string; queue: Queue.Queue<ThreadReadRequest, Cause.Done> }
  >();
  const connectedSessions = () => [...new Set([...clients.values()].map((row) => row.sessionId))];
  const isLive = (sessionId: string) =>
    [...clients.values()].some((client) => client.sessionId === sessionId);

  // These are proposals only. The event writer binds them to the input it actually accepts.
  const forSession: ThreadReadBroker["Service"]["forSession"] = (sessionId) => ({
    authorize: Effect.fn("ThreadReadBroker.authorize")(function* (threadId, inputId) {
      const captured = yield* authority.captureAuthenticatedSessionAuthority(sessionId, {
        isLive: () => isLive(sessionId),
      });
      if (captured !== undefined) return { threadId, inputId, authority: captured };
      const status = yield* authority.sessionAuthorityStatus(sessionId);
      return status === "current" || status === "unavailable"
        ? undefined
        : { threadId, inputId, denialReason: status };
    }, Effect.orDie),
  });

  const lookup = Effect.fn("ThreadReadBroker.lookup")(function* (
    thread: ThreadId,
    kind: "run" | "reference",
    id: string,
  ): Effect.fn.Return<ReadAuthority | undefined, SqlError.SqlError> {
    const grant = yield* authority.lookupGrant(thread, kind, id);
    if (grant !== undefined) return grant;
    const reason = yield* authority.lookupFailureReason(thread, kind, id);
    return reason === undefined ? undefined : { denialReason: reason };
  });

  const resolve = (
    threadId: ThreadId,
    runId: RunId | undefined,
    input?: OrchestratorMcpThreadReadInput,
  ) =>
    resolveThreadReadContinuation(
      {
        getThreadRecords: threads.getThreadRecords,
        lookupRunGrant: (id, run) => lookup(id, "run", run),
        lookupReferenceGrant: (id, nonce) => lookup(id, "reference", nonce),
        isOriginalInputReference,
      },
      {
        threadId,
        runId,
        ...(input?.environmentId === undefined
          ? {}
          : { reference: { environmentId: input.environmentId, threadId: input.threadId } }),
      },
    );

  const inherit: ThreadReadBroker["Service"]["inherit"] = Effect.fn("ThreadReadBroker.inherit")(
    function* (threadId, runId) {
      const selected = yield* resolve(threadId, runId);
      if (selected?.kind !== "grant") return ThreadReadAuthorization.defaultValue();
      if ("denialReason" in selected.grant) {
        const denialReason = selected.grant.denialReason;
        return {
          authorize: (destination: ThreadId, inputId: MessageId) =>
            Effect.succeed({ threadId: destination, inputId, denialReason }),
        };
      }
      const captured = yield* authority.prepareInheritedAuthority(
        selected.grant,
        connectedSessions,
        isLive,
      );
      if (captured === undefined) return ThreadReadAuthorization.defaultValue();
      return {
        authorize: (destination: ThreadId, inputId: MessageId) =>
          Effect.succeed({ threadId: destination, inputId, authority: captured }),
      };
    },
    Effect.orElseSucceed(() => ThreadReadAuthorization.defaultValue()),
  );

  const pending = new Map<
    string,
    {
      input: OrchestratorMcpThreadReadInput;
      grant: ThreadReadGrant;
      reference: boolean;
      clients: Set<string>;
      incomplete: boolean;
      allNoDestination: boolean;
      failure?: ThreadReadFailureReason;
      result: Deferred.Deferred<
        OrchestratorMcpThreadReadResult | OrchestratorMcpFailure,
        OrchestratorMcpFailure
      >;
    }
  >();

  const finishMiss = Effect.fn("ThreadReadBroker.finishMiss")(function* (
    requestId: string,
    expired = false,
  ) {
    const entry = pending.get(requestId);
    if (entry === undefined || (!expired && entry.clients.size > 0)) return;
    if (!expired && entry.allNoDestination && !entry.incomplete) {
      if (entry.reference) {
        yield* Deferred.succeed(entry.result, referenceReadFailure("noDestination", true));
      } else {
        yield* Deferred.fail(entry.result, threadReadFailure("noDestination", true));
      }
      return;
    }
    const error =
      entry.failure === "permission_denied"
        ? threadReadFailure("denied")
        : expired || entry.incomplete || entry.failure === "unavailable"
          ? threadReadFailure("unavailable")
          : entry.failure === "unsupported"
            ? threadReadFailure("unsupported")
            : new OrchestratorMcpFailure({
                code: "thread_not_found",
                message: `Thread ${entry.input.threadId} was not found in the checked environments.`,
              });
    yield* Deferred.fail(entry.result, error);
  });

  const connect: ThreadReadBroker["Service"]["connect"] = Effect.fn("ThreadReadBroker.connect")(
    function* (sessionId) {
      const queue = yield* Queue.unbounded<ThreadReadRequest, Cause.Done>();
      const key = yield* random.uuidV4();
      clients.set(key, { sessionId, queue });
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          clients.delete(key);
          for (const [requestId, entry] of pending) {
            if (!entry.clients.delete(key)) continue;
            entry.incomplete = true;
            entry.allNoDestination = false;
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
        (response.failure !== undefined &&
          (entry.input.environmentId !== response.failure.environmentId ||
            response.result !== null)) ||
        (response.noDestinationAttempt === true &&
          (entry.input.environmentId === undefined ||
            response.result !== null ||
            response.failure?.reason === "permission_denied"))
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
        const checked = <A>(operation: Effect.Effect<A, SqlError.SqlError>) =>
          operation.pipe(
            Effect.catch(() => {
              const error = unavailable();
              return Deferred.fail(entry.result, error).pipe(Effect.andThen(Effect.fail(error)));
            }),
          );
        const current = yield* checked(authority.touchSuccessfulRead(entry.grant, sessionId));
        if (!current) {
          const retained = yield* checked(
            lookup(entry.grant.threadId, entry.grant.kind, entry.grant.grantId),
          );
          let failure: OrchestratorMcpFailure;
          if (retained === undefined) {
            failure = threadReadFailure("lostGrant");
          } else if ("denialReason" in retained) {
            failure = deniedGrant(retained.denialReason);
          } else {
            const check = yield* checked(
              authority.eligibleConnectedSessions(retained, connectedSessions()),
            );
            failure =
              check.status === "eligible" || check.status === "disconnected"
                ? threadReadFailure("unavailable")
                : unavailableFor(check);
          }
          yield* Deferred.fail(entry.result, failure);
          return;
        }
        yield* Deferred.succeed(entry.result, { ...response.result, readVia: "client" });
        return;
      }
      entry.clients.delete(response.connectionId);
      entry.allNoDestination &&= response.noDestinationAttempt === true;
      // A catalog-only no-attempt response can name its unavailable target without implying
      // an uncertain attempt. Any old/unknown/attempted response defeats the aggregate proof.
      if (response.noDestinationAttempt !== true) {
        entry.incomplete ||= response.unavailableEnvironmentIds.length > 0;
        if (response.failure !== undefined) {
          const reason = response.failure.reason;
          if (reason === "unavailable") entry.incomplete = true;
          if (entry.failure === undefined || reason === "permission_denied") entry.failure = reason;
        }
      }
      yield* finishMiss(response.requestId);
    },
  );

  const readSelected = Effect.fn("ThreadReadBroker.readSelected")(function* (
    sourceThreadId: ThreadId,
    sourceRunId: RunId | undefined,
    input: OrchestratorMcpThreadReadInput,
    reference: boolean,
  ) {
    const selected = yield* resolve(sourceThreadId, sourceRunId, input).pipe(
      Effect.mapError(unavailable),
    );
    if (selected?.kind !== "grant") {
      if (reference) return referenceReadFailure("noGrant", true);
      return yield* threadReadFailure("noGrant", true);
    }
    if ("denialReason" in selected.grant) {
      if (reference) return deniedGrant(selected.grant.denialReason, true);
      return yield* deniedGrant(selected.grant.denialReason);
    }
    const check = yield* authority
      .eligibleConnectedSessions(selected.grant, connectedSessions())
      .pipe(Effect.mapError(unavailable));
    if (check.status !== "eligible") {
      if (reference) return unavailableFor(check, true);
      return yield* unavailableFor(check);
    }
    const sessionIds = new Set(check.sessionIds);
    const targets = [...clients].filter(([, client]) => sessionIds.has(client.sessionId));
    if (targets.length === 0) {
      if (reference) return referenceReadFailure("disconnected", true);
      return yield* threadReadFailure("disconnected", true);
    }
    const requestId = yield* random.uuidV4();
    const result = yield* Deferred.make<
      OrchestratorMcpThreadReadResult | OrchestratorMcpFailure,
      OrchestratorMcpFailure
    >();
    pending.set(requestId, {
      input,
      grant: selected.grant,
      reference,
      result,
      clients: new Set(targets.map(([key]) => key)),
      incomplete: false,
      allNoDestination: true,
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
  });
  const read: ThreadReadBroker["Service"]["read"] = (thread, run, input) =>
    readSelected(thread, run, input, false).pipe(
      Effect.filterOrFail(
        (result): result is OrchestratorMcpThreadReadResult => !isFailure(result),
        (result) => result as OrchestratorMcpFailure,
      ),
    );
  const readReference: ThreadReadBroker["Service"]["readReference"] = (thread, run, input) =>
    readSelected(thread, run, input, true);
  return ThreadReadBroker.of({ forSession, inherit, connect, respond, read, readReference });
});

export const layer = Layer.effect(ThreadReadBroker, make);
