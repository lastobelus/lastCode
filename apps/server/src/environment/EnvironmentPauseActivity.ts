import {
  isProviderNativeSubagentThread,
  type OrchestrationV2ThreadShell,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { threadPullRequestKeyOf } from "../sourceControl/threadPullRequests.ts";

export const deferredActivity = (
  thread: OrchestrationV2ThreadShell,
  deferred: ReadonlyArray<{ readonly threadId: ThreadId; readonly runId: RunId }>,
) =>
  ["queued", "starting"].includes(thread.activityRunStatus ?? thread.status) &&
  deferred.some(
    (run) => run.threadId === thread.id && run.runId === (thread.activeRunId ?? thread.latestRunId),
  );

export const pauseActivity = (
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  deferred: ReadonlyArray<{ readonly threadId: ThreadId; readonly runId: RunId }>,
  automationPaused: boolean,
) => {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const activity = new Map<ThreadId, boolean>();

  const activeBackgroundWork = (
    thread: OrchestrationV2ThreadShell,
    ancestors: ReadonlySet<ThreadId>,
  ): boolean =>
    (thread.pendingBackgroundTasks ?? []).some((task) => {
      if (!automationPaused) return true;
      if (
        task.kind === "monitor" &&
        (thread.pullRequests ?? []).some(
          (link) =>
            link.watch != null &&
            task.taskId === `pull-request-watch:${threadPullRequestKeyOf(link)}`,
        )
      )
        return false;
      if (task.kind !== "subagent" || task.childThreadId === undefined) return true;
      const child = byId.get(task.childThreadId);
      // A task stays unfinished while its child's continuation is held by Pause. That
      // obligation is not execution; missing, foreign or cyclic dependencies stay active.
      if (
        child === undefined ||
        child.deletedAt != null ||
        isProviderNativeSubagentThread(child) ||
        child.lineage.parentThreadId !== thread.id ||
        child.lineage.relationshipToParent !== "subagent"
      )
        return true;
      return activeThread(child, ancestors);
    });

  const activeThread = (
    thread: OrchestrationV2ThreadShell,
    ancestors: ReadonlySet<ThreadId>,
  ): boolean => {
    if (thread.deletedAt != null) return false;
    const cached = activity.get(thread.id);
    if (cached !== undefined) return cached;
    if (ancestors.has(thread.id)) return true;
    const active =
      (!deferredActivity(thread, deferred) &&
        (["preparing", "queued", "starting", "running", "waiting"].includes(
          thread.activityRunStatus ?? thread.status,
        ) ||
          thread.activeRunId !== null)) ||
      thread.pendingRuntimeRequest !== null ||
      thread.actionResume?.outcome === "running" ||
      activeBackgroundWork(thread, new Set([...ancestors, thread.id]));
    activity.set(thread.id, active);
    return active;
  };

  return {
    activeThread: (thread: OrchestrationV2ThreadShell) => activeThread(thread, new Set()),
    activeBackgroundWork: (thread: OrchestrationV2ThreadShell) =>
      activeBackgroundWork(thread, new Set([thread.id])),
  };
};
