import {
  linkOriginIsFenced,
  OrchestratorMcpFailure,
  type OrchestrationV2LinkOrigin,
  type OrchestrationV2ThreadShell,
  type RemoteDelegationAssociation,
  type RemoteDelegationSelector,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { McpClientCaller, McpInvocationScope } from "./McpInvocationContext.ts";
import type { Caller } from "./threadAccess.ts";

/**
 * Below full access, work a link starts here (all of it carries that session in `linkOrigin`)
 * may change only work from the same link: not the user's threads, projects or settings, nor
 * this environment's links. Reads are not fenced. It is a routing rule for T3's tools; agents
 * still run as this environment's user, so a full-access link is not fenced at all.
 */

/** The link a caller acts for: its own session, or the link that started its thread. */
export const callerLinkOrigin = (
  caller: Pick<Caller, "scope" | "caller">,
): OrchestrationV2LinkOrigin | undefined =>
  caller.caller?.linkOrigin ??
  (caller.scope.client?.linked === true
    ? {
        sessionId: caller.scope.client.sessionId,
        label: caller.scope.client.label,
        access: caller.scope.client.access,
      }
    : undefined);

/** The link that fences a caller, if any: one paired below full access. */
const fencingLinkOrigin = (caller: Pick<Caller, "scope" | "caller">) => {
  const origin = callerLinkOrigin(caller);
  return origin !== undefined && linkOriginIsFenced(origin) ? origin : undefined;
};

const outsideLink = (origin: OrchestrationV2LinkOrigin, message: string) =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message: `This work was started from ${origin.label} through a linked environment, so ${message} A link paired with full access is not limited this way.`,
  });

/** A thread a fenced caller may change: one its own link started. */
export const assertSameLink = (
  caller: Pick<Caller, "scope" | "caller">,
  target: Pick<OrchestrationV2ThreadShell, "id" | "linkOrigin">,
) => {
  const origin = fencingLinkOrigin(caller);
  return origin === undefined || target.linkOrigin?.sessionId === origin.sessionId
    ? Effect.void
    : Effect.fail(outsideLink(origin, `it may change only threads that link started.`));
};

/** Fenced work never changes what the environment already has: projects, settings, scheduled runs. */
export const assertNotLinked = (caller: Pick<Caller, "scope" | "caller">, what: string) => {
  const origin = fencingLinkOrigin(caller);
  return origin === undefined
    ? Effect.void
    : Effect.fail(outsideLink(origin, `it cannot ${what}.`));
};

export const requireRemoteDelegationPeer = (
  scope: McpInvocationScope,
  target?: Pick<OrchestrationV2ThreadShell, "linkOrigin">,
): Effect.Effect<McpClientCaller, OrchestratorMcpFailure> => {
  const client = scope.client;
  return scope.thread === undefined &&
    client?.linked === true &&
    client.access !== "read-only" &&
    (target === undefined || target.linkOrigin?.sessionId === client.sessionId)
    ? Effect.succeed(client)
    : Effect.fail(
        new OrchestratorMcpFailure({
          code: "capability_denied",
          message:
            "Remote delegation requires the authenticated peer link that prepared this work.",
        }),
      );
};

export const assertRemoteDelegation = (
  scope: McpInvocationScope,
  target: Pick<OrchestrationV2ThreadShell, "linkOrigin" | "remoteDelegations">,
  selector: RemoteDelegationSelector,
): Effect.Effect<RemoteDelegationAssociation, OrchestratorMcpFailure> =>
  requireRemoteDelegationPeer(scope, target).pipe(
    Effect.flatMap((client) => {
      const association = target.remoteDelegations?.find(
        (entry) => entry.delegationId === selector.delegationId,
      );
      return association !== undefined &&
        association.linkSessionId === client.sessionId &&
        association.parentEnvironmentId === selector.parentEnvironmentId &&
        association.parentThreadId === selector.parentThreadId &&
        association.sourceTaskId === selector.sourceTaskId
        ? Effect.succeed(association)
        : Effect.fail(
            new OrchestratorMcpFailure({
              code: "capability_denied",
              message: "Remote delegation identity does not belong to this peer link.",
            }),
          );
    }),
  );
