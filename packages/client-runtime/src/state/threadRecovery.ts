import type { OrchestrationV2ThreadRecovery, RunId } from "@t3tools/contracts";

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
        title: "Still waiting",
        variant: "info",
        action: "recover",
        label: "Check now",
        busy: false,
      } as const;
    case "stale":
      return {
        ...common,
        title: "Run stopped responding",
        variant: "warning",
        action: "recover",
        label: "Recover",
        busy: false,
      } as const;
    case "recovering":
      return {
        ...common,
        title: "Recovering run",
        variant: "warning",
        action: null,
        label: "Recovering…",
        busy: true,
      } as const;
    case "recovered":
      return {
        ...common,
        title: "Run recovered",
        variant: "success",
        action: null,
        label: null,
        busy: false,
      } as const;
    case "failed": {
      const canViewRepairThread = recovery.repairThreadId !== undefined && repairThreadAvailable;
      const repairDescription = canViewRepairThread
        ? "Open the repair conversation to see its progress."
        : recovery.repairThreadId
          ? "Open a repair conversation to continue investigating this run."
          : "Open a new repair conversation using this project’s default provider and model.";
      return {
        ...common,
        title: "Couldn't recover this run",
        description: `${recovery.detail} ${repairDescription}`,
        variant: "warning",
        action: canViewRepairThread ? "view-repair" : "launch-repair",
        label: canViewRepairThread ? "View repair thread" : "Open repair thread",
        busy: false,
      } as const;
    }
  }
}

export function threadRecoveryStatusLabel(
  recovery: OrchestrationV2ThreadRecovery | null | undefined,
) {
  return recovery?.status === "failed"
    ? "Needs repair"
    : recoverySuppressesWorking(recovery)
      ? "Not responding"
      : null;
}
