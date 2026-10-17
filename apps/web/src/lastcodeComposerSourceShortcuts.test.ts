import { assert, describe, it } from "vite-plus/test";
import type { ShortcutEventLike } from "@t3tools/shared/keybindings";
import { composerFormattingDelimiterForShortcut } from "./lastcodeComposerSourceShortcuts";

function event(overrides: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return {
    key: "j",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

describe("composer formatting shortcuts", () => {
  it.each([
    ["b", false, "**"],
    ["i", false, "*"],
    ["e", false, "`"],
    ["s", true, "~~"],
  ] as const)("uses the platform's Mod key for %s", (key, shiftKey, delimiter) => {
    assert.strictEqual(
      composerFormattingDelimiterForShortcut(event({ key, shiftKey, metaKey: true }), "MacIntel"),
      delimiter,
    );
    assert.isNull(
      composerFormattingDelimiterForShortcut(event({ key, shiftKey, ctrlKey: true }), "MacIntel"),
    );
    for (const platform of ["Win32", "Linux"]) {
      assert.strictEqual(
        composerFormattingDelimiterForShortcut(event({ key, shiftKey, ctrlKey: true }), platform),
        delimiter,
      );
      assert.isNull(
        composerFormattingDelimiterForShortcut(event({ key, shiftKey, metaKey: true }), platform),
      );
    }
  });

  it("rejects extra modifiers and matches the app's non-Latin layout policy", () => {
    assert.isNull(
      composerFormattingDelimiterForShortcut(
        event({ key: "b", metaKey: true, ctrlKey: true }),
        "MacIntel",
      ),
    );
    assert.isNull(
      composerFormattingDelimiterForShortcut(
        event({ key: "s", metaKey: true, shiftKey: true, altKey: true }),
        "MacIntel",
      ),
    );
    assert.strictEqual(
      composerFormattingDelimiterForShortcut(
        event({ key: "ы", code: "KeyS", metaKey: true, shiftKey: true }),
        "MacIntel",
      ),
      "~~",
    );
    assert.isNull(
      composerFormattingDelimiterForShortcut(
        event({ key: "x", code: "KeyS", metaKey: true, shiftKey: true }),
        "MacIntel",
      ),
    );
  });
});
