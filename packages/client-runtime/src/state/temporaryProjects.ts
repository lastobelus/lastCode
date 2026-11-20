import { Atom } from "effect/reactivity";
import type { EnvironmentProject } from "./models.ts";

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
