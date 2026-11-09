import type { ClientSettings } from "@t3tools/contracts/settings";
import { create } from "zustand";

/** Session-only presentation; hiding LastCode never rewrites the saved opt-in. */
export const useSidebarModeStore = create<{ lastcodeHidden: boolean }>(() => ({
  lastcodeHidden: false,
}));

export function resolveSidebarMode(
  settings: Pick<ClientSettings, "lastcodeSidebarEnabled">,
  hydrated = true,
  lastcodeHidden = false,
) {
  if (!hydrated || !settings.lastcodeSidebarEnabled || lastcodeHidden) return "inbox";
  return "lastcode";
}

export function shouldChooseNewThreadProject(
  mode: ReturnType<typeof resolveSidebarMode>,
  projectCount: number,
) {
  return mode === "inbox" && projectCount > 1;
}
