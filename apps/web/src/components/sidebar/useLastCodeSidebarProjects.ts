import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  discoverableProjects,
  isTemporaryProject,
  showTemporaryProjectsAtom,
} from "@t3tools/client-runtime/state/temporary-projects";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMessages } from "gt-react";
import { useProjects, useThreadShells } from "../../state/entities";
import { environmentProjects } from "../../state/projects";
import { olderSettledThreads } from "../../state/threads";
import { useClientSettings, useClientSetting } from "../../hooks/useSettings";
import { useUiStateStore, legacyProjectCwdPreferenceKey } from "../../uiStateStore";
import {
  getProjectOrderKey,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { useLastCodeHiddenThreadKeys } from "./useLastCodeHiddenThreadKeys";
import { orderItemsByPreferredIds } from "../Sidebar.logic";
import {
  createLastCodeSidebarProjectLookup,
  indexLastCodeSidebarThreads,
  sortLastCodeSidebarProjects,
  temporaryProjectsWithThreads,
} from "./lastcodeSidebarProjects";

const olderTemporaryThreadCountsAtom = Atom.make((get) => {
  const hidden = get(showTemporaryProjectsAtom)
    ? []
    : get(environmentProjects.projectsAtom).filter(isTemporaryProject);
  return new Map(
    Array.from(new Set(hidden.map((project) => project.environmentId)), (environmentId) => [
      environmentId,
      get(olderSettledThreads.olderSettledAtom(environmentId))?.counts,
    ]),
  );
});

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
  const olderCounts = useAtomValue(olderTemporaryThreadCountsAtom);
  const threadGroups =
    visibleProjects === orderedProjects
      ? []
      : buildSidebarProjectSnapshots({
          ...projectGrouping,
          projects: temporaryProjectsWithThreads(orderedProjects, threads, olderCounts),
          groupScratchProjects: false,
        }).map((group) => ({ ...group, projectKey: `temporary:${group.projectKey}` }));
  const resolveProjectKey = createLastCodeSidebarProjectLookup(orderedProjects, [
    ...groups,
    ...threadGroups,
  ]);
  const hiddenThreadKeys = useLastCodeHiddenThreadKeys(threads);
  const index = indexLastCodeSidebarThreads(threads, resolveProjectKey, hiddenThreadKeys);
  const sortedProjects = sortLastCodeSidebarProjects(groups, threads, resolveProjectKey, sortOrder);
  const threadOnlyProjects = threadGroups.length
    ? sortLastCodeSidebarProjects(threadGroups, threads, resolveProjectKey, sortOrder)
    : [];
  const orderedProjectKeys = orderedProjects.map(getProjectOrderKey);
  return { sortedProjects, threadOnlyProjects, orderedProjectKeys, resolveProjectKey, index };
}
