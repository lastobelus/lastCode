import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "./baseSchemas.ts";
import { getOwnedThreadFamily } from "./threadArchive.ts";

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

describe("owned archive family", () => {
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
});
