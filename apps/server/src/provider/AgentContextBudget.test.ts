import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { McpServer } from "effect/ai";
import { layerAdvertisedTools } from "./AgentContextBudget.ts";

// Claude Code loads these tools up front instead of behind ToolSearch, outside this budget.
it.effect("only request_secret and send_to_user ask Claude Code to load them up front", () =>
  Effect.gen(function* () {
    const mcp = yield* McpServer.McpServer;
    const alwaysLoad = mcp.tools
      .filter(({ tool }) => tool._meta?.["anthropic/alwaysLoad"] !== undefined)
      .map(({ tool }) => [tool.name, tool._meta]);
    expect(alwaysLoad).toEqual([
      ["request_secret", { "anthropic/alwaysLoad": true }],
      ["send_to_user", { "anthropic/alwaysLoad": true }],
    ]);
  }).pipe(Effect.provide(layerAdvertisedTools)),
);
