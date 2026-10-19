import {
  environmentPauseResumeComplete,
  type EnvironmentPauseStatus,
  type UpdateDrainBlocker,
} from "@t3tools/contracts";

export function environmentPauseAvailability(input: {
  readonly enabled: boolean;
  readonly connected: boolean;
  readonly fresh: boolean;
  readonly status: EnvironmentPauseStatus | null;
}) {
  const session = input.status?.session ?? null;
  const known = input.connected && input.fresh && input.status?.observation === "known";
  const pauseFailed = session?.targets.some((target) => target.pause === "failed") ?? false;
  const resumeFailed = session?.targets.some((target) => target.resume === "failed") ?? false;
  const pauseSettled = session?.targets.every((target) => target.pause !== "pending") ?? false;
  const showPauseRemaining = session?.phase === "pausing" && input.status?.quiet === false;
  const showRetryPause =
    session !== null && session.phase !== "resuming" && (pauseFailed || showPauseRemaining);
  const ready =
    known && input.status?.quiet === true && session?.phase === "paused" && !pauseFailed;
  const showCancelPause =
    session !== null && session.phase !== "resuming" && pauseSettled && !ready;
  const showPauseAgain =
    input.enabled && session?.phase === "resuming" && environmentPauseResumeComplete(session);
  return {
    visible: input.enabled || session !== null,
    known,
    ready,
    canStart: input.enabled && known && (session === null || showPauseAgain),
    showPauseAgain,
    canPauseAgain: known && showPauseAgain,
    showPauseRemaining,
    showRetryPause,
    canRetryPause: known && showRetryPause,
    showCancelPause,
    canCancelPause: known && showCancelPause,
    canResume:
      session !== null &&
      (session.phase === "resuming" ? known && resumeFailed : ready && !pauseFailed),
    pauseFailed,
    resumeFailed,
  };
}

export function environmentPauseBlockerLabel(blocker: UpdateDrainBlocker) {
  switch (blocker.type) {
    case "thread-turn":
      return "Agent turn";
    case "thread-background":
      return "Background work";
    case "terminal-process":
      return blocker.label || "Terminal process";
    case "provider-runtime":
      return "Provider activity";
    case "thread-cleanup":
      return "Thread cleanup";
    case "provider-teardown":
      return "Provider shutdown";
  }
}
