import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  branch: null,
  isPinned: false,
  isPersistent: false,
  isSettled: false,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  hasRunningAction: false,
  supports: {
    settlement: true,
    snooze: true,
    pinning: true,
    persistence: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};
const handoff = {
  entry: {
    id: "file:/src/app.ts",
    target: { kind: "file", path: "/src/app.ts" },
    markdownLabel: "Open app",
    lastOpenedAt: 1,
    sequence: 1,
  },
  label: "Open app — /src/app.ts",
} as const;

function ids(state: ThreadActionMenuState): string[] {
  return buildThreadActionMenuItems(state).map((item) => item.id);
}

function allIds(state: ThreadActionMenuState): string[] {
  const flatten = (items: ReturnType<typeof buildThreadActionMenuItems>): string[] =>
    items.flatMap((item) => [item.id, ...(item.children ? flatten(item.children) : [])]);
  return flatten(buildThreadActionMenuItems(state));
}

describe("buildThreadActionMenuItems", () => {
  it("hides lifecycle items when the environment lacks the capabilities", () => {
    expect(
      ids({
        ...baseState,
        supports: {
          settlement: false,
          snooze: false,
          pinning: false,
          persistence: false,
          titleRegeneration: false,
        },
      }),
    ).toEqual([
      "rename",
      "mark-unread",
      "copy",
      "project-settings",
      "handoffs-heading",
      "handoffs-empty",
      "archive",
      "delete",
    ]);
  });

  it("groups project settings with utility actions before archive", () => {
    const items = buildThreadActionMenuItems(baseState);
    const copyIndex = items.findIndex((item) => item.id === "copy");
    expect(items[copyIndex + 1]).toMatchObject({
      id: "project-settings",
      label: "Project settings",
      icon: "settings",
    });
    expect(items[copyIndex + 2]?.id).toBe("handoffs-heading");
    expect(items.at(-2)?.id).toBe("archive");
  });

  it("includes branch items only for threads with a branch", () => {
    const withBranch = allIds({ ...baseState, branch: "feat/menu" });
    expect(withBranch).toContain("new-thread-on-branch");
    expect(withBranch).toContain("copy-branch");
    expect(allIds(baseState)).not.toContain("new-thread-on-branch");
    expect(allIds(baseState)).not.toContain("copy-branch");
  });

  it("flips lifecycle labels with thread state", () => {
    expect(ids({ ...baseState, isPinned: true, isSettled: true, isSnoozed: true })).toEqual(
      expect.arrayContaining(["unpin", "unsettle", "unsnooze"]),
    );
    expect(ids(baseState)).toEqual(expect.arrayContaining(["pin", "settle", "snooze"]));
  });

  it("disables snooze when the thread cannot snooze, keeping presets visible", () => {
    const snooze = buildThreadActionMenuItems({ ...baseState, canSnoozeNow: false }).find(
      (item) => item.id === "snooze",
    );
    expect(snooze?.disabled).toBe(true);
    expect(snooze?.children?.map((child) => child.id)).toEqual(["snooze:hour"]);
  });

  it("disables title regeneration while one is in flight", () => {
    const item = buildThreadActionMenuItems({ ...baseState, isRegeneratingTitle: true }).find(
      (candidate) => candidate.id === "regenerate-title",
    );
    expect(item).toMatchObject({ label: "Regenerating…", disabled: true });
  });

  it("offers cancellation only while an Action is running", () => {
    expect(ids(baseState)).not.toContain("cancel-action");
    expect(ids({ ...baseState, hasRunningAction: true })).toContain("cancel-action");
  });

  it("marks delete as destructive and keeps it last", () => {
    const items = buildThreadActionMenuItems({ ...baseState, branch: "main" });
    expect(items.at(-1)).toMatchObject({ id: "delete", destructive: true });
  });
  it("offers archive as a non-destructive action right before delete", () => {
    const items = buildThreadActionMenuItems(baseState);
    const archiveItem = items.at(-2);
    expect(archiveItem?.id).toBe("archive");
    expect(archiveItem?.icon).toBe("archive");
    expect(archiveItem?.separatorBefore).toBe(true);
    expect(archiveItem?.destructive).toBeFalsy();
    expect(items.at(-1)?.id).toBe("delete");
  });

  it.each([
    [0, 0, false],
    [7, 1, false],
    [8, 1, true],
  ])("renders handoffs with the requested limit and overflow action", (count, shown, overflow) => {
    const entries = Array.from({ length: count }, (_, index) => ({
      ...handoff,
      entry: { ...handoff.entry, id: `handoff-${index}` },
      label: `Handoff ${index}`,
    }));
    const items = buildThreadActionMenuItems({
      ...baseState,
      handoffs: entries.slice(0, shown),
      handoffsOverflow: overflow,
    });
    expect(items.find((item) => item.id === "handoffs-heading")).toMatchObject({
      disabled: true,
      separatorBefore: true,
    });
    expect(
      items.filter((item) => item.id.startsWith("handoff:") && item.id !== "handoff-show-all"),
    ).toHaveLength(shown);
    expect(items.some((item) => item.id === "handoff-show-all")).toBe(overflow);
  });

  it("keeps archive available even when the environment lacks every other capability", () => {
    expect(
      ids({
        ...baseState,
        supports: {
          settlement: false,
          snooze: false,
          pinning: false,
          persistence: false,
          titleRegeneration: false,
        },
      }),
    ).toContain("archive");
  });

  it("disables archive while the thread is running", () => {
    const archiveItem = buildThreadActionMenuItems({ ...baseState, isRunning: true }).find(
      (item) => item.id === "archive",
    );
    expect(archiveItem?.disabled).toBe(true);
  });

  it("replaces the mark action and blocks archive and delete for the persistent thread", () => {
    const items = buildThreadActionMenuItems({ ...baseState, isPersistent: true });
    expect(items).toContainEqual(
      expect.objectContaining({ id: "disable-persistence", label: "Disable persistent thread" }),
    );
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "archive")?.label).toContain("disable persistence");
    expect(items.find((item) => item.id === "delete")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "delete")?.label).toContain("disable persistence");
  });
});
