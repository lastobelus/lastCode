import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { pendingBackgroundTurnItems } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";

type ArchiveControls = Pick<
  OrchestrationV2ThreadProjection,
  "runs" | "runtimeRequests" | "providerThreads" | "providerTurns"
> & {
  readonly thread: Pick<OrchestrationV2ThreadProjection["thread"], "id" | "actionResume">;
} & Partial<Pick<OrchestrationV2ThreadProjection, "turnItems">>;

type ArchiveReplyState = Pick<
  OrchestrationV2ThreadShell,
  "lastVisitedAt" | "status" | "latestRunCompletedAt"
>;

/** Retained failures and recovery metadata are history, rather than work to stop. */
export function hasUnfinishedArchiveWork(projection: ArchiveControls): boolean {
  const ownedProviderThreadIds = new Set(
    projection.providerThreads
      .filter((thread) => thread.appThreadId === projection.thread.id)
      .map((thread) => thread.id),
  );
  return (
    projection.runs.some((run) =>
      ["queued", "preparing", "starting", "running", "waiting"].includes(run.status),
    ) ||
    projection.runtimeRequests.some((request) => request.status === "pending") ||
    projection.providerTurns.some(
      (turn) =>
        (turn.status === "running" || turn.status === "pending") &&
        ownedProviderThreadIds.has(turn.providerThreadId),
    ) ||
    projection.providerThreads.some(
      (thread) =>
        ownedProviderThreadIds.has(thread.id) && (thread.pendingBackgroundTasks?.length ?? 0) > 0,
    ) ||
    pendingBackgroundTurnItems({
      runs: projection.runs,
      turnItems: projection.turnItems ?? [],
    }).length > 0 ||
    projection.thread.actionResume?.outcome === "running"
  );
}

/** Use reply/completion watermarks; unrelated metadata changes never make a reply unread. */
export function hasUnreadArchiveResponse(
  thread: ArchiveReplyState,
  latestAssistantMessageAt: DateTime.Utc | null,
): boolean {
  const timestamps = [
    ...(latestAssistantMessageAt === null ? [] : [latestAssistantMessageAt]),
    ...(thread.status === "completed" && thread.latestRunCompletedAt != null
      ? [thread.latestRunCompletedAt]
      : []),
  ];
  if (timestamps.length === 0) return false;
  // A parent summary has no receipt that the child's response was examined.
  // Never-opened replies stay unread until that conversation records a visit.
  const visitedAt =
    thread.lastVisitedAt == null ? null : DateTime.toEpochMillis(thread.lastVisitedAt);
  return timestamps.some(
    (timestamp) => visitedAt === null || DateTime.toEpochMillis(timestamp) > visitedAt,
  );
}

export function archiveNeedsConfirmation(
  thread: ArchiveReplyState,
  controls: ArchiveControls,
  latestAssistantMessageAt: DateTime.Utc | null,
): boolean {
  return (
    hasUnfinishedArchiveWork(controls) || hasUnreadArchiveResponse(thread, latestAssistantMessageAt)
  );
}

/** Prior parent archive consent covered unread delegated replies, never newly grouped ones. */
export function archiveRepairNeedsConfirmation(
  policy: { readonly unfinished: boolean; readonly unread: boolean },
  originallyOwned: boolean,
): boolean {
  return policy.unfinished || (policy.unread && !originallyOwned);
}
