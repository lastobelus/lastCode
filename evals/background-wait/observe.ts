// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import type * as NodeSqlite from "node:sqlite";

import { catalogMarker } from "./actionPolicy.ts";
import { wrapperWaitInstruction } from "./project.ts";

type Data = Record<string, unknown>;

export function record(value: unknown): Data {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Data)
    : {};
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).join("\n");
  const item = record(value);
  return typeof item.text === "string"
    ? item.text
    : typeof item.content === "string"
      ? item.content
      : JSON.stringify(value ?? "");
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function readLines(input: string, native = false): Data[] {
  const result: Data[] = [];
  for (const line of input.split("\n")) {
    if (line.trim() === "") continue;
    const payload = native ? line.match(/^\[[^\]]+\] NTIVE: (.*)$/u)?.[1] : line;
    if (payload === undefined) continue;
    // A truncated or partial record makes the sample incomplete.
    result.push(record(JSON.parse(payload)));
  }
  return result;
}

export function nativeLogName(threadId: string): string {
  const segment = threadId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^[-_]+|[-_]+$/gu, "")
    .slice(0, 80)
    .replace(/[-_]+$/gu, "");
  if (!segment) throw new Error("Thread id has no usable log segment.");
  const suffix =
    threadId.length > 80
      ? "-" + NodeCrypto.createHash("sha256").update(threadId).digest("hex").slice(0, 16)
      : "";
  return `events.${segment === "pending" ? "_pending" : segment}${suffix}.log`;
}

export interface Usage {
  input: number;
  cached: number;
  output: number;
}

const zero: Usage = { input: 0, cached: 0, output: 0 };
export function sumUsage(all: readonly Usage[]): Usage {
  return all.reduce(
    (sum, row) => ({
      input: sum.input + row.input,
      cached: sum.cached + row.cached,
      output: sum.output + row.output,
    }),
    zero,
  );
}

export interface NativeEvidence {
  requests: number;
  turns: number;
  usage: Usage;
  contexts: number[];
  trace: TraceEvent[];
  toolCatalog?: readonly string[];
  rolloutPaths: string[];
  complete: boolean;
}

export interface PendingWork {
  taskId: string;
  kind: string;
  awaited?: boolean;
  description?: string;
}

export function ownedWorkerLookup(db: NodeSqlite.DatabaseSync) {
  return db.prepare(`
    SELECT DISTINCT child.thread_id
    FROM orchestration_v2_projection_subagents AS task
    JOIN orchestration_v2_projection_threads AS child ON child.thread_id = task.child_thread_id
    WHERE task.thread_id = ? AND task.origin = 'app_owned' AND child.project_id = ?
    ORDER BY child.created_at, child.thread_id
  `);
}

export function awaitedWrapperIds(tasks: readonly PendingWork[], provider: string): string[] {
  return tasks
    .filter(
      (task) =>
        task.kind === "command" &&
        task.awaited === true &&
        // The thread CLI exposes descriptions, not raw commands. Codex uses the command
        // as its description. Claude may use the agent's label for the Bash tool call.
        (provider === "claudeAgent" ||
          /(?:scripts\/lc-run|scripts\/lastcode-run\.ts)\b/u.test(task.description ?? "")),
    )
    .map((task) => task.taskId);
}

export type TraceEvent =
  | { kind: "turn-end" }
  | { kind: "call"; id: string; name: string; args: string }
  | { kind: "output"; id: string; body: string };

function traceCall(item: Data, keys: { id: string; args: string }): TraceEvent | undefined {
  const id = item[keys.id];
  return typeof id === "string" && typeof item.name === "string"
    ? { kind: "call", id, name: item.name, args: text(item[keys.args]) }
    : undefined;
}

function traceOutput(id: unknown, body: unknown): TraceEvent | undefined {
  return typeof id === "string" ? { kind: "output", id, body: text(body) } : undefined;
}

