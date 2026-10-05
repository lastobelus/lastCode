import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import { makeThreadFixture, type ThreadFixtureOverrides } from "../test-fixtures";
import {
  legacySidebarFamilySummary,
  legacySidebarSubagentStatusLabel,
  legacySidebarThreadKey,
  projectLegacySidebarFamilies,
} from "./legacySidebarFamilies.logic";
import { resolveThreadStatusPill } from "./Sidebar.logic";

function thread(id: string, parentId?: string, overrides: ThreadFixtureOverrides = {}) {
  return makeThreadFixture({
    id: ThreadId.make(id),
    title: id,
    lineage: {
      rootThreadId: ThreadId.make(parentId ?? id),
      parentThreadId: parentId ? ThreadId.make(parentId) : null,
      relationshipToParent: parentId ? "subagent" : null,
    },
    ...overrides,
  });
}

function project(
  threads: ReturnType<typeof thread>[],
  options: Partial<Parameters<typeof projectLegacySidebarFamilies>[0]> = {},
) {
  return projectLegacySidebarFamilies({
    threads,
    collapsedByKey: {},
    activeThreadKey: null,
    projectExpanded: true,
    previewCount: 5,
    listExpanded: false,
    statusForThread: (value) => resolveThreadStatusPill({ thread: value }),
    ...options,
  });
}

const keys = (projection: ReturnType<typeof project>) =>
  projection.renderedRows.map((row) => row.thread.id);

