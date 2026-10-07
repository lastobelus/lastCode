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
    persistent?: boolean;
  } = {},
) => ({
  id: ThreadId.make(id),
  archivedAt: options.archived ? "2026-01-01" : null,
  deletedAt: null,
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
  });

  it("terminates malformed lineage cycles without including the root as its own child", () => {
    const family = getOwnedThreadFamily(
      [thread("root", "child"), thread("child", "root")],
      ThreadId.make("root"),
    );
    expect(family.children.map((child) => child.id)).toEqual(["child"]);
  });
});