export function readCodexRollout(input: string): { trace: TraceEvent[]; turns: number } {
  const trace: TraceEvent[] = [];
  let turns = 0;
  for (const row of readLines(input)) {
    const item = record(row.payload);
    if (row.type === "event_msg" && item.type === "task_complete") {
      turns++;
      trace.push({ kind: "turn-end" });
    }
    if (row.type !== "response_item") continue;
    const event =
      item.type === "function_call" || item.type === "custom_tool_call"
        ? traceCall(item, {
            id: "call_id",
            args: item.type === "function_call" ? "arguments" : "input",
          })
        : item.type === "function_call_output" || item.type === "custom_tool_call_output"
          ? traceOutput(item.call_id, item.output)
          : undefined;
    if (event) trace.push(event);
  }
  return { trace, turns };
}

export function readCodexActionCatalog(trace: readonly TraceEvent[]): string[] | undefined {
  const probes = new Set<string>();
  for (const event of trace) {
    if (
      event.kind === "call" &&
      event.name === "exec" &&
      event.args.includes("ALL_TOOLS") &&
      event.args.includes(catalogMarker)
    ) {
      probes.add(event.id);
    }
    if (event.kind !== "output" || !probes.has(event.id)) continue;
    const line = event.body.split("\n").find((line) => line.startsWith(catalogMarker));
    if (line === undefined) continue;
    try {
      const names: unknown = JSON.parse(line.slice(catalogMarker.length));
      if (Array.isArray(names) && names.every((name) => typeof name === "string")) return names;
    } catch {
      // An incomplete catalog is not evidence of tool visibility.
    }
  }
  return undefined;
}

export function readNative(input: string, provider: "codex" | "claudeAgent"): NativeEvidence {
  const usage: Usage[] = [];
  const contexts = new Map<string, number>();
  const trace: TraceEvent[] = [];
  const rolloutPaths = new Set<string>();
  const turns = new Set<string>();
  const accounted = new Set<string>();
  const requestIds = new Set<string>();
  const reportedClaudeRequestIds = new Set<string>();
  let toolCatalog: string[] | undefined;

  for (const row of readLines(input, true)) {
    const frame = record(record(row.event).payload);
    if (provider === "codex") {
      const thread = record(record(frame.result).thread);
      if (typeof thread.path === "string") rolloutPaths.add(thread.path);
      const params = record(frame.params);
      if (frame.method === "turn/completed") {
        const turn = record(params.turn);
        if (typeof turn.id === "string") turns.add(turn.id);
      }
      if (frame.method !== "thread/tokenUsage/updated") continue;
      const totals = record(params.tokenUsage);
      const last = record(totals.last);
      const total = record(totals.total);
      if (typeof last.inputTokens !== "number" || typeof total.totalTokens !== "number") continue;
      const key = `${params.threadId}:${params.turnId}:${total.totalTokens}`;
      if (accounted.has(key)) continue;
      accounted.add(key);
      const request = {
        input: number(last.inputTokens),
        cached: number(last.cachedInputTokens),
        output: number(last.outputTokens),
      };
      if (request.input === 0 && request.output === 0) continue;
      contexts.set(key, request.input);
      usage.push(request);
      continue;
    }

    if (frame.type === "system" && frame.subtype === "init" && Array.isArray(frame.tools)) {
      toolCatalog = frame.tools.filter((tool): tool is string => typeof tool === "string");
    }
    const msg = record(frame.message);
    if (frame.type === "assistant" && typeof msg.id === "string") {
      const id = msg.id;
      const tokens = record(msg.usage);
      if (typeof tokens.input_tokens === "number") {
        contexts.set(
          id,
          number(tokens.input_tokens) +
            number(tokens.cache_creation_input_tokens) +
            number(tokens.cache_read_input_tokens),
        );
        requestIds.add(id);
      }
      const rootToolBlocks =
        frame.parent_tool_use_id == null && Array.isArray(msg.content)
          ? msg.content.map(record)
          : [];
      for (const item of rootToolBlocks) {
        if (item.type !== "tool_use" || typeof item.id !== "string" || accounted.has(item.id))
          continue;
        accounted.add(item.id);
        const event = traceCall(item, { id: "id", args: "input" });
        if (event) trace.push(event);
      }
    }
    if (frame.type === "user" && frame.parent_tool_use_id == null) {
      for (const item of Array.isArray(msg.content) ? msg.content.map(record) : []) {
        if (item.type !== "tool_result") continue;
        const event = traceOutput(item.tool_use_id, item.content);
        if (event) trace.push(event);
      }
    }
    if (frame.type === "result" && typeof frame.uuid === "string" && !turns.has(frame.uuid)) {
      turns.add(frame.uuid);
      trace.push({ kind: "turn-end" });
      const counts = Object.values(record(frame.model_usage_since_last_result)).map(record);
      for (const model of counts) {
        usage.push({
          input:
            number(model.inputTokens) +
            number(model.cacheReadInputTokens) +
            number(model.cacheCreationInputTokens),
          cached: number(model.cacheReadInputTokens),
          output: number(model.outputTokens),
        });
      }
      if (counts.length > 0 && Array.isArray(frame.begun_message_ids)) {
        for (const id of frame.begun_message_ids)
          if (typeof id === "string") reportedClaudeRequestIds.add(id);
      }
    }
  }

  return {
    requests: provider === "codex" ? usage.length : reportedClaudeRequestIds.size,
    turns: turns.size,
    usage: sumUsage(usage),
    contexts: [...contexts.values()],
    trace,
    ...(toolCatalog === undefined ? {} : { toolCatalog }),
    rolloutPaths: [...rolloutPaths],
    complete:
      turns.size > 0 &&
      usage.length > 0 &&
      (provider === "codex" ||
        (reportedClaudeRequestIds.size > 0 &&
          reportedClaudeRequestIds.size === requestIds.size &&
          [...requestIds].every((id) => reportedClaudeRequestIds.has(id)))),
  };
}

