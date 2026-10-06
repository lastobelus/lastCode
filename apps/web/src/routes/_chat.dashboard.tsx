import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { ProjectDashboard } from "../components/dashboard/ProjectDashboard";

export const Route = createFileRoute("/_chat/dashboard")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...(typeof raw.environmentId === "string" && raw.environmentId
      ? { environmentId: raw.environmentId as EnvironmentId }
      : {}),
    ...(typeof raw.projectId === "string" && raw.projectId
      ? { projectId: raw.projectId as ProjectId }
      : {}),
  }),
  component: DashboardRouteView,
});

function DashboardRouteView() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <ProjectDashboard
      environmentId={search.environmentId}
      projectId={search.projectId}
      onSelectProject={(project) => {
        void navigate({
          to: "/dashboard",
          search: { environmentId: project.environmentId, projectId: project.id },
        });
      }}
    />
  );
}
