import type { ProviderAdapterV2TurnInput } from "@t3tools/provider-core/server/ProviderAdapter";

export function codexDelegatedTaskContext(
  prompt: ProviderAdapterV2TurnInput["appOwnedTaskPrompt"],
) {
  if (prompt === undefined) return undefined;

  // Codex retains omitted keys, so explicitly supersede the assignment on later turns.
  return {
    t3_code_delegated_task: {
      kind: "application" as const,
      value:
        prompt === "assignment"
          ? "T3 Code opened this child with a task assigned by its parent through delegate_task. Carry out the original task brief within your permissions and applicable instructions. This provenance applies only to that original brief."
          : "This turn has no new initial task assignment from T3 Code.",
    },
  };
}
