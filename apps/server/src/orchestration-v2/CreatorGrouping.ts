import type { OrchestrationV2AppThread, OrchestrationV2ServerCommand } from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";

const releaseCommandFields = new Set(["type", "commandId", "threadId", "creatorGrouping"]);

export function isCreatorGroupingReleaseCommand(command: OrchestrationV2ServerCommand): boolean {
  return (
    command.type === "thread.metadata.update" &&
    command.creatorGrouping === "independent" &&
    Object.keys(command).every((key) => releaseCommandFields.has(key))
  );
}

export function isGroupedCreatorThread(thread: OrchestrationV2AppThread): boolean {
  return (
    thread.deletedAt === null &&
    thread.createdBy === "agent" &&
    thread.creatorThreadId !== undefined &&
    thread.creatorGrouping === "grouped" &&
    thread.lineage.parentThreadId === null &&
    thread.lineage.relationshipToParent === null &&
    thread.forkedFrom === null
  );
}

/** Creator history is provenance; releasing placement never stops ordinary work. */
export function releaseCreatorGrouping(thread: OrchestrationV2AppThread, now: DateTime.Utc) {
  return {
    ...thread,
    creatorGrouping: "independent" as const,
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    updatedAt: now,
  };
}
