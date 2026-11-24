import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { useClientSetting } from "../../hooks/useSettings";
import { ThreadAnnotationNavigationTrigger } from "../thread-annotation/ThreadAnnotation";
import {
  lastcodeSidebarFamilySummary,
  type LastCodeSidebarFamilyRow,
} from "../lastcodeSidebarFamilies.logic";
import type { LastCodeThreadFamilyPresentation } from "./useLastCodeThreadFamily";
import type { useLastCodeThreadDetails } from "./useLastCodeThreadDetails";
import type { useLastCodeThreadRowGestures } from "./lastcodeThreadRowInteractions";

type Relationship = Pick<
  LastCodeThreadFamilyPresentation,
  "relationshipLabel" | "creatorDescription"
>;
type Gestures = Pick<
  ReturnType<typeof useLastCodeThreadRowGestures>,
  "handleRowClick" | "handleRowDoubleClick" | "handleRowKeyDown" | "handleRowContextMenu"
>;
interface Props {
  family: LastCodeSidebarFamilyRow;
  relationship: Relationship;
  lifetime: ReturnType<typeof useLastCodeThreadDetails>;
  gestures: Gestures;
  active: boolean;
  selected: boolean;
  fileDragOver: boolean;
  children: ReactNode;
}
function relationshipLabel(
  family: LastCodeSidebarFamilyRow,
  relationship: Relationship,
  showSubheaders: boolean,
) {
  if (!relationship.relationshipLabel) return undefined;
  const { thread } = family;
  const creator = relationship.creatorDescription ? `, ${relationship.creatorDescription}` : "";
  const protection = thread.persistent ? ", protected from archive and deletion" : "";
  const summary =
    (!family.expanded || !showSubheaders) && family.descendantCount
      ? `, ${lastcodeSidebarFamilySummary(family)}`
      : "";
  return `${thread.title}, ${relationship.relationshipLabel}${creator}${protection}${summary}`;
}
function rowAppearance(
  state: Pick<Props, "active" | "selected" | "fileDragOver">,
  tall: boolean,
  pending: boolean,
) {
  return cn(
    "relative isolate flex h-auto min-h-8 w-full min-w-0 flex-wrap cursor-pointer select-none items-center gap-1 overflow-hidden rounded-md py-1 pr-2 text-left text-xs outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring group-data-[collapsible=icon]:hidden [&>span:last-child]:truncate [&>svg:not([class*='size-'])]:size-4 [&>svg]:shrink-0 [&>svg]:text-sidebar-muted-foreground",
    state.active
      ? "bg-sidebar-row-active font-medium text-sidebar-foreground hover:bg-sidebar-row-active"
      : state.selected
        ? "bg-sidebar-row-selected text-sidebar-foreground hover:bg-sidebar-row-active"
        : "text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
    tall && "min-h-10",
    pending && "cursor-not-allowed opacity-65",
    state.fileDragOver && "ring-1 ring-inset ring-primary/70",
  );
}
/** Keep one row boundary; metadata wraps before consuming the reserved leading budget.
 * Height must remain automatic so wrapped controls and family summaries cannot be clipped.
 */
export function LastCodeThreadRowSurface({
  family,
  relationship,
  lifetime,
  gestures,
  active,
  selected,
  fileDragOver,
  children,
}: Props) {
  const {
    annotationPopoverHandle,
    annotationTriggerId,
    threadNavigationRef,
    threadRowActive,
    threadDetailsTooltipId,
  } = lifetime;
  const groupingStyle = useClientSetting("legacySidebarThreadGroupingStyle");
  const showSubheaders = useClientSetting("lastcodeSidebarFamilyStatusSubheaders");
  const { thread } = family;
  const annotationActive = thread.annotation?.resolvedAt === null;
  const pending =
    thread.worktreeCleanup?.status === "deleting" || thread.worktreeCleanup?.status === "queued";
  const tall = hasCollapsedFamilySummary(family, groupingStyle, showSubheaders);
  return (
    <ThreadAnnotationNavigationTrigger
      annotationActive={annotationActive}
      handle={annotationPopoverHandle}
      id={annotationTriggerId}
      render={
        <div
          ref={threadNavigationRef}
          className={rowAppearance({ active, selected, fileDragOver }, tall, pending)}
        />
      }
      role="button"
      tabIndex={0}
      aria-describedby={!annotationActive && threadRowActive ? threadDetailsTooltipId : undefined}
      data-active={active}
      aria-label={relationshipLabel(family, relationship, showSubheaders)}
      data-slot="sidebar-menu-sub-button"
      data-sidebar="menu-sub-button"
      data-size="sm"
      data-testid={`thread-row-${thread.id}`}
      data-cleanup-pending={pending}
      data-file-drag-over={fileDragOver}
      aria-disabled={pending || undefined}
      onClick={gestures.handleRowClick}
      onDoubleClick={gestures.handleRowDoubleClick}
      onKeyDown={gestures.handleRowKeyDown}
      onContextMenu={gestures.handleRowContextMenu}
    >
      {children}
    </ThreadAnnotationNavigationTrigger>
  );
}

/** Only the enabled typed summary reserves a second line; compact mode stays inline. */
function hasCollapsedFamilySummary(
  family: LastCodeSidebarFamilyRow,
  groupingStyle: string,
  showSubheaders: boolean,
) {
  if (!showSubheaders) return false;
  if (groupingStyle !== "typed-groups") return false;
  if (family.descendantCount === 0) return false;
  return !family.expanded;
}
