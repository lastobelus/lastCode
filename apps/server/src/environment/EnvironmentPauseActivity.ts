import type { OrchestrationV2ThreadShell, RunId, ThreadId } from "@t3tools/contracts";
import { threadPullRequestKeyOf } from "@t3tools/shared/threadPullRequests";

export const deferredActivity = (
  thread: OrchestrationV2ThreadShell,
  deferred: ReadonlyArray<{ readonly threadId: ThreadId; readonly runId: RunId }>,
) =>
  ["queued", "starting"].includes(thread.activityRunStatus ?? thread.status) &&
  deferred.some(
    (run) => run.threadId === thread.id && run.runId === (thread.activeRunId ?? thread.latestRunId),
  );

export const activeBackgroundWork = (
  thread: OrchestrationV2ThreadShell,
  automationPaused: boolean,
) =>
  (thread.pendingBackgroundTasks ?? []).some(
    (task) =>
      !(
        automationPaused &&
        task.kind === "monitor" &&
        (thread.pullRequests ?? []).some(
          (link) =>
            link.watch != null &&
            task.taskId === `pull-request-watch:${threadPullRequestKeyOf(link)}`,
        )
      ),
  );

export const activeThread = (
  thread: OrchestrationV2ThreadShell,
  deferred: ReadonlyArray<{ readonly threadId: ThreadId; readonly runId: RunId }>,
  automationPaused: boolean,
) =>
  thread.deletedAt == null &&
  ((!deferredActivity(thread, deferred) &&
    (["preparing", "queued", "starting", "running", "waiting"].includes(
      thread.activityRunStatus ?? thread.status,
    ) ||
      thread.activeRunId !== null)) ||
    thread.pendingRuntimeRequest !== null ||
    activeBackgroundWork(thread, automationPaused) ||
    thread.actionResume?.outcome === "running");
