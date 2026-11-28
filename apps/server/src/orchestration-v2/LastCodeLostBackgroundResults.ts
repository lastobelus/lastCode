import type { OrchestrationV2RestartCancelledBackgroundWork } from "@t3tools/contracts";

type Work = OrchestrationV2RestartCancelledBackgroundWork;

export function lostBackgroundResultWork(taskId: string): Work {
  return {
    kind: "task",
    label: `Background command result delivery (id ${taskId.slice(0, 118).toWellFormed()})`,
    id: taskId,
    awaited: true,
    resultDeliveryLost: true,
  };
}

export function hasLostBackgroundResult(work: ReadonlyArray<Work> | undefined): boolean {
  return work?.some((entry) => entry.resultDeliveryLost === true) ?? false;
}

export function lostBackgroundResultNote(cause: string): string {
  return `Note: ${cause} while background work was pending. Some results did not reach you. Check recorded outcomes or verify what took effect before reporting success or repeating any work. Resume interrupted work that still needs to finish.`;
}
