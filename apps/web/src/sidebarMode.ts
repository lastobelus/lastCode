import type { ClientSettings } from "@t3tools/contracts/settings";
import { create } from "zustand";

/** Session-only presentation; toggling never rewrites saved sidebar preferences. */
export const useSidebarModeStore = create<{ lastcodeHidden: boolean }>(() => ({
  lastcodeHidden: false,
}));

type SidebarPreferences = Pick<ClientSettings, "lastcodeSidebarEnabled" | "legacySidebarEnabled">;

/** Keep the LastCode override independent from the retained upstream fallback. */
export function resolveSidebarMode(
  settings: SidebarPreferences,
  hydrated = true,
  lastcodeHidden = false,
) {
  if (!hydrated) return "inbox";
  if (settings.lastcodeSidebarEnabled) return lastcodeHidden ? "inbox" : "lastcode";
  return settings.legacySidebarEnabled ? "legacy" : "inbox";
}

/** Upstream quick controls cannot change the visible sidebar while overridden. */
export function toggleUpstreamSidebar(settings: SidebarPreferences) {
  return settings.lastcodeSidebarEnabled
    ? {}
    : { legacySidebarEnabled: !settings.legacySidebarEnabled };
}

export function shouldChooseNewThreadProject(
  mode: ReturnType<typeof resolveSidebarMode>,
  projectCount: number,
) {
  return mode === "inbox" && projectCount > 1;
}
