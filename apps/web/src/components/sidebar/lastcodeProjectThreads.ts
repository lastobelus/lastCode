import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { threadShellIsVisible } from "@t3tools/client-runtime/state/models";
import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import { sortThreads } from "@t3tools/client-runtime/state/thread-sort";
import type { SidebarThreadSummary } from "../../types";
import {
  resolveProjectStatusIndicator,
  resolveThreadLastVisitedAt,
  resolveThreadStatusPill,
} from "../Sidebar.logic";
import {
  lastcodeSidebarInheritedStatus,
  lastcodeSidebarThreadKey,
  projectLastCodeSidebarFamilies,
} from "../lastcodeSidebarFamilies.logic";
import { getThreadSortTimestamp } from "@t3tools/client-runtime/state/thread-sort";

export function projectLastCodeProjectThreads(
  threads: readonly SidebarThreadSummary[],
  sortOrder: SidebarThreadSortOrder,
  options: Omit<Parameters<typeof projectLastCodeSidebarFamilies>[0], "threads">,
) {
  const hidden = options.ownership?.hiddenThreadKeys;
  const visibleThreads = sortThreads(
    threads.filter((thread) => {
      if (!threadShellIsVisible(thread)) return false;
      if (!hidden?.size) return true;
      const key = lastcodeSidebarThreadKey(thread);
      return key === options.activeThreadKey || !hidden.has(key);
    }),
    sortOrder,
  );
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
