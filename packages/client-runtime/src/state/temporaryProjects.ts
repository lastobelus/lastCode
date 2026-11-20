import { Atom } from "effect/reactivity";
import type { EnvironmentProject } from "./models.ts";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  type ProjectGroupingSettings,
} from "./projectGrouping.ts";

type TemporaryProject = Pick<EnvironmentProject, "temporary">;

export const showTemporaryProjectsAtom = Atom.make(false).pipe(Atom.keepAlive);

export function isTemporaryProject(project: TemporaryProject): boolean {
  return project.temporary === true;
}

/** Filter physical projects before grouping so a temporary checkout cannot surface through a kept one. */
export function discoverableProjects<Project extends TemporaryProject>(
  projects: readonly Project[],
  showTemporary: boolean,
): readonly Project[] {
  return showTemporary || !projects.some(isTemporaryProject)
    ? projects
    : projects.filter((project) => !isTemporaryProject(project));
}

/** An explicit project remains addressable while ordinary discovery is filtered. */
export function withContextualProject<Project>(
  projects: readonly Project[],
  project: Project | undefined,
): readonly Project[] {
  return project === undefined || projects.includes(project) ? projects : [project, ...projects];
}

export function projectsForSettingsScope(
  projects: readonly EnvironmentProject[],
  discoverable: readonly EnvironmentProject[],
  grouping: ProjectGroupingSettings,
  selection: {
    readonly project?: string | null | undefined;
    readonly checkout?: string | null | undefined;
    readonly machine?: string | null | undefined;
  },
): readonly EnvironmentProject[] {
  if (selection.project == null || projects === discoverable) return discoverable;
  const inGroup = (project: EnvironmentProject) =>
    deriveLogicalProjectKeyFromSettings(project, grouping) === selection.project;
  // An ordinary group selection must not add hidden siblings to bulk settings actions.
  if (selection.checkout == null && discoverable.some(inGroup)) return discoverable;
  const explicit = projects.find(
    (project) =>
      inGroup(project) &&
      (selection.checkout == null || derivePhysicalProjectKey(project) === selection.checkout) &&
      (selection.machine == null || project.environmentId === selection.machine),
  );
  return withContextualProject(discoverable, explicit);
}
