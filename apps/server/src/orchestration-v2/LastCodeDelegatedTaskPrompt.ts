import type { OrchestrationV2AppThread, OrchestrationV2Run } from "@t3tools/contracts";
import { isDelegatedTaskThread } from "@t3tools/provider-core/server/IdAllocator";
import type { ProviderAdapterV2TurnInput } from "@t3tools/provider-core/server/ProviderAdapter";

export function appOwnedTaskPrompt(input: {
  readonly appThread: Pick<OrchestrationV2AppThread, "id" | "forkedFrom" | "lineage">;
  readonly run: Pick<OrchestrationV2Run, "ordinal" | "userMessageId" | "delegatedTaskId">;
  readonly message: Pick<
    ProviderAdapterV2TurnInput["message"],
    "messageId" | "senderThreadId" | "createdBy" | "creationSource"
  >;
  readonly resume?: boolean;
}): ProviderAdapterV2TurnInput["appOwnedTaskPrompt"] {
  const { appThread, run, message } = input;
  if (!isDelegatedTaskThread(appThread.id)) return undefined;

  const assigned =
    input.resume !== true &&
    run.ordinal === 1 &&
    run.userMessageId === message.messageId &&
    appThread.forkedFrom?.type === "node" &&
    appThread.forkedFrom.nodeId === run.delegatedTaskId &&
    appThread.lineage.relationshipToParent === "subagent" &&
    appThread.lineage.independent !== true &&
    message.senderThreadId === appThread.lineage.parentThreadId &&
    message.createdBy === "agent" &&
    message.creationSource === "mcp";
  return assigned ? "assignment" : "other";
}
