import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { SidebarThreadSummary } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import { resolveThreadLastVisitedAt, resolveThreadStatusPill } from "../Sidebar.logic";

/** Select only this row's local watermark; a server-projected watermark remains authoritative. */
export function useLastCodeThreadStatus(thread: SidebarThreadSummary) {
  const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const localLastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[key]);
  return resolveThreadStatusPill({
    thread: {
      ...thread,
      lastVisitedAt: resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt),
    },
  });
}
