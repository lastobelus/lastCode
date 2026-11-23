import { describe, expect, it } from "vite-plus/test";

import { parseLastCodeWrappedAction } from "../../packages/shared/src/lastcodeWrappedCommands.ts";
import { cases } from "./cases.ts";
import { gradeSample } from "./metrics.ts";
import { awaitedWrapperIds, gradeTrace, readCodexRollout, readNative } from "./observe.ts";

const native = (...rows: object[]) =>
  rows
    .map(
      (payload) =>
        "[2026-01-01T00:00:00.000Z] NTIVE: " +
        JSON.stringify({ event: { stage: "decoded", payload } }),
    )
    .join("\n");
const wait =
  "[lc-run] If you are this LastCode thread's main agent, ran ./scripts/lc-run as a simple command, and the shell reports it running in the background, end your turn. LastCode will wake the thread with the result. Do not poll. You may prefix the command with cd <literal path> &&, with no cd options or shell expansion. For other shell constructs and native subagent runs, collect the result before returning.";

describe("real-session evidence", () => {
  it("passes real wrapper syntax for every fixture", () => {
    for (const scenario of cases)
      expect(parseLastCodeWrappedAction(scenario.wrapper)).toBeDefined();
  });

  it("counts Codex request usage once and excludes cached tokens from double counting", () => {
    const usage = (totalTokens: number, inputTokens: number, cachedInputTokens: number) => ({
      method: "thread/tokenUsage/updated",
      params: {
        turnId: "turn-1",
        threadId: "native-1",
        tokenUsage: {
          total: { totalTokens },
          last: { inputTokens, cachedInputTokens, outputTokens: 17 },
        },
      },
    });
    const result = readNative(
      native(
        { result: { thread: { path: "/home/user/eval/codex-home/sessions/foo.jsonl" } } },
        usage(117, 100, 0),
        usage(117, 100, 0),
        usage(254, 120, 100),
        { method: "turn/completed", params: { turn: { id: "turn-1" } } },
      ),
      "codex",
    );
    expect(result).toMatchObject({
      turns: 1,
      requests: 2,
      usage: { input: 220, cached: 100, output: 34 },
      contexts: [100, 120],
      complete: true,
      rolloutPaths: ["/home/user/eval/codex-home/sessions/foo.jsonl"],
    });
  });

  it("counts writes to stdin from Codex rollout and ignores tools after the wake", () => {
    const trace = readCodexRollout(
      [
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "exec",
            call_id: "1",
            input: 'await tools.exec_command({cmd:"./scripts/lc-run ci --quick"})',
          },
        },
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            call_id: "1",
            output: [{ type: "input_text", text: wait }],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "exec",
            call_id: "2",
            input: "await tools.write_stdin({session_id:1,chars:''})",
          },
        },
        { type: "event_msg", payload: { type: "task_complete" } },
        {
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            call_id: "3",
            arguments: '{"cmd":"tail report"}',
          },
        },
        { type: "event_msg", payload: { type: "task_complete" } },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
    );
    expect(trace.turns).toBe(2);
    expect(gradeTrace(trace.trace)).toMatchObject({
      markers: 1,
      polls: 1,
      extraCallsWhileWaiting: 1,
    });
  });

  it("treats a foreground Claude result as completion and ignores native child tool blocks", () => {
    const usage = {
      input_tokens: 10,
      cache_read_input_tokens: 90,
      cache_creation_input_tokens: 5,
      output_tokens: 1,
    };
    const result = readNative(
      native(
        { type: "assistant", message: { id: "1", usage, content: [{ type: "thinking" }] } },
        {
          type: "assistant",
          parent_tool_use_id: "native-child",
          message: {
            id: "native-call",
            content: [
              {
                type: "tool_use",
                id: "native-bash",
                name: "Bash",
                input: { command: "./scripts/lc-run prepare" },
              },
            ],
          },
        },
        {
          type: "user",
          parent_tool_use_id: "native-child",
          message: {
            content: [{ type: "tool_result", tool_use_id: "native-bash", content: wait }],
          },
        },
        {
          type: "assistant",
          message: {
            id: "1",
            usage,
            content: [
              {
                type: "tool_use",
                id: "use-1",
                name: "Bash",
                input: { command: "./scripts/lc-run prepare" },
              },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "use-1",
                content: wait + "\n[lc-run] prepare: success (exit 0)",
              },
            ],
          },
        },
        {
          type: "assistant",
          message: {
            id: "2",
            usage: { ...usage, input_tokens: 13 },
            content: [{ type: "text", text: "Exit 0" }],
          },
        },
        {
          type: "result",
          uuid: "result-1",
          begun_message_ids: ["1", "2"],
          model_usage_since_last_result: {
            haiku: {
              inputTokens: 23,
              cacheReadInputTokens: 180,
              cacheCreationInputTokens: 10,
              outputTokens: 50,
            },
          },
        },
      ),
      "claudeAgent",
    );
    expect(result).toMatchObject({
      turns: 1,
      requests: 2,
      usage: { input: 213, cached: 180, output: 50 },
      contexts: [105, 108],
      complete: true,
    });
    expect(gradeTrace(result.trace)).toMatchObject({
      wrapperCalls: 1,
      terminalWrapperOutputs: 1,
      markers: 0,
      polls: 0,
    });
  });

  it("counts Action tools invoked through Codex's exec and recognizes an armed Action", () => {
    const trace = gradeTrace([
      {
        kind: "call",
        id: "1",
        name: "exec",
        args: "await tools.mcp__t3_code__list_project_actions({})",
      },
      {
        kind: "call",
        id: "2",
        name: "exec",
        args: "await tools.mcp__t3_code__run_project_action_and_resume({actionId:'action'})",
      },
      { kind: "output", id: "2", body: '{"delivery":"armed"}' },
      { kind: "call", id: "3", name: "mcp__t3-code__inspect_action_run", args: "{}" },
      { kind: "turn-end" },
    ]);
    expect(trace).toMatchObject({ lists: 1, actions: 1, actionWaits: 1, polls: 1 });
  });

  it("requires a hold in the owned Quick CI worker thread when the landed wait line appears", () => {
    const scenario = cases.find((entry) => entry.id === "quick-ci")!;
    const input: Parameters<typeof gradeSample>[0] = {
      arm: "b",
      scenario,
      finished: true,
      correctCheckout: true,
      delegationCorrect: true,
      turns: 4,
      expectedTurnCounts: [2, 2],
      holds: 0,
      actionWakes: 0,
      workerMessage: "Result ID result-example, exit code 3.",
      finalMessage: "Result ID result-example, exit code 3.",
      work: [
        { event: "start", cwd: "/home/user/eval/project", arm: "b", stage: 0, operationId: "x" },
        {
          event: "finish",
          cwd: "/home/user/eval/project",
          resultId: "result-example",
          operationId: "x",
        },
      ],
      native: [],
      traces: null,
      wallSeconds: 55,
      standing: { guidance: 100, toolDefinitions: 0, backgroundWaitInstruction: 0 },
    };
    expect(gradeSample(input)).toMatchObject({ correct: false, polls: null, requests: null });
    const trace = [
      {
        kind: "call",
        id: "1",
        name: "exec_command",
        args: '{"cmd":"cd /home/user/eval/worker && ./scripts/lc-run ci --quick"}',
      },
      { kind: "output", id: "1", body: wait },
      { kind: "turn-end" },
    ] as const;
    expect(gradeSample({ ...input, traces: [[], [...trace]] })).toMatchObject({
      correct: false,
      polls: 0,
      holdExpected: 1,
      holdEngaged: false,
    });
    const holds = awaitedWrapperIds(
      [
        { taskId: "native-child", kind: "subagent", awaited: true },
        { taskId: "unmarked", kind: "command", description: "./scripts/lc-run ci --quick" },
        {
          taskId: "worker-command",
          kind: "command",
          awaited: true,
          description: "cd /home/user/eval/worker && ./scripts/lc-run ci --quick",
        },
      ],
      "codex",
    );
    expect(holds).toEqual(["worker-command"]);
    expect(gradeSample({ ...input, traces: [[], [...trace]], holds: holds.length })).toMatchObject({
      correct: true,
    });
  });
});
