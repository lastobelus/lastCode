import { useCallback, useMemo, useRef, useState } from "react";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import type { SidebarThreadSummary } from "../../types";
import type { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import type { LastCodeThreadEditingCapabilities } from "./useLastCodeThreadEditing";
import type { LastCodeThreadAnnotationActions } from "./LastCodeThreadDetails";
import type { useLastCodeThreadNavigation } from "./useLastCodeThreadNavigation";
import { useLastCodeProjectMenu } from "./useLastCodeProjectMenu";
import { useLastCodeThreadMenu } from "./useLastCodeThreadMenu";
import { useLastCodeBulkThreadMenu } from "./useLastCodeBulkThreadMenu";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { checkTaskPermission } from "./lastcodeSidebarPermission";
function useProjectMenuThreads(threadsByKey: ReadonlyMap<string, SidebarThreadSummary>) {
  // Event-time menu reads follow refreshed members without invalidating every row callback.
  const threadsRef = useRef(threadsByKey);
  threadsRef.current = threadsByKey;
  const getProjectThreads = useCallback(() => Array.from(threadsRef.current.values()), []);
  const getThread = useCallback(
    (ref: ScopedThreadRef) => threadsRef.current.get(scopedThreadKey(ref)) ?? null,
    [],
  );
  return { getProjectThreads, getThread };
}
/** Project-scoped menu targets and independent project editor lifetimes. */
export function useLastCodeProjectMenus(
  project: SidebarProjectSnapshot,
  threadsByKey: ReadonlyMap<string, SidebarThreadSummary>,
  editing: LastCodeThreadEditingCapabilities,
  annotations: LastCodeThreadAnnotationActions,
  navigateToThread: ReturnType<typeof useLastCodeThreadNavigation>["navigateToThread"],
  handleNewThread: ReturnType<typeof useNewThreadHandler>,
) {
  const { getProjectThreads, getThread } = useProjectMenuThreads(threadsByKey);
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const [renameTarget, setRenameTarget] = useState<SidebarProjectGroupMember | null>(null);
  const [groupingTarget, setGroupingTarget] = useState<SidebarProjectGroupMember | null>(null);
  const openRename = useCallback((member: SidebarProjectGroupMember) => {
    if (checkTaskPermission(member.environmentId)) setRenameTarget(member);
  }, []);
  const openGrouping = useCallback(
    (member: SidebarProjectGroupMember) => setGroupingTarget(member),
    [],
  );
  const showProjectMenu = useLastCodeProjectMenu(
    project,
    openRename,
    openGrouping,
    getProjectThreads,
  );
  const showBulkMenu = useLastCodeBulkThreadMenu();
  const startThreadRename = useCallback(
    (key: string, title: string) => {
      const ref = parseScopedThreadKey(key);
      if (ref) editing.requestRename(ref, title);
    },
    [editing],
  );
  const showThreadMenu = useLastCodeThreadMenu(
    project,
    getThread,
    startThreadRename,
    annotations.onEditAnnotation,
    navigateToThread,
    handleNewThread,
  );
  const menus = useMemo(
    () => ({ showThreadMenu, showBulkMenu, clearSelection }),
    [showThreadMenu, showBulkMenu, clearSelection],
  );
  const closeRename = useCallback(() => setRenameTarget(null), []);
  const closeGrouping = useCallback(() => setGroupingTarget(null), []);
  return {
    showProjectMenu,
    menus,
    renameDialog: { target: renameTarget, onClose: closeRename },
    groupingDialog: { target: groupingTarget, onClose: closeGrouping },
  };
}