describe("legacy sidebar subagent families", () => {
  it("preserves root sorting and nests children even when a child sorts first", () => {
    const result = project([
      thread("child", "parent"),
      thread("first"),
      thread("parent"),
      thread("last"),
    ]);
    expect(keys(result)).toEqual(["first", "parent", "child", "last"]);
    expect(result.renderedRows.map((row) => row.depth)).toEqual([0, 0, 1, 0]);
  });

  it("nests multiple levels without folding forks into families", () => {
    const fork = thread("fork", "parent", {
      lineage: {
        rootThreadId: ThreadId.make("parent"),
        parentThreadId: ThreadId.make("parent"),
        relationshipToParent: "fork",
      },
    });
    const result = project([
      thread("grandchild", "child"),
      thread("child", "parent"),
      fork,
      thread("parent"),
    ]);
    expect(keys(result)).toEqual(["fork", "parent", "child", "grandchild"]);
    expect(result.renderedRows.map((row) => row.depth)).toEqual([0, 0, 1, 2]);
  });

  it("keeps ordinary agent-created threads flat", () => {
    expect(keys(project([thread("ordinary"), thread("parent")]))).toEqual(["ordinary", "parent"]);
  });

  it("counts preview roots and keeps their complete families", () => {
    const result = project(
      [thread("first"), thread("child", "first"), thread("grandchild", "child"), thread("second")],
      { previewCount: 1 },
    );
    expect(keys(result)).toEqual(["first", "child", "grandchild"]);
    expect(result.hasOverflowingThreads).toBe(true);
    expect(result.hiddenThreads.map((value) => value.id)).toEqual(["second"]);
  });

  it("reveals the selected family outside the preview", () => {
    const child = thread("child", "second");
    const result = project([thread("first"), thread("second"), child], {
      previewCount: 1,
      activeThreadKey: legacySidebarThreadKey(child),
    });
    expect(keys(result)).toEqual(["first", "second", "child"]);
  });

  it("collapses descendants without changing the parent status", () => {
    const parent = thread("parent");
    const child = thread("child", "parent", { runtime: { ...parent.runtime!, status: "running" } });
    const result = project([parent, child], {
      collapsedByKey: { [legacySidebarThreadKey(parent)]: true },
    });
    expect(keys(result)).toEqual(["parent"]);
    expect(result.orderedThreadKeys).toEqual([legacySidebarThreadKey(parent)]);
    expect(legacySidebarFamilySummary(result.renderedRows[0]!)).toBe("1 subagent · 1 working");
    expect(resolveThreadStatusPill({ thread: parent })).toBeNull();
  });

  it("reveals selected ancestors without overwriting the stored collapse preference", () => {
    const parent = thread("parent");
    const child = thread("child", "parent");
    const grandchild = thread("grandchild", "child");
    const collapsedByKey = {
      [legacySidebarThreadKey(parent)]: true,
      [legacySidebarThreadKey(child)]: true,
    };
    const selected = project([parent, child, grandchild], {
      collapsedByKey,
      activeThreadKey: legacySidebarThreadKey(grandchild),
    });
    expect(keys(selected)).toEqual(["parent", "child", "grandchild"]);
    expect(
      selected.renderedRows.slice(0, 2).every((row) => row.selectedDescendant && row.expanded),
    ).toBe(true);
    expect(keys(project([parent, child, grandchild], { collapsedByKey }))).toEqual(["parent"]);
  });

  it("keeps only the selected ancestor path visible in a collapsed project", () => {
    const selected = thread("selected", "parent");
    const result = project(
      [thread("other"), thread("parent"), thread("sibling", "parent"), selected],
      { projectExpanded: false, activeThreadKey: legacySidebarThreadKey(selected) },
    );
    expect(keys(result)).toEqual(["parent", "selected"]);
    expect(result.shouldShowThreadPanel).toBe(true);
    expect(project([thread("parent")], { projectExpanded: false }).shouldShowThreadPanel).toBe(
      false,
    );
  });

  it("retains and labels a child with a missing or filtered-out parent", () => {
    const result = project([thread("child", "missing")]);
    expect(keys(result)).toEqual(["child"]);
    expect(result.renderedRows[0]?.unavailableParentLabel).toBe("Parent unavailable (missing)");
    expect(result.renderedRows[0]?.depth).toBe(0);
  });

  it("does not attach across physical projects even when their sidebar group is shared", () => {
    const result = project([
      thread("parent"),
      thread("child", "parent", { projectId: ProjectId.make("other") }),
    ]);
    expect(result.renderedRows.map((row) => row.depth)).toEqual([0, 0]);
    expect(result.renderedRows[1]?.unavailableParentLabel).toContain("unavailable");
  });

  it("scopes identical thread IDs to their environment", () => {
    const parent = thread("parent");
    const remoteParent = thread("parent", undefined, {
      environmentId: EnvironmentId.make("remote"),
    });
    const remoteChild = thread("child", "parent", { environmentId: remoteParent.environmentId });
    const result = project([parent, remoteChild, remoteParent]);
    expect(result.renderedRows.map((row) => [row.thread.environmentId, row.depth])).toEqual([
      [parent.environmentId, 0],
      [remoteParent.environmentId, 0],
      [remoteParent.environmentId, 1],
    ]);
    expect(result.renderedRows[2]?.parentKey).toBe(legacySidebarThreadKey(remoteParent));
  });

  it("detaches cycles defensively and leaves their descendants reachable", () => {
    const result = project([
      thread("a", "b"),
      thread("b", "a"),
      thread("child", "a"),
      thread("self", "self"),
    ]);
    expect(keys(result)).toEqual(["a", "child", "b", "self"]);
    expect(
      result.renderedRows
        .filter((row) => row.depth === 0)
        .every((row) => row.unavailableParentLabel?.includes("invalid lineage")),
    ).toBe(true);
  });

  it("keeps finished children and cleanup recovery rows, excluding only recovery from navigation", () => {
    const parent = thread("parent");
    const done = thread("done", "parent", {
      latestRun: {
        runId: RunId.make("run-done"),
        status: "completed",
        requestedAt: null,
        startedAt: null,
        completedAt: "2026-01-01T00:01:00Z",
        assistantMessageId: null,
      },
    });
    const cleanup = thread("cleanup", "parent", {
      worktreeCleanup: {
        status: "failed",
        repositoryRoot: "/repository",
        worktreePath: "/worktree",
        startedAt: "2026-01-01T00:01:00Z",
        failedAt: "2026-01-01T00:01:01Z",
        error: "failed",
      },
    });
    const result = project([parent, done, cleanup]);
    expect(keys(result)).toEqual(["parent", "done", "cleanup"]);
    expect(result.orderedThreadKeys).toEqual([
      legacySidebarThreadKey(parent),
      legacySidebarThreadKey(done),
    ]);
    expect(legacySidebarSubagentStatusLabel(done, null)).toBe("Done");
    expect(legacySidebarFamilySummary(result.renderedRows[0]!)).toContain("1 done");
  });
});
