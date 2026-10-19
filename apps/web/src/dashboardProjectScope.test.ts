import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveDashboardProjectRef } from "./dashboardProjectScope";

const environmentA = EnvironmentId.make("environment-a");
const environmentB = EnvironmentId.make("environment-b");
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const projects = [
  { id: projectA, environmentId: environmentA },
  { id: projectB, environmentId: environmentB },
  { id: projectB, environmentId: environmentA },
];

describe("dashboard contextual project", () => {
  it("keeps actions in the selected project and environment instead of the first project", () => {
    expect(
      resolveDashboardProjectRef(
        { pathname: "/dashboard", search: { projectId: projectB, environmentId: environmentB } },
        projects,
      ),
    ).toEqual({ projectId: projectB, environmentId: environmentB });
  });
  it("does not use dashboard-like search parameters on other routes", () => {
    expect(
      resolveDashboardProjectRef(
        { pathname: "/usage", search: { projectId: projectB, environmentId: environmentB } },
        projects,
      ),
    ).toBeNull();
  });
  it("rejects missing, malformed, or unknown environment-scoped project targets", () => {
    for (const search of [
      { projectId: projectB },
      { projectId: [projectB], environmentId: environmentB },
      { projectId: projectA, environmentId: environmentB },
    ])
      expect(resolveDashboardProjectRef({ pathname: "/dashboard", search }, projects)).toBeNull();
  });
});
