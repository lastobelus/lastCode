import { describe, expect, it } from "vite-plus/test";

import {
  buildDraftActionMenuItems,
  buildThreadActionMenuItems,
  buildStopThreadProcessesMenuItem,
  withThreadActionMenuDividers,
  threadActionRequiresOperate,
  type ThreadActionMenuState,
} from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isPersistent: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  hasRunningAction: false,
  hasStoppableProcesses: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
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
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isPersistent: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "disable-persistence",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "mark-persistent",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(
        items
          .filter((item) => item.disabled && threadActionRequiresOperate(item.id))
          .map((item) => item.id),
      ).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("preserves local actions and restores mutations after a grant", () => {
    const denied = buildThreadActionMenuItems({ ...baseState, canOperate: false, branch: "main" });
    expect(denied.filter((item) => !item.disabled).map((item) => item.id)).toEqual([
      "new-thread-on-branch",
      "mark-unread",
      "copy",
      "project-settings",
    ]);
    const allowed = buildThreadActionMenuItems({ ...baseState, canOperate: true });
    expect(
      allowed
        .filter((item) => threadActionRequiresOperate(item.id))
        .every((item) => !item.disabled),
    ).toBe(true);
  });

  it("keeps handoff and project navigation available while disabling persistence and process mutations", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      canOperate: false,
      hasStoppableProcesses: true,
      projectFilter: { label: "Example", isActive: false },
      handoffs: [handoff],
      handoffsOverflow: true,
    });
    for (const id of ["mark-persistent", "stop-thread-processes"]) {
      expect(items.find((item) => item.id === id)?.disabled).toBe(true);
    }
    for (const id of ["filter-by-project", "handoff:file:/src/app.ts", "handoff-show-all"]) {
      expect(items.find((item) => item.id === id)?.disabled).not.toBe(true);
    }
    expect(items.find((item) => item.id === "handoffs-heading")?.disabled).toBe(true);
  });

  it("offers stopping only when the thread owns a preview or running subprocess", () => {
    expect(buildStopThreadProcessesMenuItem(false)).toBeNull();
    expect(ids(baseState)).not.toContain("stop-thread-processes");
    const items = buildThreadActionMenuItems({ ...baseState, hasStoppableProcesses: true });
    const persistenceIndex = items.findIndex((item) => item.id === "mark-persistent");
    expect(items[persistenceIndex + 1]).toEqual({
      id: "stop-thread-processes",
      label: "Stop all previews & processes",
      destructive: true,
    });
    expect(items[persistenceIndex + 2]?.separatorBefore).toBe(true);
  });

  it("separates branch creation and persistence without separating persistence from stop", () => {
    const items = buildThreadActionMenuItems({ ...baseState, branch: "feature/preview" });
    expect(items[1]?.separatorBefore).toBe(true);
    const persistenceIndex = items.findIndex((item) => item.id === "mark-persistent");
    expect(items[persistenceIndex + 1]?.separatorBefore).toBe(true);
    const withoutPersistence = buildThreadActionMenuItems({
      ...baseState,
      hasStoppableProcesses: true,
      supports: { ...baseState.supports, persistence: false },
    });
    const stopIndex = withoutPersistence.findIndex((item) => item.id === "stop-thread-processes");
    expect(withoutPersistence[stopIndex + 1]?.separatorBefore).toBe(true);
  });

  it("groups legacy thread commands with dividers after creation, annotation, and stop", () => {
    const commands = [
      "new-thread-on-branch",
      "rename",
      "annotate",
      "mark-unread",
      "mark-persistent",
      "stop-thread-processes",
      "copy-path",
    ];
    const items = withThreadActionMenuDividers(commands.map((id) => ({ id, label: id })));
    expect(items.filter((item) => item.separatorBefore).map((item) => item.id)).toEqual([
      "rename",
      "mark-unread",
      "copy-path",
    ]);
    const withoutStop = withThreadActionMenuDividers(
      commands.filter((id) => id !== "stop-thread-processes").map((id) => ({ id, label: id })),
    );
    expect(withoutStop.find((item) => item.id === "copy-path")?.separatorBefore).toBe(true);
  });
  it("hides lifecycle items when the environment lacks the capabilities", () => {
    expect(
      ids({
        ...baseState,
        supports: {
          settlement: false,
          autoSettleOptOut: false,
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

  it("offers project filtering only for surfaces with a scoped thread list", () => {
    expect(ids(baseState)).not.toContain("filter-by-project");
    expect(
      buildThreadActionMenuItems({
        ...baseState,
        projectFilter: { label: "Beta Project", isActive: false },
      }).find((item) => item.id === "filter-by-project"),
    ).toMatchObject({ label: "Filter by Beta Project", icon: "folder-tree" });
  });

  it("offers the way back to all projects once the list is scoped", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      projectFilter: { label: "Beta Project", isActive: true },
    });
    const filterIndex = items.findIndex((candidate) => candidate.id === "filter-by-project");
    expect(items[filterIndex]).toMatchObject({ label: "Show all projects", icon: "folder-tree" });
    expect(items[filterIndex - 1]?.id).toBe("mark-unread");
    expect(items[filterIndex + 1]?.id).toBe("auto-settle");
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

  it("offers auto-settle as a submenu with the current option checked", () => {
    const find = (state: ThreadActionMenuState) =>
      buildThreadActionMenuItems(state).find((item) => item.id === "auto-settle");
    const on = find(baseState);
    expect(on?.label).toBe("Auto-settle behavior");
    expect(on?.children?.map((child) => [child.id, child.checked])).toEqual([
      ["auto-settle:enabled", true],
      ["auto-settle:disabled", false],
    ]);
    const off = find({ ...baseState, autoSettleEnabled: false });
    expect(off?.children?.map((child) => child.checked)).toEqual([false, true]);
    // Sits with the per-thread settings after Mark unread, not the lifecycle verbs.
    const items = buildThreadActionMenuItems(baseState);
    expect(items[items.findIndex((item) => item.id === "mark-unread") + 1]?.id).toBe("auto-settle");
    expect(
      ids({ ...baseState, supports: { ...baseState.supports, autoSettleOptOut: false } }),
    ).not.toContain("auto-settle");
  });

  it("disables snooze when the thread cannot snooze, keeping presets visible", () => {
    const snooze = buildThreadActionMenuItems({ ...baseState, canSnoozeNow: false }).find(
      (item) => item.id === "snooze",
    );
    expect(snooze?.disabled).toBe(true);
    expect(snooze?.children?.map((child) => child.id)).toEqual(["snooze:hour", "snooze:custom"]);
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
          autoSettleOptOut: false,
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

describe("buildDraftActionMenuItems", () => {
  it("offers only the copy values the draft has", () => {
    const items = buildDraftActionMenuItems({ hasPath: false, hasBranch: true, hasProject: true });
    expect(items[0]).toMatchObject({ id: "copy", disabled: false });
    expect(items[0]?.children?.map((item) => item.id)).toEqual(["copy-branch"]);

    const noCopy = buildDraftActionMenuItems({
      hasPath: false,
      hasBranch: false,
      hasProject: true,
    });
    expect(noCopy[0]).toMatchObject({ id: "copy", disabled: true, children: [] });
  });

  it("drops project settings without a project and keeps discard last", () => {
    const items = buildDraftActionMenuItems({ hasPath: true, hasBranch: false, hasProject: false });
    expect(items.map((item) => item.id)).toEqual(["copy", "discard"]);
    expect(items.at(-1)).toMatchObject({ label: "Discard draft", destructive: true });
  });
});
