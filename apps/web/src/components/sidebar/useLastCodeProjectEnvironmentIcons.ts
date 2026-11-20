import { useGT } from "gt-react";
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
  const gt = useGT();
  const localSandbox = gt("Local sandbox");
  const remote = gt("Remote", { $context: "environment location" });
  // oxlint-disable-next-line t3code/no-manual-memo -- Keep badge snapshots stable across GT resolver refreshes; the compiler coalesces these computations.
  return useMemo(
    () =>
      projectEnvironmentIconEntries(
        {
          members: project.memberProjects,
          primaryEnvironmentId,
          desktopLocalEnvironmentIds,
          showLocalEnvironmentIcon,
        },
        { localSandbox, remote },
      ).map((entry) => ({
        ...entry,
        color: resolveEnvironmentIconColor(
          environmentIconColors[entry.environmentId],
          knownEnvironmentIds.has(entry.environmentId),
        ),
      })),
    [
      project.memberProjects,
      primaryEnvironmentId,
      desktopLocalEnvironmentIds,
      showLocalEnvironmentIcon,
      localSandbox,
      remote,
      environmentIconColors,
      knownEnvironmentIds,
    ],
  );
}
