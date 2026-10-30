import type { EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  useEnvironments,
  useEnvironmentProviders,
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
  const providersByEnvironment = useEnvironmentProviders();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const providerEntriesByEnvironmentId = new Map<
    string,
    ReadonlyMap<string, ProviderInstanceEntry>
  >();
  for (const environment of environments) {
    const environmentProviders =
      providersByEnvironment.get(environment.environmentId) ??
      (environment.environmentId === primaryEnvironmentId ? serverProviders : []);
    providerEntriesByEnvironmentId.set(
      environment.environmentId,
      new Map(
        deriveProviderInstanceEntries(environmentProviders).map(
          (entry) => [entry.instanceId as string, entry] as const,
        ),
      ),
    );
  }
  const grouping = deriveEnvironmentGrouping(environments, primaryEnvironmentId);
  const { desktopLocalEnvironmentIds } = grouping;
  const knownEnvironmentIds = new Set(environments.map((environment) => environment.environmentId));
  const projectEnvironments = {
    desktopLocalEnvironmentIds,
    knownEnvironmentIds,
    showLocalEnvironmentIcon,
  };
  const presentation = {
    projectEnvironments,
    providerEntriesByEnvironmentId,
    environmentIconColors,
    providerBadgePreferences,
  };
  return { grouping, presentation };
}

function deriveEnvironmentGrouping(
  environments: readonly EnvironmentPresentation[],
  primaryEnvironmentId: EnvironmentId | null,
) {
  const environmentLabelById = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const scratchWorkspaceRootsByEnvironmentId = new Map(
    environments.flatMap((environment) =>
      environment.serverConfig?.scratchWorkspaceRoot
        ? [[environment.environmentId, environment.serverConfig.scratchWorkspaceRoot] as const]
        : [],
    ),
  );
  const desktopLocalEnvironmentIds = new Set(
    environments
      .filter((environment) => isDesktopLocalConnectionTarget(environment.entry.target))
      .map((environment) => environment.environmentId),
  );
  const wslEnvironmentIds = new Set(
    environments
      .filter((environment) => isWslConnectionTarget(environment.entry.target))
      .map((environment) => environment.environmentId),
  );
  return {
    primaryEnvironmentId,
    scratchWorkspaceRootsByEnvironmentId,
    environmentLabelById,
    desktopLocalEnvironmentIds,
    wslEnvironmentIds,
  };
}
