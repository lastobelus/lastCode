import { assert, describe, it } from "@effect/vitest";

import {
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  T3_CODE_BROWSER_TOOL_INSTRUCTIONS,
  t3AcpPromptWithInstructions,
  t3OrchestrationPromptForFirstRun,
  t3OrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("T3 orchestration provider instructions", () => {
  it("distinguishes delegated subagents from ordinary top-level threads", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Use `delegate_task`");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "ordinary top-level T3 conversations");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Never use them merely");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "cross-provider");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "call `delegate_task` again");
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "Do not use `t3_thread_send` on `childThreadId`",
    );
  });

  it("documents structured schedules instead of JSON strings", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "structured object, never as JSON text");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, '"everyMs":3600000');
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "bindToCurrentThread=false");
  });

  it.each([
    ["system", t3OrchestrationSystemPrompt(true)!],
    [
      "first-run prompt",
      t3OrchestrationPromptForFirstRun({
        prompt: "Find the thread.",
        runOrdinal: 1,
        hasT3Mcp: true,
      }),
    ],
    [
      "ACP prompt",
      t3AcpPromptWithInstructions({
        prompt: "Find the thread.",
        state: { interactionMode: "default", hasT3Mcp: true },
      }),
    ],
  ])("emits the thread recovery contract in the %s", (_channel, instructions) => {
    const recovery = instructions.split("### Find mentioned threads")[1]?.split("\n### ")[0] ?? "";
    assert.include(recovery, "finding it is your job");
    assert.match(recovery, /Thread IDs are opaque.*full ID unchanged/);
    assert.include(recovery, "`mcp:<uuid>`");
    assert.include(recovery, "`thread.environmentId`");
    assert.include(recovery, "`thread_not_found`");
    assert.include(recovery, "`environment_unavailable`");

    let previousStep = -1;
    for (const step of [
      "Start with `t3_thread_read`",
      "`t3_thread_search`",
      "`lastcode-thread` CLI",
      "owning installation's `thread` subcommand",
      "Ask the user only after these routes are exhausted",
    ]) {
      const position = recovery.indexOf(step);
      assert.isAbove(position, previousStep, `Recovery step is missing or out of order: ${step}`);
      previousStep = position;
    }
    assert.include(recovery, "`threadsTruncated`");
    assert.include(recovery, "only in this environment");
    assert.include(recovery, "permission refusal is a boundary");
    assert.include(recovery, '`"kind":"accepted"`');
    assert.include(recovery, '`"kind":"completed"`');
    assert.include(recovery, "`waitHandle`");
    assert.include(recovery, "`dispatch-unknown`");
    assert.include(recovery, "`transport-unknown`");
    assert.include(recovery, "ready-to-paste `link`");
  });

  it("injects prompt fallback only for an MCP-enabled first run", () => {
    const prompt = "Inspect the repository.";
    const injected = t3OrchestrationPromptForFirstRun({
      prompt,
      runOrdinal: 1,
      hasT3Mcp: true,
    });

    assert.include(injected, "<t3_code_orchestration_instructions>");
    assert.include(injected, T3_CODE_BROWSER_TOOL_INSTRUCTIONS.trim());
    assert.include(injected, T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.include(injected, `<user_request>\n${prompt}\n</user_request>`);
    assert.equal(
      t3OrchestrationPromptForFirstRun({ prompt, runOrdinal: 2, hasT3Mcp: true }),
      prompt,
    );
    assert.equal(
      t3OrchestrationPromptForFirstRun({ prompt, runOrdinal: 1, hasT3Mcp: false }),
      prompt,
    );
  });

  it("only exposes the system prompt when the T3 MCP server is attached", () => {
    assert.equal(t3OrchestrationSystemPrompt(false), undefined);
    const instructions = t3OrchestrationSystemPrompt(true)!;
    assert.include(instructions, T3_CODE_BROWSER_TOOL_INSTRUCTIONS.trim());
    assert.include(instructions, T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
  });

  it("gives ACP sessions provider-neutral mode, browser, and orchestration guidance", () => {
    const injected = t3AcpPromptWithInstructions({
      prompt: "Inspect the repository.",
      state: { interactionMode: "default", hasT3Mcp: true },
    });

    assert.include(injected, "T3 Code interaction mode: Default");
    assert.include(injected, "T3 Code collaborative browser");
    assert.include(injected, "T3 Code orchestration");
    assert.include(injected, "<user_request>\nInspect the repository.\n</user_request>");
  });

  it("reinjects ACP guidance only when mode or tool availability changes", () => {
    const prompt = "Continue.";
    const defaultState = { interactionMode: "default", hasT3Mcp: true } as const;

    assert.equal(
      t3AcpPromptWithInstructions({ prompt, state: defaultState, previousState: defaultState }),
      prompt,
    );
    assert.include(
      t3AcpPromptWithInstructions({
        prompt,
        state: { ...defaultState, interactionMode: "plan" },
        previousState: defaultState,
      }),
      "T3 Code interaction mode: Plan",
    );
    const withoutMcp = t3AcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasT3Mcp: false },
    });
    assert.include(withoutMcp, "T3 Code interaction mode: Default");
    assert.notInclude(withoutMcp, "T3 Code collaborative browser");
    assert.notInclude(withoutMcp, "T3 Code orchestration");
  });
});
