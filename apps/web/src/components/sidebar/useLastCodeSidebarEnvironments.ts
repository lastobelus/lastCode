import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  type EnvironmentPresentation,
} from "../../state/environments";
import { primaryServerProvidersAtom } from "../../state/server";
import { useClientSettings } from "../../hooks/useSettings";
import {
  isDesktopLocalConnectionTarget,
  isWslConnectionTarget,
} from "../../connection/desktopLocal";
import { deriveProviderInstanceEntries, type ProviderInstanceEntry } from "../../providerInstances";
import { useSidebarProviderBadgePreferences } from "./SidebarEnvironmentIcon";

/** Environment-only metadata; grouping and row presentation retain separate stable identities. */
export function useLastCodeSidebarEnvironments() {
  const environmentIconColors = useClientSettings((s) => s.environmentIconColors);
  const showLocalEnvironmentIcon = useClientSettings((s) => s.showLocalEnvironmentIcon);
  const providerBadgePreferences = useSidebarProviderBadgePreferences();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const providerEntriesByEnvironmentId = useMemo(() => {
    const entriesByEnvironmentId = new Map<string, ReadonlyMap<string, ProviderInstanceEntry>>();
    for (const environment of environments) {
      const environmentProviders =
        environment.serverConfig?.providers ??
        (environment.environmentId === primaryEnvironmentId ? serverProviders : []);
      entriesByEnvironmentId.set(
        environment.environmentId,
        new Map(
          deriveProviderInstanceEntries(environmentProviders).map(
            (entry) => [entry.instanceId as string, entry] as const,
          ),
        ),
      );
    }
    return entriesByEnvironmentId;
  }, [environments, primaryEnvironmentId, serverProviders]);
  const grouping = useEnvironmentGrouping(environments, primaryEnvironmentId);
  const { desktopLocalEnvironmentIds } = grouping;
  const knownEnvironmentIds = useMemo(
    () => new Set(environments.map((environment) => environment.environmentId)),
    [environments],
  );
  const projectEnvironments = useMemo(
    () => ({ desktopLocalEnvironmentIds, knownEnvironmentIds, showLocalEnvironmentIcon }),
    [desktopLocalEnvironmentIds, knownEnvironmentIds, showLocalEnvironmentIcon],
  );

  const presentation = useMemo(
    () => ({
      projectEnvironments,
      providerEntriesByEnvironmentId,
      environmentIconColors,
      providerBadgePreferences,
    }),
    [
      projectEnvironments,
      providerEntriesByEnvironmentId,
      environmentIconColors,
      providerBadgePreferences,
    ],
  );
  return { grouping, presentation };
}

function useEnvironmentGrouping(
  environments: readonly EnvironmentPresentation[],
  primaryEnvironmentId: EnvironmentId | null,
) {
  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const scratchWorkspaceRootsByEnvironmentId = useMemo(
    () =>
      new Map(
        environments.flatMap((environment) =>
          environment.serverConfig?.scratchWorkspaceRoot
            ? [[environment.environmentId, environment.serverConfig.scratchWorkspaceRoot] as const]
            : [],
        ),
      ),
    [environments],
  );
  const desktopLocalEnvironmentIds = useMemo(
    () =>
      new Set(
        environments
          .filter((environment) => isDesktopLocalConnectionTarget(environment.entry.target))
          .map((environment) => environment.environmentId),
      ),
    [environments],
  );
  const wslEnvironmentIds = useMemo(
    () =>
      new Set(
        environments
          .filter((environment) => isWslConnectionTarget(environment.entry.target))
          .map((environment) => environment.environmentId),
      ),
    [environments],
  );
  return useMemo(
    () => ({
      primaryEnvironmentId,
      scratchWorkspaceRootsByEnvironmentId,
      environmentLabelById,
      desktopLocalEnvironmentIds,
      wslEnvironmentIds,
    }),
    [
      primaryEnvironmentId,
      scratchWorkspaceRootsByEnvironmentId,
      environmentLabelById,
      desktopLocalEnvironmentIds,
      wslEnvironmentIds,
    ],
  );
}
