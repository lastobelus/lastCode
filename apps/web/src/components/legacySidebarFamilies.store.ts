import { create } from "zustand";

const STORAGE_KEY = "lastcode:legacy-sidebar-collapsed-families:v1";

function readCollapsedFamilies(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([key, value]) => key.length > 0 && value === true),
    );
  } catch {
    return {};
  }
}

/** Collapse preferences are client-local and scoped by environment/thread, like other sidebar UI state. */
export const useLegacySidebarFamiliesStore = create<{
  collapsedByKey: Record<string, boolean>;
  setCollapsed: (key: string, collapsed: boolean) => void;
}>((set) => ({
  collapsedByKey: readCollapsedFamilies(),
  setCollapsed: (key, collapsed) =>
    set((state) => {
      const collapsedByKey = { ...state.collapsedByKey };
      if (collapsed) collapsedByKey[key] = true;
      else delete collapsedByKey[key];
      try {
        if (typeof window !== "undefined")
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(collapsedByKey));
      } catch {
        // Unavailable storage must not prevent toggling the family for this session.
      }
      return { collapsedByKey };
    }),
}));
