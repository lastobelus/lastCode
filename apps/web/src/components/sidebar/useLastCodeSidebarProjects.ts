import { useAtomValue } from "@effect/atom-react";
import {
  discoverableProjects,
  isTemporaryProject,
  showTemporaryProjectsAtom,
} from "@t3tools/client-runtime/state/temporary-projects";
import { threadShellIsVisible } from "@t3tools/client-runtime/state/models";
import { scopeProjectRef, scopedProjectKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMessages } from "gt-react";
import { useProjects, useThreadShells } from "../../state/entities";
import { useClientSettings, useClientSetting } from "../../hooks/useSettings";
import { useUiStateStore, legacyProjectCwdPreferenceKey } from "../../uiStateStore";
import {
  getProjectOrderKey,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { orderItemsByPreferredIds } from "../Sidebar.logic";
import {
  createLastCodeSidebarProjectLookup,
  indexLastCodeSidebarThreads,
  sortLastCodeSidebarProjects,
} from "./lastcodeSidebarProjects";
interface ProjectEnvironments {
  primaryEnvironmentId: EnvironmentId | null;
  scratchWorkspaceRootsByEnvironmentId: ReadonlyMap<EnvironmentId, string>;
  environmentLabelById: ReadonlyMap<EnvironmentId, string>;
  desktopLocalEnvironmentIds: ReadonlySet<EnvironmentId>;
  wslEnvironmentIds: ReadonlySet<EnvironmentId>;
}
/** Collection-only entity selectors and derivation; rows keep their own project-local projections. */
export function useLastCodeSidebarProjects(environments: ProjectEnvironments) {
  const messages = useMessages();
  const projects = useProjects();
  const threads = useThreadShells();
  const preferredIds = useUiStateStore((state) => state.projectOrder);
  const settings = useClientSettings(selectProjectGroupingSettings);
  const sortOrder = useClientSetting("sidebarProjectSortOrder");
  const orderedProjects = orderItemsByPreferredIds({
    items: projects,
    preferredIds,
    getId: getProjectOrderKey,
    getPreferenceIds: (project) => [
      getProjectOrderKey(project),
      legacyProjectCwdPreferenceKey(project.workspaceRoot),
    ],
  });
  const {
    primaryEnvironmentId,
    scratchWorkspaceRootsByEnvironmentId,
    environmentLabelById,
    desktopLocalEnvironmentIds,
    wslEnvironmentIds,
  } = environments;
  const projectGrouping = {
    settings,
    primaryEnvironmentId,
    resolveMessage: messages,
    resolveEnvironmentLabel: (id: EnvironmentId) => environmentLabelById.get(id) ?? null,
    isDesktopLocalEnvironment: (id: EnvironmentId) => desktopLocalEnvironmentIds.has(id),
    isWslEnvironment: (id: EnvironmentId) => wslEnvironmentIds.has(id),
  };
  const visibleProjects = discoverableProjects(
    orderedProjects,
    useAtomValue(showTemporaryProjectsAtom),
  );
  const groups = buildSidebarProjectSnapshots({
    ...projectGrouping,
    projects: visibleProjects,
    scratchWorkspaceRootsByEnvironmentId,
  });
  const projectsWithThreads =
    visibleProjects === orderedProjects
      ? null
      : new Set(
          threads
            .filter(threadShellIsVisible)
            .map((thread) =>
              scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
            ),
        );
  const threadGroups = projectsWithThreads
    ? buildSidebarProjectSnapshots({
        ...projectGrouping,
        projects: orderedProjects.filter(
          (project) =>
            isTemporaryProject(project) &&
            projectsWithThreads.has(
              scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
            ),
        ),
        groupScratchProjects: false,
      }).map((group) => ({ ...group, projectKey: `temporary:${group.projectKey}` }))
    : [];
  const resolveProjectKey = createLastCodeSidebarProjectLookup(orderedProjects, [
    ...groups,
    ...threadGroups,
  ]);
  const index = indexLastCodeSidebarThreads(threads, resolveProjectKey);
  const sortedProjects = sortLastCodeSidebarProjects(groups, threads, resolveProjectKey, sortOrder);
  const threadOnlyProjects = threadGroups.length
    ? sortLastCodeSidebarProjects(threadGroups, threads, resolveProjectKey, sortOrder)
    : [];
  const orderedProjectKeys = orderedProjects.map(getProjectOrderKey);
  return { sortedProjects, threadOnlyProjects, orderedProjectKeys, resolveProjectKey, index };
}
