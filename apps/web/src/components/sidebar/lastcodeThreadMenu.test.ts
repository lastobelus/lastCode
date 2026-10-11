import { describe, expect, it } from "vite-plus/test";
import { buildLastCodeThreadMenu, lastcodeThreadActionRequiresOperate } from "./lastcodeThreadMenu";

function input(): Parameters<typeof buildLastCodeThreadMenu>[0] {
  return {
    thread: {
      branch: "feature",
      creatorGrouping: "grouped",
      persistent: false,
      archivePending: null,
    },
    creator: { groupingEligible: true, canOpen: true },
    canAnnotate: true,
    supportsPersistence: true,
    hasStoppableProcesses: true,
    projectSettingsKey: "project",
    handoffs: { entries: [{ id: "handoff-1", label: "Review" }], hasMore: true },
    canOperate: true,
  };
}

describe("LastCode thread context menu", () => {
  it("applies the same destination permission policy after the menu closes", () => {
    for (const action of [
      "rename",
      "annotate",
      "creator-independent",
      "creator-grouped",
      "mark-persistent",
      "disable-persistence",
      "stop-thread-processes",
      "dismiss-archive-failure",
      "delete",
    ]) {
      expect(lastcodeThreadActionRequiresOperate(action), action).toBe(true);
    }
    for (const action of [
      null,
      "mark-unread",
      "open-creator",
      "copy-path",
      "copy-thread-id",
      "new-thread-on-branch",
      "project-settings",
      "open-dashboard",
      "handoff:handoff-1",
      "handoff-show-all",
    ]) {
      expect(lastcodeThreadActionRequiresOperate(action), String(action)).toBe(false);
    }
  });
  it("preserves section order, creator direction and handoff targets", () => {
    const menu = buildLastCodeThreadMenu(input());
    expect(menu.map((item) => item.id)).toEqual([
      "new-thread-on-branch",
      "rename",
      "annotate",
      "mark-unread",
      "creator-independent",
      "open-creator",
      "mark-persistent",
      "stop-thread-processes",
      "copy-path",
      "copy-thread-id",
      "open-dashboard",
      "project-settings",
      "handoffs-heading",
      "handoff:handoff-1",
      "handoff-show-all",
      "delete",
    ]);
    expect(menu.find((item) => item.id === "creator-independent")?.label).toBe("Move to top level");
    expect(menu.find((item) => item.id === "handoff:handoff-1")?.label).toBe("Review");
    expect(menu.at(-1)).toMatchObject({ destructive: true, separatorBefore: true });
  });

  it("disables mutations on a read-only destination while retaining navigation and copy", () => {
    const menu = buildLastCodeThreadMenu({ ...input(), canOperate: false });
    for (const id of [
      "rename",
      "annotate",
      "creator-independent",
      "mark-persistent",
      "stop-thread-processes",
      "delete",
    ]) {
      expect(menu.find((item) => item.id === id)?.disabled, id).toBe(true);
    }
    for (const id of [
      "mark-unread",
      "open-creator",
      "copy-path",
      "open-dashboard",
      "handoff:handoff-1",
    ]) {
      expect(menu.find((item) => item.id === id)?.disabled, id).not.toBe(true);
    }
  });

  it("keeps persistence protection independent of operate permission", () => {
    const data = input();
    const menu = buildLastCodeThreadMenu({ ...data, thread: { ...data.thread, persistent: true } });
    expect(menu.find((item) => item.id === "disable-persistence")?.disabled).not.toBe(true);
    expect(menu.find((item) => item.id === "delete")).toMatchObject({ disabled: true });
  });

  it("omits unavailable actions and disables No project settings without hiding handoff guidance", () => {
    const data = input();
    const menu = buildLastCodeThreadMenu({
      ...data,
      thread: { ...data.thread, branch: null },
      creator: { groupingEligible: false, canOpen: false },
      canAnnotate: false,
      supportsPersistence: false,
      hasStoppableProcesses: false,
      projectSettingsKey: null,
      handoffs: { entries: [], hasMore: false },
    });
    expect(
      menu.some((item) =>
        [
          "annotate",
          "mark-persistent",
          "stop-thread-processes",
          "open-creator",
          "new-thread-on-branch",
        ].includes(item.id),
      ),
    ).toBe(false);
    expect(menu.find((item) => item.id === "project-settings")?.disabled).toBe(true);
    expect(menu.find((item) => item.id === "handoffs-empty")).toMatchObject({
      label: "No handoffs yet",
      disabled: true,
    });
  });
});