const wrapperResult =
  /\[lc-run\] (?:prepare|prepare-checkpoint|ci|wait-checkpoint|package): (?:success|attention|blocked) \(exit \d+\)/u;

export function wrapperWakeIds(db: NodeSqlite.DatabaseSync, threadId: string): string[] {
  // A fast command can wake the next run between status snapshots. The continuation
  // records which awaited command delivered a result to that run.
  const wakes = db
    .prepare(`
      SELECT task.value AS task_id, json_extract(message.payload_json, '$.text') AS text
      FROM orchestration_v2_projection_runs AS run
      JOIN orchestration_v2_projection_messages AS message
        ON message.message_id = json_extract(run.payload_json, '$.userMessageId')
      JOIN json_each(run.payload_json, '$.backgroundResultContinuation.taskIds') AS task
      WHERE run.thread_id = ? AND run.status = 'completed' AND task.type = 'text'
    `)
    .all(threadId);
  return wakes.flatMap(({ task_id, text }) => {
    const header = typeof text === "string" ? (text.split("\n", 1)[0] ?? "") : "";
    return typeof task_id === "string" &&
      typeof text === "string" &&
      header.startsWith("Background command completed") &&
      wrapperCall(header) &&
      wrapperResult.test(text)
      ? [task_id]
      : [];
  });
}

function wrapperCall(args: string): boolean {
  return /(?:\.\/scripts\/lc-run|scripts\/lastcode-run\.ts)\s+(?:prepare(?:-checkpoint)?|ci|wait-checkpoint|package)\b/u.test(
    args,
  );
}

function callsTool(call: Extract<TraceEvent, { kind: "call" }>, name: string) {
  return (
    call.name.endsWith(name) ||
    (call.name === "exec" && new RegExp(`\\b(?:mcp[\\w-]*__)?${name}\\s*\\(`, "u").test(call.args))
  );
}

