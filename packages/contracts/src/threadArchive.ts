import type { ThreadId } from "./baseSchemas.ts";
import type {
  OrchestrationV2AppThread,
  OrchestrationV2AppThreadLineage,
} from "./orchestrationV2.ts";

export function getThreadArchivePlan(pending: OrchestrationV2AppThread["archivePending"]) {
  return pending != null && "archiveThreadIds" in pending ? pending : null;
}

/** Descendants reference the operation without copying its family plan. */
export function compactThreadArchiveParticipant(
  pending: OrchestrationV2AppThread["archivePending"],
) {
  if (pending == null) return pending;
  return {
    threadId: pending.threadId,
    commandId: pending.commandId,
    status: pending.status,
    ...(pending.error === undefined ? {} : { error: pending.error }),
  };
}

interface FamilyThread {
  readonly id: ThreadId;
  readonly projectId: OrchestrationV2AppThread["projectId"];
  readonly lineage: OrchestrationV2AppThreadLineage;
  readonly archivedAt: unknown | null;
  readonly deletedAt?: unknown | null;
  readonly persistent?: boolean | undefined;
  readonly creationSource: string;
  readonly createdBy?: string | undefined;
  readonly creatorThreadId?: ThreadId | undefined;
  readonly creatorGrouping?: string | undefined;
  readonly groupedUnderThreadId?: ThreadId | null | undefined;
  readonly forkedFrom?: unknown | null;
}

/** Active delegated lineage is execution ownership, even after its run finishes. */
export function isOwnedSubagentThread(thread: Pick<FamilyThread, "lineage">): boolean {
  return thread.lineage.relationshipToParent === "subagent" && thread.lineage.independent !== true;
}

/** Deployed creator groups remain readable until explicit placement (including null) is written. */
export function getInteractiveThreadParentThreadId(thread: FamilyThread): ThreadId | null {
  if (
    thread.deletedAt != null ||
    isOwnedSubagentThread(thread) ||
    (thread.creationSource === "provider" && thread.lineage.relationshipToParent === "subagent")
  )
    return null;
  if (thread.groupedUnderThreadId !== undefined) return thread.groupedUnderThreadId;
  return thread.createdBy === "agent" &&
    thread.creatorGrouping === "grouped" &&
    thread.lineage.parentThreadId === null &&
    thread.lineage.relationshipToParent === null &&
    thread.forkedFrom == null &&
    thread.lineage.independent !== true
    ? (thread.creatorThreadId ?? null)
    : null;
}

/** Interactive placement needs the parent row to enforce the project boundary. */
export function getArchiveFamilyParentThreadId(
  thread: FamilyThread,
  creator?: Pick<FamilyThread, "id" | "projectId">,
): ThreadId | null {
  if (isOwnedSubagentThread(thread)) return thread.lineage.parentThreadId;
  const parentId = getInteractiveThreadParentThreadId(thread);
  return creator?.id === parentId && creator.projectId === thread.projectId ? parentId : null;
}

/** Forks and explicitly independent branches retain provenance without archive membership. */
export function getOwnedThreadFamily<T extends FamilyThread>(
  threads: ReadonlyArray<T>,
  rootThreadId: ThreadId,
) {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const parentOf = (thread: T) =>
    getArchiveFamilyParentThreadId(thread, byId.get(getInteractiveThreadParentThreadId(thread)!));
  const byParent = new Map<ThreadId, T[]>();
  for (const thread of threads) {
    const parent = parentOf(thread);
    if (parent === null) continue;
    const siblings = byParent.get(parent) ?? [];
    siblings.push(thread);
    byParent.set(parent, siblings);
  }
  const visited = new Set<ThreadId>([rootThreadId]);
  const children: T[] = [];
  const keptThreadIds = new Set<ThreadId>();
  const visit = (id: ThreadId, kept = false) => {
    for (const child of byParent.get(id) ?? []) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      const live = child.archivedAt === null && child.deletedAt == null;
      const retain = kept || (id === rootThreadId && live && child.creationSource !== "provider");
      if (live) {
        children.push(child);
        if (retain) keptThreadIds.add(child.id);
      }
      visit(child.id, retain);
    }
  };
  visit(rootThreadId);
  const directChildren = children.filter((child) => parentOf(child) === rootThreadId);
  const promotableChildren = directChildren.filter((child) => child.creationSource !== "provider");
  const nativeChildren = directChildren.filter((child) => child.creationSource === "provider");
  const protectedChildren = children.filter((child) => child.persistent === true);
  return {
    children,
    directChildren,
    promotableChildren,
    nativeChildren,
    protectedChildren,
    keptThreadIds,
  };
}
