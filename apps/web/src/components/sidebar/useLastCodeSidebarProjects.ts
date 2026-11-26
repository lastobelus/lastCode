import type { EnvironmentId } from "@t3tools/contracts";
import { useProjects, useThreadShells } from "../../state/entities";
import { useClientSettings, useClientSetting } from "../../hooks/useSettings";
import { useUiStateStore, legacyProjectCwdPreferenceKey } from "../../uiStateStore";
import { getProjectOrderKey, selectProjectGroupingSettings } from "../../logicalProject";
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
  const groups = buildSidebarProjectSnapshots({
    projects: orderedProjects,
    settings,
    primaryEnvironmentId,
    scratchWorkspaceRootsByEnvironmentId,
    resolveEnvironmentLabel: (id) => environmentLabelById.get(id) ?? null,
    isDesktopLocalEnvironment: (id) => desktopLocalEnvironmentIds.has(id),
    isWslEnvironment: (id) => wslEnvironmentIds.has(id),
  });
  const resolveProjectKey = createLastCodeSidebarProjectLookup(orderedProjects, groups);
  const index = indexLastCodeSidebarThreads(threads, resolveProjectKey);
  const sortedProjects = sortLastCodeSidebarProjects(groups, threads, resolveProjectKey, sortOrder);
  const orderedProjectKeys = orderedProjects.map(getProjectOrderKey);
  return { sortedProjects, orderedProjectKeys, resolveProjectKey, index };
}
