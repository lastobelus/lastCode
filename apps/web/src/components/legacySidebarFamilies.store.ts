import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

const STORAGE_KEY = "lastcode:legacy-sidebar-collapsed-families:v1";

function readCollapsedFamilies(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([key, value]) => key.length > 0 && typeof value === "boolean"),
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
      collapsedByKey[key] = collapsed;
      try {
        if (typeof window !== "undefined")
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(collapsedByKey));
      } catch {
        // Unavailable storage must not prevent toggling the family for this session.
      }
      return { collapsedByKey };
    }),
}));

/** Keep project projections stable when another project's family is toggled. */
export function useCollapsedLegacySidebarFamilies(threadKeys: readonly string[]) {
  return useLegacySidebarFamiliesStore(
    useShallow((state) => {
      const collapsedByKey: Record<string, boolean> = {};
      for (const key of threadKeys) {
        if (state.collapsedByKey[key] !== undefined)
          collapsedByKey[key] = state.collapsedByKey[key];
      }
      return collapsedByKey;
    }),
  );
}
