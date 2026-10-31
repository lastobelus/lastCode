import {
  getInteractiveThreadParentThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";

const releaseCommandFields = new Set(["type", "commandId", "threadId", "creatorGrouping"]);

export function isCreatorGroupingReleaseCommand(command: OrchestrationV2ServerCommand): boolean {
  return (
    command.type === "thread.metadata.update" &&
    command.creatorGrouping === "independent" &&
    Object.keys(command).every((key) => releaseCommandFields.has(key))
  );
}

export function isGroupedCreatorThread(thread: OrchestrationV2AppThread): boolean {
  return getInteractiveThreadParentThreadId(thread) !== null;
}

/** Creator history is provenance; releasing placement never stops ordinary work. */
export function releaseCreatorGrouping(thread: OrchestrationV2AppThread) {
  return {
    ...thread,
    ...(thread.creatorGrouping === undefined ? {} : { creatorGrouping: "independent" as const }),
    groupedUnderThreadId: null,
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
  };
}
