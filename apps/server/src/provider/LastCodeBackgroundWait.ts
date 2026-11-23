import type { OrchestrationV2ProviderSession, RunId } from "@t3tools/contracts";
import type { ProviderHost } from "@t3tools/provider-core/server/ProviderHost";
import type { ProviderAdapterV2SessionRuntime } from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderContinuationRequest } from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

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
    ? "\n\nFor a background result you need, call `t3_background_wait` with its exec session ID string in `taskIds`. End your turn without polling. Completion wakes you. Leave dev servers and watchers unmarked."
    : "";
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
            : Effect.succeed(Option.none()),
        ),
      ),
    clearIfCurrent: () => state.serialize(state.clear),
  };
}
