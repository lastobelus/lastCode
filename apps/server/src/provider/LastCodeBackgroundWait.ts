import type {
  OrchestrationV2ProviderSession,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
} from "@t3tools/contracts";
import type { ProviderHost } from "@t3tools/provider-core/server/ProviderHost";
import type { ProviderAdapterV2SessionRuntime } from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderContinuationRequest } from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as Effect from "effect/Effect";
import type { FileSystem } from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

export function readLastCodeBackgroundWaitEnabled(
  settings?: ProviderHost["Service"]["settings"]["get"],
): Effect.Effect<boolean> {
  return (
    settings?.pipe(
      Effect.map((value) => value.lastcodeBackgroundWaitEnabled),
      Effect.orElseSucceed(() => false),
    ) ?? Effect.succeed(false)
  );
}

export function withCodexBackgroundWaitCapability(
  capabilities: OrchestrationV2ProviderSession["capabilities"],
  enabled: boolean,
): OrchestrationV2ProviderSession["capabilities"] {
  return enabled
    ? { ...capabilities, tools: { ...capabilities.tools, supportsBackgroundWait: true } }
    : capabilities;
}

export function codexBackgroundWaitForNewSession(
  capabilities: ReadonlySet<string> | undefined,
  readSetting: Effect.Effect<boolean>,
) {
  // Use the issued credential's decision even if the setting changed during open.
  return capabilities === undefined
    ? readSetting
    : Effect.succeed(capabilities.has("background-wait"));
}

export function codexBackgroundWaitForAttachedSession(runtime: ProviderAdapterV2SessionRuntime) {
  return runtime.driver === "codex"
    ? runtime.providerSession.capabilities.tools.supportsBackgroundWait === true
    : undefined;
}

export function codexBackgroundWaitHook(
  enabled: boolean,
  awaitBackgroundTasks: NonNullable<ProviderAdapterV2SessionRuntime["awaitBackgroundTasks"]>,
) {
  return enabled ? { awaitBackgroundTasks } : {};
}

export function codexBackgroundWaitInstructions(enabled: boolean): string {
  return enabled
    ? "\n\nFor a needed background result, call `t3_background_wait` with its exec session ID string in `taskIds` unless `lc-run` reports a registered wake. End your turn without polling."
    : "";
}

type CodexLaunchReceipt = {
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
  readonly processId: string;
};

type CodexDeferredBackgroundWake = {
  readonly request: ProviderContinuationRequest;
  readonly launchReceipt?: CodexLaunchReceipt;
  terminalTurnId?: ProviderTurnId;
};

export interface CodexOwedBackgroundCommand {
  readonly taskId: string;
  readonly originRunId: RunId;
  readonly providerThreadId: ProviderThreadId;
  readonly processId: string | undefined;
  deferredWake?: CodexDeferredBackgroundWake;
}

export function settleCodexDeferredBackgroundWakes(
  owedCommands: Map<string, CodexOwedBackgroundCommand>,
  turn: {
    readonly originRunId: RunId | null;
    readonly providerThreadId: ProviderThreadId;
    readonly providerTurnId: ProviderTurnId;
    readonly completed: boolean;
  },
): boolean {
  let retired = false;
  for (const owed of owedCommands.values()) {
    if (
      owed.deferredWake === undefined ||
      owed.originRunId !== turn.originRunId ||
      owed.providerThreadId !== turn.providerThreadId
    )
      continue;
    if (turn.completed) {
      owed.deferredWake.terminalTurnId = turn.providerTurnId;
    } else {
      owedCommands.delete(owed.taskId);
      retired = true;
    }
  }
  return retired;
}

export function takeCodexDeferredBackgroundWakes(
  owedCommands: ReadonlyMap<string, CodexOwedBackgroundCommand>,
  providerThreadId: ProviderThreadId,
  providerTurnId: ProviderTurnId,
): CodexDeferredBackgroundWake[] {
  const wakes: CodexDeferredBackgroundWake[] = [];
  for (const owed of owedCommands.values()) {
    if (
      owed.providerThreadId !== providerThreadId ||
      owed.deferredWake?.terminalTurnId !== providerTurnId
    )
      continue;
    wakes.push(owed.deferredWake);
    delete owed.deferredWake;
  }
  return wakes;
}

