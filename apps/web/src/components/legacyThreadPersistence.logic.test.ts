import { describe, expect, it } from "vite-plus/test";

import {
  legacyThreadPersistenceAction,
  protectLegacyThreadActions,
} from "./legacyThreadPersistence.logic.ts";

describe("legacy thread persistence actions", () => {
  it("offers the reverse persistence action", () => {
    expect(legacyThreadPersistenceAction({ persistent: true, supported: true })).toMatchObject({
      id: "disable-persistence",
      label: "Disable persistent thread",
    });
  });

  it("disables archive and delete for a persistent selection", () => {
    expect(
      protectLegacyThreadActions(
        [
          { id: "archive", label: "Archive" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        true,
      ),
    ).toEqual([
      {
        id: "archive",
        label: "Archive (disable persistence first)",
        disabled: true,
      },
      {
        id: "delete",
        label: "Delete (disable persistence first)",
        destructive: true,
        disabled: true,
      },
    ]);
  });
});
