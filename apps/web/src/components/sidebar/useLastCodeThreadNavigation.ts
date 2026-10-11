import { useCallback, type MouseEvent } from "react";
import { useRouter } from "@tanstack/react-router";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { isMacPlatform } from "../../lib/utils";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { useSidebarPendingFileDropStore } from "../../sidebarPendingFileDropStore";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useSidebar } from "../ui/sidebar";
import {
  isContextMenuPointerDown,
  isSidebarNestedLinkClick,
  isTrailingDoubleClick,
} from "../Sidebar.logic";

function selectOrNavigate(
  event: MouseEvent,
  threadRef: ScopedThreadRef,
  orderedThreadKeys: readonly string[],
  navigate: (ref: ScopedThreadRef) => Promise<void>,
) {
  if (isSidebarNestedLinkClick(event.target)) return;
  const isMac = isMacPlatform(navigator.platform);
  if (isContextMenuPointerDown({ button: event.button, ctrlKey: event.ctrlKey, isMac })) {
    event.preventDefault();
    return;
  }
  const selection = useThreadSelectionStore.getState();
  const threadKey = scopedThreadKey(threadRef);
  if (isMac ? event.metaKey : event.ctrlKey) {
    event.preventDefault();
    selection.toggleThread(threadKey);
    return;
  }
  if (event.shiftKey) {
    event.preventDefault();
    selection.rangeSelectTo(threadKey, orderedThreadKeys);
    return;
  }
  // Modifier selection still processes every click; only plain double clicks
  // leave the trailing click to the inline rename interaction.
  if (isTrailingDoubleClick(event.detail)) return;
  void navigate(threadRef);
}

/** One project-owned navigation capability shared by its rows, menus and file drops. */
export function useLastCodeThreadNavigation() {
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const navigateToThread = useCallback(
    (threadRef: ScopedThreadRef) => {
      const selection = useThreadSelectionStore.getState();
      if (selection.selectedThreadKeys.size > 0) selection.clearSelection();
      selection.setAnchor(scopedThreadKey(threadRef));
      if (isMobile) setOpenMobile(false);
      return router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [isMobile, router, setOpenMobile],
  );
  const handleThreadClick = useCallback(
    (event: MouseEvent, threadRef: ScopedThreadRef, orderedThreadKeys: readonly string[]) =>
      selectOrNavigate(event, threadRef, orderedThreadKeys, navigateToThread),
    [navigateToThread],
  );
  const handleThreadFileDrop = useCallback(
    async (threadRef: ScopedThreadRef, files: File[]) => {
      const drops = useSidebarPendingFileDropStore.getState();
      const dropId = drops.queuePendingFileDrop({ threadRef, files });
      const targetPathname = router.buildLocation({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      }).pathname;
      if (targetPathname === router.state.location.pathname) return;
      try {
        await navigateToThread(threadRef);
        if (targetPathname !== router.state.location.pathname) drops.clearPendingFileDrop(dropId);
      } catch {
        drops.clearPendingFileDrop(dropId);
      }
    },
    [navigateToThread, router],
  );
  return { navigateToThread, handleThreadClick, handleThreadFileDrop };
}
