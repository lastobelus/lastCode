import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadActionMenuItems,
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
function ids(state: ThreadActionMenuState): string[] {
  return buildThreadActionMenuItems(state).map((item) => item.id);
}

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

  it("keeps explicit read markers available without task operation permission", () => {
    const items = buildThreadActionMenuItems({ ...baseState, canOperate: false });
    expect(items.filter((item) => !item.disabled).map((item) => item.id)).toEqual(
      expect.arrayContaining(["mark-read", "mark-unread"]),
    );
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

  it.each([false, true])("offers Action cancellation when running is %s", (hasRunningAction) => {
    const items = buildThreadActionMenuItems({ ...baseState, hasRunningAction });
    expect(items.some((item) => item.id === "cancel-action")).toBe(hasRunningAction);
  });

  it("offers archive so the handler can read the authoritative family", () => {
    const archiveItem = buildThreadActionMenuItems(baseState).find((item) => item.id === "archive");
    expect(archiveItem?.disabled).toBe(false);
  });

  it.each([false, true])(
    "failure dismissal requires task permission (granted=%s)",
    (canOperate) => {
      const items = buildThreadActionMenuItems({ ...baseState, archiveFailed: true, canOperate });
      const dismissal = items.find((item) => item.id === "dismiss-archive-failure");
      expect(dismissal?.label).toBe("Dismiss archive failure");
      expect(dismissal?.disabled === true).toBe(!canOperate);
      expect(ids(baseState)).not.toContain("dismiss-archive-failure");
    },
  );

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
