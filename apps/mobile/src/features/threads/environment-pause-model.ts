import type { EnvironmentPauseStatus } from "@t3tools/contracts";

export function environmentPauseAvailability(input: {
  readonly enabled: boolean;
  readonly connected: boolean;
  readonly fresh: boolean;
  readonly intent?: "start" | "resume" | null;
  readonly status: EnvironmentPauseStatus | null;
}) {
  const session = input.status?.session ?? null;
  const known = input.connected && input.fresh && input.status?.observation === "known";
  const pauseFailed = session?.targets.some((target) => target.pause === "failed") ?? false;
  const ready =
    known && input.status?.quiet === true && session?.phase === "paused" && !pauseFailed;
  const hasSession = session !== null || input.intent != null;
  const primaryAction =
    input.intent === "start" ||
    (input.intent !== "resume" && session !== null && session.phase !== "resuming")
      ? ("resume" as const)
      : ("start" as const);
  const showRetryPause =
    session !== null &&
    session.phase !== "resuming" &&
    (pauseFailed || input.status?.quiet !== true) &&
    input.intent !== "resume";
  return {
    visible: input.enabled || hasSession,
    hasSession,
    primaryAction,
    known,
    ready,
    canStart: input.enabled && input.connected && primaryAction === "start",
    canResume: input.connected && hasSession,
    pauseFailed,
    showRetryPause,
    canRetryPause: input.connected && showRetryPause,
  };
}
