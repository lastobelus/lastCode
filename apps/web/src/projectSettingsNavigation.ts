import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { derivePhysicalProjectKey } from "@t3tools/client-runtime/state/project-grouping";

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

export function contextualProjectPin(
  group: Pick<SidebarProjectSnapshot, "memberProjects" | "pinned">,
  project: EnvironmentProject | null,
) {
  return project?.temporary === true
    ? {
        pinned: project.pinnedAt != null,
        memberProjects: group.memberProjects.filter(
          (member) => member.id === project.id && member.environmentId === project.environmentId,
        ),
      }
    : group;
}
