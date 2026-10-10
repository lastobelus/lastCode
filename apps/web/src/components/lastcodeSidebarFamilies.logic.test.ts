import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import { makeThreadFixture, type ThreadFixtureOverrides } from "../test-fixtures";
import {
  lastcodeSidebarFamilySummary,
  lastcodeSidebarCreatorDetails,
  lastcodeSidebarCreatorGroupingEligible,
  lastcodeSidebarIsAgentCreated,
  lastcodeSidebarSubagentStatusLabel,
  lastcodeSidebarThreadKey,
  lastcodeSidebarSubagentGroupKey,
  projectLastCodeSidebarFamilies,
} from "./lastcodeSidebarFamilies.logic";
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
  options: Partial<Parameters<typeof projectLastCodeSidebarFamilies>[0]> = {},
) {
  return projectLastCodeSidebarFamilies({
    threads,
    collapsedByKey: Object.fromEntries(
      threads.flatMap((value) => [
        [lastcodeSidebarThreadKey(value), false],
        [lastcodeSidebarSubagentGroupKey(lastcodeSidebarThreadKey(value)), false],
      ]),
    ),
    activeThreadKey: null,
    projectExpanded: true,
    previewCount: 5,
    listExpanded: false,
    groupingStyle: "typed-groups",
    statusForThread: (value) => resolveThreadStatusPill({ thread: value }),
    ...options,
  });
}

const keys = (projection: ReturnType<typeof project>) =>
  projection.renderedRows.map((row) => row.thread.id);