const CODEX_ROLLOUT_TAIL_BYTES = 2 * 1024 * 1024;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function containsCodexSession(output: unknown, processId: string): boolean {
  const texts = Array.isArray(output)
    ? output.flatMap((part: unknown) =>
        Predicate.isObject(part) && part.type === "input_text" && typeof part.text === "string"
          ? [part.text]
          : [],
      )
    : typeof output === "string"
      ? [output]
      : [];
  for (const text of texts) {
    // Plain exec_command output has a header before stdout. Code mode can print the
    // structured result inside its own tool output, including in a parallel batch.
    const nativeSession =
      /^(?:Chunk ID: [^\n]+\n)?Wall time: [^\n]+\n(?:Process exited with code [^\n]+\n)?Process running with session ID (\d+)\b/u.exec(
        text,
      )?.[1];
    if (nativeSession === processId) return true;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      const result = parseJson(trimmed);
      if (
        Predicate.isObject(result) &&
        typeof result.chunk_id === "string" &&
        (typeof result.session_id === "number" || typeof result.session_id === "string") &&
        String(result.session_id) === processId &&
        typeof result.output === "string"
      )
        return true;
    }
  }
  return false;
}

/** Codex's command item is identical for foreground and yielded launches. Read only the
 * owning turn's model-visible tool results to confirm an early automatic wait. */
export function codexRolloutConfirmsBackgroundLaunch(
  fileSystem: FileSystem,
  path: string | null | undefined,
  receipt: CodexLaunchReceipt,
): Effect.Effect<boolean> {
  if (
    path == null ||
    !path.split("/").at(-1)?.startsWith("rollout-") ||
    !path.endsWith(`-${receipt.nativeThreadId}.jsonl`)
  )
    return Effect.succeed(false);
  return Effect.gen(function* () {
    const info = yield* fileSystem.stat(path);
    if (info.type !== "File") return false;
    const file = yield* fileSystem.open(path, { flag: "r" });
    const size = (yield* file.stat).size;
    const start =
      size > BigInt(CODEX_ROLLOUT_TAIL_BYTES) ? size - BigInt(CODEX_ROLLOUT_TAIL_BYTES) : 0n;
    const bytes = yield* file.readAlloc(CODEX_ROLLOUT_TAIL_BYTES, { position: start });
    let owningTurn = false;
    const lines = new TextDecoder().decode(Option.getOrUndefined(bytes)).split("\n");
    for (const line of lines.slice(start === 0n ? 0 : 1)) {
      const row = parseJson(line);
      if (!Predicate.isObject(row) || !Predicate.isObject(row.payload)) continue;
      const item = row.payload;
      if (row.type === "event_msg") {
        if (item.type === "task_started") owningTurn = item.turn_id === receipt.nativeTurnId;
        if (item.type === "task_complete" && item.turn_id === receipt.nativeTurnId) break;
      }
      if (
        owningTurn &&
        row.type === "response_item" &&
        (item.type === "function_call_output" || item.type === "custom_tool_call_output") &&
        containsCodexSession(item.output, receipt.processId)
      )
        return true;
    }
    return false;
  }).pipe(
    Effect.scoped,
    Effect.orElseSucceed(() => false),
  );
}

export function codexBackgroundResultRequest(
  request: ProviderContinuationRequest,
  owed: { readonly taskId: string; readonly originRunId: RunId },
  state: {
    readonly isCurrent: () => boolean;
    readonly clear: Effect.Effect<void>;
    readonly serialize: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  },
): ProviderContinuationRequest {
  return {
    ...request,
    backgroundResultContinuation: {
      providerThreadId: request.providerThreadId,
      originRunId: owed.originRunId,
      taskIds: [owed.taskId],
    },
    // Clearing and admitting a retained result are mutually exclusive.
    dispatchIfCurrent: (dispatch) =>
      state.serialize(
        Effect.suspend(() =>
          state.isCurrent()
            ? dispatch.pipe(
                Effect.tap(() => state.clear),
                Effect.asSome,
              )
            : Effect.succeedNone,
        ),
      ),
    clearIfCurrent: () => state.serialize(state.clear),
  };
}
