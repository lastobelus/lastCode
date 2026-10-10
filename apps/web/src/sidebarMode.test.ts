import { describe, expect, it } from "vite-plus/test";
import {
  resolveSidebarMode,
  shouldChooseNewThreadProject,
  toggleUpstreamSidebar,
} from "./sidebarMode";

describe("sidebar selection", () => {
  it.each([
    [false, false, "inbox"],
    [false, true, "legacy"],
    [true, false, "lastcode"],
    [true, true, "lastcode"],
  ] as const)(
    "LastCode=%s upstream legacy=%s selects %s",
    (lastcodeSidebarEnabled, legacySidebarEnabled, expected) => {
      const preferences = { lastcodeSidebarEnabled, legacySidebarEnabled };
      expect(resolveSidebarMode(preferences)).toBe(expected);
      expect(resolveSidebarMode(preferences, false)).toBe("inbox");
      expect(shouldChooseNewThreadProject(resolveSidebarMode(preferences), 2)).toBe(
        expected === "inbox",
      );
      expect(shouldChooseNewThreadProject(resolveSidebarMode(preferences), 1)).toBe(false);
    },
  );

  it.each([false, true])(
    "restores upstream legacy=%s when LastCode is turned off",
    (legacySidebarEnabled) => {
      const preferences = { lastcodeSidebarEnabled: true, legacySidebarEnabled };
      expect(toggleUpstreamSidebar(preferences)).toEqual({});
      const restored = { ...preferences, lastcodeSidebarEnabled: false };
      expect(resolveSidebarMode(restored)).toBe(legacySidebarEnabled ? "legacy" : "inbox");
      expect(resolveSidebarMode({ ...restored, ...toggleUpstreamSidebar(restored) })).toBe(
        legacySidebarEnabled ? "inbox" : "legacy",
      );
    },
  );
});
