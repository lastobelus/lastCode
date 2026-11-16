import {
  type EnvironmentId,
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadShell,
  type OrchestratorMcpThreadReadInput,
  type OrchestratorMcpThreadReadToolInput,
  type OrchestratorMcpThreadReadResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as PeerLinks from "../peer/PeerLinks.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { callerLinkOrigin, fencingLinkOrigin } from "./linkOrigin.ts";

const isFailure = Schema.is(OrchestratorMcpFailure);

type Read = (
  input: OrchestratorMcpThreadReadInput,
) => Effect.Effect<OrchestratorMcpThreadReadResult, OrchestratorMcpFailure>;

interface ReadRoutes {
  readonly local: Read;
  readonly client: Read;
  readonly reference: (
    input: OrchestratorMcpThreadReadInput,
  ) => Effect.Effect<
    OrchestratorMcpThreadReadResult | OrchestratorMcpFailure,
    OrchestratorMcpFailure
  >;
  readonly peer: (
    environmentId: EnvironmentId,
    input: OrchestratorMcpThreadReadInput,
  ) => Effect.Effect<OrchestratorMcpThreadReadResult, OrchestratorMcpFailure>;
  readonly peerLink: PeerLinks.PeerLinks["Service"]["get"];
}

const clientReadAuthorityDenied = () =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    threadReadReason: "permission_denied",
    message:
      "Only work started in this environment can read through its initiating client. Outside callers and work started through a linked environment cannot, and setting via does not change that. Report this to the user instead of trying another route.",
  });

const referencePeerUnavailable = (environmentId: EnvironmentId, expired: boolean) =>
  new OrchestratorMcpFailure({
    code: "environment_unavailable",
    threadReadReason: "unavailable",
    message: expired
      ? `No initiating client attempted this reference, and this environment's outgoing read link to ${environmentId} has expired. Ask the user to renew that link, or to authorize this exact reference through a client that can read it.`
      : `No initiating client attempted this reference, and this environment has no outgoing read link to ${environmentId}. Ask the user to link that environment, or to authorize this exact reference through a client that can read it.`,
  });

export const readRouteTargetRequired = () =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message: "A client or reference read needs the exact environmentId of the target environment.",
  });

const linkedReadForwardingDenied = (label: string) =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    threadReadReason: "permission_denied",
    message: `This work started from ${label} through a linked environment, so it cannot read through this environment's clients or links. Exact reads of this environment's own threads still work. For anything else, ask the user to grant access on the originating link or a direct link to the target; do not retry under a different identity.`,
  });

// Only tool entry accepts reference. Every transport receives the old strict type.
const strictReadInput = (
  input: OrchestratorMcpThreadReadToolInput,
  via: "client" | undefined,
): OrchestratorMcpThreadReadInput => {
  const { via: _route, ...rest } = input;
  return via === undefined ? rest : { ...rest, via };
};

// The automatic reference selection has already considered both available authorities.
const exhaustedReference = (cause: OrchestratorMcpFailure) =>
  new OrchestratorMcpFailure({
    code: cause.code,
    ...(cause.threadReadReason === undefined ? {} : { threadReadReason: cause.threadReadReason }),
    message: cause.message,
  });

export const readThreadWithRoutes = Effect.fn("mcp.readThreadWithRoutes")(function* (
  scope: McpInvocationScope,
  caller: Pick<OrchestrationV2ThreadShell, "linkOrigin"> | undefined,
  input: OrchestratorMcpThreadReadToolInput,
  routes: ReadRoutes,
) {
  if (input.via !== undefined && input.environmentId === undefined) {
    return yield* readRouteTargetRequired();
  }
  const wireInput = strictReadInput(input, input.via === "client" ? "client" : undefined);
  if (input.environmentId === scope.environmentId) return yield* routes.local(wireInput);

  const origin = fencingLinkOrigin({ scope, caller });
  const clientAuthority =
    caller !== undefined &&
    scope.client === undefined &&
    callerLinkOrigin({ scope, caller }) === undefined;
  if (input.environmentId === undefined) {
    return yield* routes.local(wireInput).pipe(
      Effect.catchIf(
        (error) => error.code === "thread_not_found",
        (error) => (clientAuthority ? routes.client(wireInput) : Effect.fail(error)),
      ),
    );
  }
  if (origin !== undefined) return yield* linkedReadForwardingDenied(origin.label);
  if (input.via === "client") {
    if (!clientAuthority) return yield* clientReadAuthorityDenied();
    return yield* routes.client(wireInput);
  }
  if (input.via === "reference" && input.environmentId !== undefined) {
    let clientUnavailable: OrchestratorMcpFailure | undefined;
    if (clientAuthority) {
      const result = yield* routes.reference(strictReadInput(input, "client"));
      if (!isFailure(result)) return result;
      if (result.noDestinationAttempt !== true || result.threadReadReason === "permission_denied")
        return yield* result;
      clientUnavailable = result;
    }
    const link = yield* routes
      .peerLink(input.environmentId)
      .pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
        ),
      );
    if (Option.isNone(link))
      return yield* clientUnavailable === undefined
        ? referencePeerUnavailable(input.environmentId, false)
        : exhaustedReference(clientUnavailable);
    if (DateTime.isLessThanOrEqualTo(link.value.expiresAt, yield* DateTime.now)) {
      return yield* clientUnavailable === undefined
        ? referencePeerUnavailable(input.environmentId, true)
        : exhaustedReference(clientUnavailable);
    }
    // PeerLinks.get returns only this environment's outgoing links. Legacy
    // unfenced links are represented as expired; every supported access can read.
    return yield* routes.peer(input.environmentId, wireInput);
  }
  return yield* routes.peer(input.environmentId, wireInput);
});
