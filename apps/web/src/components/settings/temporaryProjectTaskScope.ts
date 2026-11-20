import type { EnvironmentId, ScheduledTask } from "@t3tools/contracts";
import { useDiscoverableProjects } from "../../hooks/useDiscoverableProjects";
import { useProjects } from "../../state/entities";
import { matchesScheduledTaskScope } from "./scheduledTasksSettings.logic";
import type { ResolvedSettingsScope } from "./settingsScope";

export function useScheduledTaskProjectChoices(
  scope: ResolvedSettingsScope,
  initialEnvironmentId: EnvironmentId,
  task: ScheduledTask | null,
) {
  const allProjects = useProjects();
  const discoverable = useDiscoverableProjects();
  const available =
    scope.kind === "project" || scope.kind === "checkout" ? scope.members : discoverable;
  const projectsOn = (environmentId: EnvironmentId) => {
    const choices = available.filter(
      (project) =>
        project.environmentId === environmentId &&
        matchesScheduledTaskScope(scope, environmentId, project.id),
    );
    if (
      !task ||
      environmentId !== initialEnvironmentId ||
      choices.some((project) => project.id === task.projectId)
    )
      return choices;
    const destination = allProjects.find(
      (project) => project.environmentId === environmentId && project.id === task.projectId,
    );
    return destination ? [...choices, destination] : choices;
  };
  return { projectsOn, discoverable };
}
