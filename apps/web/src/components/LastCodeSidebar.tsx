import { useLastCodeSidebarEnvironments } from "./sidebar/useLastCodeSidebarEnvironments";
import { useLastCodeSidebarNavigation } from "./sidebar/useLastCodeSidebarNavigation";
import { useLastCodeSidebarProjects } from "./sidebar/useLastCodeSidebarProjects";
import { LastCodeSidebarProjectList } from "./sidebar/LastCodeSidebarProjectList";
import { LastCodeSidebarPresentationProvider } from "./sidebar/LastCodeSidebarPresentation";
import { LastCodeThreadActionsProvider } from "./sidebar/LastCodeThreadActions";
import { LastCodeSidebarOptions } from "./sidebar/LastCodeSidebarOptions";
import { LastCodeSidebarDesktopNotice } from "./sidebar/LastCodeSidebarDesktopNotice";
import { LastCodeSidebarConnectionNotice } from "./sidebar/LastCodeSidebarConnectionNotice";
import { FolderPlusIcon, SearchIcon } from "lucide-react";
import { ProjectSidebarDraftList } from "./sidebar/ProjectSidebarDraftList";
import { useCallback, memo, useMemo, useState, type CSSProperties } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { LegacySidebarScale } from "@t3tools/contracts/settings";
import { isElectron } from "../env";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { lastcodeSidebarScaleStyle } from "../lastcodeSidebarScale";
import { useEnvironmentThread } from "../state/threads";
import { Kbd } from "./ui/kbd";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "./ui/sidebar";
import { openCommandPalette } from "../commandPaletteBus";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { LastCodeSidebarThreadPicker } from "./sidebar/LastCodeSidebarThreadPicker";
import { CommandDialogTrigger } from "./ui/command";
import { useClientSettings } from "~/hooks/useSettings";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
function SidebarThreadDetailPrewarmer({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  useEnvironmentThread(threadRef.environmentId, threadRef.threadId);
  return null;
}

interface SidebarProjectsContentProps {
  openAddProject: () => void;
  handleNewThread: ReturnType<typeof useNewThreadHandler>;
  sortedProjects: readonly SidebarProjectSnapshot[];
  orderedProjectKeys: readonly string[];
  expandedThreadListsByProject: ReadonlySet<string>;
  activeRouteProjectKey: string | null;
  routeThreadKey: string | null;
  newThreadShortcutLabel: string | null;
  commandPaletteShortcutLabel: string | null;
  threadJumpLabelByKey: ReadonlyMap<string, string>;
  expandThreadListForProject: (projectKey: string) => void;
  collapseThreadListForProject: (projectKey: string) => void;
  projectsLength: number;
  lastcodeSidebarScale: LegacySidebarScale;
  projectTreeScaleStyle: CSSProperties;
}

const SidebarProjectsContent = memo(function SidebarProjectsContent(
  props: SidebarProjectsContentProps,
) {
  const {
    openAddProject,
    handleNewThread,
    sortedProjects,
    orderedProjectKeys,
    expandedThreadListsByProject,
    activeRouteProjectKey,
    routeThreadKey,
    newThreadShortcutLabel,
    commandPaletteShortcutLabel,
    threadJumpLabelByKey,
    expandThreadListForProject,
    collapseThreadListForProject,
    projectsLength,
    lastcodeSidebarScale,
    projectTreeScaleStyle,
  } = props;

  const newThread = useMemo(
    () => ({ handle: handleNewThread, shortcutLabel: newThreadShortcutLabel }),
    [handleNewThread, newThreadShortcutLabel],
  );
  const activeRoute = useMemo(
    () => ({ projectKey: activeRouteProjectKey, threadKey: routeThreadKey }),
    [activeRouteProjectKey, routeThreadKey],
  );
  const onListExpandedChange = useCallback(
    (key: string, expanded: boolean) => {
      if (expanded) expandThreadListForProject(key);
      else collapseThreadListForProject(key);
    },
    [expandThreadListForProject, collapseThreadListForProject],
  );

  return (
    <SidebarContent
      fixedHeader={
        // Lifted above the stage backdrop, whose fade bleeds below the
        // header and would otherwise paint across the search row's outline.
        <SidebarGroup className="z-[1]">
          <SidebarMenu>
            <SidebarMenuItem>
              <div className="flex min-w-0 items-center gap-1">
                <div className="min-w-0 flex-1">
                  <CommandDialogTrigger
                    render={<SidebarMenuButton data-testid="command-palette-trigger" />}
                  >
                    <SearchIcon />
                    <span className="flex-1 truncate">Search</span>
                    {commandPaletteShortcutLabel ? <Kbd>{commandPaletteShortcutLabel}</Kbd> : null}
                  </CommandDialogTrigger>
                </div>
                <LastCodeSidebarThreadPicker projectGroups={sortedProjects} />
              </div>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      }
    >
      <LastCodeSidebarDesktopNotice />
      <LastCodeSidebarConnectionNotice />
      <SidebarGroup>
        <ProjectSidebarDraftList />
        <div className="mb-1 flex items-center justify-between pl-2 pr-1.5">
          <span className="text-xs font-medium text-sidebar-muted-foreground/80">Projects</span>
          <div className="flex items-center gap-1">
            <LastCodeSidebarOptions />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label="Add project"
                    data-testid="sidebar-add-project-trigger"
                    onClick={openAddProject}
                  />
                }
              >
                <FolderPlusIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="right">Add project</TooltipPopup>
            </Tooltip>
          </div>
        </div>

        <LastCodeSidebarProjectList
          projects={sortedProjects}
          orderedProjectKeys={orderedProjectKeys}
          activeRoute={activeRoute}
          expandedLists={expandedThreadListsByProject}
          onExpandedChange={onListExpandedChange}
          jumpLabels={threadJumpLabelByKey}
          newThread={newThread}
        />

        {projectsLength === 0 && (
          <div
            className="px-2 pt-4 text-center text-secondary-label text-xs"
            data-lastcode-sidebar-scale={lastcodeSidebarScale}
            style={projectTreeScaleStyle}
          >
            No projects yet
          </div>
        )}
      </SidebarGroup>
    </SidebarContent>
  );
});

