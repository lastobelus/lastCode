import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { EnvironmentProject } from "./models.ts";
import { AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";
import { derivePhysicalProjectKey } from "./projectGrouping.ts";
import {
  discoverableProjects,
  projectsForSettingsScope,
  showTemporaryProjectsAtom,
  withContextualProject,
} from "./temporaryProjects.ts";

it("hides only marked project records until reveal or Keep", () => {
  const registry = AtomRegistry.make();
  const ordinary = { id: "ordinary" };
  const kept = { id: "kept", temporary: false };
  const temporary = { id: "temporary", temporary: true };
  const projects: ReadonlyArray<{ id: string; temporary?: boolean }> = [ordinary, kept, temporary];

  expect(discoverableProjects(projects, registry.get(showTemporaryProjectsAtom))).toEqual([
    ordinary,
    kept,
  ]);
  registry.set(showTemporaryProjectsAtom, true);
  expect(discoverableProjects(projects, registry.get(showTemporaryProjectsAtom))).toBe(projects);
  registry.set(showTemporaryProjectsAtom, false);

  const afterKeep: typeof projects = [ordinary, kept, { ...temporary, temporary: false }];
  expect(discoverableProjects(afterKeep, registry.get(showTemporaryProjectsAtom))).toBe(afterKeep);
});

it("keeps hidden checkouts out of ordinary group settings and honors an exact checkout link", () => {
  const ordinary: EnvironmentProject = {
    id: ProjectId.make("ordinary"),
    environmentId: EnvironmentId.make("local"),
    title: "Acme App",
    workspaceRoot: "/work/acme-app",
    repositoryIdentity: {
      canonicalKey: "github.com/acme/app",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://github.com/acme/app.git",
      },
    },
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  };
  const temporary = {
    ...ordinary,
    id: ProjectId.make("temporary"),
    environmentId: EnvironmentId.make("remote"),
    workspaceRoot: "/work/evaluation",
    temporary: true,
  };
  const grouping = {
    sidebarProjectGroupingMode: "repository" as const,
    sidebarProjectGroupingOverrides: {},
  };
  const projects = [ordinary, temporary];
  const visible = discoverableProjects(projects, false);
  const project = "github.com/acme/app";

  expect(projectsForSettingsScope(projects, visible, grouping, { project })).toEqual([ordinary]);
  expect(
    projectsForSettingsScope(projects, visible, grouping, {
      project,
      checkout: derivePhysicalProjectKey(temporary),
    }),
  ).toEqual([temporary, ordinary]);
  expect(projectsForSettingsScope([temporary], [], grouping, { project })).toEqual([temporary]);
  expect(projectsForSettingsScope(projects, projects, grouping, { project })).toBe(projects);
  expect(withContextualProject(visible, temporary)).toEqual([temporary, ordinary]);
});
