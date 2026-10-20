import { type RefObject, type MouseEvent, type KeyboardEvent, type PointerEvent } from "react";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useUiStateStore, legacyProjectCwdPreferenceKey } from "../../uiStateStore";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { isMacPlatform } from "../../lib/utils";
import { isContextMenuPointerDown } from "../Sidebar.logic";
export interface LastCodeProjectDragGestures {
  dragInProgressRef: RefObject<boolean>;
  suppressProjectClickAfterDragRef: RefObject<boolean>;
  suppressProjectClickForContextMenuRef: RefObject<boolean>;
}
export function lastCodeProjectExpansionPreferenceKeys(project: SidebarProjectSnapshot): string[] {
  return [
    project.projectKey,
    ...project.memberProjects.map((member) => member.physicalProjectKey),
    ...project.memberProjects.map((member) => legacyProjectCwdPreferenceKey(member.workspaceRoot)),
  ];
}
function activateProjectHeader(
  event: MouseEvent<HTMLButtonElement>,
  gestures: LastCodeProjectDragGestures,
  toggle: () => void,
) {
  const {
    dragInProgressRef,
    suppressProjectClickAfterDragRef,
    suppressProjectClickForContextMenuRef,
  } = gestures;
  if (suppressProjectClickForContextMenuRef.current) {
    suppressProjectClickForContextMenuRef.current = false;
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (dragInProgressRef.current) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (suppressProjectClickAfterDragRef.current) {
    suppressProjectClickAfterDragRef.current = false;
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  const selection = useThreadSelectionStore.getState();
  if (selection.hasSelection()) selection.clearSelection();
  toggle();
}
function prepareProjectPointer(
  event: PointerEvent<HTMLButtonElement>,
  gestures: LastCodeProjectDragGestures,
) {
  gestures.suppressProjectClickForContextMenuRef.current = false;
  if (
    isContextMenuPointerDown({
      button: event.button,
      ctrlKey: event.ctrlKey,
      isMac: isMacPlatform(navigator.platform),
    })
  )
    event.stopPropagation();
  gestures.suppressProjectClickAfterDragRef.current = false;
}
export function useLastCodeProjectHeaderGestures(
  projectPreferenceKeys: string[],
  projectExpanded: boolean,
  gestures: LastCodeProjectDragGestures,
  showProjectMenu: (position: { x: number; y: number }) => Promise<void>,
) {
  const {
    dragInProgressRef,
    suppressProjectClickAfterDragRef,
    suppressProjectClickForContextMenuRef,
  } = gestures;
  const setProjectExpanded = useUiStateStore((state) => state.setProjectExpanded);
  const toggle = () => setProjectExpanded(projectPreferenceKeys, !projectExpanded);
  const onClick = (event: MouseEvent<HTMLButtonElement>) =>
    activateProjectHeader(
      event,
      {
        dragInProgressRef,
        suppressProjectClickAfterDragRef,
        suppressProjectClickForContextMenuRef,
      },
      toggle,
    );
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (!dragInProgressRef.current) toggle();
  };
  const onPointerDownCapture = (event: PointerEvent<HTMLButtonElement>) =>
    prepareProjectPointer(event, {
      dragInProgressRef,
      suppressProjectClickAfterDragRef,
      suppressProjectClickForContextMenuRef,
    });
  const onContextMenu = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    suppressProjectClickForContextMenuRef.current = true;
    void showProjectMenu({ x: event.clientX, y: event.clientY });
  };
  return { onClick, onKeyDown, onPointerDownCapture, onContextMenu };
}
