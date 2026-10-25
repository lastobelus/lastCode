import {
  type AuthMcpClientAccess,
  type EnvironmentId,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { currentThreadDeviceAccess } from "../device/DeviceAgentAccess.ts";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

const ALL_MCP_CAPABILITIES = [
  "preview",
  "orchestration",
  "worktree",
  "device",
  "pull-requests",
  "action-resume",
] as const;
export type McpCapability = (typeof ALL_MCP_CAPABILITIES)[number];

export interface McpThreadCaller {
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
}

export interface McpClientCaller {
  readonly sessionId: string;
  readonly label: string;
  readonly access: AuthMcpClientAccess;
}

/** Read-only clients map to the lowest mode because McpToolAccess blocks writes first. */
export const clientRuntimeModeCeiling = (client: McpClientCaller | undefined): RuntimeMode =>
  client === undefined || client.access === "read-only" ? "approval-required" : client.access;

/** Thread callers default to their own thread; client callers need thread for tools that act as the caller. */
export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
  readonly requestNamespace: string;
  readonly thread: McpThreadCaller | undefined;
  readonly client: McpClientCaller | undefined;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

export type McpCapabilityError<C extends McpCapability> = C extends "preview"
  ? PreviewAutomationUnavailableError
  : McpCapabilityUnavailableError;

const missingCapability = <C extends McpCapability>(
  invocation: McpInvocationScope,
  capability: C,
): McpCapabilityError<C> => {
  const fields = {
    environmentId: invocation.environmentId,
    ...(invocation.thread === undefined
      ? {}
      : {
          threadId: invocation.thread.threadId,
          providerSessionId: invocation.thread.providerSessionId,
          providerInstanceId: invocation.thread.providerInstanceId,
        }),
  };
  return (
    capability === "preview"
      ? new PreviewAutomationUnavailableError({ capability, ...fields })
      : new McpCapabilityUnavailableError({ capability, ...fields })
  ) as McpCapabilityError<C>;
};

export const requireMcpCapability = <const C extends McpCapability>(
  capability: C,
): Effect.Effect<McpInvocationScope, McpCapabilityError<C>, McpInvocationContext> =>
  McpInvocationContext.pipe(
    Effect.filterOrFail(
      (invocation) => invocation.capabilities.has(capability),
      (invocation) => missingCapability(invocation, capability) as McpCapabilityError<C>,
    ),
    Effect.withSpan("mcp.requireCapability"),
  );

export const requireThreadMcpCapability = <const C extends "preview" | "device">(
  capability: C,
): Effect.Effect<McpThreadInvocationScope, McpCapabilityError<C>, McpInvocationContext> =>
  McpInvocationContext.pipe(
    Effect.filterOrFail(
      (invocation): invocation is McpThreadInvocationScope =>
        invocation.capabilities.has(capability) && invocation.thread !== undefined,
      (invocation) => missingCapability(invocation, capability) as McpCapabilityError<C>,
    ),
    Effect.withSpan("mcp.requireCapability"),
  );

/** A granted device credential still needs the calling project's current consent. */
export const requireCurrentThreadDeviceAccess = Effect.gen(function* () {
  const scope = yield* requireThreadMcpCapability("device");
  const threads = yield* ProjectionStore.ProjectionStoreV2;
  const allowed = yield* currentThreadDeviceAccess(threads.getThreadShell(scope.thread.threadId));
  if (!allowed) return yield* missingCapability(scope, "device");
  return scope;
});

const threadCallerRequired = (operation: string) =>
  new OrchestratorMcpFailure({
    code: "thread_credential_required",
    message: `${operation} acts as the calling T3 thread, so it needs an agent running inside T3 Code. This MCP client signed in from outside a thread.`,
  });

export type McpThreadInvocationScope = McpInvocationScope & { readonly thread: McpThreadCaller };

export const requireThreadScope = (scope: McpInvocationScope, operation: string) =>
  scope.thread === undefined
    ? Effect.fail(threadCallerRequired(operation))
    : Effect.succeed(scope as McpThreadInvocationScope);
