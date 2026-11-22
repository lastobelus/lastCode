import { useAtomValue } from "@effect/atom-react";
import {
  discoverableProjects,
  showTemporaryProjectsAtom,
} from "@t3tools/client-runtime/state/temporary-projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useProjects } from "../state/entities";

export function useProjectPickerGroups<Group>(
  projects: readonly EnvironmentProject[],
  buildGroups: (projects: readonly EnvironmentProject[]) => Group[],
) {
  const showTemporary = useAtomValue(showTemporaryProjectsAtom);
  const discoverable = discoverableProjects(projects, showTemporary);
  const projectGroups = buildGroups(projects);
  // Keep contextual actions on the full set and group picker candidates after filtering.
  return {
    projectGroups,
    pickerGroups: discoverable === projects ? projectGroups : buildGroups(discoverable),
  };
}

type DraftProject = Pick<EnvironmentProject, "environmentId" | "id" | "temporary">;

export function draftProjectChoices<Project extends DraftProject>(
  projects: readonly Project[],
  showTemporary: boolean,
  activeProject: Project | null,
): readonly Project[] {
  const discoverable = discoverableProjects(projects, showTemporary);
  if (activeProject?.temporary !== true) return discoverable;
  return [
    activeProject,
    ...discoverable.filter(
      (project) =>
        project.environmentId !== activeProject.environmentId || project.id !== activeProject.id,
    ),
  ];
}

export function useDraftProjectChoices(activeProject: EnvironmentProject | null) {
  const projects = useProjects();
  return draftProjectChoices(projects, useAtomValue(showTemporaryProjectsAtom), activeProject);
}
