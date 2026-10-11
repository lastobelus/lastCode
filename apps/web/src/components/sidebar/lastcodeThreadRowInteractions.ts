import { useIsMobile } from "../../hooks/useMediaQuery";
import { makeWorkspaceFileDropHandlers } from "../chat/workspaceFileDrop";
import type { useLastCodeThreadNavigation } from "./useLastCodeThreadNavigation";
import type { LastCodeThreadEditingCapabilities } from "./useLastCodeThreadEditing";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { SidebarThreadSummary } from "../../types";
import { readEnvironmentScope } from "../../state/session";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { toastManager, stackedThreadToast } from "../ui/toast";
import { activateSidebarRowFromKeyboard } from "./sidebarRowKeyboard";

export function activateLastCodeThreadRow(
  thread: SidebarThreadSummary,
  activate: () => void,
  showCleanupFailure: () => void,
  event?: MouseEvent,
) {
  const status = thread.worktreeCleanup?.status;
  if (status === "failed") {
    event?.preventDefault();
    showCleanupFailure();
    return;
  }
  if (status === "deleting" || status === "queued") {
    event?.preventDefault();
    return;
  }
  activate();
}

/** Modified gestures belong to selection/navigation rather than the inline editor. */
function hasRowGestureModifier(event: MouseEvent) {
  return (["metaKey", "ctrlKey", "shiftKey", "altKey"] as const).some((key) => event[key]);
}

function requestsRowContextMenu(event: KeyboardEvent) {
  if (event.key === "ContextMenu") return true;
  return event.key === "F10" && event.shiftKey;
}

/** Preserve the in-progress editor and leave nested controls/modifiers to their own action. */
export function renameLastCodeThreadRow(
  event: MouseEvent,
  thread: SidebarThreadSummary,
  state: { isMobile: boolean; renameActive: boolean },
  requestRename: (ref: ScopedThreadRef, title: string) => void,
) {
  if (!readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)) return;
  if (thread.worktreeCleanup != null) return;
  if (state.renameActive) return;
  if (state.isMobile) return;
  if (hasRowGestureModifier(event)) return;
  if ((event.target as HTMLElement).closest("button, a")) return;
  event.preventDefault();
  requestRename(scopeThreadRef(thread.environmentId, thread.id), thread.title);
}

export function handleLastCodeThreadRowKeyDown(event: KeyboardEvent, activate: () => void) {
  if (requestsRowContextMenu(event)) {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    // Keyboard menus use the same cleanup/multiselect path as pointer requests.
    event.currentTarget.dispatchEvent(
      new globalThis.MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: bounds.left + 16,
        clientY: bounds.bottom,
      }),
    );
    return;
  }
  activateSidebarRowFromKeyboard(event, activate);
}

type MenuPosition = { x: number; y: number };
export type LastCodeThreadRowMenus = {
  showThreadMenu: (
    ref: ScopedThreadRef,
    position: MenuPosition,
    hasStoppableProcesses: boolean,
  ) => Promise<void>;
  showBulkMenu: (position: MenuPosition) => Promise<void>;
  clearSelection: () => void;
};
async function showRowMenu(show: () => Promise<void>) {
  const result = await settlePromise(show);
  if (result._tag !== "Failure") return;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Thread action failed",
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}
export async function openLastCodeThreadRowMenu(
  event: MouseEvent,
  threadRef: ScopedThreadRef,
  state: { cleanupBlocked: boolean; isSelected: boolean; hasStoppableProcesses: boolean },
  menus: LastCodeThreadRowMenus,
) {
  event.preventDefault();
  if (state.cleanupBlocked) return;
  const hasSelection = useThreadSelectionStore.getState().hasSelection();
  const position = { x: event.clientX, y: event.clientY };
  if (hasSelection && state.isSelected) {
    await showRowMenu(() => menus.showBulkMenu(position));
    return;
  }
  if (hasSelection) menus.clearSelection();
  await showRowMenu(() => menus.showThreadMenu(threadRef, position, state.hasStoppableProcesses));
}

type RowNavigation = Pick<
  ReturnType<typeof useLastCodeThreadNavigation>,
  "navigateToThread" | "handleThreadClick"
>;
/** Row-owned interaction and cleanup-dialog lifetime; operations remain project-owned. */
export function useLastCodeThreadRowGestures(
  thread: SidebarThreadSummary,
  navigation: RowNavigation,
  menus: LastCodeThreadRowMenus,
  state: { selected: boolean; hasStoppableProcesses: boolean; renameActive: boolean },
  requestRename: LastCodeThreadEditingCapabilities["requestRename"],
) {
  const isMobile = useIsMobile();
  const [cleanupFailureOpen, setCleanupFailureOpen] = useState(false);
  const { environmentId, id } = thread;
  const { navigateToThread, handleThreadClick } = navigation;
  const { showThreadMenu, showBulkMenu, clearSelection } = menus;
  const { selected, hasStoppableProcesses, renameActive } = state;
  const handleRowClick = useCallback(
    (event: MouseEvent) =>
      activateLastCodeThreadRow(
        thread,
        () => handleThreadClick(event, scopeThreadRef(environmentId, id)),
        () => setCleanupFailureOpen(true),
        event,
      ),
    [thread, handleThreadClick, environmentId, id],
  );
  const handleRowDoubleClick = useCallback(
    (event: MouseEvent) =>
      renameLastCodeThreadRow(event, thread, { isMobile, renameActive }, requestRename),
    [thread, isMobile, renameActive, requestRename],
  );
  const handleRowKeyDown = useCallback(
    (event: KeyboardEvent) =>
      handleLastCodeThreadRowKeyDown(event, () =>
        activateLastCodeThreadRow(
          thread,
          () => {
            void navigateToThread(scopeThreadRef(environmentId, id));
          },
          () => setCleanupFailureOpen(true),
        ),
      ),
    [thread, navigateToThread, environmentId, id],
  );
  const handleRowContextMenu = useCallback(
    (event: MouseEvent) => {
      void openLastCodeThreadRowMenu(
        event,
        scopeThreadRef(environmentId, id),
        {
          cleanupBlocked: thread.worktreeCleanup != null,
          isSelected: selected,
          hasStoppableProcesses,
        },
        { showThreadMenu, showBulkMenu, clearSelection },
      );
    },
    [
      environmentId,
      id,
      thread.worktreeCleanup,
      selected,
      hasStoppableProcesses,
      showThreadMenu,
      showBulkMenu,
      clearSelection,
    ],
  );
  return {
    handleRowClick,
    handleRowDoubleClick,
    handleRowKeyDown,
    handleRowContextMenu,
    cleanupFailureOpen,
    setCleanupFailureOpen,
  };
}

/** File-only drop highlighting belongs to the mounted row, including global drag cancellation. */
export function useLastCodeThreadFileDrop(
  threadRef: ScopedThreadRef,
  onDrop: (ref: ScopedThreadRef, files: File[]) => void,
) {
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const fileDropHandlers = useMemo(
    () =>
      makeWorkspaceFileDropHandlers({
        setDragActive: setIsFileDragOver,
        addFiles: (files) => onDrop(threadRef, files),
        addFolders: () => {},
      }),
    [onDrop, threadRef],
  );
  useEffect(() => {
    if (!isFileDragOver) return;
    const clearFileDrag = () => setIsFileDragOver(false);
    window.addEventListener("dragend", clearFileDrag);
    return () => window.removeEventListener("dragend", clearFileDrag);
  }, [isFileDragOver]);
  return { isFileDragOver, fileDropHandlers };
}
