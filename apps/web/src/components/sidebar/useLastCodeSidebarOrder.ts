import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { SidebarThreadSummary } from "../../types";
import { useClientSetting } from "../../hooks/useSettings";
import { resolveProjectExpanded, useUiStateStore } from "../../uiStateStore";
import { useLastCodeSidebarFamiliesStore } from "../lastcodeSidebarFamilies.store";
import { lastCodeProjectExpansionPreferenceKeys } from "./useLastCodeProjectHeaderGestures";
import type { indexLastCodeSidebarThreads } from "./lastcodeSidebarProjects";
import { projectLastCodeProjectThreads } from "./lastcodeProjectThreads";
/** Root navigation uses the same pure projection inputs as project-local rendering. */
export function useLastCodeSidebarOrder(
  sortedProjects: readonly SidebarProjectSnapshot[],
  threadsByProjectKey: ReadonlyMap<string, readonly SidebarThreadSummary[]>,
  routeThreadKey: string | null,
  expandedThreadListsByProject: ReadonlySet<string>,
  threadIndex?: ReturnType<typeof indexLastCodeSidebarThreads>,
  threadOnlyProjects: readonly SidebarProjectSnapshot[] = [],
) {
  const collapsedFamiliesByKey = useLastCodeSidebarFamiliesStore((state) => state.collapsedByKey);
  const projectExpandedById = useUiStateStore((state) => state.projectExpandedById);
  const sidebarThreadSortOrder = useClientSetting("sidebarThreadSortOrder");
  const groupingStyle = useClientSetting("legacySidebarThreadGroupingStyle");
  const showFamilyStatusSubheaders = useClientSetting("lastcodeSidebarFamilyStatusSubheaders");
  const sidebarThreadPreviewCount = useClientSetting("sidebarThreadPreviewCount");
  const orderProjectThreads = (project: SidebarProjectSnapshot, projectExpanded: boolean) => {
    const projectThreads = threadsByProjectKey.get(project.projectKey) ?? [];
    return projectLastCodeProjectThreads(projectThreads, sidebarThreadSortOrder, {
      ownership: threadIndex
        ? {
            projectKey: project.projectKey,
            byThreadKey: threadIndex.byThreadKey,
            hiddenThreadKeys: threadIndex.hiddenThreadKeys,
          }
        : undefined,
      collapsedByKey: collapsedFamiliesByKey,
      activeThreadKey: routeThreadKey,
      projectExpanded,
      previewCount: sidebarThreadPreviewCount,
      listExpanded: expandedThreadListsByProject.has(project.projectKey),
      groupingStyle,
      showFamilyStatusSubheaders,
    }).familyProjection.orderedThreadKeys;
  };
  return [
    ...sortedProjects.flatMap((project) =>
      orderProjectThreads(
        project,
        resolveProjectExpanded(
          projectExpandedById,
          lastCodeProjectExpansionPreferenceKeys(project),
        ),
      ),
    ),
    ...threadOnlyProjects.flatMap((project) => orderProjectThreads(project, true)),
  ];
}
