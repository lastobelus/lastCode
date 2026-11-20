import {
  ThreadId,
  CommandId,
  NodeId,
  RunId,
  RunAttemptId,
  ProjectId,
  EnvironmentId,
} from "./baseSchemas.ts";
import { RuntimeMode, ProviderInteractionMode } from "./providerPolicy.ts";
import * as Schema from "effect/Schema";
import type {
  OrchestrationV2AppThread,
  OrchestrationV2AppThreadLineage,
} from "./orchestrationV2.ts";

/** Idle archive is not consent to stop newly active work; the server rechecks before accepting it. */
export const ThreadArchiveChildDisposition = Schema.Literals([
  "archive_if_idle",
  "archive_after_review",
  "stop_and_archive",
]);
export type ThreadArchiveChildDisposition = typeof ThreadArchiveChildDisposition.Type;
export const ThreadArchivedWith = Schema.Struct({ threadId: ThreadId, commandId: CommandId });
export const ThreadArchiveParticipant = Schema.Struct({
  threadId: ThreadId,
  commandId: CommandId,
  status: Schema.Literals(["stopping", "failed"]),
  error: Schema.optional(Schema.String),
});
/** Only the operation owner stores the family plan; participants hold a compact reference. */
export const ThreadArchiveOperation = Schema.Struct({
  ...ThreadArchiveParticipant.fields,
  /** Missing on deployed plans whose consent covered delegated ownership only. */
  familyVersion: Schema.optional(Schema.Literals([1, 2])),
  includeTypedInThreadIds: Schema.optional(Schema.Array(ThreadId)),
  // Already-deployed pending operations may finish their original promotion plan.
  childDisposition: Schema.Literals([
    "archive_if_idle",
    "archive_after_review",
    "stop_and_archive",
    "promote",
  ]),
  childThreadIds: Schema.Array(ThreadId),
  archiveThreadIds: Schema.Array(ThreadId),
  promoteThreadIds: Schema.Array(ThreadId),
  /** Keeps a limited caller's ceiling across provider shutdown and server recovery. */
  modeLimit: Schema.optional(
    Schema.Struct({ runtimeMode: RuntimeMode, interactionMode: ProviderInteractionMode }),
  ),
});
export const ThreadArchivePending = Schema.Union([
  ThreadArchiveOperation,
  ThreadArchiveParticipant,
]);

export const ThreadArchivePreview = Schema.Struct({
  environmentId: EnvironmentId,
  typedInThreadIds: Schema.Array(ThreadId),
  keptWithTypedInThreadIds: Schema.optional(Schema.Array(ThreadId)),
  threads: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      projectId: ProjectId,
      title: Schema.String,
    }),
  ),
});

export const ThreadArchiveConsultationTarget = Schema.Struct({
  ownerThreadId: ThreadId,
  ownerTitle: Schema.String,
  work: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      taskId: Schema.optional(NodeId),
      runId: Schema.optional(RunId),
      attemptId: Schema.optional(RunAttemptId),
    }),
  ),
  unavailableReason: Schema.optional(Schema.Literals(["busy", "unavailable"])),
});
export type ThreadArchiveConsultationTarget = typeof ThreadArchiveConsultationTarget.Type;

export function getThreadArchivePlan(pending: OrchestrationV2AppThread["archivePending"]) {
  return pending != null && "archiveThreadIds" in pending ? pending : null;
}

/** Descendants reference the operation without copying its family plan. */
export function compactThreadArchiveParticipant(
  pending: OrchestrationV2AppThread["archivePending"],
) {
  if (pending == null) return pending;
  return {
    threadId: pending.threadId,
    commandId: pending.commandId,
    status: pending.status,
    ...(pending.error === undefined ? {} : { error: pending.error }),
  };
}

