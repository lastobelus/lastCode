import type { OrchestrationV2ThreadRecovery, RunId } from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

/** Only the active incident blocks delivery; retained receipts must not block a new turn. */
export function recoveryQueuesFollowUps(
  recovery: OrchestrationV2ThreadRecovery | null | undefined,
  activeRunId: RunId | null | undefined,
) {
  return (
    activeRunId != null &&
    recovery != null &&
    recovery.runId === activeRunId &&
    recovery.status !== "recovered"
  );
}

/** Only provider-confirmed stale work replaces the ordinary working indicator. */
export function recoverySuppressesWorking(
  recovery: OrchestrationV2ThreadRecovery | null | undefined,
) {
  return (
    recovery?.status === "stale" ||
    recovery?.status === "recovering" ||
    recovery?.status === "failed"
  );
}

export function presentThreadRecovery(
  recovery: OrchestrationV2ThreadRecovery | null | undefined,
  repairThreadAvailable: boolean,
  resolve: MFunctionType = mFallback,
) {
  if (!recovery) return null;
  const common = {
    description: recovery.detail,
    suppressWorking: recoverySuppressesWorking(recovery),
  };
  switch (recovery.status) {
    case "suspect":
      return {
        ...common,
        title: resolve(msg("Still waiting")),
        variant: "info",
        action: "recover",
        label: resolve(msg("Check now")),
        busy: false,
      } as const;
    case "stale":
      return {
        ...common,
        title: resolve(msg("Run stopped responding")),
        variant: "warning",
        action: "recover",
        label: resolve(msg("Recover", { $context: "verb, retry a stopped run" })),
        busy: false,
      } as const;
    case "recovering":
      return {
        ...common,
        title: resolve(msg("Recovering run")),
        variant: "warning",
        action: null,
        label: resolve(msg("Recovering…")),
        busy: true,
      } as const;
    case "recovered":
      return {
        ...common,
        title: resolve(msg("Run recovered")),
        variant: "success",
        action: null,
        label: null,
        busy: false,
      } as const;
    case "failed": {
      const canViewRepairThread = recovery.repairThreadId !== undefined && repairThreadAvailable;
      const repairDescription = canViewRepairThread
        ? resolve(msg("Open the repair conversation to see its progress."))
        : recovery.repairThreadId
          ? resolve(msg("Open a repair conversation to continue investigating this run."))
          : resolve(
              msg(
                "Open a new repair conversation using this project’s default provider and model.",
              ),
            );
      return {
        ...common,
        title: resolve(msg("Couldn't recover this run")),
        description: `${recovery.detail} ${repairDescription}`,
        variant: "warning",
        action: canViewRepairThread ? "view-repair" : "launch-repair",
        label: canViewRepairThread
          ? resolve(msg("View repair thread"))
          : resolve(msg("Open repair thread")),
        busy: false,
      } as const;
    }
  }
}

export function threadRecoveryStatusLabel(
  recovery: OrchestrationV2ThreadRecovery | null | undefined,
  resolve: MFunctionType = mFallback,
) {
  return recovery?.status === "failed"
    ? resolve(msg("Needs repair"))
    : recoverySuppressesWorking(recovery)
      ? resolve(msg("Not responding"))
      : null;
}
