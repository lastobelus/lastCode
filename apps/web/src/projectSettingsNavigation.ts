import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  type ProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import type { SidebarProjectSnapshot } from "./sidebarProjectGrouping";

type ProjectCheckout = Pick<EnvironmentProject, "temporary" | "environmentId" | "workspaceRoot">;

export function contextualProjectSettings(
  projectKey: string,
  project: ProjectCheckout | null | undefined,
) {
  if (project?.temporary === true) {
    return {
      to: "/settings/projects" as const,
      search: {
        project: projectKey,
        machine: project.environmentId,
        checkout: derivePhysicalProjectKey(project),
      },
    };
  }
  return { to: "/projects/$projectKey" as const, params: { projectKey } };
}

export function contextualProjectActionTarget(
  group: Pick<SidebarProjectSnapshot, "projectKey" | "displayName" | "environmentId" | "id"> | null,
  project: EnvironmentProject | null,
  settings: ProjectGroupingSettings,
) {
  if (project?.temporary === true) {
    return {
      project,
      key: deriveLogicalProjectKeyFromSettings(project, settings),
      label: project.title,
    };
  }
  return group === null
    ? null
    : { project: group, key: group.projectKey, label: group.displayName };
}
