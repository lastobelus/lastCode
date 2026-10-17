import { useMemo } from "react";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { projectEnvironmentIconEntries, resolveEnvironmentIconColor } from "../../environmentIcons";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useLastCodeSidebarPresentation } from "./LastCodeSidebarPresentation";
export function useLastCodeProjectEnvironmentIcons(project: SidebarProjectSnapshot) {
  const { environmentIconColors, projectEnvironments } = useLastCodeSidebarPresentation();
  const { desktopLocalEnvironmentIds, knownEnvironmentIds, showLocalEnvironmentIcon } =
    projectEnvironments;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return useMemo(
    () =>
      projectEnvironmentIconEntries({
        members: project.memberProjects,
        primaryEnvironmentId,
        desktopLocalEnvironmentIds,
        showLocalEnvironmentIcon,
      }).map((entry) => ({
        ...entry,
        color: resolveEnvironmentIconColor(
          environmentIconColors[entry.environmentId],
          knownEnvironmentIds.has(entry.environmentId),
        ),
      })),
    [
      primaryEnvironmentId,
      project.memberProjects,
      desktopLocalEnvironmentIds,
      showLocalEnvironmentIcon,
      environmentIconColors,
      knownEnvironmentIds,
    ],
  );
}
