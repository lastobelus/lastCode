import type {
  OrchestrationV2SubagentPromotion,
  OrchestrationV2ThreadCapabilities,
} from "@t3tools/contracts";

/** Native promotion requires a provider that can fork the actual subagent conversation. */
export function canPromoteSubagent(
  capabilities:
    | Pick<OrchestrationV2ThreadCapabilities, "canForkThread" | "canForkFromSubagentThread">
    | null
    | undefined,
): boolean {
  return capabilities?.canForkThread === true && capabilities.canForkFromSubagentThread === true;
}

/** Durable server progress is authoritative; RPC pending only locks the local actions. */
export function presentSubagentPromotion(
  promotion: OrchestrationV2SubagentPromotion | null | undefined,
  pending: boolean,
) {
  const status = promotion?.status ?? null;
  return {
    label:
      status === "promoted"
        ? "promoted to interactive thread"
        : status === "waiting" || status === "forking" || pending
          ? "Promoting to interactive thread"
          : status === "failed"
            ? "Retry"
            : "Promote to interactive thread",
    busy: pending || status === "waiting" || status === "forking",
    disabled: pending || status === "waiting" || status === "forking",
    waiting: status === "waiting",
    canCancel: status === "waiting" && !pending,
    error:
      status === "failed" && !pending
        ? (promotion?.error ?? "Could not promote this subagent.")
        : null,
  };
}
