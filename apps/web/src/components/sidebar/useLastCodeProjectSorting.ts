import { useRef } from "react";
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
  const gestures = {
    dragInProgressRef,
    suppressProjectClickAfterDragRef,
    suppressProjectClickForContextMenuRef,
  };
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const collisionDetection = ((args) => {
    const collisions = pointerWithin(args);
    return collisions.length > 0 ? collisions : closestCorners(args);
  }) satisfies CollisionDetection;
  const onDragStart = () => {
    if (!manual) return;
    dragInProgressRef.current = true;
    suppressProjectClickAfterDragRef.current = true;
  };
  const onDragEnd = (event: DragEndEvent) => {
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
  };
  const onDragCancel = () => {
    dragInProgressRef.current = false;
  };
  return { manual, gestures, sensors, collisionDetection, onDragStart, onDragEnd, onDragCancel };
}
