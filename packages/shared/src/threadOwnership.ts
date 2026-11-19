import type { EnvironmentId, OrchestrationV2AppThread, ThreadOwner } from "@t3tools/contracts";

export type { ThreadOwner } from "@t3tools/contracts";

export function getThreadOwner(
  thread: Pick<OrchestrationV2AppThread, "creatorOrigin" | "delegatedFrom" | "lineage">,
  environmentId: EnvironmentId,
): ThreadOwner | null {
  if (thread.lineage.independent === true) return null;

  const remote = thread.delegatedFrom;
  if (remote != null) return { environmentId: remote.environmentId, threadId: remote.threadId };

  const { relationshipToParent, parentThreadId } = thread.lineage;
  if (relationshipToParent === "subagent" && parentThreadId !== null)
    return { environmentId, threadId: parentThreadId };

  const origin = thread.creatorOrigin;
  return origin?.kind === "thread_launch" && origin.owned === true
    ? { environmentId: origin.environmentId, threadId: origin.threadId }
    : null;
}
