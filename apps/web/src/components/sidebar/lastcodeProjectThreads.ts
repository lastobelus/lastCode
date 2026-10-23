import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { threadShellIsVisible } from "@t3tools/client-runtime/state/models";
import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import { getThreadSortTimestamp, sortThreads } from "../../lib/threadSort";
import type { SidebarThreadSummary } from "../../types";
import {
  resolveProjectStatusIndicator,
  resolveThreadLastVisitedAt,
  resolveThreadStatusPill,
} from "../Sidebar.logic";
import {
  lastcodeSidebarInheritedStatus,
  projectLastCodeSidebarFamilies,
} from "../lastcodeSidebarFamilies.logic";

export function projectLastCodeProjectThreads(
  threads: readonly SidebarThreadSummary[],
  sortOrder: SidebarThreadSortOrder,
  options: Omit<Parameters<typeof projectLastCodeSidebarFamilies>[0], "threads">,
) {
  const visibleThreads = sortThreads(threads.filter(threadShellIsVisible), sortOrder);
  const familyProjection = projectLastCodeSidebarFamilies({
    ...options,
    threads: visibleThreads,
  });
  const statusForThread = options.statusForThread ?? (() => null);
  const inheritedStatusForThread = (thread: SidebarThreadSummary) =>
    lastcodeSidebarInheritedStatus(thread, statusForThread(thread));
  const latestTimestamp = visibleThreads.reduce(
    (latest, thread) => Math.max(latest, getThreadSortTimestamp(thread, "updated_at")),
    Number.NEGATIVE_INFINITY,
  );
  return {
    latestThreadTimestamp: Number.isFinite(latestTimestamp)
      ? new Date(latestTimestamp).toISOString()
      : null,
    familyProjection,
    projectStatus: resolveProjectStatusIndicator(visibleThreads.map(inheritedStatusForThread)),
    hiddenThreadStatus: resolveProjectStatusIndicator(
      familyProjection.hiddenThreads.map(inheritedStatusForThread),
    ),
  };
}

export function lastCodeProjectThreadStatus(
  threads: readonly SidebarThreadSummary[],
  localVisits: readonly (string | null)[],
) {
  const visitsByKey = new Map(
    threads.map((thread, index) => [
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      resolveThreadLastVisitedAt(thread.lastVisitedAt, localVisits[index] ?? undefined),
    ]),
  );
  return (thread: SidebarThreadSummary) => {
    const lastVisitedAt = visitsByKey.get(
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
    );
    return resolveThreadStatusPill({
      thread: { ...thread, ...(lastVisitedAt != null ? { lastVisitedAt } : {}) },
    });
  };
}
