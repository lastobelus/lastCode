import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import type { Project } from "../../types";
import { makeThreadFixture } from "../../test-fixtures";
import { buildSidebarProjectSnapshots, NO_PROJECT_GROUP_KEY } from "../../sidebarProjectGrouping";
import type { ProjectGroupingSettings } from "../../logicalProject";
import {
  createLastCodeSidebarProjectLookup,
  indexLastCodeSidebarThreads,
  sortLastCodeSidebarProjects,
} from "./lastcodeSidebarProjects";
const first = EnvironmentId.make("first"),
  second = EnvironmentId.make("second");
function project(env: EnvironmentId, id: string, path: string, root = path): Project {
  return {
    environmentId: env,
    id: ProjectId.make(id),
    title: id,
    workspaceRoot: path,
    repositoryIdentity: {
      canonicalKey: "github.com/example/project",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/example/project.git",
      },
      provider: "github",
      owner: "example",
      name: "project",
      displayName: "Project",
      rootPath: root,
    },
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}
const projects = [
  project(first, "same", "/work/first/src", "/work/first"),
  project(second, "same", "/work/second/src", "/work/second"),
  project(first, "old-alias", "/work/first/src", "/work/first"),
];
function groups(
  projects: readonly Project[],
  mode: ProjectGroupingSettings["sidebarProjectGroupingMode"],
  scratchWorkspaceRootsByEnvironmentId = new Map<EnvironmentId, string>(),
) {
  return buildSidebarProjectSnapshots({
    projects,
    settings: { sidebarProjectGroupingMode: mode, sidebarProjectGroupingOverrides: {} },
    primaryEnvironmentId: first,
    scratchWorkspaceRootsByEnvironmentId,
    resolveEnvironmentLabel: (id) => id,
  });
}
describe("scoped sidebar collection", () => {
  it.each(["repository", "repository_path", "separate"] as const)(
    "preserves environment collisions and every deduplicated alias in %s",
    (mode) => {
      const snapshots = groups(projects, mode),
        resolve = createLastCodeSidebarProjectLookup(projects, snapshots);
      const firstKey =
        mode === "repository"
          ? "github.com/example/project"
          : mode === "repository_path"
            ? "github.com/example/project::src"
            : "first:/work/first/src";
      const secondKey = mode === "separate" ? "second:/work/second/src" : firstKey;
      expect(resolve(scopeProjectRef(first, ProjectId.make("same")))).toBe(firstKey);
      expect(resolve(scopeProjectRef(first, ProjectId.make("old-alias")))).toBe(firstKey);
      expect(resolve(scopeProjectRef(second, ProjectId.make("same")))).toBe(secondKey);
      expect(snapshots.flatMap((g) => g.memberProjectRefs)).toHaveLength(3);
      expect(snapshots.flatMap((g) => g.memberProjects)).toHaveLength(2);
    },
  );
  it("keeps No project shared while its concrete thread targets remain scoped", () => {
    const scratch = [
      project(first, "scratch", "/work/scratch-one"),
      project(second, "scratch", "/work/scratch-two"),
    ];
    const snapshots = groups(
      scratch,
      "separate",
      new Map([
        [first, "/work/scratch-one"],
        [second, "/work/scratch-two"],
      ]),
    );
    const resolve = createLastCodeSidebarProjectLookup(scratch, snapshots);
    const threads = scratch.map((p) =>
      makeThreadFixture({
        environmentId: p.environmentId,
        projectId: p.id,
        id: ThreadId.make("collision"),
      }),
    );
    const index = indexLastCodeSidebarThreads(threads, resolve);
    expect(snapshots.map((p) => p.projectKey)).toEqual([NO_PROJECT_GROUP_KEY]);
    expect(index.byProjectKey.get(NO_PROJECT_GROUP_KEY)).toEqual(threads);
    for (const thread of threads)
      expect(
        index.byThreadKey.get(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
      ).toBe(thread);
  });
  it("retains missing-project and physical-key fallbacks, and last record for a duplicate scoped ref", () => {
    const duplicate = [...projects, project(first, "same", "/work/last")];
    const resolve = createLastCodeSidebarProjectLookup(duplicate, groups(duplicate, "separate"));
    expect(resolve(scopeProjectRef(first, ProjectId.make("same")))).toBe("first:/work/last");
    expect(resolve(scopeProjectRef(second, ProjectId.make("missing")))).toBe("second:missing");
    // The prior physical-to-logical fallback also recognizes this key without a project record.
    const grouped = createLastCodeSidebarProjectLookup(projects, groups(projects, "repository"));
    expect(grouped(scopeProjectRef(first, ProjectId.make("/work/first/src")))).toBe(
      "github.com/example/project",
    );
  });
  it.each(["manual", "created_at", "updated_at"] as const)(
    "orders %s activity through logical targets and excludes archived shells",
    (order) => {
      const ordinary = {
        ...project(first, "ordinary", "/work/ordinary"),
        repositoryIdentity: null,
      };
      const input = [ordinary, ...projects],
        snapshots = groups(input, "repository"),
        resolve = createLastCodeSidebarProjectLookup(input, snapshots);
      const old = makeThreadFixture({
        environmentId: ordinary.environmentId,
        projectId: ordinary.id,
        id: ThreadId.make("old"),
        createdAt: "2026-02-01T00:00:00Z",
        latestUserMessageAt: "2026-02-01T00:00:00Z",
      });
      const recent = makeThreadFixture({
        environmentId: second,
        projectId: ProjectId.make("same"),
        id: ThreadId.make("recent"),
        createdAt: "2026-03-01T00:00:00Z",
        latestUserMessageAt: "2026-03-01T00:00:00Z",
      });
      const archived = makeThreadFixture({
        ...old,
        id: ThreadId.make("archived"),
        createdAt: "2026-04-01T00:00:00Z",
        latestUserMessageAt: "2026-04-01T00:00:00Z",
        archivedAt: "2026-04-02T00:00:00Z",
      });
      const result = sortLastCodeSidebarProjects(
        snapshots,
        [old, recent, archived],
        resolve,
        order,
      );
      expect(result.map((p) => p.projectKey)).toEqual(
        order === "manual"
          ? ["first:/work/ordinary", "github.com/example/project"]
          : ["github.com/example/project", "first:/work/ordinary"],
      );
      expect(result.find((p) => p.projectKey === "github.com/example/project")).toBe(snapshots[1]);
      expect(indexLastCodeSidebarThreads([old, recent, archived], resolve).byThreadKey.size).toBe(
        3,
      );
    },
  );
});
