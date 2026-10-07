import type { ThreadId } from "./baseSchemas.ts";
import type { OrchestrationV2AppThreadLineage } from "./orchestrationV2.ts";

interface FamilyThread {
  readonly id: ThreadId;
  readonly lineage: OrchestrationV2AppThreadLineage;
  readonly archivedAt: unknown | null;
  readonly deletedAt?: unknown | null;
  readonly persistent?: boolean | undefined;
  readonly creationSource: string;
}

/** Current ownership follows subagent edges; forks and released conversations keep provenance only. */
export function getOwnedThreadFamily<T extends FamilyThread>(
  threads: ReadonlyArray<T>,
  rootThreadId: ThreadId,
) {
  const byParent = new Map<ThreadId, T[]>();
  for (const thread of threads) {
    const parent = thread.lineage.parentThreadId;
    if (
      parent === null ||
      thread.lineage.relationshipToParent !== "subagent" ||
      thread.lineage.independent === true
    )
      continue;
    const siblings = byParent.get(parent) ?? [];
    siblings.push(thread);
    byParent.set(parent, siblings);
  }
  const visited = new Set<ThreadId>([rootThreadId]);
  const children: T[] = [];
  const visit = (id: ThreadId) => {
    for (const child of byParent.get(id) ?? []) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      if (child.archivedAt === null && child.deletedAt == null) children.push(child);
      visit(child.id);
    }
  };
  visit(rootThreadId);
  const directChildren = children.filter((child) => child.lineage.parentThreadId === rootThreadId);
  const promotableChildren = directChildren.filter((child) => child.creationSource !== "provider");
  const nativeChildren = directChildren.filter((child) => child.creationSource === "provider");
  const protectedChildren = children.filter((child) => child.persistent === true);
  return { children, directChildren, promotableChildren, nativeChildren, protectedChildren };
}
