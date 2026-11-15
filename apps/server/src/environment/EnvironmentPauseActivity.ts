import {
  isProviderNativeSubagentThread,
  type OrchestrationV2ThreadShell,
  type RunId,
  type ThreadId,
  TurnId,
  type UpdateDrainBlocker,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import { threadPullRequestKeyOf } from "../sourceControl/threadPullRequests.ts";

export interface PauseCaller {
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly providerSessionId: string;
}

export const EnvironmentPauseCaller = Context.Reference<PauseCaller | null>(
  "t3/environment/EnvironmentPauseCaller",
  { defaultValue: () => null },
);

const callerTurn = (thread: OrchestrationV2ThreadShell, caller: PauseCaller | null) =>
  caller !== null &&
  caller.runId !== null &&
  thread.id === caller.threadId &&
  thread.activeRunId === caller.runId;

export const pauseExecutionBlockers = (
  blockers: ReadonlyArray<UpdateDrainBlocker>,
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  caller: PauseCaller | null,
  previews: ReadonlyArray<{
    readonly threadId: string;
    readonly terminalId: string;
    readonly cleanupPending?: boolean | undefined;
  }>,
) => {
  const currentCaller = threads.some((thread) => callerTurn(thread, caller)) ? caller : null;
  return blockers.filter((blocker) => {
    if (blocker.type === "terminal-process")
      return !previews.some(
        (preview) =>
          !preview.cleanupPending &&
          preview.threadId === blocker.threadId &&
          preview.terminalId === blocker.terminalId,
      );
    if (currentCaller === null || currentCaller.runId === null) return true;
    if (blocker.type === "thread-turn")
      return (
        blocker.threadId !== currentCaller.threadId ||
        blocker.turnId !== TurnId.make(currentCaller.runId)
      );
    // A running caller necessarily owns live provider work. Shutdown is separate
    // work and stays visible, as do the caller's commands, Actions and cleanup.
    return (
      blocker.type !== "provider-runtime" ||
      blocker.providerSessionId !== currentCaller.providerSessionId ||
      blocker.status !== "running"
    );
  });
};

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
  caller: PauseCaller | null = null,
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
      (!callerTurn(thread, caller) &&
        !deferredActivity(thread, deferred) &&
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
