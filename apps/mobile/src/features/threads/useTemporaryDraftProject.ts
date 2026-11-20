import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { withContextualProject } from "@t3tools/client-runtime/state/temporary-projects";
import { useState } from "react";

import { scopedProjectKey } from "../../lib/scopedEntities";
import { resolveEnvironmentProjectMatch } from "./new-task-project-selection";

/** Remember the exact temporary checkout while switching machines in an explicitly opened draft. */
export function useTemporaryDraftProject(
  flowKey: string,
  projects: readonly EnvironmentProject[],
  discoverable: readonly EnvironmentProject[],
  selectedProject: EnvironmentProject | null,
) {
  const [origin, setOrigin] = useState<{ flowKey: string; projectKey: string } | null>(null);
  const contextualProject =
    selectedProject?.temporary === true
      ? selectedProject
      : origin?.flowKey === flowKey
        ? projects.find(
            (project) => scopedProjectKey(project.environmentId, project.id) === origin.projectKey,
          )
        : undefined;
  const environmentProjects = withContextualProject(discoverable, contextualProject);
  return {
    environmentProjects,
    clearOrigin: () => setOrigin(null),
    selectEnvironment: (environmentId: EnvironmentId) => {
      const match =
        contextualProject?.environmentId === environmentId
          ? contextualProject
          : resolveEnvironmentProjectMatch(
              environmentProjects.filter((project) => project.environmentId === environmentId),
              selectedProject,
            );
      if (match && selectedProject?.temporary === true) {
        setOrigin({
          flowKey,
          projectKey: scopedProjectKey(selectedProject.environmentId, selectedProject.id),
        });
      }
      return match;
    },
  };
}
