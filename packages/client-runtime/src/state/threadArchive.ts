import type { EnvironmentThreadShell } from "./models.ts";

export const THREAD_ARCHIVE_UPDATE_REQUIRED_MESSAGE =
  "Update this environment's server before archiving thread families safely.";

/** One shared presentation for web and mobile; family membership and activity come from the server. */
export function buildThreadArchiveConfirmation<
  T extends Pick<EnvironmentThreadShell, "id" | "title" | "persistent">,
>(family: {
  readonly threads: readonly T[];
  readonly children: readonly T[];
  readonly activeThreadIds: readonly string[];
  readonly unreadThreadIds: readonly string[];
  readonly protectedChildThreadIds: readonly string[];
  readonly canStopAndArchive: boolean;
}) {
  const activeIds = new Set(family.activeThreadIds);
  const unreadIds = new Set(family.unreadThreadIds);
  const active = activeIds.size > 0;
  const unread = unreadIds.size > 0;
  const blocked = !family.canStopAndArchive;
  const protectedThreads = family.threads.filter((thread) => thread.persistent);
  const summary = blocked
    ? `${protectedThreads.length === 1 ? `${protectedThreads[0]!.title || "This thread"} is` : `${protectedThreads.length} threads are`} persistent and can't be archived. Remove persistent protection, then try again.`
    : active
      ? `${activeIds.size} ${activeIds.size === 1 ? "thread is" : "threads are"} still working. Archiving stops ${activeIds.size === 1 ? "it" : "them"}, cancels pending approvals and queued messages, and archives the whole family.${unread ? " Unread replies stay in archived history." : ""}`
      : `${unreadIds.size} ${unreadIds.size === 1 ? "thread has" : "threads have"} replies you haven't read. Archiving closes the whole family. Replies stay in archived history.`;
  return {
    blocked,
    active,
    description: blocked
      ? summary
      : `${summary} Unarchiving reopens history. Stopped work won't restart.`,
    confirmLabel: active ? "Stop active threads & archive" : "Archive unread threads",
    disposition: active ? ("stop_and_archive" as const) : ("archive_after_review" as const),
    threads: family.threads
      .filter((thread) =>
        blocked ? thread.persistent : activeIds.has(thread.id) || unreadIds.has(thread.id),
      )
      .map((thread) => ({
        thread,
        label: blocked
          ? "Persistent"
          : [
              activeIds.has(thread.id) ? "Working" : null,
              unreadIds.has(thread.id) ? "Unread" : null,
            ]
              .filter(Boolean)
              .join(" · "),
      })),
  };
}

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
