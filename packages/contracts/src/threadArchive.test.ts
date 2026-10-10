import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ProjectId, ThreadId } from "./baseSchemas.ts";
import { OrchestrationV2Command, ThreadArchiveOperation } from "./orchestrationV2.ts";
import { getArchiveFamilyParentThreadId, getOwnedThreadFamily } from "./threadArchive.ts";

const thread = (
  id: string,
  parent: string | null,
  options: {
    relationship?: "fork" | "subagent";
    independent?: boolean;
    source?: string;
    archived?: boolean;
    deleted?: boolean;
    persistent?: boolean;
  } = {},
) => ({
  id: ThreadId.make(id),
  projectId: ProjectId.make("family-project"),
  archivedAt: options.archived ? "2026-01-01" : null,
  deletedAt: options.deleted ? "2026-01-01" : null,
  creationSource: options.source ?? "mcp",
  persistent: options.persistent ?? false,
  lineage: {
    parentThreadId: parent === null ? null : ThreadId.make(parent),
    relationshipToParent: parent === null ? null : (options.relationship ?? "subagent"),
    rootThreadId: ThreadId.make("root"),
    independent: options.independent ?? false,
  },
});

it("rejects archive promotion on new commands while preserving deployed plan consent", () => {
  const decodeCommand = Schema.decodeUnknownSync(OrchestrationV2Command);
  const decodePlan = Schema.decodeUnknownSync(ThreadArchiveOperation);
  const command = {
    type: "thread.archive",
    commandId: "archive-owner",
    threadId: "owner",
    childDisposition: "promote",
    expectedChildThreadIds: ["child"],
  };
  expect(() => decodeCommand(command)).toThrow();
  const plan = {
    threadId: "owner",
    commandId: "archive-owner",
    status: "stopping",
    childDisposition: "promote",
    childThreadIds: ["child"],
    archiveThreadIds: ["owner"],
    promoteThreadIds: ["child"],
  };
  expect(decodePlan(plan).familyVersion).toBeUndefined();
  expect(
    decodePlan({ ...plan, childDisposition: "stop_and_archive", familyVersion: 1 }).familyVersion,
  ).toBe(1);
});

describe("owned archive family", () => {
  it("groups created conversations only with a creator in the same project while retaining cross-project delegated ownership", () => {
    const root = thread("root", null);
    const grouped = (id: string, creator: string, projectId = root.projectId) => ({
      ...thread(id, null),
      projectId,
      createdBy: "agent",
      creatorThreadId: ThreadId.make(creator),
      creatorGrouping: "grouped",
    });
    const foreignProject = ProjectId.make("other-family-project");
    const same = grouped("same-project", "root");
    const foreign = grouped("foreign-project", "root", foreignProject);
    const delegated = { ...thread("foreign-delegated", "root"), projectId: foreignProject };
    const family = getOwnedThreadFamily(
      [
        root,
        same,
        foreign,
        thread("foreign-group-descendant", "foreign-project"),
        delegated,
        grouped("delegated-same-project", "foreign-delegated", foreignProject),
        grouped("delegated-other-project", "foreign-delegated"),
      ],
      root.id,
    );
    expect(family.children.map((child) => child.id)).toEqual([
      "same-project",
      "foreign-delegated",
      "delegated-same-project",
    ]);
    expect(getArchiveFamilyParentThreadId(same, root)).toBe(root.id);
    expect(getArchiveFamilyParentThreadId(foreign, root)).toBeNull();
    expect(getArchiveFamilyParentThreadId(delegated, root)).toBe(root.id);
  });

  it("walks owned children recursively and excludes forks, release boundaries, and archived children", () => {
    const threads = [
      thread("root", null),
      thread("child", "root"),
      thread("grandchild", "child"),
      thread("fork", "root", { relationship: "fork" }),
      thread("fork-child", "fork"),
      thread("released", "root", { independent: true }),
      thread("released-child", "released"),
      thread("archived", "root", { archived: true }),
      thread("live-below-archive", "archived"),
    ];
    const family = getOwnedThreadFamily(threads, ThreadId.make("root"));
    expect(family.children.map((child) => child.id)).toEqual([
      "child",
      "grandchild",
      "live-below-archive",
    ]);
    expect(family.directChildren.map((child) => child.id)).toEqual(["child"]);
    expect([...family.keptThreadIds]).toEqual(["child", "grandchild"]);
  });

  it("separates independently runnable app children from native mirrors and tracks protection", () => {
    const family = getOwnedThreadFamily(
      [
        thread("native", "root", { source: "provider" }),
        thread("native-protected", "native", { source: "provider", persistent: true }),
        thread("app", "root", { persistent: true }),
      ],
      ThreadId.make("root"),
    );
    expect(family.nativeChildren.map((child) => child.id)).toEqual(["native"]);
    expect(family.promotableChildren.map((child) => child.id)).toEqual(["app"]);
    expect(family.protectedChildren.map((child) => child.id)).toEqual(["native-protected", "app"]);
    expect([...family.keptThreadIds]).toEqual(["app"]);
  });

  it("retains live descendants across hidden owners only inside a promotable branch", () => {
    const family = getOwnedThreadFamily(
      [
        thread("app", "root"),
        thread("hidden", "app", { deleted: true }),
        thread("nested-native", "hidden", { source: "provider", persistent: true }),
        thread("archived-direct", "root", { archived: true }),
        thread("stranded", "archived-direct"),
        thread("fork", "app", { relationship: "fork" }),
        thread("fork-child", "fork"),
        thread("released", "app", { independent: true }),
        thread("released-child", "released"),
      ],
      ThreadId.make("root"),
    );
    expect(family.children.map((child) => child.id)).toEqual(["app", "nested-native", "stranded"]);
    expect([...family.keptThreadIds]).toEqual(["app", "nested-native"]);
    expect(family.protectedChildren.map((child) => child.id)).toEqual(["nested-native"]);
  });

  it("terminates malformed lineage cycles without including the root as its own child", () => {
    const family = getOwnedThreadFamily(
      [thread("root", "child"), thread("child", "root")],
      ThreadId.make("root"),
    );
    expect(family.children.map((child) => child.id)).toEqual(["child"]);
  });

  it("archives recursive mixed conversation groups and delegated children without independent branches", () => {
    const grouped = (id: string, creator: string, independent = false) => ({
      ...thread(id, null),
      createdBy: "agent",
      creatorThreadId: ThreadId.make(creator),
      creatorGrouping: independent ? "independent" : "grouped",
      forkedFrom: null,
    });
    const family = getOwnedThreadFamily(
      [
        thread("root", null),
        grouped("interactive", "root"),
        thread("delegated", "interactive"),
        grouped("nested-interactive", "delegated"),
        thread("native", "nested-interactive", { source: "provider" }),
        grouped("separate", "root", true),
        thread("separate-child", "separate"),
        { ...grouped("fork-origin", "root"), forkedFrom: { nodeId: "example-node" } },
        thread("fork", "interactive", { relationship: "fork" }),
        thread("fork-child", "fork"),
      ],
      ThreadId.make("root"),
    );
    expect(family.children.map((child) => child.id)).toEqual([
      "interactive",
      "delegated",
      "nested-interactive",
      "native",
    ]);
    expect(family.directChildren.map((child) => child.id)).toEqual(["interactive"]);
  });
});
