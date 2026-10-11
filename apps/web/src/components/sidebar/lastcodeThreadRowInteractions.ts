import type { KeyboardEvent, MouseEvent } from "react";
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

/** Preserve the in-progress editor and leave nested controls/modifiers to their own action. */
export function renameLastCodeThreadRow(
  event: MouseEvent,
  thread: SidebarThreadSummary,
  state: { isMobile: boolean; renameActive: boolean },
  requestRename: (ref: ScopedThreadRef, title: string) => void,
) {
  if (!readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)) return;
  if (thread.worktreeCleanup != null || state.renameActive || state.isMobile) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if ((event.target as HTMLElement).closest("button, a")) return;
  event.preventDefault();
  requestRename(scopeThreadRef(thread.environmentId, thread.id), thread.title);
}

export function handleLastCodeThreadRowKeyDown(event: KeyboardEvent, activate: () => void) {
  if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
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
