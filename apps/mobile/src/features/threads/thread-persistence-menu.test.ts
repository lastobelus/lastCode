import { describe, expect, it } from "vite-plus/test";

import { buildThreadPersistenceMenuItems } from "./thread-persistence-menu.ts";

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
});
