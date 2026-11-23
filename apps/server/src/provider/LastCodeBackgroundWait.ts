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

export function codexBackgroundCommandNeedsWake(
  settled: boolean,
  awaited: boolean,
  command:
    | { readonly explicitlyAwaited?: boolean; readonly toolBatchesAtLaunch?: number }
    | undefined,
  completedToolBatches: number | undefined,
): boolean {
  if (settled) return true;
  if (!awaited) return false;
  // Codex publishes token usage after draining the sampling step's tool calls.
  // If the command survived that boundary, the launch returned a session, not an exit result.
  return (
    command?.explicitlyAwaited === true ||
    (command?.toolBatchesAtLaunch !== undefined &&
      (completedToolBatches ?? 0) > command.toolBatchesAtLaunch)
  );
}

export interface CodexOwedBackgroundCommand {
  readonly taskId: string;
  readonly originRunId: RunId;
  readonly providerThreadId: ProviderThreadId;
  readonly processId: string | undefined;
  deferredWake?: {
    readonly request: ProviderContinuationRequest;
    terminalTurnId?: ProviderTurnId;
  };
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
): ProviderContinuationRequest[] {
  const wakes: ProviderContinuationRequest[] = [];
  for (const owed of owedCommands.values()) {
    if (
      owed.providerThreadId !== providerThreadId ||
      owed.deferredWake?.terminalTurnId !== providerTurnId
    )
      continue;
    wakes.push(owed.deferredWake.request);
    delete owed.deferredWake;
  }
  return wakes;
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
