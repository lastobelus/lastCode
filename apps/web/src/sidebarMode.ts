import type { ClientSettings } from "@t3tools/contracts/settings";

type SidebarPreferences = Pick<ClientSettings, "lastcodeSidebarEnabled" | "legacySidebarEnabled">;

/** Keep the LastCode override independent from the retained upstream fallback. */
export function resolveSidebarMode(settings: SidebarPreferences, hydrated = true) {
  if (!hydrated) return "inbox";
  if (settings.lastcodeSidebarEnabled) return "lastcode";
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
