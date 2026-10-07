import {
  threadRuntimeCanArchive,
  type ThreadRuntimeSummary,
} from "@t3tools/client-runtime/state/models";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { getOwnedThreadFamily } from "@t3tools/contracts";
import { resolveThreadStatus } from "../threads/thread-status";
import { archiveChildNeedsAttention } from "@t3tools/client-runtime/state/thread-archive";

/**
 * Archiving may discard queued work, but it must not detach a provider while
 * that provider is still executing a turn.
 */
export function threadCanArchive(runtime: ThreadRuntimeSummary | null | undefined): boolean {
  return threadRuntimeCanArchive(runtime);
}

/** Restore a cascaded archive through its owner; provenance alone does not imply a shared archive. */
export function threadUnarchiveTargetId(
  thread: Pick<EnvironmentThreadShell, "environmentId" | "id" | "archivedWith">,
  archivedThreads: readonly EnvironmentThreadShell[] = [],
) {
  const cohort = thread.archivedWith;
  if (!cohort || cohort.threadId === thread.id) return thread.id;
  const owner = archivedThreads.find(
    (candidate) =>
      candidate.id === cohort.threadId && candidate.environmentId === thread.environmentId,
  );
  return owner?.archivedAt != null &&
    owner.deletedAt === null &&
    owner.archivedWith?.threadId === cohort.threadId &&
    owner.archivedWith.commandId === cohort.commandId
    ? owner.id
    : thread.id;
}

/** Snapshot the environment's owned children so confirmation and command agree. */
export function resolveThreadArchiveFamily(
  threads: readonly EnvironmentThreadShell[],
  thread: EnvironmentThreadShell,
) {
  const familyThreads = threads
    .filter((candidate) => candidate.environmentId === thread.environmentId)
    .map((candidate) => ({ ...candidate, creationSource: candidate.source.creationSource }));
  const family = getOwnedThreadFamily(familyThreads, thread.id);
  const byId = new Map(familyThreads.map((child) => [child.id, child]));
  const keptIds = new Set(family.promotableChildren.map((child) => child.id));
  const isKept = (child: (typeof family.children)[number]): boolean => {
    const visited = new Set<string>();
    let current: typeof child | undefined = child;
    while (current && !visited.has(current.id)) {
      if (keptIds.has(current.id)) return true;
      visited.add(current.id);
      if (current.lineage.parentThreadId === null) return false;
      current = byId.get(current.lineage.parentThreadId);
    }
    return false;
  };
  const activeChildren = family.children.filter(archiveChildNeedsAttention);
  const canKeepSeparately =
    family.promotableChildren.length > 0 && family.protectedChildren.every(isKept);
  const nativeStopCount = family.children.filter(
    (child) => child.creationSource === "provider" && !isKept(child),
  ).length;
  const total = family.children.length;
  const active = activeChildren.length;
  const summary =
    active > 0
      ? `${active} ${active === 1 ? "subagent is still working or needs" : "subagents are still working or need"} your attention. Stop and archive all ${total} with this thread${canKeepSeparately ? ", or keep them running as separate threads" : ""}.`
      : `${total} ${total === 1 ? "subagent belongs" : "subagents belong"} to this thread.`;
  const activeIds = new Set(activeChildren.map((child) => child.id));
  const previewChildren = [
    ...activeChildren,
    ...family.children.filter((child) => !activeIds.has(child.id)),
  ];
  const details = previewChildren
    .slice(0, 3)
    .map(
      (child) =>
        `${child.title || "Untitled thread"} · ${resolveThreadStatus(child)?.label ?? (child.hasActionableProposedPlan ? "Plan ready" : child.pendingBackgroundTasks.length > 0 ? "Working" : "Ready")}`,
    );
  const remaining = previewChildren.length - details.length;
  if (remaining > 0) details.push(`+${remaining} more`);
  return {
    ...family,
    requiresConfirmation: active > 0 || family.protectedChildren.length > 0,
    canStopAndArchive: family.protectedChildren.length === 0,
    canKeepSeparately,
    message: [
      summary,
      details.join("\n"),
      nativeStopCount > 0
        ? `${nativeStopCount} provider ${nativeStopCount === 1 ? "subagent cannot" : "subagents cannot"} run on their own and will stop either way.`
        : null,
      family.protectedChildren.length > 0
        ? canKeepSeparately
          ? "Persistent subagents cannot be archived. Keep running separately preserves them."
          : "Persistent subagents cannot be archived or kept separately. Remove their persistent protection before archiving this thread."
        : null,
      "Reopening restores archived threads. Stopped work won't restart; promoted threads stay separate.",
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}
