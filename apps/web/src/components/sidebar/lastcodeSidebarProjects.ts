import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@t3tools/contracts";
import {
  scopedProjectKey,
  scopeProjectRef,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { threadShellIsVisible } from "@t3tools/client-runtime/state/models";
import { isTemporaryProject } from "@t3tools/client-runtime/state/temporary-projects";
import type { Project, SidebarThreadSummary } from "../../types";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { derivePhysicalProjectKey } from "@t3tools/client-runtime/state/project-grouping";
import { sortScopedProjectsForSidebar } from "../Sidebar.logic";

export function temporaryProjectsWithThreads(
  projects: readonly Project[],
  threads: readonly SidebarThreadSummary[],
  olderCounts: ReadonlyMap<EnvironmentId, ReadonlyMap<ProjectId, number> | undefined>,
): readonly Project[] {
  const loaded = new Set(
    threads
      .filter(threadShellIsVisible)
      .map((thread) => scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId))),
  );
  return projects.filter(
    (project) =>
      isTemporaryProject(project) &&
      (loaded.has(scopedProjectKey(scopeProjectRef(project.environmentId, project.id))) ||
        (olderCounts.get(project.environmentId)?.get(project.id) ?? 0) > 0),
  );
}

/** Pre-resolve known scoped projects once; retain physical-key fallback for missing project records. */
export function createLastCodeSidebarProjectLookup(
  projects: readonly Project[],
  groups: readonly SidebarProjectSnapshot[],
) {
  const groupByPhysicalKey = new Map<string, string>();
  for (const group of groups)
    for (const member of group.memberProjects)
      groupByPhysicalKey.set(member.physicalProjectKey, group.projectKey);
  const groupByScopedRef = new Map<string, string>();
  for (const project of projects) {
    const physicalKey = derivePhysicalProjectKey(project);
    groupByScopedRef.set(
      scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
      groupByPhysicalKey.get(physicalKey) ?? physicalKey,
    );
  }
  return (ref: ScopedProjectRef): string => {
    const key = scopedProjectKey(ref);
    return groupByScopedRef.get(key) ?? groupByPhysicalKey.get(key) ?? key;
  };
}
export function indexLastCodeSidebarThreads(
  threads: readonly SidebarThreadSummary[],
  projectKey: ReturnType<typeof createLastCodeSidebarProjectLookup>,
  hiddenThreadKeys: ReadonlySet<string> = new Set(),
) {
  const byThreadKey = new Map<string, SidebarThreadSummary>();
  const byProjectKey = new Map<string, SidebarThreadSummary[]>();
  for (const thread of threads) {
    byThreadKey.set(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread);
    const key = projectKey(scopeProjectRef(thread.environmentId, thread.projectId));
    const members = byProjectKey.get(key);
    if (members) members.push(thread);
    else byProjectKey.set(key, [thread]);
  }
  return { byThreadKey, byProjectKey, hiddenThreadKeys };
}
export function sortLastCodeSidebarProjects(
  groups: readonly SidebarProjectSnapshot[],
  threads: readonly SidebarThreadSummary[],
  projectKey: ReturnType<typeof createLastCodeSidebarProjectLookup>,
  order: Parameters<typeof sortScopedProjectsForSidebar>[2],
) {
  const byKey = new Map(groups.map((group) => [group.projectKey, group]));
  const sortableThreads = threads.filter(threadShellIsVisible).map((thread) => {
    const key = projectKey(scopeProjectRef(thread.environmentId, thread.projectId));
    return {
      ...thread,
      environmentId: byKey.get(key)?.environmentId ?? thread.environmentId,
      projectId: key as ProjectId,
    };
  });
  return sortScopedProjectsForSidebar(
    groups.map((group) => ({ ...group, id: group.projectKey })),
    sortableThreads,
    order,
  ).flatMap((group) => {
    const snapshot = byKey.get(group.id);
    return snapshot ? [snapshot] : [];
  });
}
