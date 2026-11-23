import { isThreadAnnotationHiddenInList } from "@t3tools/shared/threadAnnotation";

import type { SidebarThreadSummary } from "../../types";
import { lastcodeSidebarThreadKey } from "../lastcodeSidebarFamilies.logic";

export function filterLastCodeAnnotationInboxRows<T extends SidebarThreadSummary>(
  threads: readonly T[],
  routeRowThreadKey: string | null,
): T[] {
  return threads.filter(
    (thread) =>
      !isThreadAnnotationHiddenInList(thread) ||
      lastcodeSidebarThreadKey(thread) === routeRowThreadKey,
  );
}
