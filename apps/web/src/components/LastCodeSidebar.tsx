import {
  LastCodeSidebarPresentationProvider,
  useLastCodeSidebarPresentation,
} from "./sidebar/LastCodeSidebarPresentation";
import { LastCodeThreadMetadataControls } from "./sidebar/LastCodeThreadMetadataControls";
import { LastCodeThreadRowSurface } from "./sidebar/LastCodeThreadRowSurface";
import { useLastCodeThreadNavigation } from "./sidebar/useLastCodeThreadNavigation";
import {
  LastCodeProjectHeader,
  type LastCodeProjectDragHandle as SortableProjectHandleProps,
} from "./sidebar/LastCodeProjectHeader";
import { lastCodeProjectExpansionPreferenceKeys } from "./sidebar/useLastCodeProjectHeaderGestures";
import { useLastCodeProjectThreads } from "./sidebar/useLastCodeProjectThreads";
import { projectLastCodeProjectThreads } from "./sidebar/lastcodeProjectThreads";
import {
  LastCodeThreadDetails,
  LastCodeThreadCleanupOverlay,
  type LastCodeThreadAnnotationActions,
} from "./sidebar/LastCodeThreadDetails";
import {
  useLastCodeThreadRowGestures,
  useLastCodeThreadFileDrop,
  type LastCodeThreadRowMenus,
} from "./sidebar/lastcodeThreadRowInteractions";
import { useLastCodeThreadIdentity } from "./sidebar/useLastCodeThreadIdentity";
import { createLastCodeThreadHoverContents } from "./sidebar/LastCodeThreadHoverDetails";
import { useLastCodeThreadStatus } from "./sidebar/useLastCodeThreadStatus";
import { useLastCodeThreadDetails } from "./sidebar/useLastCodeThreadDetails";
import { useLastCodeThreadFamily } from "./sidebar/useLastCodeThreadFamily";
import {
  LastCodeThreadFamilyDisclosure,
  LastCodeSubagentGroup,
  LastCodeThreadGroupHeading,
} from "./sidebar/LastCodeThreadFamily";
import { useLastCodeThreadSourceControl } from "./sidebar/useLastCodeThreadSourceControl";
import { useLastCodeThreadProcesses } from "./sidebar/useLastCodeThreadProcesses";
import { LastCodeThreadProcesses } from "./sidebar/LastCodeThreadProcesses";
import { LastCodeThreadLeadingControls } from "./sidebar/LastCodeThreadTitle";
import { LastCodeThreadRowLayout } from "./sidebar/LastCodeThreadRowLayout";
import {
  useLastCodeThreadEditing,
  type LastCodeRenameTarget,
  type LastCodeThreadEditingCapabilities,
} from "./sidebar/useLastCodeThreadEditing";
import { useLastCodeBulkThreadMenu } from "./sidebar/useLastCodeBulkThreadMenu";
import { useLastCodeThreadMenu } from "./sidebar/useLastCodeThreadMenu";
import { useLastCodeThreadAnnotations } from "./sidebar/useLastCodeThreadAnnotations";
import { LastCodeThreadActionsProvider } from "./sidebar/LastCodeThreadActions";
import { useLastCodeProjectMenu } from "./sidebar/useLastCodeProjectMenu";
import { checkTaskPermission } from "./sidebar/lastcodeSidebarPermission";
import { LastCodeProjectRenameDialog } from "./sidebar/LastCodeProjectRenameDialog";
import { LastCodeProjectGroupingDialog } from "./sidebar/LastCodeProjectGroupingDialog";

import { LastCodeSidebarOptions } from "./sidebar/LastCodeSidebarOptions";
import { LastCodeSidebarDesktopNotice } from "./sidebar/LastCodeSidebarDesktopNotice";
import { LastCodeSidebarConnectionNotice } from "./sidebar/LastCodeSidebarConnectionNotice";
import { LastCodeProjectNewThread } from "./sidebar/LastCodeProjectNewThread";

