import { useClientSetting } from "../../hooks/useSettings";
import type { EnvironmentIconColor } from "@t3tools/contracts/settings";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { shouldShowInstanceBadge } from "../../providerInstances";
import { getTriggerDisplayModelLabel } from "../chat/providerIconUtils";
import {
  legacyThreadEnvironmentPresentation,
  resolveEnvironmentIconColor,
} from "../../environmentIcons";
import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { useEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import type { LastCodeSidebarFamilyRow } from "../lastcodeSidebarFamilies.logic";
import type { SidebarProviderBadgePreferences } from "./SidebarEnvironmentIcon";
export function useLastCodeThreadIdentity(
  family: LastCodeSidebarFamilyRow,
  providerEntriesByEnvironmentId: ReadonlyMap<string, ReadonlyMap<string, ProviderInstanceEntry>>,
  configuredEnvironmentIconColor: EnvironmentIconColor | undefined,
  providerBadgePreferences: SidebarProviderBadgePreferences,
) {
  const thread = family.thread;
  const showLocalEnvironmentIcon = useClientSetting("showLocalEnvironmentIcon");
  const environment = useEnvironment(thread.environmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // No primary (the hosted app) means every thread is remote, and the machine
  // glyph is what tells the environments apart.
  const isRemoteThread = thread.environmentId !== primaryEnvironmentId;
  const remoteEnvLabel = environment?.label ?? null;
  // A desktop-local secondary backend (e.g. the WSL backend) shows up as a
  // bearer environment whose connection id is prefixed "local:". It runs on the
  // user's own machine, so a remote-server icon is misleading — label it "Local" and
  // suppress the row icon (the project header already shows a container icon
  // for desktop-local projects, see sidebarProjectGrouping).
  const isDesktopLocalThread =
    environment !== null && isDesktopLocalConnectionTarget(environment.entry.target);
  const environmentPresentation = legacyThreadEnvironmentPresentation({
    isPrimary: !isRemoteThread,
    isDesktopLocal: isDesktopLocalThread,
    showLocalEnvironmentIcon: showLocalEnvironmentIcon || providerBadgePreferences.enabled,
    environmentLabel: remoteEnvLabel,
  });
  const decoration = resolveThreadEnvironmentDecoration(
    family,
    environmentPresentation,
    providerBadgePreferences.enabled,
    remoteEnvLabel,
  );
  const environmentIconColor = resolveEnvironmentIconColor(
    configuredEnvironmentIconColor,
    environment !== null && !isDesktopLocalThread,
  );
  const providerIdentity = resolveThreadProviderIdentity(thread, providerEntriesByEnvironmentId);
  return { ...decoration, environmentIconColor, ...providerIdentity };
}

/** Family rows suppress repeated environment labels; provider badges explicitly opt back in. */
function resolveThreadEnvironmentDecoration(
  family: LastCodeSidebarFamilyRow,
  presentation: ReturnType<typeof legacyThreadEnvironmentPresentation>,
  showProviderBadge: boolean,
  remoteEnvLabel: string | null,
) {
  if (showProviderBadge) {
    return {
      showsThreadEnvironmentIcon: true,
      threadEnvironmentLabel: presentation.hoverLabel ?? remoteEnvLabel ?? "Local",
    };
  }
  const thread = family.thread;
  const independent =
    thread.lineage.relationshipToParent !== "subagent" || thread.lineage.independent === true;
  return {
    showsThreadEnvironmentIcon:
      presentation.showRowIcon && family.parentKey === null && independent,
    threadEnvironmentLabel: family.parentKey !== null ? null : presentation.hoverLabel,
  };
}

/** Provider identity always comes from the thread's owning environment, including runtime overrides. */
function resolveThreadProviderIdentity(
  thread: LastCodeSidebarFamilyRow["thread"],
  providerEntriesByEnvironmentId: ReadonlyMap<string, ReadonlyMap<string, ProviderInstanceEntry>>,
) {
  const modelInstanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  const environmentProviderEntries = providerEntriesByEnvironmentId.get(thread.environmentId);
  const providerEntry = environmentProviderEntries?.get(modelInstanceId) ?? null;
  const showInstanceBadge =
    providerEntry !== null &&
    shouldShowInstanceBadge(providerEntry, environmentProviderEntries?.values() ?? []);
  const selectedModel = providerEntry?.models.find(
    (model) => model.slug === thread.modelSelection.model,
  );
  const modelLabel = selectedModel
    ? getTriggerDisplayModelLabel(selectedModel)
    : thread.modelSelection.model;
  return { modelInstanceId, providerEntry, showInstanceBadge, modelLabel };
}

export type LastCodeThreadIdentity = ReturnType<typeof useLastCodeThreadIdentity>;
