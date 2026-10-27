import { type ComponentProps, type ReactNode } from "react";
import { DndContext } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import { SidebarMenu, SidebarMenuItem } from "../ui/sidebar";
import { LastCodeSidebarProject } from "./LastCodeSidebarProject";
import type { LastCodeProjectDragHandle } from "./LastCodeProjectHeader";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useLastCodeProjectSorting } from "./useLastCodeProjectSorting";
import { useLastCodeSidebarListAnimation } from "./useLastCodeSidebarListAnimation";
function SortableProjectItem({
  projectId,
  children,
}: {
  projectId: string;
  children: (handle: LastCodeProjectDragHandle) => ReactNode;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: projectId, disabled: false });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`group/menu-item relative rounded-md ${isDragging ? "z-20 opacity-80" : ""} ${isOver && !isDragging ? "ring-1 ring-inset ring-primary/40" : ""}`}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
    >
      {children({ attributes, listeners, setActivatorNodeRef })}
    </li>
  );
}
interface Props {
  projects: readonly SidebarProjectSnapshot[];
  orderedProjectKeys: readonly string[];
  activeRoute: { projectKey: string | null; threadKey: string | null };
  expandedLists: ReadonlySet<string>;
  onExpandedChange: (projectKey: string, expanded: boolean) => void;
  jumpLabels: ReadonlyMap<string, string>;
  newThread: ComponentProps<typeof LastCodeSidebarProject>["newThread"];
}
/** One project-content binding, with the original distinct sort-mode mount boundaries. */
export function LastCodeSidebarProjectList(props: Props) {
  const {
    projects,
    orderedProjectKeys,
    activeRoute,
    expandedLists,
    onExpandedChange,
    jumpLabels,
    newThread,
  } = props;
  const sorting = useLastCodeProjectSorting(projects, orderedProjectKeys);
  const animate = useLastCodeSidebarListAnimation();
  const { gestures } = sorting;
  const renderProject = (
    project: SidebarProjectSnapshot,
    dragHandle: LastCodeProjectDragHandle | null,
  ) => (
    <LastCodeSidebarProject
      project={project}
      dragHandle={dragHandle}
      gestures={gestures}
      activeThreadKey={activeRoute.projectKey === project.projectKey ? activeRoute.threadKey : null}
      listExpanded={expandedLists.has(project.projectKey)}
      onListExpandedChange={onExpandedChange}
      jumpLabels={jumpLabels}
      newThread={newThread}
    />
  );
  if (sorting.manual)
    return (
      <DndContext
        sensors={sorting.sensors}
        collisionDetection={sorting.collisionDetection}
        modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
        onDragStart={sorting.onDragStart}
        onDragEnd={sorting.onDragEnd}
        onDragCancel={sorting.onDragCancel}
      >
        <SidebarMenu>
          <SortableContext
            items={projects.map((project) => project.projectKey)}
            strategy={verticalListSortingStrategy}
          >
            {projects.map((project) => (
              <SortableProjectItem key={project.projectKey} projectId={project.projectKey}>
                {(handle) => renderProject(project, handle)}
              </SortableProjectItem>
            ))}
          </SortableContext>
        </SidebarMenu>
      </DndContext>
    );
  return (
    <SidebarMenu ref={animate}>
      {projects.map((project) => (
        <SidebarMenuItem key={project.projectKey}>{renderProject(project, null)}</SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}
