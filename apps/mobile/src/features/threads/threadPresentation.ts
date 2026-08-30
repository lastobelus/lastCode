import type { StatusTone } from "../../components/StatusPill";
import type { OrchestrationLatestTurn, OrchestrationSession } from "@t3tools/contracts";
import { actionRunningPresentation } from "@t3tools/shared/actionResume";
import { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

export type ThreadStatusKind =
  | "pending-approval"
  | "awaiting-input"
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
  /** Foreground color for the leading status icon. */
  readonly iconColor: string;
  /** Background color for the leading status icon circle. */
  readonly iconBackground: string;
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

function isLatestTurnSettled(
  latestTurn: OrchestrationLatestTurn | null,
  session: OrchestrationSession | null,
): boolean {
  if (!latestTurn?.startedAt) return false;
  if (!latestTurn.completedAt) return false;
  if (!session) return true;
  return session.status !== "running";
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
      iconColor: "#ff453a",
      iconBackground: "rgba(255,69,58,0.22)",
      pulse: false,
    };
  }

  if (thread.worktreeCleanup?.status === "queued") {
    return {
      kind: "cleanup-queued",
      label: "Deleting (Queued)",
      pillClassName: "bg-adaptive-orange-500-a12-a16",
      textClassName: "text-adaptive-orange-700-300",
      iconColor: "#ff9f0a",
      iconBackground: "rgba(255,159,10,0.22)",
      pulse: false,
    };
  }

  if (thread.worktreeCleanup?.status === "deleting") {
    return {
      kind: "cleanup-deleting",
      label: "Deleting",
      pillClassName: "bg-adaptive-orange-500-a12-a16",
      textClassName: "text-adaptive-orange-700-300",
      iconColor: "#ff9f0a",
      iconBackground: "rgba(255,159,10,0.22)",
      pulse: false,
    };
  }

  if (thread.hasPendingApprovals) {
    return {
      kind: "pending-approval",
      label: "Needs Approval",
      pillClassName: "bg-adaptive-amber-500-a12-a16",
      textClassName: "text-adaptive-amber-700-300",
      iconColor: "#ff9f0a",
      iconBackground: "rgba(255,159,10,0.22)",
      pulse: false,
    };
  }

  if (thread.hasPendingUserInput) {
    return {
      kind: "awaiting-input",
      label: "Awaiting Input",
      pillClassName: "bg-adaptive-indigo-500-a12-a16",
      textClassName: "text-adaptive-indigo-700-300",
      iconColor: "#5e5ce6",
      iconBackground: "rgba(94,92,230,0.22)",
      pulse: false,
    };
  }

  if (thread.session?.status === "running") {
    return {
      kind: "working",
      label: "Working",
      pillClassName: "bg-adaptive-sky-500-a12-a16",
      textClassName: "text-adaptive-sky-700-300",
      iconColor: "#0a84ff",
      iconBackground: "rgba(10,132,255,0.22)",
      pulse: true,
    };
  }

  if (thread.session?.status === "starting") {
    return {
      kind: "connecting",
      label: "Connecting",
      pillClassName: "bg-adaptive-sky-500-a12-a16",
      textClassName: "text-adaptive-sky-700-300",
      iconColor: "#0a84ff",
      iconBackground: "rgba(10,132,255,0.22)",
      pulse: true,
    };
  }

  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") {
    return {
      kind: "error",
      label: "Error",
      pillClassName: "bg-adaptive-rose-500-a12-a16",
      textClassName: "text-adaptive-rose-700-300",
      iconColor: "#ff453a",
      iconBackground: "rgba(255,69,58,0.22)",
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
      iconColor: action.state === "working" ? "#0a84ff" : "#eab308",
      iconBackground: action.state === "working" ? "rgba(10,132,255,0.22)" : "rgba(234,179,8,0.22)",
      pulse: false,
    };
  }

  const hasPlanReadyPrompt =
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
    thread.hasActionableProposedPlan;
  if (hasPlanReadyPrompt) {
    return {
      kind: "plan-ready",
      label: "Plan Ready",
      pillClassName: "bg-adaptive-violet-500-a12-a16",
      textClassName: "text-adaptive-violet-700-300",
      iconColor: "#bf5af2",
      iconBackground: "rgba(191,90,242,0.22)",
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