import { useSidebarProviderBadgePreferences } from "./sidebar/SidebarEnvironmentIcon";
import { FolderPlusIcon, SearchIcon } from "lucide-react";
import { ThreadStatusLabel } from "./ThreadStatusIndicators";
import { ProjectSidebarDraftList } from "./sidebar/ProjectSidebarDraftList";
import { useAtomValue } from "@effect/atom-react";
import { autoAnimate } from "@formkit/auto-animate";
import React, {
  useCallback,
  useEffect,
  memo,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  DndContext,
  type DragCancelEvent,
  type CollisionDetection,
  PointerSensor,
  type DragStartEvent,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  ProjectId,
  type ScopedThreadRef,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import {
  parseScopedThreadKey,
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { threadShellIsVisible } from "@t3tools/client-runtime/state/models";
import { useNavigate, useParams } from "@tanstack/react-router";
import { type EnvironmentIconColor, type LegacySidebarScale } from "@t3tools/contracts/settings";
import { isDesktopLocalConnectionTarget, isWslConnectionTarget } from "../connection/desktopLocal";
import { isElectron } from "../env";
import { useTerminalFocus } from "../hooks/useTerminalFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { useProjects, useThreadShells } from "../state/entities";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { useEnvironmentScope } from "../state/session";
import {
  legacyProjectCwdPreferenceKey,
  resolveProjectExpanded,
  useUiStateStore,
} from "../uiStateStore";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHintsForModifiers,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { useShortcutModifierState } from "../shortcutModifierState";
import { useComposerDraftStore } from "../composerDraftStore";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { lastcodeSidebarScaleStyle } from "../lastcodeSidebarScale";
import { projectEnvironmentIconEntries, resolveEnvironmentIconColor } from "../environmentIcons";

import { useEnvironmentThread } from "../state/threads";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import {
  buildThreadRouteParams,
  resolveActiveThreadRouteRef,
  resolveThreadRouteTarget,
} from "../threadRoutes";
import { Kbd } from "./ui/kbd";
import { Button } from "./ui/button";

import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "./ui/sidebar";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { isCommandPaletteOpen, openCommandPalette } from "../commandPaletteBus";
import {
  getSidebarThreadIdsToPrewarm,
  resolveAdjacentThreadId,
  orderItemsByPreferredIds,
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  useSidebarRowSubscriptionLease,
  useThreadJumpHintVisibility,
} from "./Sidebar.logic";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { LastCodeSidebarThreadPicker } from "./sidebar/LastCodeSidebarThreadPicker";
import { CommandDialogTrigger } from "./ui/command";
import { useClientSettings } from "~/hooks/useSettings";
import { primaryServerKeybindingsAtom, primaryServerProvidersAtom } from "../state/server";
import {
  derivePhysicalProjectKey,
  getProjectOrderKey,
  selectProjectGroupingSettings,
} from "../logicalProject";
import type { SidebarThreadSummary } from "../types";
import { type LastCodeSidebarFamilyRow } from "./lastcodeSidebarFamilies.logic";
import { useLastCodeSidebarFamiliesStore } from "./lastcodeSidebarFamilies.store";
import { deriveProviderInstanceEntries, type ProviderInstanceEntry } from "../providerInstances";
import { WorktreeCleanupFailureDialog } from "./WorktreeCleanupFailureDialog";
import {
  buildPhysicalToLogicalProjectKeyMap,
  buildSidebarProjectSnapshots,
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";
const SIDEBAR_LIST_ANIMATION_OPTIONS = {
  duration: 180,
  easing: "ease-out",
} as const;
const EMPTY_THREAD_JUMP_LABELS = new Map<string, string>();

function SidebarThreadDetailPrewarmer({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  useEnvironmentThread(threadRef.environmentId, threadRef.threadId);
  return null;
}

function buildThreadJumpLabelMap(input: {
  keybindings: ResolvedKeybindingsConfig;
  platform: string;
  terminalOpen: boolean;
  threadJumpCommandByKey: ReadonlyMap<
    string,
    NonNullable<ReturnType<typeof threadJumpCommandForIndex>>
  >;
}): ReadonlyMap<string, string> {
  if (input.threadJumpCommandByKey.size === 0) {
    return EMPTY_THREAD_JUMP_LABELS;
  }

  const shortcutLabelOptions = {
    platform: input.platform,
    context: {
      terminalFocus: false,
      terminalOpen: input.terminalOpen,
    },
  } as const;
  const mapping = new Map<string, string>();
  for (const [threadKey, command] of input.threadJumpCommandByKey) {
    const label = shortcutLabelForCommand(input.keybindings, command, shortcutLabelOptions);
    if (label) {
      mapping.set(threadKey, label);
    }
  }
  return mapping.size > 0 ? mapping : EMPTY_THREAD_JUMP_LABELS;
}

interface SidebarThreadRowProps {
  familyRow: LastCodeSidebarFamilyRow;
  projectCwd: string | null;
  isActive: boolean;
  jumpLabel: string | null;
  renameTarget: LastCodeRenameTarget | null;
  editing: LastCodeThreadEditingCapabilities;
  archiveConfirmActive: boolean;
  navigation: ReturnType<typeof useLastCodeThreadNavigation>;
  menus: LastCodeThreadRowMenus;
  annotations: LastCodeThreadAnnotationActions;
}

const SidebarThreadRow = memo(function SidebarThreadRow(props: SidebarThreadRowProps) {
  const {
    isActive,
    jumpLabel,
    renameTarget,
    editing,
    archiveConfirmActive,
    navigation,
    menus,
    annotations,
  } = props;
  const { providerEntriesByEnvironmentId, environmentIconColors, providerBadgePreferences } =
    useLastCodeSidebarPresentation();
  const thread = props.familyRow.thread;
  const canOperateThread = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const threadKey = scopedThreadKey(threadRef);
  const { isFileDragOver, fileDropHandlers } = useLastCodeThreadFileDrop(
    threadRef,
    navigation.handleThreadFileDrop,
  );
  const { leaseLiveStatus, rowRef } = useSidebarRowSubscriptionLease(isActive);
  const cleanup = thread.worktreeCleanup ?? null;
  const isSelected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));
  const processes = useLastCodeThreadProcesses(threadRef);
  const { hasStoppableProcesses } = processes;
  const identity = useLastCodeThreadIdentity(
    props.familyRow,
    providerEntriesByEnvironmentId,
    environmentIconColors[thread.environmentId],
    providerBadgePreferences,
  );
  const sourceControl = useLastCodeThreadSourceControl(thread, leaseLiveStatus, props.projectCwd);
  const { gitCwd } = sourceControl;
  const isHighlighted = isActive || isSelected;
  const threadStatus = useLastCodeThreadStatus(thread);
  const canArchive = canOperateThread && !thread.persistent && cleanup === null;
  const hasActiveAnnotation = thread.annotation?.resolvedAt === null;
  const familyPresentation = useLastCodeThreadFamily(props.familyRow, threadStatus);
  const { content: threadHoverDetails, trailingContent: cleanupHoverDetails } =
    createLastCodeThreadHoverContents({
      thread,
      sourceControl,
      processes,
      identity,
      familyPresentation,
      projectCwdFallback: props.projectCwd,
    });
  const detailsLifetime = useLastCodeThreadDetails(threadRef, editing);
  const { annotationPopoverHandle } = detailsLifetime;
  const {
    handleRowClick,
    handleRowDoubleClick,
    handleRowKeyDown,
    handleRowContextMenu,
    cleanupFailureOpen,
    setCleanupFailureOpen,
  } = useLastCodeThreadRowGestures(
    thread,
    navigation,
    menus,
    { selected: isSelected, hasStoppableProcesses, renameActive: renameTarget !== null },
    editing.requestRename,
  );
  const family = props.familyRow;

  return (
    <LastCodeThreadRowLayout
      depth={family.depth}
      rowRef={rowRef}
      fileDropHandlers={fileDropHandlers}
      annotated={hasActiveAnnotation}
      lifetime={detailsLifetime}
    >
      <LastCodeThreadRowSurface
        family={family}
        relationship={familyPresentation}
        lifetime={detailsLifetime}
        gestures={{ handleRowClick, handleRowDoubleClick, handleRowKeyDown, handleRowContextMenu }}
        active={isActive}
        selected={isSelected}
        fileDragOver={isFileDragOver}
      >
        <LastCodeThreadCleanupOverlay thread={thread} content={threadHoverDetails} />
        <LastCodeThreadFamilyDisclosure
          family={family}
          renameTarget={renameTarget !== null}
          navigateToThread={navigation.navigateToThread}
        />
        <LastCodeThreadLeadingControls
          family={family}
          presentation={familyPresentation}
          threadStatus={threadStatus}
          renameTarget={canOperateThread ? renameTarget : null}
          editing={editing}
          sourceControl={sourceControl}
          active={isActive}
          navigateToThread={navigation.navigateToThread}
        />
        <LastCodeThreadMetadataControls
          thread={thread}
          identity={identity}
          preferences={providerBadgePreferences}
          jumpLabel={jumpLabel}
          highlighted={isHighlighted}
          archive={{ allowed: canArchive, confirmationRequested: archiveConfirmActive, editing }}
          annotationHandle={annotationPopoverHandle}
        >
          <LastCodeThreadProcesses
            threadRef={threadRef}
            processes={processes}
            cleanupBlocked={cleanup !== null}
            navigateToThread={navigation.navigateToThread}
          />
        </LastCodeThreadMetadataControls>
      </LastCodeThreadRowSurface>
      <LastCodeThreadDetails
        thread={thread}
        lifetime={detailsLifetime}
        gitCwd={gitCwd}
        content={threadHoverDetails}
        trailingContent={cleanupHoverDetails}
        annotations={annotations}
      />
      <WorktreeCleanupFailureDialog
        thread={thread}
        open={cleanupFailureOpen}
        onOpenChange={setCleanupFailureOpen}
      />
    </LastCodeThreadRowLayout>
  );
});

interface SidebarProjectThreadListProps {
  lastcodeSidebarScale: LegacySidebarScale;
  scaleStyle: CSSProperties;
  projectCwd: string | null;
  projectKey: string;
  projectExpanded: boolean;
  projection: Pick<
    ReturnType<typeof useLastCodeProjectThreads>,
    "familyProjection" | "hiddenThreadStatus"
  >;
  isThreadListExpanded: boolean;
  activeRouteThreadKey: string | null;
  threadJumpLabelByKey: ReadonlyMap<string, string>;
  renameTarget: LastCodeRenameTarget | null;
  editing: LastCodeThreadEditingCapabilities;
  archiveTarget: string | null;
  attachThreadListAutoAnimateRef: (node: HTMLElement | null) => void;
  navigation: ReturnType<typeof useLastCodeThreadNavigation>;
  menus: LastCodeThreadRowMenus;
  annotations: LastCodeThreadAnnotationActions;
  expandThreadListForProject: (projectKey: string) => void;
  collapseThreadListForProject: (projectKey: string) => void;
}

const SidebarProjectThreadList = memo(function SidebarProjectThreadList(
  props: SidebarProjectThreadListProps,
) {
  const {
    lastcodeSidebarScale,
    scaleStyle,
    projectCwd,
    projectKey,
    projectExpanded,
    projection,
    isThreadListExpanded,
    activeRouteThreadKey,
    threadJumpLabelByKey,
    renameTarget,
    editing,
    archiveTarget,
    attachThreadListAutoAnimateRef,
    navigation,
    menus,
    annotations,
    expandThreadListForProject,
    collapseThreadListForProject,
  } = props;
  const { hiddenThreadStatus, familyProjection } = projection;
  const { hasOverflowingThreads, renderedItems, showEmptyThreadState, shouldShowThreadPanel } =
    familyProjection;
  const showMoreButtonRender = useMemo(() => <button type="button" />, []);
  const showLessButtonRender = useMemo(() => <button type="button" />, []);

  return (
    <ul
      ref={attachThreadListAutoAnimateRef}
      className="@container/lastcode-sidebar relative flex min-w-0 flex-col before:pointer-events-none before:absolute before:inset-y-0 before:left-2 before:border-l before:border-sidebar-border group-data-[collapsible=icon]:hidden"
      data-sidebar="menu-sub"
      data-slot="sidebar-menu-sub"
      data-lastcode-sidebar-scale={lastcodeSidebarScale}
      style={{
        ...scaleStyle,
        marginLeft: "calc(8px * var(--lastcode-sidebar-content-zoom) - 8px)",
      }}
    >
      {shouldShowThreadPanel && showEmptyThreadState ? (
        <SidebarMenuSubItem className="w-full" data-thread-selection-safe>
          <div
            data-thread-selection-safe
            className="flex h-8 w-full items-center pl-8 pr-2 text-left text-xs text-sidebar-muted-foreground/75"
          >
            <span>No threads yet</span>
          </div>
        </SidebarMenuSubItem>
      ) : null}
      {shouldShowThreadPanel &&
        renderedItems.map((item) => {
          if (item.type === "subagents")
            return (
              <LastCodeSubagentGroup
                key={item.key}
                item={item}
                navigateToThread={navigation.navigateToThread}
              />
            );
          const familyRow = item.row;
          const thread = familyRow.thread;
          const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
          return (
            <React.Fragment key={threadKey}>
              <LastCodeThreadGroupHeading family={familyRow} />
              <SidebarThreadRow
                familyRow={familyRow}
                projectCwd={projectCwd}
                isActive={activeRouteThreadKey === threadKey}
                jumpLabel={threadJumpLabelByKey.get(threadKey) ?? null}
                renameTarget={renameTarget?.key === threadKey ? renameTarget : null}
                editing={editing}
                archiveConfirmActive={archiveTarget === threadKey}
                navigation={navigation}
                menus={menus}
                annotations={annotations}
              />
            </React.Fragment>
          );
        })}

      {projectExpanded && hasOverflowingThreads && !isThreadListExpanded && (
        <SidebarMenuSubItem className="ml-6">
          <SidebarMenuSubButton
            render={showMoreButtonRender}
            data-thread-selection-safe
            size="sm"
            onClick={() => {
              expandThreadListForProject(projectKey);
            }}
          >
            <span className="flex min-w-0 flex-1 items-center gap-2">
              {hiddenThreadStatus && <ThreadStatusLabel status={hiddenThreadStatus} compact />}
              <span>Show more</span>
            </span>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      )}
      {projectExpanded && hasOverflowingThreads && isThreadListExpanded && (
        <SidebarMenuSubItem className="ml-6">
          <SidebarMenuSubButton
            render={showLessButtonRender}
            data-thread-selection-safe
            size="sm"
            onClick={() => {
              collapseThreadListForProject(projectKey);
            }}
          >
            <span>Show less</span>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      )}
    </ul>
  );
});

interface SidebarProjectItemProps {
  lastcodeSidebarScale: LegacySidebarScale;
  scaleStyle: CSSProperties;
  desktopLocalEnvironmentIds: ReadonlySet<EnvironmentId>;
  knownEnvironmentIds: ReadonlySet<EnvironmentId>;
  environmentIconColors: Readonly<Record<string, EnvironmentIconColor>>;
  showLocalEnvironmentIcon: boolean;
  project: SidebarProjectSnapshot;
  isThreadListExpanded: boolean;
  activeRouteThreadKey: string | null;
  newThreadShortcutLabel: string | null;
  handleNewThread: ReturnType<typeof useNewThreadHandler>;
  threadJumpLabelByKey: ReadonlyMap<string, string>;
  attachThreadListAutoAnimateRef: (node: HTMLElement | null) => void;
  expandThreadListForProject: (projectKey: string) => void;
  collapseThreadListForProject: (projectKey: string) => void;
  dragInProgressRef: React.RefObject<boolean>;
  suppressProjectClickAfterDragRef: React.RefObject<boolean>;
  suppressProjectClickForContextMenuRef: React.RefObject<boolean>;
  isManualProjectSorting: boolean;
  dragHandleProps: SortableProjectHandleProps | null;
}

const SidebarProjectItem = memo(function SidebarProjectItem(props: SidebarProjectItemProps) {
  const {
    lastcodeSidebarScale,
    scaleStyle,
    project,
    isThreadListExpanded,
    activeRouteThreadKey,
    newThreadShortcutLabel,
    handleNewThread,
    threadJumpLabelByKey,
    attachThreadListAutoAnimateRef,
    expandThreadListForProject,
    collapseThreadListForProject,
    dragInProgressRef,
    suppressProjectClickAfterDragRef,
    suppressProjectClickForContextMenuRef,
    isManualProjectSorting,
    dragHandleProps,
  } = props;

  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectEnvironmentIcons = useMemo(
    () =>
      projectEnvironmentIconEntries({
        members: project.memberProjects,
        primaryEnvironmentId,
        desktopLocalEnvironmentIds: props.desktopLocalEnvironmentIds,
        showLocalEnvironmentIcon: props.showLocalEnvironmentIcon,
      }).map((entry) => ({
        ...entry,
        color: resolveEnvironmentIconColor(
          props.environmentIconColors[entry.environmentId],
          props.knownEnvironmentIds.has(entry.environmentId),
        ),
      })),
    [
      primaryEnvironmentId,
      project.memberProjects,
      props.desktopLocalEnvironmentIds,
      props.showLocalEnvironmentIcon,
      props.environmentIconColors,
      props.knownEnvironmentIds,
    ],
  );

  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const projectPreferenceKeys = useMemo(
    () => lastCodeProjectExpansionPreferenceKeys(project),
    [project],
  );
  const projectExpanded = useUiStateStore((state) =>
    resolveProjectExpanded(state.projectExpandedById, projectPreferenceKeys),
  );
  const {
    threadsByKey: sidebarThreadByKey,
    projectStatus,
    hiddenThreadStatus,
    familyProjection,
  } = useLastCodeProjectThreads(
    project,
    activeRouteThreadKey,
    projectExpanded,
    isThreadListExpanded,
  );
  // Menu callbacks read current project members without invalidating every row callback.
  const sidebarThreadByKeyRef = useRef(sidebarThreadByKey);
  sidebarThreadByKeyRef.current = sidebarThreadByKey;
  const { renameTarget, archiveTarget, capabilities: editing } = useLastCodeThreadEditing();
  const annotations = useLastCodeThreadAnnotations();
  const [projectRenameTarget, setProjectRenameTarget] = useState<SidebarProjectGroupMember | null>(
    null,
  );
  const [projectGroupingTarget, setProjectGroupingTarget] =
    useState<SidebarProjectGroupMember | null>(null);
  const navigation = useLastCodeThreadNavigation(familyProjection.orderedThreadKeys);
  const projection = useMemo(
    () => ({ familyProjection, hiddenThreadStatus }),
    [familyProjection, hiddenThreadStatus],
  );

  const openProjectRenameDialog = useCallback((member: SidebarProjectGroupMember) => {
    if (checkTaskPermission(member.environmentId)) setProjectRenameTarget(member);
  }, []);
  const openProjectGroupingDialog = useCallback(
    (member: SidebarProjectGroupMember) => setProjectGroupingTarget(member),
    [],
  );

  const getProjectMenuThreads = useCallback(
    () => Array.from(sidebarThreadByKeyRef.current.values()),
    [],
  );
  const showProjectMenu = useLastCodeProjectMenu(
    project,
    openProjectRenameDialog,
    openProjectGroupingDialog,
    getProjectMenuThreads,
  );
  const handleMultiSelectContextMenu = useLastCodeBulkThreadMenu();

  const startThreadRename = useCallback(
    (key: string, title: string) => {
      const ref = parseScopedThreadKey(key);
      if (ref) editing.requestRename(ref, title);
    },
    [editing],
  );

  const getMenuThread = useCallback(
    (ref: ScopedThreadRef) => sidebarThreadByKeyRef.current.get(scopedThreadKey(ref)) ?? null,
    [],
  );
  const handleThreadContextMenu = useLastCodeThreadMenu(
    project,
    getMenuThread,
    startThreadRename,
    annotations.actions.onEditAnnotation,
    navigation.navigateToThread,
    handleNewThread,
  );
  const menus = useMemo(
    () => ({
      showThreadMenu: handleThreadContextMenu,
      showBulkMenu: handleMultiSelectContextMenu,
      clearSelection,
    }),
    [handleThreadContextMenu, handleMultiSelectContextMenu, clearSelection],
  );

  return (
    <>
      <LastCodeProjectHeader
        project={project}
        expanded={projectExpanded}
        status={projectStatus}
        environments={projectEnvironmentIcons}
        drag={{ manual: isManualProjectSorting, handle: dragHandleProps }}
        gestures={{
          dragInProgressRef,
          suppressProjectClickAfterDragRef,
          suppressProjectClickForContextMenuRef,
        }}
        showMenu={showProjectMenu}
      >
        <LastCodeProjectNewThread
          project={project}
          handleNewThread={handleNewThread}
          shortcutLabel={newThreadShortcutLabel}
        />
      </LastCodeProjectHeader>

      <SidebarProjectThreadList
        lastcodeSidebarScale={lastcodeSidebarScale}
        scaleStyle={scaleStyle}
        projectCwd={project.workspaceRoot}
        projectKey={project.projectKey}
        projectExpanded={projectExpanded}
        projection={projection}
        isThreadListExpanded={isThreadListExpanded}
        activeRouteThreadKey={activeRouteThreadKey}
        threadJumpLabelByKey={threadJumpLabelByKey}
        renameTarget={renameTarget}
        editing={editing}
        archiveTarget={archiveTarget}
        attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
        navigation={navigation}
        menus={menus}
        annotations={annotations.actions}
        expandThreadListForProject={expandThreadListForProject}
        collapseThreadListForProject={collapseThreadListForProject}
      />

      {annotations.editor}

      <LastCodeProjectRenameDialog
        target={projectRenameTarget}
        onClose={() => setProjectRenameTarget(null)}
      />
      <LastCodeProjectGroupingDialog
        target={projectGroupingTarget}
        onClose={() => setProjectGroupingTarget(null)}
      />
    </>
  );
});

const SidebarProjectListRow = memo(function SidebarProjectListRow(props: SidebarProjectItemProps) {
  return (
    <SidebarMenuItem>
      <SidebarProjectItem {...props} />
    </SidebarMenuItem>
  );
});

function SortableProjectItem({
  projectId,
  disabled = false,
  children,
}: {
  projectId: string;
  disabled?: boolean;
  children: (handleProps: SortableProjectHandleProps) => React.ReactNode;
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
  } = useSortable({ id: projectId, disabled });
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={`group/menu-item relative rounded-md ${
        isDragging ? "z-20 opacity-80" : ""
      } ${isOver && !isDragging ? "ring-1 ring-inset ring-primary/40" : ""}`}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
    >
      {children({ attributes, listeners, setActivatorNodeRef })}
    </li>
  );
}

interface SidebarProjectsContentProps {
  openAddProject: () => void;
  isManualProjectSorting: boolean;
  projectDnDSensors: ReturnType<typeof useSensors>;
  projectCollisionDetection: CollisionDetection;
  handleProjectDragStart: (event: DragStartEvent) => void;
  handleProjectDragEnd: (event: DragEndEvent) => void;
  handleProjectDragCancel: (event: DragCancelEvent) => void;
  handleNewThread: ReturnType<typeof useNewThreadHandler>;
  sortedProjects: readonly SidebarProjectSnapshot[];
  expandedThreadListsByProject: ReadonlySet<string>;
  activeRouteProjectKey: string | null;
  routeThreadKey: string | null;
  newThreadShortcutLabel: string | null;
  commandPaletteShortcutLabel: string | null;
  threadJumpLabelByKey: ReadonlyMap<string, string>;
  attachThreadListAutoAnimateRef: (node: HTMLElement | null) => void;
  expandThreadListForProject: (projectKey: string) => void;
  collapseThreadListForProject: (projectKey: string) => void;
  dragInProgressRef: React.RefObject<boolean>;
  suppressProjectClickAfterDragRef: React.RefObject<boolean>;
  suppressProjectClickForContextMenuRef: React.RefObject<boolean>;
  attachProjectListAutoAnimateRef: (node: HTMLElement | null) => void;
  projectsLength: number;
  lastcodeSidebarScale: LegacySidebarScale;
  projectTreeScaleStyle: CSSProperties;
  desktopLocalEnvironmentIds: ReadonlySet<EnvironmentId>;
  knownEnvironmentIds: ReadonlySet<EnvironmentId>;
  environmentIconColors: Readonly<Record<string, EnvironmentIconColor>>;
  showLocalEnvironmentIcon: boolean;
}

const SidebarProjectsContent = memo(function SidebarProjectsContent(
  props: SidebarProjectsContentProps,
) {
  const {
    openAddProject,
    isManualProjectSorting,
    projectDnDSensors,
    projectCollisionDetection,
    handleProjectDragStart,
    handleProjectDragEnd,
    handleProjectDragCancel,
    handleNewThread,
    sortedProjects,
    expandedThreadListsByProject,
    activeRouteProjectKey,
    routeThreadKey,
    newThreadShortcutLabel,
    commandPaletteShortcutLabel,
    threadJumpLabelByKey,
    attachThreadListAutoAnimateRef,
    expandThreadListForProject,
    collapseThreadListForProject,
    dragInProgressRef,
    suppressProjectClickAfterDragRef,
    suppressProjectClickForContextMenuRef,
    attachProjectListAutoAnimateRef,
    projectsLength,
    lastcodeSidebarScale,
    projectTreeScaleStyle,
    desktopLocalEnvironmentIds,
    knownEnvironmentIds,
    environmentIconColors,
    showLocalEnvironmentIcon,
  } = props;

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

        {isManualProjectSorting ? (
          <DndContext
            sensors={projectDnDSensors}
            collisionDetection={projectCollisionDetection}
            modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
            onDragStart={handleProjectDragStart}
            onDragEnd={handleProjectDragEnd}
            onDragCancel={handleProjectDragCancel}
          >
            <SidebarMenu>
              <SortableContext
                items={sortedProjects.map((project) => project.projectKey)}
                strategy={verticalListSortingStrategy}
              >
                {sortedProjects.map((project) => (
                  <SortableProjectItem key={project.projectKey} projectId={project.projectKey}>
                    {(dragHandleProps) => (
                      <SidebarProjectItem
                        lastcodeSidebarScale={lastcodeSidebarScale}
                        scaleStyle={projectTreeScaleStyle}
                        desktopLocalEnvironmentIds={desktopLocalEnvironmentIds}
                        knownEnvironmentIds={knownEnvironmentIds}
                        environmentIconColors={environmentIconColors}
                        showLocalEnvironmentIcon={showLocalEnvironmentIcon}
                        project={project}
                        isThreadListExpanded={expandedThreadListsByProject.has(project.projectKey)}
                        activeRouteThreadKey={
                          activeRouteProjectKey === project.projectKey ? routeThreadKey : null
                        }
                        newThreadShortcutLabel={newThreadShortcutLabel}
                        handleNewThread={handleNewThread}
                        threadJumpLabelByKey={threadJumpLabelByKey}
                        attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
                        expandThreadListForProject={expandThreadListForProject}
                        collapseThreadListForProject={collapseThreadListForProject}
                        dragInProgressRef={dragInProgressRef}
                        suppressProjectClickAfterDragRef={suppressProjectClickAfterDragRef}
                        suppressProjectClickForContextMenuRef={
                          suppressProjectClickForContextMenuRef
                        }
                        isManualProjectSorting={isManualProjectSorting}
                        dragHandleProps={dragHandleProps}
                      />
                    )}
                  </SortableProjectItem>
                ))}
              </SortableContext>
            </SidebarMenu>
          </DndContext>
        ) : (
          <SidebarMenu ref={attachProjectListAutoAnimateRef}>
            {sortedProjects.map((project) => (
              <SidebarProjectListRow
                key={project.projectKey}
                lastcodeSidebarScale={lastcodeSidebarScale}
                scaleStyle={projectTreeScaleStyle}
                desktopLocalEnvironmentIds={desktopLocalEnvironmentIds}
                knownEnvironmentIds={knownEnvironmentIds}
                environmentIconColors={environmentIconColors}
                showLocalEnvironmentIcon={showLocalEnvironmentIcon}
                project={project}
                isThreadListExpanded={expandedThreadListsByProject.has(project.projectKey)}
                activeRouteThreadKey={
                  activeRouteProjectKey === project.projectKey ? routeThreadKey : null
                }
                newThreadShortcutLabel={newThreadShortcutLabel}
                handleNewThread={handleNewThread}
                threadJumpLabelByKey={threadJumpLabelByKey}
                attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
                expandThreadListForProject={expandThreadListForProject}
                collapseThreadListForProject={collapseThreadListForProject}
                dragInProgressRef={dragInProgressRef}
                suppressProjectClickAfterDragRef={suppressProjectClickAfterDragRef}
                suppressProjectClickForContextMenuRef={suppressProjectClickForContextMenuRef}
                isManualProjectSorting={isManualProjectSorting}
                dragHandleProps={null}
              />
            ))}
          </SidebarMenu>
        )}

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
  const projects = useProjects();
  const sidebarThreads = useThreadShells();
  const collapsedFamiliesByKey = useLastCodeSidebarFamiliesStore((state) => state.collapsedByKey);
  const projectExpandedById = useUiStateStore((store) => store.projectExpandedById);
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const reorderProjects = useUiStateStore((store) => store.reorderProjects);
  const navigate = useNavigate();
  const sidebarThreadSortOrder = useClientSettings((s) => s.sidebarThreadSortOrder);
  const groupingStyle = useClientSettings((s) => s.legacySidebarThreadGroupingStyle);
  const sidebarProjectSortOrder = useClientSettings((s) => s.sidebarProjectSortOrder);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const sidebarThreadPreviewCount = useClientSettings((s) => s.sidebarThreadPreviewCount);
  const lastcodeSidebarScale = useClientSettings<LegacySidebarScale>((s) => s.legacySidebarScale);
  const environmentIconColors = useClientSettings((s) => s.environmentIconColors);
  const showLocalEnvironmentIcon = useClientSettings((s) => s.showLocalEnvironmentIcon);
  const providerBadgePreferences = useSidebarProviderBadgePreferences();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const scaleStyle = useMemo(
    () => lastcodeSidebarScaleStyle(lastcodeSidebarScale),
    [lastcodeSidebarScale],
  );
  const handleNewThread = useNewThreadHandler();

  const { isMobile, setOpenMobile } = useSidebar();
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeDraftThread = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const routeThreadRef = useMemo(
    () => resolveActiveThreadRouteRef(routeTarget, routeDraftThread),
    [routeDraftThread, routeTarget],
  );
  const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;
  const routeTerminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const openAddProjectCommandPalette = useCallback(
    () => openCommandPalette({ open: "add-project" }),
    [],
  );
  const [expandedThreadListsByProject, setExpandedThreadListsByProject] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const { showThreadJumpHints, updateThreadJumpHintsVisibility } = useThreadJumpHintVisibility();
  const dragInProgressRef = useRef(false);
  const suppressProjectClickAfterDragRef = useRef(false);
  const suppressProjectClickForContextMenuRef = useRef(false);
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const platform = navigator.platform;
  const shortcutModifiers = useShortcutModifierState();
  const terminalFocused = useTerminalFocus();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const providerEntriesByEnvironmentId = useMemo(() => {
    const entriesByEnvironmentId = new Map<string, ReadonlyMap<string, ProviderInstanceEntry>>();
    for (const environment of environments) {
      const environmentProviders =
        environment.serverConfig?.providers ??
        (environment.environmentId === primaryEnvironmentId ? serverProviders : []);
      entriesByEnvironmentId.set(
        environment.environmentId,
        new Map(
          deriveProviderInstanceEntries(environmentProviders).map(
            (entry) => [entry.instanceId as string, entry] as const,
          ),
        ),
      );
    }
    return entriesByEnvironmentId;
  }, [environments, primaryEnvironmentId, serverProviders]);
  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const scratchWorkspaceRootsByEnvironmentId = useMemo(
    () =>
      new Map(
        environments.flatMap((environment) =>
          environment.serverConfig?.scratchWorkspaceRoot
            ? [[environment.environmentId, environment.serverConfig.scratchWorkspaceRoot] as const]
            : [],
        ),
      ),
    [environments],
  );
  const desktopLocalEnvironmentIds = useMemo(
    () =>
      new Set(
        environments
          .filter((environment) => isDesktopLocalConnectionTarget(environment.entry.target))
          .map((environment) => environment.environmentId),
      ),
    [environments],
  );
  const wslEnvironmentIds = useMemo(
    () =>
      new Set(
        environments
          .filter((environment) => isWslConnectionTarget(environment.entry.target))
          .map((environment) => environment.environmentId),
      ),
    [environments],
  );
  const knownEnvironmentIds = useMemo(
    () => new Set(environments.map((environment) => environment.environmentId)),
    [environments],
  );
  const orderedProjects = useMemo(() => {
    return orderItemsByPreferredIds({
      items: projects,
      preferredIds: projectOrder,
      getId: getProjectOrderKey,
      getPreferenceIds: (project) => [
        getProjectOrderKey(project),
        legacyProjectCwdPreferenceKey(project.workspaceRoot),
      ],
    });
  }, [projectOrder, projects]);

  // Build a mapping from physical project key → logical project key for
  // cross-environment grouping.  Projects that share a repositoryIdentity
  // canonicalKey are treated as one logical project in the sidebar.
  const physicalToLogicalKey = useMemo(() => {
    return buildPhysicalToLogicalProjectKeyMap({
      projects: orderedProjects,
      settings: projectGroupingSettings,
      primaryEnvironmentId,
      scratchWorkspaceRootsByEnvironmentId,
    });
  }, [
    orderedProjects,
    projectGroupingSettings,
    primaryEnvironmentId,
    scratchWorkspaceRootsByEnvironmentId,
  ]);
  const projectPhysicalKeyByScopedRef = useMemo(
    () =>
      new Map(
        orderedProjects.map((project) => [
          scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
          derivePhysicalProjectKey(project),
        ]),
      ),
    [orderedProjects],
  );

  const sidebarProjects = useMemo<SidebarProjectSnapshot[]>(() => {
    return buildSidebarProjectSnapshots({
      projects: orderedProjects,
      settings: projectGroupingSettings,
      primaryEnvironmentId,
      scratchWorkspaceRootsByEnvironmentId,
      resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
      isDesktopLocalEnvironment: (environmentId) => desktopLocalEnvironmentIds.has(environmentId),
      isWslEnvironment: (environmentId) => wslEnvironmentIds.has(environmentId),
    });
  }, [
    environmentLabelById,
    desktopLocalEnvironmentIds,
    wslEnvironmentIds,
    orderedProjects,
    projectGroupingSettings,
    primaryEnvironmentId,
    scratchWorkspaceRootsByEnvironmentId,
  ]);

  const sidebarProjectByKey = useMemo(
    () => new Map(sidebarProjects.map((project) => [project.projectKey, project] as const)),
    [sidebarProjects],
  );
  const sidebarThreadByKey = useMemo(
    () =>
      new Map(
        sidebarThreads.map(
          (thread) =>
            [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
        ),
      ),
    [sidebarThreads],
  );
  // Resolve the active route's project key to a logical key so it matches the
  // sidebar's grouped project entries.
  const activeRouteProjectKey = useMemo(() => {
    if (!routeThreadKey) {
      return null;
    }
    const activeThread = sidebarThreadByKey.get(routeThreadKey);
    if (!activeThread) return null;
    const physicalKey =
      projectPhysicalKeyByScopedRef.get(
        scopedProjectKey(scopeProjectRef(activeThread.environmentId, activeThread.projectId)),
      ) ?? scopedProjectKey(scopeProjectRef(activeThread.environmentId, activeThread.projectId));
    return physicalToLogicalKey.get(physicalKey) ?? physicalKey;
  }, [routeThreadKey, sidebarThreadByKey, physicalToLogicalKey, projectPhysicalKeyByScopedRef]);

  // Group threads by logical project key so all threads from grouped projects
  // are displayed together.
  const threadsByProjectKey = useMemo(() => {
    const next = new Map<string, SidebarThreadSummary[]>();
    for (const thread of sidebarThreads) {
      const physicalKey =
        projectPhysicalKeyByScopedRef.get(
          scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
        ) ?? scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
      const logicalKey = physicalToLogicalKey.get(physicalKey) ?? physicalKey;
      const existing = next.get(logicalKey);
      if (existing) {
        existing.push(thread);
      } else {
        next.set(logicalKey, [thread]);
      }
    }
    return next;
  }, [sidebarThreads, physicalToLogicalKey, projectPhysicalKeyByScopedRef]);
  const getCurrentSidebarShortcutContext = useCallback(
    () => ({
      terminalFocus: isTerminalFocused(),
      terminalOpen: routeTerminalOpen,
      modelPickerOpen: isModelPickerOpen(),
    }),
    [routeTerminalOpen],
  );
  const newThreadShortcutLabelOptions = useMemo(
    () => ({
      platform,
      context: {
        terminalFocus: false,
        terminalOpen: false,
      },
    }),
    [platform],
  );
  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.newLocal", newThreadShortcutLabelOptions) ??
    shortcutLabelForCommand(keybindings, "chat.new", newThreadShortcutLabelOptions);

  const navigateToThread = useCallback(
    (threadRef: ScopedThreadRef) => {
      if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(scopedThreadKey(threadRef));
      if (isMobile) {
        setOpenMobile(false);
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [clearSelection, isMobile, navigate, setOpenMobile, setSelectionAnchor],
  );

  const projectDnDSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const projectCollisionDetection = useCallback<CollisionDetection>((args) => {
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) {
      return pointerCollisions;
    }

    return closestCorners(args);
  }, []);

  const handleProjectDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (sidebarProjectSortOrder !== "manual") {
        dragInProgressRef.current = false;
        return;
      }
      dragInProgressRef.current = false;
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const activeProject = sidebarProjects.find((project) => project.projectKey === active.id);
      const overProject = sidebarProjects.find((project) => project.projectKey === over.id);
      if (!activeProject || !overProject) return;
      const activeMemberKeys = activeProject.memberProjects.map(
        (member) => member.physicalProjectKey,
      );
      const overMemberKeys = overProject.memberProjects.map((member) => member.physicalProjectKey);
      reorderProjects(orderedProjects.map(getProjectOrderKey), activeMemberKeys, overMemberKeys);
    },
    [orderedProjects, sidebarProjectSortOrder, reorderProjects, sidebarProjects],
  );

  const handleProjectDragStart = useCallback(
    (_event: DragStartEvent) => {
      if (sidebarProjectSortOrder !== "manual") {
        return;
      }
      dragInProgressRef.current = true;
      suppressProjectClickAfterDragRef.current = true;
    },
    [sidebarProjectSortOrder],
  );

  const handleProjectDragCancel = useCallback((_event: DragCancelEvent) => {
    dragInProgressRef.current = false;
  }, []);

  const animatedProjectListsRef = useRef(new WeakSet<HTMLElement>());
  const attachProjectListAutoAnimateRef = useCallback((node: HTMLElement | null) => {
    if (!node || animatedProjectListsRef.current.has(node)) {
      return;
    }
    autoAnimate(node, SIDEBAR_LIST_ANIMATION_OPTIONS);
    animatedProjectListsRef.current.add(node);
  }, []);

  const animatedThreadListsRef = useRef(new WeakSet<HTMLElement>());
  const attachThreadListAutoAnimateRef = useCallback((node: HTMLElement | null) => {
    if (!node || animatedThreadListsRef.current.has(node)) {
      return;
    }
    autoAnimate(node, SIDEBAR_LIST_ANIMATION_OPTIONS);
    animatedThreadListsRef.current.add(node);
  }, []);

  const visibleThreads = useMemo(
    () => sidebarThreads.filter(threadShellIsVisible),
    [sidebarThreads],
  );
  const sortedProjects = useMemo(() => {
    const sortableProjects = sidebarProjects.map((project) => ({
      ...project,
      id: project.projectKey,
    }));
    const sortableThreads = visibleThreads.map((thread) => {
      const physicalKey =
        projectPhysicalKeyByScopedRef.get(
          scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
        ) ?? scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
      return {
        ...thread,
        projectId: (physicalToLogicalKey.get(physicalKey) ?? physicalKey) as ProjectId,
      };
    });
    return sortProjectsForSidebar(
      sortableProjects,
      sortableThreads,
      sidebarProjectSortOrder,
    ).flatMap((project) => {
      const resolvedProject = sidebarProjectByKey.get(project.id);
      return resolvedProject ? [resolvedProject] : [];
    });
  }, [
    sidebarProjectSortOrder,
    physicalToLogicalKey,
    projectPhysicalKeyByScopedRef,
    sidebarProjectByKey,
    sidebarProjects,
    visibleThreads,
  ]);
  const isManualProjectSorting = sidebarProjectSortOrder === "manual";
  const visibleSidebarThreadKeys = useMemo(
    () =>
      sortedProjects.flatMap((project) => {
        const projectThreads = threadsByProjectKey.get(project.projectKey) ?? [];
        const projectExpanded = resolveProjectExpanded(
          projectExpandedById,
          lastCodeProjectExpansionPreferenceKeys(project),
        );
        return projectLastCodeProjectThreads(projectThreads, sidebarThreadSortOrder, {
          collapsedByKey: collapsedFamiliesByKey,
          activeThreadKey: routeThreadKey,
          projectExpanded,
          previewCount: sidebarThreadPreviewCount,
          listExpanded: expandedThreadListsByProject.has(project.projectKey),
          groupingStyle,
        }).familyProjection.orderedThreadKeys;
      }),
    [
      sidebarThreadSortOrder,
      sidebarThreadPreviewCount,
      collapsedFamiliesByKey,
      groupingStyle,
      expandedThreadListsByProject,
      projectExpandedById,
      routeThreadKey,
      sortedProjects,
      threadsByProjectKey,
    ],
  );
  const threadJumpCommandByKey = useMemo(() => {
    const mapping = new Map<string, NonNullable<ReturnType<typeof threadJumpCommandForIndex>>>();
    for (const [visibleThreadIndex, threadKey] of visibleSidebarThreadKeys.entries()) {
      const jumpCommand = threadJumpCommandForIndex(visibleThreadIndex);
      if (!jumpCommand) {
        return mapping;
      }
      mapping.set(threadKey, jumpCommand);
    }

    return mapping;
  }, [visibleSidebarThreadKeys]);
  const threadJumpThreadKeys = useMemo(
    () => [...threadJumpCommandByKey.keys()],
    [threadJumpCommandByKey],
  );
  const sidebarShortcutContext = {
    terminalFocus: terminalFocused,
    terminalOpen: routeTerminalOpen,
    modelPickerOpen: isModelPickerOpen(),
  };
  const threadJumpLabelByKey = useMemo(
    () =>
      buildThreadJumpLabelMap({
        keybindings,
        platform,
        terminalOpen: sidebarShortcutContext.terminalOpen,
        threadJumpCommandByKey,
      }),
    [keybindings, platform, sidebarShortcutContext.terminalOpen, threadJumpCommandByKey],
  );
  const shouldShowThreadJumpHintsNow = shouldShowThreadJumpHintsForModifiers(
    shortcutModifiers,
    keybindings,
    {
      platform,
      context: sidebarShortcutContext,
    },
  );
  const visibleThreadJumpLabelByKey = showThreadJumpHints
    ? threadJumpLabelByKey
    : EMPTY_THREAD_JUMP_LABELS;
  const orderedSidebarThreadKeys = visibleSidebarThreadKeys;
  const prewarmedSidebarThreadKeys = useMemo(
    () => getSidebarThreadIdsToPrewarm(visibleSidebarThreadKeys),
    [visibleSidebarThreadKeys],
  );
  const prewarmedSidebarThreadRefs = useMemo(
    () =>
      prewarmedSidebarThreadKeys.flatMap((threadKey) => {
        const ref = parseScopedThreadKey(threadKey);
        return ref ? [ref] : [];
      }),
    [prewarmedSidebarThreadKeys],
  );

  useEffect(() => {
    updateThreadJumpHintsVisibility(shouldShowThreadJumpHintsNow);
  }, [shouldShowThreadJumpHintsNow, updateThreadJumpHintsVisibility]);

  useEffect(() => {
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      const shortcutContext = getCurrentSidebarShortcutContext();

      if (event.defaultPrevented || event.repeat || isCommandPaletteOpen() || isModelPickerOpen()) {
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        platform,
        context: shortcutContext,
      });
      const traversalDirection = threadTraversalDirectionFromCommand(command);
      if (traversalDirection !== null) {
        const targetThreadKey = resolveAdjacentThreadId({
          threadIds: orderedSidebarThreadKeys,
          currentThreadId: routeThreadKey,
          direction: traversalDirection,
        });
        if (!targetThreadKey) {
          return;
        }
        const targetThread = sidebarThreadByKey.get(targetThreadKey);
        if (!targetThread) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        navigateToThread(scopeThreadRef(targetThread.environmentId, targetThread.id));
        return;
      }

      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) {
        return;
      }

      const targetThreadKey = threadJumpThreadKeys[jumpIndex];
      if (!targetThreadKey) {
        return;
      }
      const targetThread = sidebarThreadByKey.get(targetThreadKey);
      if (!targetThread) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      navigateToThread(scopeThreadRef(targetThread.environmentId, targetThread.id));
    };

    window.addEventListener("keydown", onWindowKeyDown);

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [
    getCurrentSidebarShortcutContext,
    keybindings,
    navigateToThread,
    orderedSidebarThreadKeys,
    platform,
    routeThreadKey,
    sidebarThreadByKey,
    threadJumpThreadKeys,
  ]);

  useEffect(() => {
    const onMouseDown = (event: globalThis.MouseEvent) => {
      if (!useThreadSelectionStore.getState().hasSelection()) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!shouldClearThreadSelectionOnMouseDown(target)) return;
      clearSelection();
    };

    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [clearSelection]);

  const commandPaletteShortcutLabel = isMobile
    ? null
    : shortcutLabelForCommand(keybindings, "commandPalette.toggle", newThreadShortcutLabelOptions);

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
        providerEntriesByEnvironmentId={providerEntriesByEnvironmentId}
        environmentIconColors={environmentIconColors}
        providerBadgePreferences={providerBadgePreferences}
        openPullRequestsInRightPanel={routeThreadRef !== null}
      >
        <SidebarProjectsContent
          openAddProject={openAddProjectCommandPalette}
          isManualProjectSorting={isManualProjectSorting}
          projectDnDSensors={projectDnDSensors}
          projectCollisionDetection={projectCollisionDetection}
          handleProjectDragStart={handleProjectDragStart}
          handleProjectDragEnd={handleProjectDragEnd}
          handleProjectDragCancel={handleProjectDragCancel}
          handleNewThread={handleNewThread}
          sortedProjects={sortedProjects}
          expandedThreadListsByProject={expandedThreadListsByProject}
          activeRouteProjectKey={activeRouteProjectKey}
          routeThreadKey={routeThreadKey}
          newThreadShortcutLabel={newThreadShortcutLabel}
          commandPaletteShortcutLabel={commandPaletteShortcutLabel}
          threadJumpLabelByKey={visibleThreadJumpLabelByKey}
          attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
          expandThreadListForProject={expandThreadListForProject}
          collapseThreadListForProject={collapseThreadListForProject}
          dragInProgressRef={dragInProgressRef}
          suppressProjectClickAfterDragRef={suppressProjectClickAfterDragRef}
          suppressProjectClickForContextMenuRef={suppressProjectClickForContextMenuRef}
          attachProjectListAutoAnimateRef={attachProjectListAutoAnimateRef}
          projectsLength={projects.length}
          lastcodeSidebarScale={lastcodeSidebarScale}
          projectTreeScaleStyle={scaleStyle}
          desktopLocalEnvironmentIds={desktopLocalEnvironmentIds}
          knownEnvironmentIds={knownEnvironmentIds}
          environmentIconColors={environmentIconColors}
          showLocalEnvironmentIcon={showLocalEnvironmentIcon}
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
