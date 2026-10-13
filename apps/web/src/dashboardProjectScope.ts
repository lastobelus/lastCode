import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

/** A dashboard's URL names one physical project; never resolve an id across environments. */
export function resolveDashboardProjectRef(
  location: { readonly pathname: string; readonly search: Readonly<Record<string, unknown>> },
  projects: ReadonlyArray<{ readonly id: ProjectId; readonly environmentId: EnvironmentId }>,
) {
  if (location.pathname !== "/dashboard") return null;
  const { environmentId, projectId } = location.search;
  if (typeof environmentId !== "string" || typeof projectId !== "string") return null;
  const project = projects.find(
    (candidate) => candidate.id === projectId && candidate.environmentId === environmentId,
  );
  return project ? scopeProjectRef(project.environmentId, project.id) : null;
}
