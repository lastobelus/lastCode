import type { OrchestrationV2ThreadShell, RunId, ThreadId } from "@t3tools/contracts";

export function capacityActivity(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  deferred: ReadonlyArray<{ readonly threadId: ThreadId; readonly runId: RunId }>,
  automationPaused: boolean,
) {
  const counts = { runningTurns: 0, startingTurns: 0, heldTurns: 0 };
  const held = new Set(deferred.map((run) => `${run.threadId}:${run.runId}`));
  for (const thread of threads) {
    if (thread.deletedAt != null) continue;
    const status = thread.activityRunStatus ?? thread.status;
    if (
      automationPaused &&
      ["queued", "starting"].includes(status) &&
      held.has(`${thread.id}:${thread.activeRunId ?? thread.latestRunId}`)
    ) {
      counts.heldTurns++;
    } else if (["preparing", "queued", "starting"].includes(status)) {
      counts.startingTurns++;
    } else if (["running", "waiting"].includes(status)) {
      counts.runningTurns++;
    }
  }
  return counts;
}
