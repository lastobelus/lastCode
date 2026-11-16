import type {
  ActionResumeState,
  EnvironmentPauseStatus,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";

import { actionResumeStatus, actionWaitPresentation } from "@t3tools/shared/actionResume";

export interface ActionResumeContext {
  readonly action: ActionResumeState;
  readonly followUp: Pick<OrchestrationV2Run, "status" | "queueHeld"> | null;
  readonly hasPendingRequest: boolean;
}

export function threadActionResumeContext(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "runtimeRequests">,
): ActionResumeContext | null {
  const action = projection.thread.actionResume;
  if (!action || action.threadId !== projection.thread.id) return null;
  const followUp = projection.runs.find(
    (run) => run.userMessageId === `action-resume:${action.runId}:follow-up`,
  );
  return {
    action,
    followUp: followUp ? { status: followUp.status, queueHeld: followUp.queueHeld } : null,
    hasPendingRequest: projection.runtimeRequests.some((request) => request.status === "pending"),
  };
}

export function childActionResumeContext(
  shell: OrchestrationV2ThreadShell,
): ActionResumeContext | null {
  const action = shell.actionResume;
  if (
    !action ||
    action.threadId !== shell.id ||
    action.delivery === "delivered" ||
    action.delivery === "disposed"
  )
    return null;
  return { action, followUp: null, hasPendingRequest: shell.pendingRuntimeRequest != null };
}

export function actionResumeEnvironmentPaused(input: {
  readonly connected: boolean;
  readonly supported: boolean;
  readonly known: boolean;
  readonly status: EnvironmentPauseStatus | null;
}): boolean | null {
  if (!input.connected || !input.known) return null;
  if (!input.supported) return false;
  if (input.status === null || input.status.observation !== "known") return null;
  return input.status.session !== null && input.status.session.phase !== "resuming";
}

export function actionResumeWait(
  context: ActionResumeContext | null,
  action: ActionResumeState | null,
  paused: boolean | null,
) {
  const matching = context?.action.runId === action?.runId ? context : null;
  const derived =
    action === null
      ? null
      : actionResumeStatus({
          action,
          environmentPaused: paused ?? false,
          followUp: matching?.followUp,
          hasPendingRequest: matching?.hasPendingRequest ?? false,
        });
  const status = paused === null ? null : derived;
  return {
    status,
    presentation:
      action === null || derived?.state === "follow_up_ended"
        ? null
        : actionWaitPresentation(action, status),
  };
}