describe("legacy sidebar subagent families", () => {
  it("shows released subagents as independent roots while preserving their owned descendants", () => {
    const released = thread("helper", "archived-parent", {
      lineage: {
        rootThreadId: ThreadId.make("archived-parent"),
        parentThreadId: ThreadId.make("archived-parent"),
        relationshipToParent: "subagent",
        independent: true,
      },
    });
    const nested = thread("nested", "helper");
    const result = project([released, nested]);
    expect(
      result.renderedRows.map((row) => [row.thread.id, row.depth, row.unavailableParentLabel]),
    ).toEqual([
      ["helper", 0, null],
      ["nested", 1, null],
    ]);
    expect(released.lineage.parentThreadId).toBe("archived-parent");
  });
  it("collapses families by default and keeps the subagent section separately collapsed", () => {
    const parent = thread("parent");
    const helper = thread("helper", "parent");
    const ordinary = created("ordinary", parent.id);
    const threads = [helper, parent, ordinary];
    const parentKey = lastcodeSidebarThreadKey(parent);
    expect(keys(project(threads, { collapsedByKey: {} }))).toEqual(["parent"]);
    const expanded = project(threads, {
      collapsedByKey: { [parentKey]: false },
      groupingStyle: "minimal",
    });
    expect(keys(expanded)).toEqual(["parent", "ordinary"]);
    expect(expanded.renderedItems.map((item) => item.type)).toEqual([
      "thread",
      "thread",
      "subagents",
    ]);
    expect(expanded.renderedItems.at(-1)).toMatchObject({ expanded: false, count: 1 });
    expect(expanded.orderedThreadKeys).toEqual([parentKey, lastcodeSidebarThreadKey(ordinary)]);
    expect(
      keys(
        project(threads, {
          collapsedByKey: {
            [parentKey]: false,
            [lastcodeSidebarSubagentGroupKey(parentKey)]: false,
          },
        }),
      ),
    ).toEqual(["parent", "ordinary", "helper"]);
    const selected = project(threads, {
      collapsedByKey: {},
      activeThreadKey: lastcodeSidebarThreadKey(helper),
    });
    expect(keys(selected)).toEqual(["parent", "ordinary", "helper"]);
    expect(selected.renderedItems.find((item) => item.type === "subagents")).toMatchObject({
      expanded: true,
      selectedDescendant: true,
    });
  });

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

  it.each([
    ["Working", { runtime: { ...thread("fixture").runtime!, status: "running" as const } }],
    ["Awaiting Input", { hasPendingUserInput: true }],
    ["Failed", { runtime: { ...thread("fixture").runtime!, lastError: "Provider failed" } }],
    [
      "Failed",
      {
        latestRun: {
          runId: RunId.make("failed-run"),
          status: "failed" as const,
          requestedAt: null,
          startedAt: null,
          completedAt: "2026-01-01T00:01:00Z",
          assistantMessageId: null,
        },
      },
    ],
  ])("keeps %s visible in a collapsed subagent section", (label, overrides) => {
    const parent = thread("parent");
    const helper = thread("helper", "parent", overrides);
    const result = project([parent, helper], {
      collapsedByKey: { [lastcodeSidebarThreadKey(parent)]: false },
    });
    expect(keys(result)).toEqual(["parent"]);
    expect(result.renderedItems.at(-1)).toMatchObject({
      type: "subagents",
      expanded: false,
      status: { label },
    });
  });

  it("aggregates only the hidden subagent branch and prioritizes failed work", () => {
    const parent = thread("parent");
    const ordinary = created("ordinary", parent.id, "grouped", { hasPendingUserInput: true });
    const helper = thread("helper", "parent");
    const nested = thread("nested", "helper", {
      runtime: { ...helper.runtime!, status: "running" },
    });
    const threads = [parent, ordinary, helper, nested];
    const options = { collapsedByKey: { [lastcodeSidebarThreadKey(parent)]: false } };
    const working = project(threads, options);
    expect(keys(working)).toEqual(["parent", "ordinary"]);
    expect(working.renderedItems.at(-1)).toMatchObject({ status: { label: "Working" } });
    const failed = thread("failed", "parent", {
      runtime: { ...helper.runtime!, lastError: "Error" },
    });
    expect(project([...threads, failed], options).renderedItems.at(-1)).toMatchObject({
      count: 2,
      status: { label: "Failed" },
    });
    expect(project([parent, ordinary, helper], options).renderedItems.at(-1)).toMatchObject({
      status: null,
    });
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
      activeThreadKey: lastcodeSidebarThreadKey(child),
    });
    expect(keys(result)).toEqual(["first", "second", "child"]);
  });

  it("collapses descendants without changing the parent status", () => {
    const parent = thread("parent");
    const child = thread("child", "parent", { runtime: { ...parent.runtime!, status: "running" } });
    const result = project([parent, child], {
      collapsedByKey: { [lastcodeSidebarThreadKey(parent)]: true },
    });
    expect(keys(result)).toEqual(["parent"]);
    expect(result.orderedThreadKeys).toEqual([lastcodeSidebarThreadKey(parent)]);
    expect(lastcodeSidebarFamilySummary(result.renderedRows[0]!)).toBe("1 subagent (1 working)");
    expect(resolveThreadStatusPill({ thread: parent })).toBeNull();
  });

  it("aggregates failures from ordinary children in a default-collapsed minimal family", () => {
    const parent = thread("parent");
    const child = created("child", parent.id, "grouped", {
      latestRun: {
        runId: RunId.make("failed-child-run"),
        status: "failed",
        requestedAt: null,
        startedAt: null,
        completedAt: "2026-01-01T00:01:00Z",
        assistantMessageId: null,
      },
    });
    const result = project([parent, child], { collapsedByKey: {}, groupingStyle: "minimal" });
    expect(keys(result)).toEqual(["parent"]);
    expect(result.renderedItems.map((item) => item.type)).toEqual(["thread"]);
    expect(result.renderedRows[0]?.descendantsStatus?.label).toBe("Failed");
    expect(lastcodeSidebarFamilySummary(result.renderedRows[0]!)).toBe(
      "1 created thread (1 failed)",
    );
    expect(resolveThreadStatusPill({ thread: parent })).toBeNull();
  });

  it("retains only the selected path in explicitly collapsed families", () => {
    const parent = thread("parent");
    const child = thread("child", "parent");
    const grandchild = thread("grandchild", "child");
    const collapsedByKey = {
      [lastcodeSidebarThreadKey(parent)]: true,
      [lastcodeSidebarThreadKey(child)]: true,
    };
    const threads = [
      parent,
      thread("sibling", "parent"),
      child,
      thread("nested-sibling", "child"),
      grandchild,
      thread("next-root"),
    ];
    const selected = project(threads, {
      collapsedByKey,
      activeThreadKey: lastcodeSidebarThreadKey(grandchild),
    });
    expect(keys(selected)).toEqual(["parent", "child", "grandchild", "next-root"]);
    expect(
      selected.renderedRows
        .slice(0, 2)
        .every((row) => row.selectedDescendant && !row.expanded && row.collapseNavigatesToParent),
    ).toBe(true);
    expect(keys(project(threads, { collapsedByKey }))).toEqual(["parent", "next-root"]);
  });

  it("returns an open subagent to the collapsed ancestor rather than its immediate parent", () => {
    const parent = thread("parent");
    const child = thread("child", "parent");
    const grandchild = thread("grandchild", "child");
    const threads = [parent, created("conversation", "parent"), child, grandchild];
    const collapsedByKey = { [lastcodeSidebarThreadKey(parent)]: true };
    const selected = project(threads, {
      collapsedByKey,
      activeThreadKey: lastcodeSidebarThreadKey(grandchild),
    });
    expect(selected.renderedRows[0]).toMatchObject({
      expanded: false,
      collapseNavigatesToParent: true,
    });
    expect(
      keys(project(threads, { collapsedByKey, activeThreadKey: lastcodeSidebarThreadKey(parent) })),
    ).toEqual(["parent"]);
  });

  it("collapses the subagent section without hiding its selected path before navigation", () => {
    const parent = thread("parent");
    const helper = thread("helper", "parent");
    const nested = thread("nested", "helper");
    const ordinary = created("ordinary", "parent");
    const threads = [parent, ordinary, thread("other-helper", "parent"), helper, nested];
    const collapsedByKey = {
      [lastcodeSidebarThreadKey(parent)]: false,
      [lastcodeSidebarSubagentGroupKey(lastcodeSidebarThreadKey(parent))]: true,
    };
    const selected = project(threads, {
      collapsedByKey,
      activeThreadKey: lastcodeSidebarThreadKey(nested),
    });
    expect(keys(selected)).toEqual(["parent", "ordinary", "helper", "nested"]);
    expect(selected.renderedItems.find((item) => item.type === "subagents")).toMatchObject({
      expanded: false,
      collapseNavigatesToParent: true,
      count: 2,
    });
    expect(
      keys(project(threads, { collapsedByKey, activeThreadKey: lastcodeSidebarThreadKey(parent) })),
    ).toEqual(["parent", "ordinary"]);
  });

  it("keeps only the selected ancestor path visible in a collapsed project", () => {
    const selected = thread("selected", "parent");
    const result = project(
      [thread("other"), thread("parent"), thread("sibling", "parent"), selected],
      { projectExpanded: false, activeThreadKey: lastcodeSidebarThreadKey(selected) },
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
    expect(result.renderedRows[2]?.parentKey).toBe(lastcodeSidebarThreadKey(remoteParent));
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
      collapsedByKey: { [lastcodeSidebarThreadKey(parent)]: true },
    });
    expect(lastcodeSidebarSubagentStatusLabel(child, null)).toBe("Stopped");
    expect(keys(result)).toEqual(["parent"]);
    expect(lastcodeSidebarFamilySummary(result.renderedRows[0]!)).toContain("1 stopped");
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
      lastcodeSidebarThreadKey(parent),
      lastcodeSidebarThreadKey(done),
    ]);
    expect(lastcodeSidebarSubagentStatusLabel(done, null)).toBe("Done");
    expect(lastcodeSidebarFamilySummary(result.renderedRows[0]!)).toContain("1 done");
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
    expect(lastcodeSidebarIsAgentCreated(historical)).toBe(true);
    expect(lastcodeSidebarCreatorGroupingEligible(historical)).toBe(false);
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
    expect(lastcodeSidebarCreatorGroupingEligible(independent)).toBe(true);
    expect(lastcodeSidebarCreatorDetails(independent, thread("creator"))).toEqual({
      description: "Created by creator",
      unavailableLabel: null,
      groupingEligible: true,
      canOpen: true,
    });
  });

  it("keeps subagents together after created threads in both layouts", () => {
    const threads = [
      thread("creator"),
      thread("helper-first", "creator"),
      created("ordinary-first", "creator"),
      thread("helper-second", "creator"),
      created("ordinary-second", "creator"),
    ];
    const expected = [
      "creator",
      "ordinary-first",
      "ordinary-second",
      "helper-first",
      "helper-second",
    ];
    const typed = project(threads);
    expect(keys(typed)).toEqual(expected);
    expect(typed.renderedRows.map((row) => row.groupHeading)).toEqual([
      null,
      "Created by this thread",
      null,
      null,
      null,
    ]);
    const minimal = project(threads, { groupingStyle: "minimal" });
    expect(keys(minimal)).toEqual(expected);
    expect(minimal.renderedRows.every((row) => row.groupHeading === null)).toBe(true);
    expect(minimal.orderedThreadKeys).toEqual(minimal.renderedRows.map((row) => row.key));
  });

  it("separates subagent and created-conversation counts in collapsed summaries", () => {
    const parent = thread("creator");
    const result = project([parent, thread("helper", "creator"), created("ordinary", "creator")], {
      collapsedByKey: { [lastcodeSidebarThreadKey(parent)]: true },
    });
    expect(keys(result)).toEqual(["creator"]);
    expect(lastcodeSidebarFamilySummary(result.renderedRows[0]!)).toBe(
      "1 subagent (1 idle) · 1 created thread (1 idle)",
    );
    expect(result.renderedRows[0]?.descendantCount).toBe(2);
  });

  it("keeps missing and cross-environment creators as marked reachable roots", () => {
    const missing = created("missing-child", "missing");
    const remote = created("remote-child", "creator", "grouped", {
      environmentId: EnvironmentId.make("remote"),
    });
    const creator = thread("creator");
    const result = project([creator, missing, remote]);
    expect(result.renderedRows.map((row) => row.depth)).toEqual([0, 0, 0]);
    expect(lastcodeSidebarCreatorDetails(missing, null).unavailableLabel).toBe(
      "Creator unavailable (missing)",
    );
    const remoteDetails = lastcodeSidebarCreatorDetails(remote, creator);
    expect(remoteDetails.description).toBe("Creator unavailable (creator)");
    expect(remoteDetails.unavailableLabel).toBe("Creator unavailable (creator)");
    expect(remoteDetails.canOpen).toBe(false);
  });

  it.each(["grouped", "independent"] as const)(
    "retains available cross-project attribution without offering %s grouping changes",
    (grouping) => {
      const creator = thread("creator");
      const child = created("other-project", "creator", grouping, {
        projectId: ProjectId.make("another-project"),
      });
      // A creator outside this project's subscription must remain resolvable by the row.
      const result = project([child]);
      expect(keys(result)).toEqual(["other-project"]);
      expect(result.renderedRows[0]?.depth).toBe(0);
      expect(result.renderedRows[0]?.parentKey).toBeNull();
      expect(result.renderedRows[0]?.creatorGroupingWarning).toBeNull();
      expect(lastcodeSidebarCreatorDetails(child, creator)).toEqual({
        description: "Created by creator",
        unavailableLabel: null,
        groupingEligible: false,
        canOpen: true,
      });
      // Logical project groups may include both physical projects without joining families.
      expect(project([creator, child]).renderedRows.map((row) => row.depth)).toEqual([0, 0]);
      expect(child.creatorThreadId).toBe(creator.id);
      expect(child.lineage.parentThreadId).toBeNull();
    },
  );

  it.each(["archivedAt", "deletedAt"] as const)(
    "marks a creator with %s unavailable and does not offer to open it",
    (field) => {
      const child = created("conversation", "creator");
      const creator = thread("creator", undefined, { [field]: "2026-01-01T00:00:00Z" });
      const result = project([child]);
      expect(result.renderedRows[0]?.depth).toBe(0);
      expect(lastcodeSidebarCreatorDetails(child, creator)).toEqual({
        description: "Creator unavailable (creator)",
        unavailableLabel: "Creator unavailable (creator)",
        groupingEligible: true,
        canOpen: false,
      });
    },
  );

  it("keeps regrouping available for missing creators and omits warnings for independent rows", () => {
    const child = created("conversation", "missing");
    expect(lastcodeSidebarCreatorDetails(child, null).groupingEligible).toBe(true);
    const independent = { ...child, creatorGrouping: "independent" as const };
    const details = lastcodeSidebarCreatorDetails(independent, null);
    expect(details.description).toBe("Creator unavailable (missing)");
    expect(details.unavailableLabel).toBeNull();
    expect(details.canOpen).toBe(false);
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
    expect(result.renderedRows[2]?.parentKey).toBe(lastcodeSidebarThreadKey(thread("real-parent")));
    expect(lastcodeSidebarIsAgentCreated(fork)).toBe(false);
    expect(lastcodeSidebarIsAgentCreated(subagent)).toBe(false);
    expect(lastcodeSidebarIsAgentCreated(thread("user-created"))).toBe(false);
    expect(lastcodeSidebarCreatorGroupingEligible(fork)).toBe(false);
    expect(lastcodeSidebarCreatorGroupingEligible(subagent)).toBe(false);
  });

  it("detaches creator cycles without discarding true subagent ownership in mixed cycles", () => {
    const a = created("a", "b");
    const b = created("b", "a");
    const invalid = project([a, b]);
    expect(
      invalid.renderedRows.every(
        (row) => row.depth === 0 && row.creatorGroupingWarning?.includes("invalid grouping"),
      ),
    ).toBe(true);
    const helper = thread("helper", "parent");
    const parent = created("parent", "helper");
    const mixed = project([helper, parent]);
    expect(keys(mixed)).toEqual(["parent", "helper"]);
    expect(mixed.renderedRows[1]?.parentKey).toBe(lastcodeSidebarThreadKey(parent));
    expect(mixed.renderedRows[0]?.creatorGroupingWarning).toContain("invalid grouping");
  });

  it("reveals nested selected conversations outside preview and collapsed creator families", () => {
    const parent = thread("creator");
    const child = created("ordinary", "creator");
    const result = project([thread("first"), parent, child], {
      previewCount: 1,
      activeThreadKey: lastcodeSidebarThreadKey(child),
      collapsedByKey: { [lastcodeSidebarThreadKey(parent)]: true },
    });
    expect(keys(result)).toEqual(["first", "creator", "ordinary"]);
    expect(result.renderedRows[1]?.expanded).toBe(false);
  });

  it.each(["minimal", "typed-groups"] as const)(
    "keeps only the open interactive path when its mixed family is collapsed (%s)",
    (groupingStyle) => {
      const parent = thread("creator");
      const child = created("conversation", "creator");
      const grandchild = created("nested-conversation", "conversation");
      const threads = [
        parent,
        created("sibling", "creator"),
        child,
        created("nested-sibling", "conversation"),
        grandchild,
        thread("helper", "creator"),
        thread("next-root"),
      ];
      const options = {
        groupingStyle,
        collapsedByKey: { [lastcodeSidebarThreadKey(parent)]: true },
        activeThreadKey: lastcodeSidebarThreadKey(grandchild),
      };
      const result = project(threads, options);
      expect(keys(result)).toEqual(["creator", "conversation", "nested-conversation", "next-root"]);
      expect(result.renderedRows[0]).toMatchObject({
        expanded: false,
        selectedDescendant: true,
        collapseNavigatesToParent: false,
      });
      expect(result.orderedThreadKeys).toEqual(result.renderedRows.map((row) => row.key));
      expect(keys(project(threads, { ...options, activeThreadKey: null }))).toEqual([
        "creator",
        "next-root",
      ]);
    },
  );

  it("keeps an interactive conversation open even when its collapsed ancestors are subagents", () => {
    const parent = thread("parent");
    const helper = thread("helper", "parent");
    const selected = created("conversation", "helper");
    const threads = [
      parent,
      created("ordinary-sibling", "parent"),
      thread("other-helper", "parent"),
      helper,
      created("nested-sibling", "helper"),
      selected,
    ];
    const result = project(threads, {
      collapsedByKey: {
        [lastcodeSidebarThreadKey(parent)]: false,
        [lastcodeSidebarThreadKey(helper)]: false,
        [lastcodeSidebarSubagentGroupKey(lastcodeSidebarThreadKey(parent))]: true,
      },
      activeThreadKey: lastcodeSidebarThreadKey(selected),
    });
    expect(keys(result)).toEqual(["parent", "ordinary-sibling", "helper", "conversation"]);
    expect(result.renderedItems.find((item) => item.type === "subagents")).toMatchObject({
      expanded: false,
      selectedDescendant: true,
      collapseNavigatesToParent: false,
    });
    expect(result.renderedRows.every((row) => !row.collapseNavigatesToParent)).toBe(true);
  });

  it("marks the active-parent path as belonging to a collapsed project (R3)", () => {
    const parent = thread("parent");
    const result = project([parent, thread("helper", "parent")], {
      projectExpanded: false,
      activeThreadKey: lastcodeSidebarThreadKey(parent),
    });
    expect(keys(result)).toEqual(["parent"]);
    expect(result.renderedRows[0]?.projectExpanded).toBe(false);
    expect(result.renderedRows[0]?.descendantCount).toBe(1);
    expect(result.orderedThreadKeys).toEqual([lastcodeSidebarThreadKey(parent)]);
  });
});
