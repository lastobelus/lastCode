import type { OrchestrationV2ProviderSession } from "@t3tools/contracts";
import { ProviderHost } from "@t3tools/provider-core/server/ProviderHost";
import type { ProviderAdapterV2SessionRuntime } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export function readCodexBackgroundWait(settings?: ProviderHost["Service"]["settings"]["get"]) {
  return (
    settings?.pipe(
      Effect.map((value) => value.lastcodeCodexBackgroundWaitEnabled),
      Effect.orElseSucceed(() => false),
    ) ?? Effect.succeed(false)
  );
}

export const loadCodexBackgroundWaitReader = Effect.serviceOption(ProviderHost).pipe(
  Effect.map((host) => readCodexBackgroundWait(Option.getOrUndefined(host)?.settings.get)),
);

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
