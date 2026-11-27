import type { SidebarThreadSummary } from "../../types";
import { lastcodeSidebarThreadKey } from "../lastcodeSidebarFamilies.logic";

export function filterLastCodeAnnotationInboxRows<T extends SidebarThreadSummary>(
  threads: readonly T[],
  routeRowThreadKey: string | null,
  hidden: ReadonlySet<string>,
): T[] {
  return threads.filter((thread) => {
    const key = lastcodeSidebarThreadKey(thread);
    return key === routeRowThreadKey || !hidden.has(key);
  });
}
