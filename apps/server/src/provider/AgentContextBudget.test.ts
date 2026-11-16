import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { McpServer } from "effect/ai";
import { layerAdvertisedTools, measureAgentContextBudget } from "./AgentContextBudget.ts";
import budget from "./agentContextBudget.json" with { type: "json" };

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

// CI rejects a PR that raises any value above main's agentContextBudget.json, so growth
// needs the agent-context-increase label. Lower the values when the text shrinks.
it.effect("agent context matches the committed budget", () =>
  Effect.gen(function* () {
    const measured = yield* measureAgentContextBudget;

    expect(
      measured,
      "Run pnpm --dir apps/server agent-context:generate. Before you cut text to fit, run the evals that cover it (evals/README.md).",
    ).toEqual(budget);
  }),
);
