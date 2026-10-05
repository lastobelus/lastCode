import type { OrchestrationV2ThreadRecovery } from "@t3tools/contracts";

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

export function presentThreadRecovery(recovery: OrchestrationV2ThreadRecovery | null | undefined) {
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
    case "failed":
      return {
        ...common,
        title: "Couldn't recover this run",
        description: `${recovery.detail} ${recovery.repairThreadId ? "Open the repair conversation to see its progress." : "Open a new repair conversation using this project’s default provider and model."}`,
        variant: "warning",
        action: recovery.repairThreadId ? "view-repair" : "launch-repair",
        label: recovery.repairThreadId ? "View repair thread" : "Open repair thread",
        busy: false,
      } as const;
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
