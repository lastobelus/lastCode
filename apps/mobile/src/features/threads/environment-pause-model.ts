import type { EnvironmentPauseStatus } from "@t3tools/contracts";

export function environmentPauseAvailability(input: {
  readonly enabled: boolean;
  readonly connected: boolean;
  readonly fresh: boolean;
  readonly starting?: boolean;
  readonly status: EnvironmentPauseStatus | null;
}) {
  const session = input.status?.session ?? null;
  const known = input.connected && input.fresh && input.status?.observation === "known";
  const pauseFailed = session?.targets.some((target) => target.pause === "failed") ?? false;
  const ready =
    known && input.status?.quiet === true && session?.phase === "paused" && !pauseFailed;
  const hasSession = session !== null || input.starting === true;
  return {
    visible: input.enabled || hasSession,
    hasSession,
    known,
    ready,
    canStart: input.enabled && input.connected && !hasSession,
    canResume: input.connected && hasSession,
    pauseFailed,
  };
}
