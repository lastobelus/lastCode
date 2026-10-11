import { useMemo } from "react";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { SidebarThreadSummary } from "../../types";
import { useClientSetting } from "../../hooks/useSettings";
import { resolveProjectExpanded, useUiStateStore } from "../../uiStateStore";
import { useLastCodeSidebarFamiliesStore } from "../lastcodeSidebarFamilies.store";
import { lastCodeProjectExpansionPreferenceKeys } from "./useLastCodeProjectHeaderGestures";
import { projectLastCodeProjectThreads } from "./lastcodeProjectThreads";
/** Root navigation uses the same pure projection inputs as project-local rendering. */
export function useLastCodeSidebarOrder(
  sortedProjects: readonly SidebarProjectSnapshot[],
  threadsByProjectKey: ReadonlyMap<string, readonly SidebarThreadSummary[]>,
  routeThreadKey: string | null,
  expandedThreadListsByProject: ReadonlySet<string>,
) {
  const collapsedFamiliesByKey = useLastCodeSidebarFamiliesStore((state) => state.collapsedByKey);
  const projectExpandedById = useUiStateStore((state) => state.projectExpandedById);
  const sidebarThreadSortOrder = useClientSetting("sidebarThreadSortOrder");
  const groupingStyle = useClientSetting("legacySidebarThreadGroupingStyle");
  const sidebarThreadPreviewCount = useClientSetting("sidebarThreadPreviewCount");
  return useMemo(
    () =>
      sortedProjects.flatMap((project) => {
        const projectThreads = threadsByProjectKey.get(project.projectKey) ?? [];
        const projectExpanded = resolveProjectExpanded(
          projectExpandedById,
          lastCodeProjectExpansionPreferenceKeys(project),
        );
        return projectLastCodeProjectThreads(projectThreads, sidebarThreadSortOrder, {
          collapsedByKey: collapsedFamiliesByKey,
          activeThreadKey: routeThreadKey,
          projectExpanded,
          previewCount: sidebarThreadPreviewCount,
          listExpanded: expandedThreadListsByProject.has(project.projectKey),
          groupingStyle,
        }).familyProjection.orderedThreadKeys;
      }),
    [
      sidebarThreadSortOrder,
      sidebarThreadPreviewCount,
      collapsedFamiliesByKey,
      groupingStyle,
      expandedThreadListsByProject,
      projectExpandedById,
      routeThreadKey,
      sortedProjects,
      threadsByProjectKey,
    ],
  );
}
