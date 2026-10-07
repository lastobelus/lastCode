import { threadRecoveryStatusLabel } from "@t3tools/client-runtime/state/thread-recovery";
import type { StatusTone } from "../../components/StatusPill";
import {
  threadRuntimeIsActive,
  type ThreadRunSummary,
  type ThreadRuntimeSummary,
} from "@t3tools/client-runtime/state/models";
import { actionRunningPresentation } from "@t3tools/shared/actionResume";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

export type ThreadStatusKind =
  | "pending-approval"
  | "awaiting-input"
  | "question"
  | "not-responding"
  | "needs-repair"
  | "working"
  | "waiting"
  | "connecting"
  | "error"
  | "cleanup-deleting"
  | "cleanup-queued"
  | "cleanup-failed"
  | "plan-ready";

export interface ThreadStatusPresentation extends StatusTone {
  readonly kind: ThreadStatusKind;
  /** Whether the indicator represents in-flight activity. */
  readonly pulse: boolean;
}

export function shouldShowActionWaitingIndicator(
  thread: Pick<EnvironmentThreadShell, "actionResume">,
  primaryStatus: string | null,
): boolean {
  return (
    thread.actionResume?.outcome === "running" &&
    actionRunningPresentation(thread.actionResume).state === "waiting" &&
    primaryStatus !== "waiting"
  );
}

function isLatestRunSettled(
  latestRun: ThreadRunSummary | null,
  runtime: ThreadRuntimeSummary | null,
): boolean {
  if (!latestRun?.startedAt) return false;
  if (!latestRun.completedAt) return false;
  return !threadRuntimeIsActive(runtime);
}

/**
 * Resolves the user-facing status of a thread, in priority order. Returns
 * `null` for quiescent threads so rows stay free of "Idle"-style noise.
 * Mirrors `resolveThreadStatusPill` in apps/web/src/components/Sidebar.logic.ts.
 */
export function resolveThreadStatus(
  thread: EnvironmentThreadShell,
): ThreadStatusPresentation | null {
  if (thread.worktreeCleanup?.status === "failed") {
    return {
      kind: "cleanup-failed",
      label: "Cleanup failed",
      pillClassName: "bg-adaptive-rose-500-a12-a16",
      textClassName: "text-adaptive-rose-700-300",
      pulse: false,
    };
  }

  if (thread.worktreeCleanup?.status === "queued") {
    return {
      kind: "cleanup-queued",
      label: "Deleting (Queued)",
      pillClassName: "bg-adaptive-orange-500-a12-a16",
      textClassName: "text-adaptive-orange-700-300",
      pulse: false,
    };
  }

  if (thread.worktreeCleanup?.status === "deleting") {
    return {
      kind: "cleanup-deleting",
      label: "Deleting",
      pillClassName: "bg-adaptive-orange-500-a12-a16",
      textClassName: "text-adaptive-orange-700-300",
      pulse: false,
    };
  }

  const recoveryLabel = threadRecoveryStatusLabel(thread.recovery);
  if (recoveryLabel)
    return {
      kind: recoveryLabel === "Needs repair" ? "needs-repair" : "not-responding",
      label: recoveryLabel,
      pillClassName: "bg-warning",
      textClassName: "text-warning-foreground",
      pulse: false,
    };

  if (thread.hasPendingApprovals) {
    return {
      kind: "pending-approval",
      label: "Needs Approval",
      pillClassName: "bg-warning",
      textClassName: "text-warning-foreground",
      pulse: false,
    };
  }

  if (thread.hasPendingUserInput) {
    return {
      kind: "awaiting-input",
      label: "Awaiting Input",
      pillClassName: "bg-adaptive-indigo-500-a12-a16",
      textClassName: "text-adaptive-indigo-600-300",
      pulse: false,
    };
  }

  if (thread.attention?.kind === "question") {
    return {
      kind: "question",
      label: "Question",
      pillClassName: "bg-adaptive-violet-500-a12-a16",
      textClassName: "text-adaptive-violet-700-300",
      pulse: false,
    };
  }

  if (thread.runtime?.status === "running" || thread.runtime?.status === "waiting") {
    return {
      kind: "working",
      label: "Working",
      pillClassName: "bg-adaptive-sky-500-a12-a16",
      textClassName: "text-adaptive-sky-600-400",
      pulse: true,
    };
  }

  if (
    thread.runtime?.status === "preparing" ||
    thread.runtime?.status === "queued" ||
    thread.runtime?.status === "starting"
  ) {
    return {
      kind: "connecting",
      label: "Connecting",
      pillClassName: "bg-adaptive-sky-500-a12-a16",
      textClassName: "text-adaptive-sky-600-400",
      pulse: true,
    };
  }

  if (thread.runtime?.status === "failed" || thread.latestRun?.status === "failed") {
    return {
      kind: "error",
      label: "Error",
      pillClassName: "bg-danger",
      textClassName: "text-danger-foreground",
      pulse: false,
    };
  }

  if (thread.actionResume?.outcome === "running") {
    const action = actionRunningPresentation(thread.actionResume);
    return {
      kind: action.state,
      label: action.label,
      pillClassName:
        action.state === "working"
          ? "bg-adaptive-sky-500-a12-a16"
          : "bg-adaptive-yellow-500-a12-a16",
      textClassName:
        action.state === "working" ? "text-adaptive-sky-700-300" : "text-adaptive-yellow-700-300",
      pulse: false,
    };
  }

  const hasPlanReadyPrompt =
    thread.interactionMode === "plan" &&
    isLatestRunSettled(thread.latestRun, thread.runtime) &&
    thread.hasActionableProposedPlan;
  if (hasPlanReadyPrompt) {
    return {
      kind: "plan-ready",
      label: "Plan Ready",
      pillClassName: "bg-adaptive-violet-500-a12-a16",
      textClassName: "text-adaptive-violet-600-400",
      pulse: false,
    };
  }

  return null;
}

/**
 * Returns the durable cleanup status when a thread is being deleted. Mobile
 * list variants use this shared presentation so cleanup state cannot fall
 * through to the ordinary agent-status labels.
 */
export function resolveWorktreeCleanupStatus(
  thread: EnvironmentThreadShell,
): ThreadStatusPresentation | null {
  if (thread.worktreeCleanup == null) return null;
  const status = resolveThreadStatus(thread);
  return status?.kind === "cleanup-failed" ||
    status?.kind === "cleanup-queued" ||
    status?.kind === "cleanup-deleting"
    ? status
    : null;
}