interface FamilyThread {
  readonly id: ThreadId;
  readonly projectId: OrchestrationV2AppThread["projectId"];
  readonly lineage: OrchestrationV2AppThreadLineage;
  readonly archivedAt: unknown | null;
  readonly deletedAt?: unknown | null;
  readonly persistent?: boolean | undefined;
  readonly creationSource: string;
  readonly createdBy?: string | undefined;
  readonly creatorThreadId?: ThreadId | undefined;
  readonly creatorGrouping?: string | undefined;
  readonly groupedUnderThreadId?: ThreadId | null | undefined;
  readonly forkedFrom?: unknown | null;
}

/** Active delegated lineage is execution ownership, even after its run finishes. */
export function isOwnedSubagentThread(thread: Pick<FamilyThread, "lineage">): boolean {
  return thread.lineage.relationshipToParent === "subagent" && thread.lineage.independent !== true;
}

/** Deployed creator groups remain readable until explicit placement (including null) is written. */
export function getInteractiveThreadParentThreadId(thread: FamilyThread): ThreadId | null {
  if (
    thread.deletedAt != null ||
    isOwnedSubagentThread(thread) ||
    (thread.creationSource === "provider" && thread.lineage.relationshipToParent === "subagent")
  )
    return null;
  if (thread.groupedUnderThreadId !== undefined) return thread.groupedUnderThreadId;
  return thread.createdBy === "agent" &&
    thread.creatorGrouping === "grouped" &&
    thread.lineage.parentThreadId === null &&
    thread.lineage.relationshipToParent === null &&
    thread.forkedFrom == null &&
    thread.lineage.independent !== true
    ? (thread.creatorThreadId ?? null)
    : null;
}

/** Interactive placement needs the parent row to enforce the project boundary. */
export function getArchiveFamilyParentThreadId(
  thread: FamilyThread,
  creator?: Pick<FamilyThread, "id" | "projectId">,
): ThreadId | null {
  if (isOwnedSubagentThread(thread)) return thread.lineage.parentThreadId;
  const parentId = getInteractiveThreadParentThreadId(thread);
  return creator?.id === parentId && creator.projectId === thread.projectId ? parentId : null;
}

/** Forks and explicitly independent branches retain provenance without archive membership. */
export function getOwnedThreadFamily<T extends FamilyThread>(
  threads: ReadonlyArray<T>,
  rootThreadId: ThreadId,
  recordedParentOf?: (thread: T) => ThreadId | null,
) {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const parentsOf = (thread: T) =>
    new Set([
      getArchiveFamilyParentThreadId(thread, byId.get(getInteractiveThreadParentThreadId(thread)!)),
      recordedParentOf?.(thread) ?? null,
    ]);
  const byParent = new Map<ThreadId, T[]>();
  for (const thread of threads) {
    for (const parent of parentsOf(thread)) {
      if (parent === null) continue;
      const siblings = byParent.get(parent) ?? [];
      siblings.push(thread);
      byParent.set(parent, siblings);
    }
  }
  const visited = new Set<ThreadId>([rootThreadId]);
  const children: T[] = [];
  const keptThreadIds = new Set<ThreadId>();
  const visit = (id: ThreadId, kept = false) => {
    for (const child of byParent.get(id) ?? []) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      const live = child.archivedAt === null && child.deletedAt == null;
      const retain = kept || (id === rootThreadId && live && child.creationSource !== "provider");
      if (live) {
        children.push(child);
        if (retain) keptThreadIds.add(child.id);
      }
      visit(child.id, retain);
    }
  };
  visit(rootThreadId);
  const directChildren = children.filter((child) => parentsOf(child).has(rootThreadId));
  const promotableChildren = directChildren.filter((child) => child.creationSource !== "provider");
  const nativeChildren = directChildren.filter((child) => child.creationSource === "provider");
  const protectedChildren = children.filter((child) => child.persistent === true);
  return {
    reachableThreadIds: visited,
    children,
    directChildren,
    promotableChildren,
    nativeChildren,
    protectedChildren,
    keptThreadIds,
  };
}
