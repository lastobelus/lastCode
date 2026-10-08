import type { EnvironmentThreadShell } from "./models.ts";

export const THREAD_ARCHIVE_UPDATE_REQUIRED_MESSAGE =
  "Update this environment's server before archiving threads and their subagents safely.";

type ArchiveRecoveryThread = Pick<EnvironmentThreadShell, "lineage" | "archivePending"> & {
  readonly id: string;
  readonly environmentId?: string;
  readonly archivedAt: unknown | null;
  readonly deletedAt: unknown | null;
};

/** Keep pending owned archive roots and stranded participants reachable without releasing ownership. */
export function getArchiveRecoveryRows<T extends ArchiveRecoveryThread>(threads: readonly T[]) {
  const key = (environmentId: string | undefined, id: string) =>
    `${environmentId ?? ""}\u0000${id}`;
  const owners = new Map(threads.map((thread) => [key(thread.environmentId, thread.id), thread]));
  return new Set(
    threads.filter((thread) => {
      if (
        thread.archivedAt !== null ||
        thread.deletedAt !== null ||
        !thread.archivePending ||
        thread.lineage.relationshipToParent !== "subagent" ||
        thread.lineage.independent === true
      )
        return false;
      const owner = owners.get(key(thread.environmentId, thread.archivePending.threadId));
      return (
        thread.archivePending.threadId === thread.id ||
        owner === undefined ||
        owner.archivedAt !== null ||
        owner.deletedAt !== null
      );
    }),
  );
}

/** Every failed participant retries the original owner, including an archived repair owner. */
export function archiveRetryThreadId(
  thread: Pick<EnvironmentThreadShell, "id" | "archivePending">,
) {
  return thread.archivePending?.status === "failed" ? thread.archivePending.threadId : thread.id;
}

/** Persisted shutdown progress remains visible after the initiating client disconnects. */
export function presentThreadArchive(thread: Pick<EnvironmentThreadShell, "archivePending">) {
  const pending = thread.archivePending;
  if (!pending) return null;
  if (pending.status === "stopping")
    return {
      status: "archiving" as const,
      label: "Archiving…" as const,
      description: "Stopping provider work before archiving this thread family.",
    };
  return {
    status: "archive-failed" as const,
    label: "Archive failed" as const,
    description: `${pending.error ? `${pending.error} ` : ""}Conversations remain visible; some work may have stopped. Choose Archive again to retry, or dismiss to keep these threads as they are.`,
  };
}
