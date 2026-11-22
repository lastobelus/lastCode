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
