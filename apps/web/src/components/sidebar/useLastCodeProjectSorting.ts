import { useCallback, useMemo, useRef } from "react";
import {
  closestCorners,
  pointerWithin,
  PointerSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useClientSetting } from "../../hooks/useSettings";
import { useUiStateStore } from "../../uiStateStore";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
/** Own one collection's drag session; reorder exact physical members of logical groups. */
export function useLastCodeProjectSorting(
  projects: readonly SidebarProjectSnapshot[],
  orderedProjectKeys: readonly string[],
) {
  const manual = useClientSetting("sidebarProjectSortOrder") === "manual";
  const reorderProjects = useUiStateStore((state) => state.reorderProjects);
  const dragInProgressRef = useRef(false);
  const suppressProjectClickAfterDragRef = useRef(false);
  const suppressProjectClickForContextMenuRef = useRef(false);
  const gestures = useMemo(
    () => ({
      dragInProgressRef,
      suppressProjectClickAfterDragRef,
      suppressProjectClickForContextMenuRef,
    }),
    [],
  );
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const collisionDetection = useCallback<CollisionDetection>((args) => {
    const collisions = pointerWithin(args);
    return collisions.length > 0 ? collisions : closestCorners(args);
  }, []);
  const onDragStart = useCallback(() => {
    if (!manual) return;
    dragInProgressRef.current = true;
    suppressProjectClickAfterDragRef.current = true;
  }, [manual]);
  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      dragInProgressRef.current = false;
      if (!manual) return;
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const activeProject = projects.find((project) => project.projectKey === active.id);
      const overProject = projects.find((project) => project.projectKey === over.id);
      if (!activeProject || !overProject) return;
      reorderProjects(
        [...orderedProjectKeys],
        activeProject.memberProjects.map((member) => member.physicalProjectKey),
        overProject.memberProjects.map((member) => member.physicalProjectKey),
      );
    },
    [manual, orderedProjectKeys, projects, reorderProjects],
  );
  const onDragCancel = useCallback(() => {
    dragInProgressRef.current = false;
  }, []);
  return { manual, gestures, sensors, collisionDetection, onDragStart, onDragEnd, onDragCancel };
}
