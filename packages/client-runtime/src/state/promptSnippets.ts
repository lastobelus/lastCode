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
