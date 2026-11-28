import type {
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import { originalDelegatedTaskIds } from "@t3tools/provider-core/server/IdAllocator";
import type { ProviderAdapterV2TurnInput } from "@t3tools/provider-core/server/ProviderAdapter";

export function appOwnedTaskPrompt(input: {
  readonly appThread: Pick<OrchestrationV2AppThread, "id" | "forkedFrom" | "lineage">;
  readonly message:
    | Pick<
        OrchestrationV2ConversationMessage,
        "id" | "senderThreadId" | "createdBy" | "creationSource"
      >
    | undefined;
}): ProviderAdapterV2TurnInput["appOwnedTaskPrompt"] {
  const { appThread, message } = input;
  const original = originalDelegatedTaskIds(appThread.id);
  if (original === undefined) return undefined;

  const assigned =
    message?.id === original.messageId &&
    appThread.forkedFrom?.type === "node" &&
    appThread.forkedFrom.nodeId === original.nodeId &&
    appThread.lineage.relationshipToParent === "subagent" &&
    appThread.lineage.independent !== true &&
    message.senderThreadId === appThread.lineage.parentThreadId &&
    message.createdBy === "agent" &&
    message.creationSource === "mcp";
  return assigned ? "assignment" : "other";
}
