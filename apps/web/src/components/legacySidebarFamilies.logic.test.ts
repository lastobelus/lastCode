import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import { makeThreadFixture, type ThreadFixtureOverrides } from "../test-fixtures";
import {
  legacySidebarFamilySummary,
  legacySidebarCreatorGroupingEligible,
  legacySidebarIsAgentCreated,
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
    expect(legacySidebarFamilySummary(result.renderedRows[0]!)).toBe("1 subagent (1 working)");
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

  it("counts rolled-back subagents as stopped in collapsed families", () => {
    const parent = thread("parent");
    const child = thread("child", "parent", {
      latestRun: {
        runId: RunId.make("run-rolled-back"),
        status: "rolled_back",
        requestedAt: null,
        startedAt: null,
        completedAt: "2026-01-01T00:01:00Z",
        assistantMessageId: null,
      },
    });
    const result = project([parent, child], {
      collapsedByKey: { [legacySidebarThreadKey(parent)]: true },
    });
    expect(legacySidebarSubagentStatusLabel(child, null)).toBe("Stopped");
    expect(keys(result)).toEqual(["parent"]);
    expect(legacySidebarFamilySummary(result.renderedRows[0]!)).toContain("1 stopped");
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

function created(
  id: string,
  creatorId?: string,
  grouping: "grouped" | "independent" = "grouped",
  overrides: ThreadFixtureOverrides = {},
) {
  const value = thread(id, undefined, overrides);
  return {
    ...value,
    source: { ...value.source, createdBy: "agent" as const },
    ...(creatorId ? { creatorThreadId: ThreadId.make(creatorId), creatorGrouping: grouping } : {}),
  };
}

describe("legacy sidebar creator grouping", () => {
  it("groups ordinary conversations by trusted creator without changing their identity or lineage", () => {
    const child = created("conversation", "creator");
    const result = project([child, thread("creator")]);
    expect(keys(result)).toEqual(["creator", "conversation"]);
    expect(result.renderedRows[1]?.depth).toBe(1);
    expect(result.renderedRows[1]?.thread).toBe(child);
    expect(child.lineage.parentThreadId).toBeNull();
    expect(child.lineage.relationshipToParent).toBeNull();
    expect(child.id).toBe("conversation");
  });

  it("keeps historical unknown creators flat and does not offer regrouping", () => {
    const historical = created("historical");
    expect(project([historical, thread("creator")]).renderedRows.map((row) => row.depth)).toEqual([
      0, 0,
    ]);
    expect(legacySidebarIsAgentCreated(historical)).toBe(true);
    expect(legacySidebarCreatorGroupingEligible(historical)).toBe(false);
  });

  it("promotes and regroups using saved server metadata alone", () => {
    const child = created("conversation", "creator");
    const independent = { ...child, creatorGrouping: "independent" as const };
    expect(keys(project([independent, thread("creator")]))).toEqual(["conversation", "creator"]);
    expect(project([independent, thread("creator")]).renderedRows[0]?.depth).toBe(0);
    expect(
      project([{ ...independent, creatorGrouping: "grouped" }, thread("creator")]).renderedRows[1]
        ?.depth,
    ).toBe(1);
    expect(independent.creatorThreadId).toBe(child.creatorThreadId);
    expect(legacySidebarCreatorGroupingEligible(independent)).toBe(true);
  });

  it("shows distinct typed subgroups by default, and a mixed list in minimal style", () => {
    const threads = [
      thread("creator"),
      created("ordinary", "creator"),
      thread("helper", "creator"),
    ];
    const typed = project(threads);
    expect(keys(typed)).toEqual(["creator", "helper", "ordinary"]);
    expect(typed.renderedRows.map((row) => row.groupHeading)).toEqual([
      null,
      "Subagents",
      "Created by this thread",
    ]);
    const minimal = project(threads, { groupingStyle: "minimal" });
    expect(keys(minimal)).toEqual(["creator", "ordinary", "helper"]);
    expect(minimal.renderedRows.every((row) => row.groupHeading === null)).toBe(true);
    expect(minimal.orderedThreadKeys).toEqual(minimal.renderedRows.map((row) => row.key));
  });

  it("separates subagent and created-conversation counts in collapsed summaries", () => {
    const parent = thread("creator");
    const result = project([parent, thread("helper", "creator"), created("ordinary", "creator")], {
      collapsedByKey: { [legacySidebarThreadKey(parent)]: true },
    });
    expect(keys(result)).toEqual(["creator"]);
    expect(legacySidebarFamilySummary(result.renderedRows[0]!)).toBe(
      "1 subagent (1 idle) · 1 created thread (1 idle)",
    );
    expect(result.renderedRows[0]?.descendantCount).toBe(2);
  });

  it("keeps missing, cross-project, and cross-environment creators as marked reachable roots", () => {
    const missing = created("missing-child", "missing");
    const otherProject = created("other-project", "creator", "grouped", {
      projectId: ProjectId.make("another-project"),
    });
    const remote = created("remote-child", "creator", "grouped", {
      environmentId: EnvironmentId.make("remote"),
    });
    const result = project([thread("creator"), missing, otherProject, remote]);
    expect(result.renderedRows.map((row) => row.depth)).toEqual([0, 0, 0, 0]);
    expect(
      result.renderedRows
        .slice(1)
        .every((row) => row.unavailableCreatorLabel?.includes("Creator unavailable")),
    ).toBe(true);
  });

  it("does not attach forks or true subagents using creator metadata", () => {
    const fork = created("fork", "creator", "grouped", {
      lineage: {
        rootThreadId: ThreadId.make("fork-parent"),
        parentThreadId: ThreadId.make("fork-parent"),
        relationshipToParent: "fork",
      },
    });
    const subagent = created("helper", "creator", "grouped", {
      lineage: {
        rootThreadId: ThreadId.make("real-parent"),
        parentThreadId: ThreadId.make("real-parent"),
        relationshipToParent: "subagent",
      },
    });
    const result = project([thread("creator"), thread("real-parent"), fork, subagent]);
    expect(keys(result)).toEqual(["creator", "real-parent", "helper", "fork"]);
    expect(result.renderedRows[2]?.parentKey).toBe(legacySidebarThreadKey(thread("real-parent")));
    expect(legacySidebarIsAgentCreated(fork)).toBe(false);
    expect(legacySidebarIsAgentCreated(subagent)).toBe(false);
    expect(legacySidebarIsAgentCreated(thread("user-created"))).toBe(false);
    expect(legacySidebarCreatorGroupingEligible(fork)).toBe(false);
    expect(legacySidebarCreatorGroupingEligible(subagent)).toBe(false);
  });

  it("detaches creator cycles without discarding true subagent ownership in mixed cycles", () => {
    const a = created("a", "b");
    const b = created("b", "a");
    const invalid = project([a, b]);
    expect(
      invalid.renderedRows.every(
        (row) => row.depth === 0 && row.unavailableCreatorLabel?.includes("invalid grouping"),
      ),
    ).toBe(true);
    const helper = thread("helper", "parent");
    const parent = created("parent", "helper");
    const mixed = project([helper, parent]);
    expect(keys(mixed)).toEqual(["parent", "helper"]);
    expect(mixed.renderedRows[1]?.parentKey).toBe(legacySidebarThreadKey(parent));
    expect(mixed.renderedRows[0]?.unavailableCreatorLabel).toContain("invalid grouping");
  });

  it("reveals nested selected conversations outside preview and collapsed creator families", () => {
    const parent = thread("creator");
    const child = created("ordinary", "creator");
    const result = project([thread("first"), parent, child], {
      previewCount: 1,
      activeThreadKey: legacySidebarThreadKey(child),
      collapsedByKey: { [legacySidebarThreadKey(parent)]: true },
    });
    expect(keys(result)).toEqual(["first", "creator", "ordinary"]);
    expect(result.renderedRows[1]?.expanded).toBe(true);
  });

  it("marks the active-parent path as belonging to a collapsed project (R3)", () => {
    const parent = thread("parent");
    const result = project([parent, thread("helper", "parent")], {
      projectExpanded: false,
      activeThreadKey: legacySidebarThreadKey(parent),
    });
    expect(keys(result)).toEqual(["parent"]);
    expect(result.renderedRows[0]?.projectExpanded).toBe(false);
    expect(result.renderedRows[0]?.descendantCount).toBe(1);
    expect(result.orderedThreadKeys).toEqual([legacySidebarThreadKey(parent)]);
  });
});
