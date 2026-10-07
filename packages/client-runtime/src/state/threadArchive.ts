import type { EnvironmentThreadShell } from "./models.ts";
import { threadRuntimeIsActive } from "./models.ts";

/** Every failed participant retries the original owner, including an archived repair owner. */
export function archiveRetryThreadId(
  thread: Pick<EnvironmentThreadShell, "id" | "archivePending">,
) {
  return thread.archivePending?.status === "failed" ? thread.archivePending.threadId : thread.id;
}

/** Ownership release or shutdown must be chosen even when the provider itself is idle. */
export function archiveChildNeedsAttention(
  thread: Pick<
    EnvironmentThreadShell,
    | "runtime"
    | "latestRun"
    | "recovery"
    | "actionResume"
    | "archivePending"
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "hasActionableProposedPlan"
    | "attention"
    | "pendingBackgroundTasks"
  >,
) {
  return (
    threadRuntimeIsActive(thread.runtime) ||
    thread.runtime?.status === "failed" ||
    thread.latestRun?.status === "failed" ||
    (thread.recovery != null && thread.recovery.status !== "recovered") ||
    thread.actionResume?.outcome === "running" ||
    thread.archivePending != null ||
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.hasActionableProposedPlan ||
    thread.attention != null ||
    thread.pendingBackgroundTasks.length > 0
  );
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
    description: `${pending.error ? `${pending.error} ` : ""}Conversations remain visible; some work may have stopped. Choose Archive again to retry.`,
  };
}
