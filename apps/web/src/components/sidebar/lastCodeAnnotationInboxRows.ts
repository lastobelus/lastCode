import { isThreadAnnotationHidden } from "@t3tools/shared/threadAnnotation";

import type { SidebarThreadSummary } from "../../types";
import { lastcodeSidebarThreadKey } from "../lastcodeSidebarFamilies.logic";

export function filterLastCodeAnnotationInboxRows<T extends SidebarThreadSummary>(
  threads: readonly T[],
  routeThreadKey: string | null,
): T[] {
  return threads.filter(
    (thread) =>
      !isThreadAnnotationHidden(thread.annotation) ||
      lastcodeSidebarThreadKey(thread) === routeThreadKey,
  );
}
