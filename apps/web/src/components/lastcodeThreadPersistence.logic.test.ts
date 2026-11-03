import { describe, expect, it } from "vite-plus/test";

import {
  lastcodeThreadPersistenceAction,
  protectLegacyThreadActions,
} from "./lastcodeThreadPersistence.logic.ts";

describe("legacy thread persistence actions", () => {
  it("offers the reverse persistence action", () => {
    expect(lastcodeThreadPersistenceAction({ persistent: true, supported: true })).toMatchObject({
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
