import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createPromptSnippetsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "prompt-snippets:list",
    tag: WS_METHODS.promptSnippetsList,
    staleTimeMs: 0,
    refreshIntervalMs: 2_000,
    isFinal: (state) => !state.discovering,
  });
  return {
    list,
    recordUse: createEnvironmentRpcCommand(runtime, {
      label: "prompt-snippets:record-use",
      tag: WS_METHODS.promptSnippetsRecordUse,
      onSuccess: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(list({ environmentId: target.environmentId, input: {} })),
        ),
    }),
    restore: createEnvironmentRpcCommand(runtime, {
      label: "prompt-snippets:restore",
      tag: WS_METHODS.promptSnippetsRestore,
      onSuccess: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(list({ environmentId: target.environmentId, input: {} })),
        ),
    }),
    dismiss: createEnvironmentRpcCommand(runtime, {
      label: "prompt-snippets:dismiss",
      tag: WS_METHODS.promptSnippetsDismiss,
      onSuccess: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(list({ environmentId: target.environmentId, input: {} })),
        ),
    }),
    discover: createEnvironmentRpcCommand(runtime, {
      label: "prompt-snippets:discover",
      tag: WS_METHODS.promptSnippetsDiscover,
      onSuccess: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(list({ environmentId: target.environmentId, input: {} })),
        ),
    }),
  };
}
