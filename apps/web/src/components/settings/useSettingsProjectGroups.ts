import { useClientSettings } from "../../hooks/useSettings";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useDiscoverableProjects } from "../../hooks/useDiscoverableProjects";
import { useProjects } from "../../state/entities";
import { projectsForSettingsScope } from "@t3tools/client-runtime/state/temporary-projects";
import type { SettingsScopeSearch } from "./settingsScope";

export function useSettingsProjectGroups(selection: SettingsScopeSearch = {}) {
  const projects = useProjects();
  const discoverable = useDiscoverableProjects();
  // Avoid object selector identities that rebuild groups and every settings row on each write.
  const sidebarProjectGroupingMode = useClientSettings(
    (settings) => settings.sidebarProjectGroupingMode,
  );
  const sidebarProjectGroupingOverrides = useClientSettings(
    (settings) => settings.sidebarProjectGroupingOverrides,
  );
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const labels = new Map(environments.map((entry) => [entry.environmentId, entry.label]));
  const settings = { sidebarProjectGroupingMode, sidebarProjectGroupingOverrides };
  return buildSidebarProjectSnapshots({
    projects: projectsForSettingsScope(projects, discoverable, settings, selection),
    settings,
    primaryEnvironmentId,
    resolveEnvironmentLabel: (id) => labels.get(id) ?? null,
  }).sort((a, b) => a.displayName.localeCompare(b.displayName));
}
