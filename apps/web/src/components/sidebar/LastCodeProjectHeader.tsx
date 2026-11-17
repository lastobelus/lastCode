import { LastCodeStatusGlyph } from "./LastCodeStatusGlyph";
import { type CSSProperties, type ReactNode } from "react";
import type { EnvironmentIconColor } from "@t3tools/contracts/settings";
import type { useSortable } from "@dnd-kit/sortable";
import { ChevronRightIcon } from "lucide-react";
import { useClientSetting } from "../../hooks/useSettings";
import { lastcodeSidebarScaleStyle } from "../../lastcodeSidebarScale";
import { ConnectedEnvironmentIcon, type ProjectEnvironmentIconEntry } from "../../environmentIcons";
import { NO_PROJECT_GROUP_KEY, type SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { ProjectFavicon } from "../ProjectFavicon";
import { RelativeTime } from "../RelativeTime";
import type { ThreadStatusPill } from "../Sidebar.logic";
import { SidebarMenuButton } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  lastCodeProjectExpansionPreferenceKeys,
  useLastCodeProjectHeaderGestures,
  type LastCodeProjectDragGestures,
} from "./useLastCodeProjectHeaderGestures";
export type LastCodeProjectDragHandle = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners" | "setActivatorNodeRef"
>;
export type LastCodeProjectEnvironmentBadge = ProjectEnvironmentIconEntry & {
  readonly color: EnvironmentIconColor | undefined;
};
function ProjectDisclosure({
  expanded,
  status,
}: {
  expanded: boolean;
  status: ThreadStatusPill | null;
}) {
  return !expanded && status ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={status.label}
            className={`relative inline-flex size-4 shrink-0 items-center justify-center ${status.colorClass}`}
          />
        }
      >
        <span className="absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover/project-header:opacity-0">
          <LastCodeStatusGlyph status={status} size={9} />
        </span>
        <ChevronRightIcon className="absolute inset-0 m-auto size-3.5 text-icon-muted opacity-0 transition-opacity duration-150 group-hover/project-header:opacity-100" />
      </TooltipTrigger>
      <TooltipPopup side="top">{status.label}</TooltipPopup>
    </Tooltip>
  ) : (
    <span className="inline-flex size-4 shrink-0 items-center justify-center">
      <ChevronRightIcon
        className={`size-3.5 text-muted-foreground/70 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
      />
    </span>
  );
}
function ProjectEnvironmentBadges({
  entries,
}: {
  entries: readonly LastCodeProjectEnvironmentBadge[];
}) {
  return (
    entries.length > 0 && (
      <span
        aria-label={`Project environments: ${entries.map((entry) => entry.label).join(", ")}`}
        className="pointer-events-none absolute top-1 right-(--project-environment-inset) inline-flex h-5 items-center gap-(--thread-metadata-gap) rounded-md max-sm:right-[calc(var(--project-environment-inset)+1.5rem*var(--lastcode-sidebar-content-zoom)+var(--thread-metadata-gap))]"
        style={
          {
            "--project-environment-inset":
              "calc(0.5rem + 3rem * var(--lastcode-sidebar-content-zoom) + var(--thread-metadata-gap))",
            "--thread-metadata-gap": "calc(var(--spacing) * var(--lastcode-sidebar-content-zoom))",
          } as CSSProperties
        }
      >
        {entries.slice(0, entries.length > 3 ? 2 : 3).map((entry) => (
          <Tooltip key={entry.environmentId}>
            <TooltipTrigger
              render={
                <span
                  role="img"
                  tabIndex={0}
                  aria-label={entry.label}
                  className="pointer-events-auto inline-flex size-3 items-center justify-center"
                  data-lastcode-sidebar-unscaled-content
                />
              }
            >
              <ConnectedEnvironmentIcon
                environmentId={entry.environmentId}
                context="project"
                color={entry.color}
                className="size-3"
              />
            </TooltipTrigger>
            <TooltipPopup side="top">{entry.label}</TooltipPopup>
          </Tooltip>
        ))}
        {entries.length > 3 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  role="img"
                  tabIndex={0}
                  aria-label={`${entries.length - 2} more project environments`}
                  className="pointer-events-auto inline-flex size-3 items-center justify-center text-3xs text-icon-muted"
                  data-lastcode-sidebar-unscaled-content
                />
              }
            >
              +{entries.length - 2}
            </TooltipTrigger>
            <TooltipPopup side="top">
              <div className="flex flex-col gap-1.5">
                {entries.slice(2).map((entry) => (
                  <div key={entry.environmentId} className="flex items-center gap-2">
                    <ConnectedEnvironmentIcon
                      environmentId={entry.environmentId}
                      context="project"
                      className="size-3 shrink-0"
                    />
                    <span>{entry.label}</span>
                  </div>
                ))}
              </div>
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </span>
    )
  );
}
export function LastCodeProjectHeader({
  project,
  expanded: projectExpanded,
  status: projectStatus,
  environments: projectEnvironmentIcons,
  latestThreadTimestamp,
  drag,
  gestures,
  showMenu,
  children,
}: {
  project: SidebarProjectSnapshot;
  expanded: boolean;
  status: ThreadStatusPill | null;
  environments: readonly LastCodeProjectEnvironmentBadge[];
  latestThreadTimestamp: string | null;
  drag: { readonly manual: boolean; readonly handle: LastCodeProjectDragHandle | null };
  gestures: LastCodeProjectDragGestures;
  showMenu: (position: { x: number; y: number }) => Promise<void>;
  children: ReactNode;
}) {
  const lastcodeSidebarScale = useClientSetting("legacySidebarScale");
  const scaleStyle = lastcodeSidebarScaleStyle(lastcodeSidebarScale);
  const isNoProjectGroup = project.projectKey === NO_PROJECT_GROUP_KEY;
  const isManualProjectSorting = drag.manual;
  const dragHandleProps = drag.handle;
  const environmentCount = Math.min(projectEnvironmentIcons.length, 3);
  const showTimestamp = !projectExpanded && latestThreadTimestamp !== null;
  const preferenceKeys = lastCodeProjectExpansionPreferenceKeys(project);
  const headerGestures = useLastCodeProjectHeaderGestures(
    preferenceKeys,
    projectExpanded,
    gestures,
    showMenu,
  );
  return (
    <div
      className="group/project-header relative"
      data-lastcode-sidebar-scale={lastcodeSidebarScale}
      style={
        {
          ...scaleStyle,
          marginLeft: "calc(8px * var(--lastcode-sidebar-content-zoom) - 8px)",
          "--thread-metadata-gap": "calc(var(--spacing) * var(--lastcode-sidebar-content-zoom))",
          "--project-metadata-width":
            environmentCount > 0 || showTimestamp
              ? `calc(0.5rem + ${3 + environmentCount * 0.75}rem * var(--lastcode-sidebar-content-zoom) + ${environmentCount} * var(--thread-metadata-gap))`
              : "1rem",
        } as CSSProperties
      }
    >
      <SidebarMenuButton
        size="tree"
        ref={isManualProjectSorting ? dragHandleProps?.setActivatorNodeRef : undefined}
        className={isManualProjectSorting ? "cursor-grab active:cursor-grabbing" : undefined}
        {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.attributes : {})}
        {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.listeners : {})}
        {...headerGestures}
      >
        <ProjectDisclosure expanded={projectExpanded} status={projectStatus} />
        <span className="mr-0.5 flex shrink-0">
          <ProjectFavicon project={project} />
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-sm font-medium text-sidebar-foreground/90">
            {project.displayName}
          </span>
          {project.groupedProjectCount > 1 && !isNoProjectGroup ? (
            <span className="shrink-0 text-secondary-label text-3xs">
              {project.groupedProjectCount} projects
            </span>
          ) : null}
        </span>
        {/* Reserve the same timestamp track as thread rows, plus the environment badges. */}
        <span
          aria-hidden
          className="w-(--project-metadata-width) shrink-0 max-sm:w-[calc(var(--project-metadata-width)+1.5rem*var(--lastcode-sidebar-content-zoom)+var(--thread-metadata-gap))]"
        />
      </SidebarMenuButton>
      {/* Environment badges stay left of the New thread action so mixed
            groups remain inspectable without overlapping the action or title. */}
      <ProjectEnvironmentBadges entries={projectEnvironmentIcons} />
      {showTimestamp ? (
        <span className="pointer-events-none absolute top-1 right-2 inline-flex h-5 w-[calc(3rem*var(--lastcode-sidebar-content-zoom))] items-center justify-end transition-opacity duration-150 max-sm:right-[calc(0.5rem+1.5rem*var(--lastcode-sidebar-content-zoom)+var(--thread-metadata-gap))] sm:group-hover/project-header:opacity-0 sm:group-has-[:focus-visible]/project-header:opacity-0">
          <span
            className="text-3xs tabular-nums text-secondary-label"
            data-lastcode-sidebar-unscaled-content
          >
            <RelativeTime timestamp={latestThreadTimestamp} />
          </span>
        </span>
      ) : null}
      {children}
    </div>
  );
}
