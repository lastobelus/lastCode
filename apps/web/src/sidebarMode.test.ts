import { describe, expect, it } from "vite-plus/test";
import { resolveSidebarMode, shouldChooseNewThreadProject } from "./sidebarMode";

describe("sidebar selection", () => {
  it.each([
    [false, "inbox"],
    [true, "lastcode"],
  ] as const)("LastCode=%s selects %s", (lastcodeSidebarEnabled, expected) => {
    const preferences = { lastcodeSidebarEnabled };
    expect(resolveSidebarMode(preferences)).toBe(expected);
    expect(resolveSidebarMode(preferences, true, true)).toBe("inbox");
    expect(resolveSidebarMode(preferences, false)).toBe("inbox");
    expect(shouldChooseNewThreadProject(resolveSidebarMode(preferences), 2)).toBe(
      expected === "inbox",
    );
    expect(shouldChooseNewThreadProject(resolveSidebarMode(preferences), 1)).toBe(false);
  });
});
