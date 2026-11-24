import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";

export const layerMcpEventTestAuth = (
  scopes: Readonly<Record<string, McpInvocationContext.McpInvocationScope>>,
) => {
  // Non-client fixtures must reach LastCode's full endpoint before event authorization runs.
  const admitted = new Map(
    Object.entries(scopes).map(([token, scope]) => [
      `Bearer ${token}`,
      scope.client === undefined
        ? { ...scope, capabilities: new Set([...scope.capabilities, "preview" as const]) }
        : scope,
    ]),
  );
  return Layer.merge(
    Layer.mock(McpSessionRegistry.McpSessionRegistry)({
      resolve: (token) => {
        const scope = admitted.get(`Bearer ${token}`);
        return Effect.succeed(
          scope?.thread === undefined ? undefined : { ...scope, thread: scope.thread },
        );
      },
    }),
    Layer.succeed(McpHttpServer.McpClientAuthenticator, {
      authenticate: Effect.fn("McpEventTestAuth.authenticate")((request) =>
        Effect.succeed(admitted.get(request.headers.authorization ?? "")),
      ),
    }),
  );
};
