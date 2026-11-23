// @effect-diagnostics nodeBuiltinImport:off -- Use an in-memory copy of the worker lookup tables.
import * as NodeSqlite from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";

import { parseLastCodeWrappedAction } from "../../packages/shared/src/lastcodeWrappedCommands.ts";
import { cases } from "./cases.ts";
import { compare } from "./compare.ts";
import { gradeSample, type Results } from "./metrics.ts";
import {
  awaitedWrapperIds,
  gradeTrace,
  ownedWorkerLookup,
  readCodexRollout,
  readNative,
  wrapperWakeIds,
} from "./observe.ts";
import { wrapperWaitInstruction } from "./project.ts";

const native = (...rows: object[]) =>
  rows
    .map(
      (payload) =>
        "[2026-01-01T00:00:00.000Z] NTIVE: " +
        JSON.stringify({ event: { stage: "decoded", payload } }),
    )
    .join("\n");
const wait = wrapperWaitInstruction();

describe("real-session evidence", () => {
  it("requires an exact opt-in to reuse a baseline recorded at another head", () => {
    const a: Results = {
      version: 1,
      config: {
        arm: "a",
        head: "earlier",
        provider: "codex",
        model: "fixture",
        scale: 1,
        base: "/home/user/a",
      },
      samples: [],
    };
    const b: Results = {
      ...a,
      config: { ...a.config, arm: "b", head: "later", base: "/home/user/b" },
    };
    expect(() => compare(a, b, 5)).toThrow("same source revision");
    expect(() => compare(a, b, 5, "wrong")).toThrow("does not match arm A");
    expect(compare(a, b, 5, "earlier")).toMatchObject({
      outcome: "incomplete",
      heads: { a: "earlier", b: "later" },
    });
  });

  it("passes real wrapper syntax for every fixture", () => {
    for (const scenario of cases)
      expect(parseLastCodeWrappedAction(scenario.wrapper)).toBeDefined();
  });

  it("gates zero polls only on arm B's polls", () => {
    const data = (arm: "a" | "b", polls: number, extraCallsWhileWaiting: number): Results => ({
      version: 1,
      config: {
        arm,
        head: "fixture",
        provider: "codex",
        model: "fixture",
        scale: 1,
        base: "/eval",
      },
      samples: [
        {
          caseId: "prepare",
          index: 1,
          title: "Prepare Dependencies",
          holds: [],
          result: {
            finished: true,
            correct: false,
            problems: [],
            turns: 1,
            requests: 1,
            tokens: { input: 9, cached: 0, output: 1 },
            rawTokens: 10,
            polls,
            redundantMarks: 1,
            waitToolLookups: 1,
            extraCallsWhileWaiting,
            holdEngaged: false,
            holds: 0,
            holdExpected: 0,
            wallSeconds: 1,
            firstInput: 9,
            contextGrowth: 0,
            standing: { guidance: 0, toolDefinitions: 0, backgroundWaitInstruction: 0 },
            standingAcrossRequests: 0,
          },
        },
      ],
    });
    const a = data("a", 3, 3);
    expect(compare(a, data("b", 0, 1), 5).gates.zeroPolls).toBe(true);
    expect(compare(a, data("b", 1, 1), 5).gates.zeroPolls).toBe(false);
  });

  it("finds a local owned worker from the app's task record", () => {
    using db = new NodeSqlite.DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE orchestration_v2_projection_threads(thread_id, project_id, created_at);
      CREATE TABLE orchestration_v2_projection_subagents(thread_id, child_thread_id, origin);
      INSERT INTO orchestration_v2_projection_threads VALUES
        ('worker', 'project', 1), ('native', 'project', 2), ('elsewhere', 'other-project', 3);
      INSERT INTO orchestration_v2_projection_subagents VALUES
        ('parent', 'worker', 'app_owned'), ('parent', 'native', 'provider_native'),
        ('parent', 'elsewhere', 'app_owned');
    `);
    expect(ownedWorkerLookup(db).all("parent", "project")).toEqual([{ thread_id: "worker" }]);
  });

  it("finds a delivered wrapper wake even when no status snapshot caught the hold", () => {
    using db = new NodeSqlite.DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE orchestration_v2_projection_runs(thread_id, status, payload_json);
      CREATE TABLE orchestration_v2_projection_messages(message_id, payload_json);
    `);
    const addRun = db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, ?)");
    const addMessage = db.prepare("INSERT INTO orchestration_v2_projection_messages VALUES (?, ?)");
    const completion =
      "Background command completed (exit 0): /bin/zsh -lc './scripts/lc-run prepare'\n\n" +
      "[lc-run] prepare: success (exit 0)\nResult ID result-example.";
    for (const [id, thread, status, message, taskIds] of [
      ["own", "worker", "completed", completion, ["exec-wrapped"]],
      ["other", "another-thread", "completed", completion, ["exec-other"]],
      ["queued", "worker", "queued", completion, ["exec-queued"]],
      ["manual", "worker", "completed", completion, undefined],
      ["unrelated", "worker", "completed", "Background command completed: ls", ["exec-ls"]],
    ] as const) {
      addRun.run(
        thread,
        status,
        JSON.stringify({
          userMessageId: id,
          backgroundResultContinuation: taskIds === undefined ? undefined : { taskIds },
        }),
      );
      addMessage.run(id, JSON.stringify({ text: message }));
    }
    expect(wrapperWakeIds(db, "worker")).toEqual(["exec-wrapped"]);
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
            call_id: "mark",
            input: 'await tools.mcp__t3_code__t3_background_wait({taskIds:["1"]})',
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
    expect(gradeTrace(trace.trace, wait)).toMatchObject({
      markers: 1,
      polls: 1,
      redundantMarks: 1,
      extraCallsWhileWaiting: 1,
    });
  });

  it("links a yielded wrapper cell to the wait result that first shows the instruction", () => {
    const trace = [
      {
        kind: "call",
        id: "exec",
        name: "exec",
        args: 'await tools.exec_command({cmd:"./scripts/lc-run wait-checkpoint"})',
      },
      {
        kind: "output",
        id: "exec",
        body: "Script running with cell ID g1:2\nWall time: 1.0 seconds\nOutput:\n",
      },
      { kind: "call", id: "other", name: "wait", args: '{"cell_id":"g1:3"}' },
      { kind: "output", id: "other", body: wait },
      { kind: "call", id: "wait", name: "wait", args: '{"cell_id":"g1:2"}' },
      { kind: "output", id: "wait", body: "Script running with cell ID g1:2\nOutput:\n" },
      { kind: "call", id: "resume", name: "wait", args: '{"cell_id":"g1:2"}' },
      {
        kind: "output",
        id: "resume",
        body: `Script completed\nOutput:\n${JSON.stringify({ session_id: 123, output: wait })}`,
      },
      { kind: "turn-end" },
    ] as const;
    expect(gradeTrace([...trace], wait, true)).toMatchObject({
      wrapperCalls: 1,
      markers: 1,
      polls: 0,
      extraCallsWhileWaiting: 0,
    });
    expect(
      gradeTrace(
        [
          ...trace.slice(0, -1),
          { kind: "call", id: "poll", name: "write_stdin", args: '{"session_id":123,"chars":""}' },
          { kind: "turn-end" },
        ],
        wait,
        true,
      ),
    ).toMatchObject({ wrapperCalls: 1, markers: 1, polls: 1 });
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

  it("requires evidence of the owned Quick CI worker's wrapper wait", () => {
    const scenario = cases.find((entry) => entry.id === "quick-ci")!;
    const input: Parameters<typeof gradeSample>[0] = {
      arm: "b",
      scenario,
      finished: true,
      correctCheckout: true,
      delegationCorrect: true,
      turns: 4,
      expectedTurnCounts: [2, 2],
      holds: [],
      wrapperWakeIds: [],
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
      waitInstruction: wait,
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
    expect(
      gradeSample({
        ...input,
        traces: [[], [...trace]],
        wrapperWakeIds: ["worker-command"],
      }),
    ).toMatchObject({ correct: true, holds: 0, holdExpected: 1, holdEngaged: false });
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
    const withMark = [
      trace[0],
      trace[1],
      {
        kind: "call",
        id: "lookup",
        name: "exec",
        args: 'text(ALL_TOOLS.filter(x => x.name.includes("background")))',
      },
      {
        kind: "output",
        id: "lookup",
        body: "mcp__t3_code__t3_background_wait Keep this thread in Working.",
      },
      {
        kind: "call",
        id: "mark",
        name: "mcp__t3_code__t3_background_wait",
        args: '{"taskIds":["1"]}',
      },
      trace[2],
    ] as const;
    expect(gradeSample({ ...input, traces: [[], [...withMark]], holds })).toMatchObject({
      correct: true,
      redundantMarks: 1,
      waitToolLookups: 1,
      extraCallsWhileWaiting: 0,
    });
    expect(
      gradeSample({
        ...input,
        traces: [
          [],
          [
            trace[0],
            trace[1],
            { kind: "call", id: "thread", name: "mcp__t3_code__t3_thread_read", args: "{}" },
            trace[2],
          ],
        ],
        holds,
      }),
    ).toMatchObject({ correct: false, polls: 0, extraCallsWhileWaiting: 1 });
    expect(gradeTrace([...trace])).toMatchObject({
      markers: 1,
      redundantMarks: 0,
    });
  });
});
