import { CommandId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadArchiveFamily, threadUnarchiveTargetId } from "./threadArchive";
import { makeThreadShellFixture } from "../../test-fixtures";

describe("thread family archive confirmation", () => {
  const root = makeThreadShellFixture({ id: ThreadId.make("root"), title: "Parent" });
  const child = (id: string, parent = root.id) =>
    makeThreadShellFixture({
      id: ThreadId.make(id),
      title: id,
      environmentId: root.environmentId,
      lineage: { rootThreadId: root.id, parentThreadId: parent, relationshipToParent: "subagent" },
    });

  const decision = (
    children: ReturnType<typeof child>[],
    options: Partial<Parameters<typeof resolveThreadArchiveFamily>[0]> = {},
  ): Parameters<typeof resolveThreadArchiveFamily>[0] => ({
    threads: [root, ...children],
    children,
    childThreadIds: children.map(({ id }) => id),
    promotableChildThreadIds: [],
    keptThreadIds: [],
    activeChildThreadIds: [],
    activeThreadIds: [],
    unreadThreadIds: [],
    protectedChildThreadIds: [],
    nativeStopCount: 0,
    requiresConfirmation: false,
    canPromote: false,
    canStopAndArchive: true,
    activeChildren: [],
    activeThreads: [],
    unreadThreads: [],
    promotableChildren: [],
    protectedChildren: [],
    ...options,
  });

  it("lists an active owner and unread descendants from the server's decision", () => {
    const first = child("first");
    const nested = child("nested", first.id);
    const family = resolveThreadArchiveFamily(
      decision([first, nested], {
        activeThreadIds: [root.id],
        unreadThreadIds: [nested.id],
        activeThreads: [root],
        unreadThreads: [nested],
        requiresConfirmation: true,
        canPromote: true,
      }),
    );
    expect(family.requiresConfirmation).toBe(true);
    expect(family.confirmLabel).toBe("Stop active threads & archive");
    expect(family.message).toContain("Parent · Working");
    expect(family.message).toContain("nested · Unread");
    expect(family.message).not.toContain("first ·");
    expect(family.message).not.toContain("Keep running separately");
  });

  it("uses the unread label for a standalone owner", () => {
    const family = resolveThreadArchiveFamily(
      decision([], {
        unreadThreadIds: [root.id],
        unreadThreads: [root],
        requiresConfirmation: true,
      }),
    );
    expect(family.confirmLabel).toBe("Archive unread threads");
    expect(family.message).toContain("Parent · Unread");
  });

  it("restores a cascade through its archived owner while preserving individually archived children", () => {
    const archivedChild = { ...child("archived-child"), archivedAt: "2026-10-06T00:00:00.000Z" };
    const cohort = { threadId: root.id, commandId: CommandId.make("archive-family") };
    const archivedOwner = { ...root, archivedAt: archivedChild.archivedAt, archivedWith: cohort };
    expect(threadUnarchiveTargetId(archivedChild)).toBe(archivedChild.id);
    expect(
      threadUnarchiveTargetId(
        {
          ...archivedChild,
          archivedWith: cohort,
        },
        [archivedOwner],
      ),
    ).toBe(root.id);
    expect(threadUnarchiveTargetId({ ...archivedChild, archivedWith: null })).toBe(
      archivedChild.id,
    );
  });

  it("restores the surviving child when its archive owner is unavailable or belongs to another cohort", () => {
    const cohort = { threadId: root.id, commandId: CommandId.make("archive-family") };
    const archivedAt = "2026-10-06T00:00:00.000Z";
    const archivedChild = { ...child("survivor"), archivedAt, archivedWith: cohort };
    const archivedOwner = { ...root, archivedAt, archivedWith: cohort };
    const unavailableOwners = [
      [],
      [{ ...archivedOwner, deletedAt: archivedAt }],
      [{ ...archivedOwner, archivedAt: null }],
      [
        {
          ...archivedOwner,
          archivedWith: { ...cohort, commandId: CommandId.make("other-archive") },
        },
      ],
      [{ ...archivedOwner, archivedWith: null }],
      [{ ...archivedOwner, environmentId: EnvironmentId.make("other-environment") }],
    ];
    for (const owners of unavailableOwners) {
      expect(threadUnarchiveTargetId(archivedChild, owners)).toBe(archivedChild.id);
    }
  });

  it.each([true, false])(
    "explains protected children without offering a separate archive choice: %s",
    (canPromote) => {
      const protectedChild = { ...child("persistent"), persistent: true };
      const family = resolveThreadArchiveFamily(
        decision([protectedChild], {
          protectedChildren: [protectedChild],
          protectedChildThreadIds: [protectedChild.id],
          requiresConfirmation: true,
          canStopAndArchive: false,
          canPromote,
        }),
      );
      expect(family.canStopAndArchive).toBe(false);
      expect(family.message).toMatch(/persistent|protected/i);
      expect(family.message).not.toContain("Keep running separately");
    },
  );

  it("lists every attention member instead of truncating the confirmation", () => {
    const children = Array.from({ length: 5 }, (_, index) => child(`child-${index}`));
    const family = resolveThreadArchiveFamily(
      decision(children, {
        unreadThreadIds: children.map(({ id }) => id),
        unreadThreads: children,
        requiresConfirmation: true,
      }),
    );
    for (const { title } of children) expect(family.message).toContain(`${title} · Unread`);
  });
});
