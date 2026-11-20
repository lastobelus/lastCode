import type { EnvironmentId, OrchestrationV2AppThread, ThreadId } from "@t3tools/contracts";

export interface ThreadOwner {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

type ThreadOwnershipProvenance = Pick<OrchestrationV2AppThread, "creatorOrigin" | "lineage"> & {
  readonly delegatedFrom?: OrchestrationV2AppThread["delegatedFrom"] | null;
};

export function getThreadOwner(
  thread: ThreadOwnershipProvenance,
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

export function getRecordedThreadOwner(
  thread: ThreadOwnershipProvenance,
  environmentId: EnvironmentId,
) {
  return getThreadOwner(
    { ...thread, lineage: { ...thread.lineage, independent: false } },
    environmentId,
  );
}
