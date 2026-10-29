import { CommandId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  buildLastCodeThreadMenu,
  lastcodeThreadActionRequiresOperate,
  LASTCODE_THREAD_ACTION_POLICY,
  isLastCodeThreadActionId,
  parseLastCodeHandoffAction,
} from "./lastcodeThreadMenu";

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

function menuInput(
  canOperate: boolean,
  persistent: boolean,
  grouped: boolean,
  optional: boolean,
): ReturnType<typeof input> {
  const data = input();
  return {
    ...data,
    canOperate,
    thread: {
      ...data.thread,
      persistent,
      creatorGrouping: grouped ? "grouped" : "independent",
      archivePending: optional
        ? {
            status: "failed",
            threadId: ThreadId.make("thread"),
            commandId: CommandId.make("command"),
            error: "Rejected",
          }
        : null,
    },
    handoffs: optional ? data.handoffs : { entries: [], hasMore: false },
  };
}

describe("LastCode thread context menu", () => {
  it("classifies every emitted static action across optional menu states", () => {
    const emitted = new Set<string>();
    const permissions = [true, false].flatMap((canOperate) =>
      [true, false].map((persistent) => ({ canOperate, persistent })),
    );
    const grouping = permissions.flatMap((permission) =>
      [true, false].map((grouped) => ({ ...permission, grouped })),
    );
    const cases = grouping.flatMap((group) =>
      [true, false].map((optional) => ({ ...group, optional })),
    );
    for (const { canOperate, persistent, grouped, optional } of cases) {
      const menu = buildLastCodeThreadMenu(menuInput(canOperate, persistent, grouped, optional));
      for (const item of menu) {
        if (item.id.startsWith("handoff:")) continue;
        expect(isLastCodeThreadActionId(item.id), item.id).toBe(true);
        emitted.add(item.id);
        if (lastcodeThreadActionRequiresOperate(item.id) && !canOperate)
          expect(item.disabled, item.id).toBe(true);
      }
    }
    expect([...emitted].sort()).toEqual(Object.keys(LASTCODE_THREAD_ACTION_POLICY).sort());
    for (const action of [null, "unknown", "constructor", "__proto__"]) {
      expect(isLastCodeThreadActionId(action)).toBe(false);
      expect(lastcodeThreadActionRequiresOperate(action)).toBe(false);
    }
  });
  it("parses dynamic handoff IDs separately without splitting their identity", () => {
    expect(parseLastCodeHandoffAction("handoff:remote:entry")).toEqual({
      kind: "entry",
      id: "remote:entry",
    });
    expect(parseLastCodeHandoffAction("handoff-show-all")).toEqual({ kind: "all" });
    expect(parseLastCodeHandoffAction(null)).toBeNull();
    expect(parseLastCodeHandoffAction("copy-path")).toBeNull();
  });
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
      "mark-read",
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
      "mark-read",
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
      "mark-read",
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