export function gradeTrace(
  trace: TraceEvent[],
  waitInstruction = wrapperWaitInstruction(),
  followWrapperCells = false,
) {
  const calls = new Map<string, Extract<TraceEvent, { kind: "call" }>>();
  const wrapperCells = new Map<string, Extract<TraceEvent, { kind: "call" }>>();
  const waitToolOutputs = new Set(
    trace.flatMap((event) =>
      event.kind === "output" && event.body.includes("t3_background_wait") ? [event.id] : [],
    ),
  );
  let waiting: "action" | "wrapper" | undefined;
  let wrapperCalls = 0;
  let terminalWrapperOutputs = 0;
  let markers = 0;
  let lists = 0;
  let actions = 0;
  let polls = 0;
  let redundantMarks = 0;
  let waitToolLookups = 0;
  let extraCallsWhileWaiting = 0;
  let actionWaits = 0;
  for (const event of trace) {
    if (event.kind === "turn-end") {
      waiting = undefined;
      continue;
    }
    if (event.kind === "call") {
      const cellId =
        followWrapperCells && event.name === "wait"
          ? /"cell_id"\s*:\s*"([^"]+)"/u.exec(event.args)?.[1]
          : undefined;
      const launch = cellId === undefined ? undefined : wrapperCells.get(cellId);
      if (cellId !== undefined) wrapperCells.delete(cellId);
      calls.set(event.id, launch ?? event);
      if (waiting) {
        if (waiting === "wrapper" && callsTool(event, "t3_background_wait")) {
          redundantMarks++;
        } else if (
          waiting === "wrapper" &&
          ((/tool_?search/iu.test(event.name) && event.args.includes("background_wait")) ||
            (event.name === "exec" &&
              event.args.includes("ALL_TOOLS") &&
              (event.args.includes("background_wait") ||
                (/\bbackground\b/u.test(event.args) && waitToolOutputs.has(event.id)))))
        ) {
          waitToolLookups++;
        } else {
          const request = event.name + " " + event.args;
          const poll =
            waiting === "action"
              ? /write_stdin|TaskOutput|inspect_action_run|thread[ /_-]+(?:show|read|wait)|\b(?:tail|sleep|ps|jobs|pgrep)\b|terminal.*(?:log|read|status)/iu.test(
                  request,
                )
              : /\b(?:write_stdin|TaskOutput)\b/iu.test(request) ||
                (/\b(?:exec_command|Bash)\b/iu.test(request) &&
                  /\b(?:tail|sleep|ps|jobs|pgrep)\b/u.test(event.args));
          if (poll) polls++;
          extraCallsWhileWaiting++;
        }
      }
      if (callsTool(event, "list_project_actions")) lists++;
      if (callsTool(event, "run_project_action_and_resume")) actions++;
      if (wrapperCall(event.args)) wrapperCalls++;
      continue;
    }
    const call = calls.get(event.id);
    if (
      call !== undefined &&
      callsTool(call, "run_project_action_and_resume") &&
      /"delivery"\s*:\s*"armed"/u.test(event.body.replaceAll('\\"', '"'))
    ) {
      waiting = "action";
      actionWaits++;
    }
    if (call === undefined || !wrapperCall(call.args)) continue;
    if (wrapperResult.test(event.body)) terminalWrapperOutputs++;
    else if (event.body.includes(waitInstruction)) {
      waiting = "wrapper";
      markers++;
    } else if (followWrapperCells) {
      // A yielded exec cell can deliver the wrapper's first output via functions.wait.
      const cellId = /^Script running with cell ID (\S+)/u.exec(event.body)?.[1];
      if (cellId !== undefined) wrapperCells.set(cellId, call);
    }
  }
  return {
    wrapperCalls,
    terminalWrapperOutputs,
    markers,
    lists,
    actions,
    actionWaits,
    polls,
    redundantMarks,
    waitToolLookups,
    extraCallsWhileWaiting,
  };
}
