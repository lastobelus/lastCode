import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadPersistenceMenuItems,
  persistenceIntentForMenuEvent,
  withThreadMenuDividers,
} from "./thread-persistence-menu.ts";

describe("buildThreadPersistenceMenuItems", () => {
  const actions = [
    { id: "archive", title: "Archive" },
    { id: "delete", title: "Delete", attributes: { destructive: true } },
  ] as const;

  it("offers designation when supported", () => {
    expect(
      buildThreadPersistenceMenuItems({ actions, persistent: false, supported: true })[0],
    ).toMatchObject({ id: "mark-persistent", title: "Mark as persistent thread" });
  });

  it("offers disable and guards destructive lifecycle actions", () => {
    const items = buildThreadPersistenceMenuItems({ actions, persistent: true, supported: true });

    expect(items[0]).toMatchObject({ id: "disable-persistence" });
    expect(items.slice(1)).toEqual([
      {
        id: "archive",
        title: "Archive (disable persistence first)",
        attributes: { disabled: true },
      },
      {
        id: "delete",
        title: "Delete (disable persistence first)",
        attributes: { destructive: true, disabled: true },
      },
    ]);
  });

  it("preserves the selected persistence intent even if shell state changes", () => {
    expect(persistenceIntentForMenuEvent("mark-persistent")).toBe(true);
    expect(persistenceIntentForMenuEvent("disable-persistence")).toBe(false);
    expect(persistenceIntentForMenuEvent("archive")).toBeNull();
  });
});

describe("thread menu dividers", () => {
  const actions = [
    { id: "new-thread-on-branch", title: "New thread on feature" },
    { id: "annotate", title: "Annotate thread" },
    { id: "mark-persistent", title: "Mark as persistent thread" },
    { id: "stop-thread-processes", title: "Stop all previews & processes" },
    { id: "archive", title: "Archive" },
  ];

  it("keeps persistence and stop together between inline native dividers", () => {
    const groups = withThreadMenuDividers(actions, true);
    expect(groups.map((group) => group.subactions?.map((action) => action.id))).toEqual([
      ["new-thread-on-branch"],
      ["annotate"],
      ["mark-persistent", "stop-thread-processes"],
      ["archive"],
    ]);
    expect(groups.every((group) => group.displayInline === true)).toBe(true);
  });

  it("ends the persistence group when there is nothing to stop", () => {
    const groups = withThreadMenuDividers(
      actions.filter((action) => action.id !== "stop-thread-processes"),
      true,
    );
    expect(groups.map((group) => group.subactions?.map((action) => action.id))).toEqual([
      ["new-thread-on-branch"],
      ["annotate"],
      ["mark-persistent"],
      ["archive"],
    ]);
  });

  it("keeps commands directly accessible when inline groups are unsupported", () => {
    expect(withThreadMenuDividers(actions, false)).toEqual(actions);
  });
});
