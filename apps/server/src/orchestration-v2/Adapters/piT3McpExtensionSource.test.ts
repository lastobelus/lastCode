import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { assert, describe, it } from "@effect/vitest";

import { PI_T3_MCP_EXTENSION_SOURCE } from "./piT3McpExtensionSource.ts";

type RequestHook = (
  event: { payload: unknown },
  ctx: { model: { provider: string } },
) => Record<string, unknown> | undefined;

async function loadExtensionHandlers(hasT3Mcp = false): Promise<Map<string, unknown>> {
  const handlers = new Map<string, unknown>();
  // An empty MCP catalog needs no Typebox and keeps the bridge entirely local.
  const source = NodeModule.stripTypeScriptTypes(
    PI_T3_MCP_EXTENSION_SOURCE.replace('import { Type } from "typebox";', "").replace(
      "export default async function",
      "async function",
    ),
  );
  await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
    process: {
      env: hasT3Mcp
        ? { T3_MCP_URL: "http://localhost:43123/mcp", T3_MCP_BEARER_TOKEN: "test-token" }
        : {},
    },
    AbortSignal,
    fetch: async () =>
      new Response('{"id":1,"result":{"tools":[]}}', {
        headers: { "content-type": "application/json" },
      }),
    pi: { on: (name: string, handler: unknown) => handlers.set(name, handler) },
  });
  return handlers;
}

async function loadRequestHook(): Promise<RequestHook> {
  const handlers = await loadExtensionHandlers();
  const hook = handlers.get("before_provider_request") as RequestHook | undefined;
  assert.isDefined(hook);
  return hook!;
}

describe("Pi upstream output-budget workaround", () => {
  it.each(["max_tokens", "max_completion_tokens"])(
    "caps %s without changing the conversation or tools",
    async (key) => {
      const hook = await loadRequestHook();
      const payload = {
        model: "moonshotai/kimi-k2.6",
        messages: [{ role: "user", content: "hello" }],
        tools: [{ type: "function", function: { name: "read" } }],
        [key]: 231_969,
      };
      const result = hook({ payload }, { model: { provider: "openrouter" } });
      assert.equal(result?.[key], 32_768);
      assert.strictEqual(result?.messages, payload.messages);
      assert.strictEqual(result?.tools, payload.tools);
      assert.equal(result?.model, payload.model);
      assert.equal(payload[key], 231_969);
    },
  );

  it("preserves smaller budgets and other providers' payloads", async () => {
    const hook = await loadRequestHook();
    for (const payload of [{ max_tokens: 8192 }, { max_completion_tokens: 32_768 }, {}, null]) {
      assert.isUndefined(hook({ payload }, { model: { provider: "openrouter" } }));
    }
    assert.isUndefined(
      hook({ payload: { max_tokens: 231_969 } }, { model: { provider: "anthropic" } }),
    );
  });
});

describe("Pi T3 MCP instructions", () => {
  it("adds background browser guidance through the attached bridge's system prompt", async () => {
    const handlers = await loadExtensionHandlers(true);
    const hook = handlers.get("before_agent_start") as
      | ((event: { readonly systemPrompt: string }) => { readonly systemPrompt: string })
      | undefined;
    assert.isDefined(hook);
    const result = hook!({ systemPrompt: "Original instructions." });
    assert.include(result.systemPrompt, "Original instructions.");
    assert.include(result.systemPrompt, "Use `delegate_task`");
    assert.include(result.systemPrompt, "without a separate browser-permission prompt");
    assert.include(result.systemPrompt, "preview_open({ open: false, reuseExistingTab: false })");
  });

  it("leaves the system prompt untouched without MCP credentials", async () => {
    const handlers = await loadExtensionHandlers();
    assert.isFalse(handlers.has("before_agent_start"));
  });
});
