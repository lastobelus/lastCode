type ArchivedFamilyThread = {
  readonly id: string;
  readonly environmentId?: string | undefined;
  readonly archivedWith?:
    | { readonly threadId: string; readonly commandId: string }
    | null
    | undefined;
};

type ArchivedRestoreThread = ArchivedFamilyThread & {
  readonly archivedAt: unknown;
  readonly deletedAt: unknown;
};

/** Resolve family restores from one environment-scoped index for the archive snapshot. */
export function createArchivedThreadRestoreTarget<T extends ArchivedRestoreThread>(
  snapshots: readonly {
    readonly environmentId: string;
    readonly snapshot: { readonly threads: readonly T[] };
  }[],
) {
  const ownersByEnvironment = new Map(
    snapshots.map(({ environmentId, snapshot }) => [
      environmentId,
      new Map(snapshot.threads.map((thread) => [thread.id, thread])),
    ]),
  );
  return (
    thread: Omit<ArchivedFamilyThread, "id"> & {
      readonly id: T["id"];
      readonly environmentId: string;
    },
  ): T["id"] => {
    const cohort = thread.archivedWith;
    if (cohort == null || cohort.threadId === thread.id) return thread.id;
    const owner = ownersByEnvironment.get(thread.environmentId)?.get(cohort.threadId);
    return owner &&
      owner.deletedAt === null &&
      owner.archivedAt !== null &&
      owner.archivedWith?.commandId === cohort.commandId
      ? owner.id
      : thread.id;
  };
}

/** Keep each archived cohort beneath its owner, preserving the supplied order. */
export function groupArchivedThreadFamilies<T extends ArchivedFamilyThread>(threads: readonly T[]) {
  const key = (environmentId: string | undefined, threadId: string) =>
    `${environmentId ?? ""}\u0000${threadId}`;
  const threadKey = (thread: T) => key(thread.environmentId, thread.id);
  const byKey = new Map(threads.map((thread) => [threadKey(thread), thread]));
  const childrenByOwner = new Map<string, T[]>();
  const roots: T[] = [];
  for (const thread of threads) {
    const cohort = thread.archivedWith;
    const ownerKey = cohort ? key(thread.environmentId, cohort.threadId) : null;
    const owner = ownerKey === null ? undefined : byKey.get(ownerKey);
    if (
      ownerKey !== null &&
      owner &&
      owner !== thread &&
      owner.archivedWith?.commandId === cohort?.commandId
    ) {
      const children = childrenByOwner.get(ownerKey);
      if (children) children.push(thread);
      else childrenByOwner.set(ownerKey, [thread]);
    } else {
      roots.push(thread);
    }
  }
  return roots.flatMap((root) => [root, ...(childrenByOwner.get(threadKey(root)) ?? [])]);
}
