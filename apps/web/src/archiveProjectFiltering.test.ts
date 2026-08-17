import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildArchivedProjectModel,
  filterArchivedProjectGroups,
  resolveArchivedProjectKey,
} from "./archiveProjectFiltering";

const primaryEnvironmentId = EnvironmentId.make("env-primary");
const remoteEnvironmentId = EnvironmentId.make("env-remote");
const groupingSettings = {
  sidebarProjectGroupingMode: "repository" as const,
  sidebarProjectGroupingOverrides: {},
};
const repositoryIdentity = {
  canonicalKey: "github.com/example/shared-repo",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/example/shared-repo.git",
  },
};

function makeProject(overrides: Partial<EnvironmentProject> = {}): EnvironmentProject {
  return {
    id: ProjectId.make("project-1"),
    environmentId: primaryEnvironmentId,
    title: "Project one",
    workspaceRoot: "/tmp/project-one",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeThread(
  project: EnvironmentProject,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    id: ThreadId.make(`thread-${project.environmentId}-${project.id}`),
    projectId: project.id,
    environmentId: project.environmentId,
    title: `Archived thread for ${project.title}`,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    archivedAt: "2026-01-02T00:00:00.000Z",
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function buildModel(
  projects: ReadonlyArray<EnvironmentProject>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
) {
  return buildArchivedProjectModel({
    projects,
    threads,
    settings: groupingSettings,
    primaryEnvironmentId,
    resolveEnvironmentLabel: (environmentId) =>
      environmentId === primaryEnvironmentId ? "Local" : "Remote",
  });
}

describe("archive project filtering", () => {
  it("shows every archived project for All and narrows to one selected project", () => {
    const alpha = makeProject({ title: "Alpha", workspaceRoot: "/tmp/alpha" });
    const beta = makeProject({
      id: ProjectId.make("project-beta"),
      title: "Beta",
      workspaceRoot: "/tmp/beta",
    });
    const model = buildModel([beta, alpha], [makeThread(beta), makeThread(alpha)]);

    expect(model.projectGroups.map((group) => group.displayName)).toEqual(["Alpha", "Beta"]);
    expect(filterArchivedProjectGroups(model.archivedGroups, null)).toHaveLength(2);

    const alphaKey = model.projectGroups.find((group) => group.displayName === "Alpha")?.projectKey;
    expect(alphaKey).toBeDefined();
    expect(filterArchivedProjectGroups(model.archivedGroups, alphaKey ?? null)).toEqual([
      expect.objectContaining({ project: expect.objectContaining({ title: "Alpha" }) }),
    ]);
  });

  it("selects every physical member of one logical project", () => {
    const local = makeProject({ repositoryIdentity, title: "Shared" });
    const remote = makeProject({
      id: ProjectId.make("project-remote"),
      environmentId: remoteEnvironmentId,
      workspaceRoot: "/srv/shared",
      repositoryIdentity,
      title: "Shared remote",
    });
    const model = buildModel([local, remote], [makeThread(local), makeThread(remote)]);

    expect(model.projectGroups).toHaveLength(1);
    expect(
      filterArchivedProjectGroups(model.archivedGroups, model.projectGroups[0]!.projectKey),
    ).toHaveLength(2);
  });

  it("keeps duplicate project ids scoped to their environments", () => {
    const local = makeProject({ title: "Local", workspaceRoot: "/tmp/local" });
    const remote = makeProject({
      environmentId: remoteEnvironmentId,
      title: "Remote",
      workspaceRoot: "/srv/remote",
    });
    const model = buildModel([local, remote], [makeThread(local), makeThread(remote)]);

    expect(model.archivedGroups).toHaveLength(2);
    expect(model.archivedGroups.map((group) => group.threads[0]?.environmentId)).toEqual([
      primaryEnvironmentId,
      remoteEnvironmentId,
    ]);
  });

  it("keeps an archived-only project as an individual picker item", () => {
    const archivedOnly = makeProject({ title: "Removed project" });
    const model = buildModel([archivedOnly], [makeThread(archivedOnly)]);

    expect(model.projectGroups.map((group) => group.displayName)).toEqual(["Removed project"]);
  });

  it("falls back to All for a stale project key", () => {
    const project = makeProject();
    const model = buildModel([project], [makeThread(project)]);

    expect(resolveArchivedProjectKey(model.projectGroups, "missing-project")).toBeNull();
    expect(resolveArchivedProjectKey(model.projectGroups, model.projectGroups[0]!.projectKey)).toBe(
      model.projectGroups[0]!.projectKey,
    );
  });
});