function LastCodeSidebarView() {
  const lastcodeSidebarScale = useClientSettings<LegacySidebarScale>((s) => s.legacySidebarScale);
  const { grouping, presentation } = useLastCodeSidebarEnvironments();
  const scaleStyle = useMemo(
    () => lastcodeSidebarScaleStyle(lastcodeSidebarScale),
    [lastcodeSidebarScale],
  );
  const handleNewThread = useNewThreadHandler();

  const openAddProjectCommandPalette = useCallback(
    () => openCommandPalette({ open: "add-project" }),
    [],
  );
  const [expandedThreadListsByProject, setExpandedThreadListsByProject] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const { sortedProjects, orderedProjectKeys, resolveProjectKey, index } =
    useLastCodeSidebarProjects(grouping);
  const {
    routeThreadRef,
    routeThreadKey,
    prewarmedSidebarThreadRefs,
    visibleThreadJumpLabelByKey,
    newThreadShortcutLabel,
    commandPaletteShortcutLabel,
  } = useLastCodeSidebarNavigation(sortedProjects, index, expandedThreadListsByProject);
  const { byThreadKey: sidebarThreadByKey } = index;
  const activeRouteProjectKey = useMemo(() => {
    const thread = routeThreadKey ? sidebarThreadByKey.get(routeThreadKey) : null;
    return thread
      ? resolveProjectKey(scopeProjectRef(thread.environmentId, thread.projectId))
      : null;
  }, [routeThreadKey, sidebarThreadByKey, resolveProjectKey]);
  const expandThreadListForProject = useCallback((projectKey: string) => {
    setExpandedThreadListsByProject((current) => {
      if (current.has(projectKey)) return current;
      const next = new Set(current);
      next.add(projectKey);
      return next;
    });
  }, []);

  const collapseThreadListForProject = useCallback((projectKey: string) => {
    setExpandedThreadListsByProject((current) => {
      if (!current.has(projectKey)) return current;
      const next = new Set(current);
      next.delete(projectKey);
      return next;
    });
  }, []);

  return (
    <>
      {prewarmedSidebarThreadRefs.map((threadRef) => (
        <SidebarThreadDetailPrewarmer key={scopedThreadKey(threadRef)} threadRef={threadRef} />
      ))}
      <SidebarChromeHeader isElectron={isElectron} />

      <LastCodeSidebarPresentationProvider
        {...presentation}
        openPullRequestsInRightPanel={routeThreadRef !== null}
      >
        <SidebarProjectsContent
          openAddProject={openAddProjectCommandPalette}
          handleNewThread={handleNewThread}
          sortedProjects={sortedProjects}
          orderedProjectKeys={orderedProjectKeys}
          expandedThreadListsByProject={expandedThreadListsByProject}
          activeRouteProjectKey={activeRouteProjectKey}
          routeThreadKey={routeThreadKey}
          newThreadShortcutLabel={newThreadShortcutLabel}
          commandPaletteShortcutLabel={commandPaletteShortcutLabel}
          threadJumpLabelByKey={visibleThreadJumpLabelByKey}
          expandThreadListForProject={expandThreadListForProject}
          collapseThreadListForProject={collapseThreadListForProject}
          projectsLength={sortedProjects.length}
          lastcodeSidebarScale={lastcodeSidebarScale}
          projectTreeScaleStyle={scaleStyle}
        />
      </LastCodeSidebarPresentationProvider>
      <SidebarChromeFooter />
    </>
  );
}

export default function LastCodeSidebar() {
  return (
    <LastCodeThreadActionsProvider>
      <LastCodeSidebarView />
    </LastCodeThreadActionsProvider>
  );
}
