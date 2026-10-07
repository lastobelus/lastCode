type ArchivedFamilyThread = {
  readonly id: string;
  readonly archivedWith?:
    | { readonly threadId: string; readonly commandId: string }
    | null
    | undefined;
};

/** Keep each archived cohort beneath its owner, preserving the supplied order. */
export function groupArchivedThreadFamilies<T extends ArchivedFamilyThread>(threads: readonly T[]) {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const childrenByOwner = new Map<string, T[]>();
  const roots: T[] = [];
  for (const thread of threads) {
    const owner = thread.archivedWith && byId.get(thread.archivedWith.threadId);
    if (
      owner != null &&
      owner.id !== thread.id &&
      owner.archivedWith?.commandId === thread.archivedWith?.commandId
    ) {
      const children = childrenByOwner.get(owner.id);
      if (children) children.push(thread);
      else childrenByOwner.set(owner.id, [thread]);
    } else {
      roots.push(thread);
    }
  }
  return roots.flatMap((root) => [root, ...(childrenByOwner.get(root.id) ?? [])]);
}
