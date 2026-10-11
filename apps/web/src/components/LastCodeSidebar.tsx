import { LastCodeThreadArchiveControl } from "./sidebar/LastCodeThreadArchiveControl";
import { LastCodeThreadTitleEditor } from "./sidebar/LastCodeThreadTitle";
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
import { formatProjectMemberActionLabel } from "./sidebar/lastcodeProjectMenu";
import { activateSidebarRowFromKeyboard } from "./sidebar/sidebarRowKeyboard";
import {
  ConnectedSidebarEnvironmentIcon,
  useSidebarProviderBadgePreferences,
  type SidebarProviderBadgePreferences,
} from "./sidebar/SidebarEnvironmentIcon";
import { ThreadDashboardIndicator } from "./dashboard/ThreadDashboardIndicator";
import { useSupportsMultiplePullRequests } from "~/hooks/useSupportsMultiplePullRequests";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/shared/threadPullRequests";
import {
  BotIcon,
  SparklesIcon,
  ChevronRightIcon,
  FolderPlusIcon,
  Globe2Icon,
  MessageSquareLockIcon,
  SearchIcon,
  SquarePenIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  ChangeRequestStatusIcon,
  prStatusIndicator,
  PrStatusTooltipContent,
  terminalStatusFromRunningIds,
  synchronizeTerminalPulse,
  ThreadStatusLabel,
  ThreadWorktreeIndicator,
  useLinkedThreadPullRequest,
} from "./ThreadStatusIndicators";
import { ProjectFavicon } from "./ProjectFavicon";
import { ProjectSidebarDraftList } from "./sidebar/ProjectSidebarDraftList";
import { useAtomValue } from "@effect/atom-react";
import { autoAnimate } from "@formkit/auto-animate";
import { actionRunningPresentation } from "@t3tools/shared/actionResume";
import React, {
  useCallback,
  useEffect,
  useId,
  memo,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { cn } from "~/lib/utils";
import { useShallow } from "zustand/react/shallow";
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
  AuthPreviewOperateScope,
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
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { threadShellIsVisible } from "@t3tools/client-runtime/state/models";
import { useNavigate, useParams, useRouter } from "@tanstack/react-router";
import {
  type EnvironmentIconColor,
  type LegacySidebarScale,
  type SidebarThreadPreviewCount,
  type SidebarThreadSortOrder,
} from "@t3tools/contracts/settings";
import { isDesktopLocalConnectionTarget, isWslConnectionTarget } from "../connection/desktopLocal";
import { isElectron } from "../env";
import { useTerminalFocus } from "../hooks/useTerminalFocus";
import { useOpenPrLink } from "../lib/openPullRequestLink";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isMacPlatform } from "../lib/utils";
import { useSidebarPendingFileDropStore } from "../sidebarPendingFileDropStore";
import { makeWorkspaceFileDropHandlers } from "./chat/workspaceFileDrop";
import {
  readThreadShell,
  useProject,
  useProjects,
  useThreadShells,
  useThreadShell,
  useThreadShellsForProjectRefs,
} from "../state/entities";
import {
  ThreadAnnotationHoverPopover,
  ThreadAnnotationNavigationTrigger,
} from "./thread-annotation/ThreadAnnotation";
import { PopoverCreateHandle as createAnnotationPopoverHandle, PopoverTrigger } from "./ui/popover";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { useThreadRunningTerminalIds } from "../state/terminalSessions";
import {
  usePreviewProcessControlsSupported,
  useThreadPreviewLeases,
} from "../state/previewHosting";
import { useThreadDiscoveredPorts } from "../portDiscoveryState";
import { openDiscoveredPort } from "./preview/openDiscoveredPort";
import { useAtomCommand } from "../state/use-atom-command";
import { useEnvironmentQuery } from "../state/query";
import { previewEnvironment } from "../state/preview";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { vcsEnvironment } from "../state/vcs";
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
import { readLocalApi } from "../localApi";
import { useComposerDraftStore } from "../composerDraftStore";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { lastcodeSidebarScaleStyle } from "../lastcodeSidebarScale";
import {
  ConnectedEnvironmentIcon,
  legacyThreadEnvironmentPresentation,
  projectEnvironmentIconEntries,
  resolveEnvironmentIconColor,
} from "../environmentIcons";

import { useEnvironmentThread } from "../state/threads";
import { useEnvironment, useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import {
  buildThreadRouteParams,
  resolveActiveThreadRouteRef,
  resolveThreadRouteTarget,
} from "../threadRoutes";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { formatRelativeTimeLabel } from "../timestampFormat";
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
  isContextMenuPointerDown,
  isSidebarNestedLinkClick,
  isTrailingDoubleClick,
  resolveProjectStatusIndicator,
  resolveThreadLastVisitedAt,
  resolveThreadStatusPill,
  orderItemsByPreferredIds,
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  useSidebarRowSubscriptionLease,
  useThreadJumpHintVisibility,
  ThreadStatusPill,
} from "./Sidebar.logic";
import { sortThreads } from "../lib/threadSort";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { LastCodeSidebarThreadPicker } from "./sidebar/LastCodeSidebarThreadPicker";
import { useIsMobile } from "~/hooks/useMediaQuery";
import { CommandDialogTrigger } from "./ui/command";
import { useClientSettings } from "~/hooks/useSettings";
import { primaryServerKeybindingsAtom, primaryServerProvidersAtom } from "../state/server";
import {
  derivePhysicalProjectKey,
  getProjectOrderKey,
  selectProjectGroupingSettings,
} from "../logicalProject";
import type { SidebarThreadSummary } from "../types";
import {
  projectLastCodeSidebarFamilies,
  lastcodeSidebarFamilySummary,
  lastcodeSidebarCreatorDetails,
  lastcodeSidebarIsAgentCreated,
  lastcodeSidebarSubagentStatusLabel,
  lastcodeSidebarSubagentGroupKey,
  type LastCodeSidebarFamilyItem,
  type LastCodeSidebarFamilyRow,
} from "./lastcodeSidebarFamilies.logic";
import {
  useCollapsedLastCodeSidebarFamilies,
  useLastCodeSidebarFamiliesStore,
} from "./lastcodeSidebarFamilies.store";
import { resolveLocalCheckoutBranchMismatch } from "./BranchToolbar.logic";
import {
  deriveProviderInstanceEntries,
  shouldShowInstanceBadge,
  type ProviderInstanceEntry,
} from "../providerInstances";
import { getTriggerDisplayModelLabel } from "./chat/providerIconUtils";
import {
  SidebarThreadCleanupHoverContent,
  SidebarThreadHoverContent,
} from "./sidebar/SidebarThreadHoverContent";
import { WorktreeCleanupFailureDialog } from "./WorktreeCleanupFailureDialog";
import {
  NO_PROJECT_GROUP_KEY,
  buildPhysicalToLogicalProjectKeyMap,
  buildSidebarProjectSnapshots,
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
const SIDEBAR_LIST_ANIMATION_OPTIONS = {
  duration: 180,
  easing: "ease-out",
} as const;
const EMPTY_THREAD_JUMP_LABELS = new Map<string, string>();
const SIDEBAR_ICON_ACTION_BUTTON_CLASS =
  "inline-flex h-6 min-w-6 cursor-pointer items-center justify-center rounded-md px-0.75 text-icon-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

function SidebarThreadDetailPrewarmer({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  useEnvironmentThread(threadRef.environmentId, threadRef.threadId);
  return null;
}

function projectExpansionPreferenceKeys(project: SidebarProjectSnapshot): string[] {
  return [
    project.projectKey,
    ...project.memberProjects.map((member) => member.physicalProjectKey),
    ...project.memberProjects.map((member) => legacyProjectCwdPreferenceKey(member.workspaceRoot)),
  ];
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

// Each descendant supplies the segment below its ancestor disclosure slot.
// Keeping rails outside the row background preserves them through selection;
// the next sibling starts a new segment only for ancestors it actually shares.
function LastCodeSidebarFamilyGuides({ depth }: { depth: number }) {
  return Array.from({ length: Math.min(depth, 6) }, (_, level) => (
    <span
      key={level}
      aria-hidden
      className="pointer-events-none absolute -top-1 bottom-0 border-l border-sidebar-border"
      style={{ left: 20 + level * 12 }}
    />
  ));
}

interface SidebarThreadRowProps {
  thread: SidebarThreadSummary;
  familyRow: LastCodeSidebarFamilyRow;
  groupingStyle: "minimal" | "typed-groups";
  compactStatusIndicators: boolean;
  showWorktreeIndicators: boolean;
  showLocalEnvironmentIcon: boolean;
  providerBadgePreferences: SidebarProviderBadgePreferences;
  configuredEnvironmentIconColor: EnvironmentIconColor | undefined;
  projectCwd: string | null;
  providerEntriesByEnvironmentId: ReadonlyMap<string, ReadonlyMap<string, ProviderInstanceEntry>>;
  orderedProjectThreadKeys: readonly string[];
  isActive: boolean;
  openPullRequestsInRightPanel: boolean;
  jumpLabel: string | null;
  renameTarget: LastCodeRenameTarget | null;
  editing: LastCodeThreadEditingCapabilities;
  archiveConfirmActive: boolean;
  handleThreadClick: (
    event: React.MouseEvent,
    threadRef: ScopedThreadRef,
    orderedProjectThreadKeys: readonly string[],
  ) => void;
  navigateToThread: (threadRef: ScopedThreadRef) => Promise<void>;
  handleMultiSelectContextMenu: (position: { x: number; y: number }) => Promise<void>;
  handleThreadContextMenu: (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
    hasStoppableProcesses: boolean,
  ) => Promise<void>;
  clearSelection: () => void;

  openPrLink: (
    event: React.MouseEvent<HTMLElement>,
    prUrl: string,
    threadRef?: ScopedThreadRef,
  ) => boolean;
  onFileDropThreads: (threadRef: ScopedThreadRef, files: File[]) => void;
  onEditAnnotation: (thread: SidebarThreadSummary) => void;
  onSaveAnnotationBody: (thread: SidebarThreadSummary, body: string) => Promise<boolean>;
  onResolveAnnotation: (thread: SidebarThreadSummary) => void;
}

const SidebarThreadRow = memo(function SidebarThreadRow(props: SidebarThreadRowProps) {
  const {
    orderedProjectThreadKeys,
    isActive,
    openPullRequestsInRightPanel,
    jumpLabel,
    renameTarget,
    editing,
    archiveConfirmActive,
    handleThreadClick,
    navigateToThread,
    handleMultiSelectContextMenu,
    handleThreadContextMenu,
    clearSelection,
    openPrLink,
    onFileDropThreads,
    onEditAnnotation,
    onSaveAnnotationBody,
    onResolveAnnotation,
    providerEntriesByEnvironmentId,
    thread,
  } = props;
  const canOperateThread = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  const canOperatePreview = useEnvironmentScope(thread.environmentId, AuthPreviewOperateScope);
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const threadKey = scopedThreadKey(threadRef);
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const fileDropHandlers = useMemo(
    () =>
      makeWorkspaceFileDropHandlers({
        setDragActive: setIsFileDragOver,
        addFiles: (files) => {
          onFileDropThreads(threadRef, files);
        },
        addFolders: () => {},
      }),
    [onFileDropThreads, threadRef],
  );
  useEffect(() => {
    if (!isFileDragOver) return;
    const clearFileDrag = () => setIsFileDragOver(false);
    window.addEventListener("dragend", clearFileDrag);
    return () => window.removeEventListener("dragend", clearFileDrag);
  }, [isFileDragOver]);
  const { leaseLiveStatus, rowRef } = useSidebarRowSubscriptionLease(isActive);
  const cleanup = thread.worktreeCleanup ?? null;
  const isCleanupPending = cleanup?.status === "deleting" || cleanup?.status === "queued";
  const isCleanupFailed = cleanup?.status === "failed";
  const [cleanupFailureOpen, setCleanupFailureOpen] = useState(false);
  const localLastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  const isSelected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const previews = useThreadPreviewLeases(threadRef);
  const supportsProcessControls = usePreviewProcessControlsSupported(thread.environmentId);
  const hasStoppableProcesses =
    supportsProcessControls && (runningTerminalIds.length > 0 || previews.length > 0);
  const isMobile = useIsMobile();
  const discoveredPorts = useThreadDiscoveredPorts({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  const environment = useEnvironment(thread.environmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // No primary (the hosted app) means every thread is remote, and the machine
  // glyph is what tells the environments apart.
  const isRemoteThread = thread.environmentId !== primaryEnvironmentId;
  const remoteEnvLabel = environment?.label ?? null;
  // A desktop-local secondary backend (e.g. the WSL backend) shows up as a
  // bearer environment whose connection id is prefixed "local:". It runs on the
  // user's own machine, so a remote-server icon is misleading — label it "Local" and
  // suppress the row icon (the project header already shows a container icon
  // for desktop-local projects, see sidebarProjectGrouping).
  const isDesktopLocalThread =
    environment !== null && isDesktopLocalConnectionTarget(environment.entry.target);
  const environmentPresentation = legacyThreadEnvironmentPresentation({
    isPrimary: !isRemoteThread,
    isDesktopLocal: isDesktopLocalThread,
    showLocalEnvironmentIcon:
      props.showLocalEnvironmentIcon || props.providerBadgePreferences.enabled,
    environmentLabel: remoteEnvLabel,
  });
  const showsThreadEnvironmentIcon =
    props.providerBadgePreferences.enabled ||
    (environmentPresentation.showRowIcon &&
      props.familyRow.parentKey === null &&
      (thread.lineage.relationshipToParent !== "subagent" || thread.lineage.independent === true));
  const threadEnvironmentLabel = props.providerBadgePreferences.enabled
    ? (environmentPresentation.hoverLabel ?? remoteEnvLabel ?? "Local")
    : props.familyRow.parentKey !== null
      ? null
      : environmentPresentation.hoverLabel;
  const environmentIconColor = resolveEnvironmentIconColor(
    props.configuredEnvironmentIconColor,
    environment !== null && !isDesktopLocalThread,
  );
  // For grouped projects, the thread may belong to a different environment
  // than the representative project.  Look up the thread's own project cwd
  // so git status (and thus PR detection) queries the correct path.
  const threadProject = useProject(
    useMemo(
      () => scopeProjectRef(thread.environmentId, thread.projectId),
      [thread.environmentId, thread.projectId],
    ),
  );
  const threadProjectCwd = threadProject?.workspaceRoot ?? null;
  const gitCwd = thread.worktreePath ?? threadProjectCwd ?? props.projectCwd;
  const gitStatus = useEnvironmentQuery(
    leaseLiveStatus && thread.linkedPullRequest == null && thread.branch != null && gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd: gitCwd, includeRemote: false },
        })
      : null,
  );
  const isHighlighted = isActive || isSelected;
  const handleOpenDiscoveredPort = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const port = discoveredPorts[0];
      if (!port || !readEnvironmentScope(thread.environmentId, AuthPreviewOperateScope)) return;
      event.preventDefault();
      event.stopPropagation();
      navigateToThread(threadRef);
      void (async () => {
        const result = await openDiscoveredPort({ threadRef, port, openPreview });
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open preview",
            description:
              error instanceof Error ? error.message : "The preview could not be opened.",
          }),
        );
      })();
    },
    [discoveredPorts, navigateToThread, openPreview, thread.environmentId, threadRef],
  );
  const threadStatus = resolveThreadStatusPill({
    thread: {
      ...thread,
      lastVisitedAt,
    },
  });
  const linkedPullRequestStatus = useLinkedThreadPullRequest(
    thread.environmentId,
    thread.linkedPullRequest,
    leaseLiveStatus,
    thread.pullRequests,
    thread.branchPullRequest,
  );
  const pr = linkedPullRequestStatus?.pr ?? null;
  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(thread.environmentId);
  const currentLinkedPr = supportsMultiplePullRequests
    ? resolveThreadCurrentPullRequestLink(thread.pullRequests)
    : null;
  const prStatus = prStatusIndicator(pr, linkedPullRequestStatus?.sourceControlProvider);
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const isConfirmingArchive =
    canOperateThread && !thread.persistent && cleanup === null && archiveConfirmActive;
  const annotation = thread.annotation ?? null;
  const hasActiveAnnotation = annotation?.resolvedAt === null;
  const cleanupBlockerTitle =
    cleanup?.status === "queued"
      ? (readThreadShell(scopeThreadRef(thread.environmentId, cleanup.blockedByThreadId))?.title ??
        null)
      : null;
  const branchMismatch = resolveLocalCheckoutBranchMismatch({
    effectiveEnvMode: thread.worktreePath === null ? "local" : "worktree",
    activeWorktreePath: thread.worktreePath,
    activeThreadBranch: thread.branch,
    currentGitBranch: gitStatus.data?.refName ?? null,
  });
  const modelInstanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  const environmentProviderEntries = providerEntriesByEnvironmentId.get(thread.environmentId);
  const providerEntry = environmentProviderEntries?.get(modelInstanceId) ?? null;
  const showInstanceBadge =
    providerEntry !== null &&
    shouldShowInstanceBadge(providerEntry, environmentProviderEntries?.values() ?? []);
  const selectedModel = providerEntry?.models.find(
    (model) => model.slug === thread.modelSelection.model,
  );
  const modelLabel = selectedModel
    ? getTriggerDisplayModelLabel(selectedModel)
    : thread.modelSelection.model;
  const isAgentCreated = lastcodeSidebarIsAgentCreated(thread);
  const creatorRef = useMemo(
    () =>
      isAgentCreated && thread.creatorThreadId
        ? scopeThreadRef(thread.environmentId, thread.creatorThreadId)
        : null,
    [isAgentCreated, thread.environmentId, thread.creatorThreadId],
  );
  const creatorShell = useThreadShell(creatorRef);
  const creatorDetails = lastcodeSidebarCreatorDetails(thread, creatorShell);
  const creatorDescription = creatorDetails.description;
  const lineageDescription =
    thread.lineage.relationshipToParent === "subagent" && thread.lineage.independent !== true
      ? `Subagent · ${lastcodeSidebarSubagentStatusLabel(thread, threadStatus)}${props.familyRow.unavailableParentLabel ? ` · ${props.familyRow.unavailableParentLabel}` : ""}`
      : null;
  const relationshipDescription = creatorDescription
    ? `Agent-created · ${creatorDescription}`
    : lineageDescription;
  const threadHoverDetails = (
    <>
      {relationshipDescription ? (
        <div className="mb-2 text-xs text-sidebar-muted-foreground">{relationshipDescription}</div>
      ) : null}

      <SidebarThreadHoverContent
        branchMismatch={branchMismatch}
        environmentLabel={threadEnvironmentLabel}
        environmentIconColor={environmentIconColor}
        modelInstanceId={modelInstanceId}
        modelLabel={modelLabel}
        projectCwd={threadProjectCwd ?? props.projectCwd}
        projectFaviconPath={threadProject?.faviconPath ?? null}
        projectTitle={threadProject?.title ?? null}
        providerEntry={providerEntry}
        showInstanceBadge={showInstanceBadge}
        terminalProcessCount={runningTerminalIds.length}
        terminalStatus={terminalStatus}
        thread={thread}
        cleanupBlockerTitle={cleanupBlockerTitle}
        showCleanup={!hasActiveAnnotation}
      />
    </>
  );
  const cleanupHoverDetails = (
    <SidebarThreadCleanupHoverContent
      thread={thread}
      blockerTitle={cleanupBlockerTitle}
      standalone
    />
  );
  const threadMetaVisibilityClassName = isConfirmingArchive
    ? "opacity-0"
    : canOperateThread && !thread.persistent && cleanup === null
      ? "transition-opacity duration-150 group-hover/menu-sub-item:opacity-0 group-focus-within/menu-sub-item:opacity-0"
      : "";
  const threadMetaClassName = `pointer-events-none inline-flex w-full justify-end ${
    jumpLabel ? "col-start-1 row-start-1 z-10" : ""
  } ${threadMetaVisibilityClassName}`;
  const threadMetadataGridClassName = jumpLabel
    ? "grid shrink-0 grid-cols-[max-content] items-center max-sm:grid-cols-[max-content_calc(1.5rem*var(--lastcode-sidebar-content-zoom))]"
    : "grid shrink-0 grid-cols-[repeat(2,calc(0.75rem*var(--lastcode-sidebar-content-zoom)))_calc(3rem*var(--lastcode-sidebar-content-zoom))] items-center gap-x-(--thread-metadata-gap) max-sm:grid-cols-[repeat(2,calc(0.75rem*var(--lastcode-sidebar-content-zoom)))_calc(3rem*var(--lastcode-sidebar-content-zoom))_calc(1.5rem*var(--lastcode-sidebar-content-zoom))]";
  const [threadRowActive, setThreadRowActive] = useState(false);
  const annotationPopoverHandle = useMemo(() => createAnnotationPopoverHandle(), []);
  const annotationTriggerId = useId();
  const clearConfirmingArchive = useCallback(() => {
    editing.cancelArchiveConfirmation(threadRef);
  }, [editing, threadRef]);
  const handleMouseLeave = useCallback(() => {
    clearConfirmingArchive();
    setThreadRowActive(false);
  }, [clearConfirmingArchive]);
  const handleThreadDetailsTooltipOpenChange = useCallback<
    NonNullable<React.ComponentProps<typeof Tooltip>["onOpenChange"]>
  >((open, eventDetails) => {
    if (!open && eventDetails.reason === "escape-key") setThreadRowActive(false);
  }, []);
  const handleBlurCapture = useCallback(
    (event: React.FocusEvent<HTMLLIElement>) => {
      const currentTarget = event.currentTarget;
      requestAnimationFrame(() => {
        if (currentTarget.contains(document.activeElement)) {
          return;
        }
        clearConfirmingArchive();
        setThreadRowActive(false);
      });
    },
    [clearConfirmingArchive],
  );
  const handleRowClick = useCallback(
    (event: React.MouseEvent) => {
      if (isCleanupFailed) {
        event.preventDefault();
        setCleanupFailureOpen(true);
        return;
      }
      if (isCleanupPending) {
        event.preventDefault();
        return;
      }
      handleThreadClick(event, threadRef, orderedProjectThreadKeys);
    },
    [handleThreadClick, isCleanupFailed, isCleanupPending, orderedProjectThreadKeys, threadRef],
  );
  const handleRowDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      if (!readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)) return;
      if (cleanup !== null) return;
      // Already renaming this row: a double-click on the row chrome (outside the
      // input) must not restart and discard the in-progress edit.
      if (renameTarget) return;
      // On mobile the first tap navigates and closes the sidebar sheet, so the
      // inline rename can't be shown. Renaming there stays on the context menu.
      if (isMobile) return;
      // cmd/ctrl/shift double-clicks are multi-select intent, not rename.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      // Ignore double-clicks bubbling from nested controls (PR status, port,
      // archive buttons) — only the row body should enter inline rename.
      if ((event.target as HTMLElement).closest("button, a")) return;
      event.preventDefault();
      editing.requestRename(threadRef, thread.title);
    },
    [cleanup, isMobile, renameTarget, editing, threadRef, thread.environmentId, thread.title],
  );
  const handleRowKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        event.stopPropagation();
        const bounds = event.currentTarget.getBoundingClientRect();
        // Route keyboard requests through the same cleanup and multiselect guards as a click.
        event.currentTarget.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: bounds.left + 16,
            clientY: bounds.bottom,
          }),
        );
        return;
      }
      activateSidebarRowFromKeyboard(event, () => {
        if (isCleanupFailed) {
          setCleanupFailureOpen(true);
          return;
        }
        if (isCleanupPending) return;
        navigateToThread(threadRef);
      });
    },
    [isCleanupFailed, isCleanupPending, navigateToThread, threadRef],
  );
  const handleRowContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      if (cleanup !== null) return;
      const hasSelection = useThreadSelectionStore.getState().hasSelection();
      if (hasSelection && isSelected) {
        void (async () => {
          const result = await settlePromise(() =>
            handleMultiSelectContextMenu({
              x: event.clientX,
              y: event.clientY,
            }),
          );
          if (result._tag === "Failure") {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Thread action failed",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
        })();
        return;
      }

      if (hasSelection) {
        clearSelection();
      }
      void (async () => {
        const result = await settlePromise(() =>
          handleThreadContextMenu(
            threadRef,
            {
              x: event.clientX,
              y: event.clientY,
            },
            hasStoppableProcesses,
          ),
        );
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Thread action failed",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [
      cleanup,
      clearSelection,
      handleMultiSelectContextMenu,
      handleThreadContextMenu,
      hasStoppableProcesses,
      isSelected,
      threadRef,
    ],
  );
  const handlePrClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      const url = prStatus?.url ?? currentLinkedPr?.url;
      if (!url) return;
      const openedInRightPanel = openPrLink(
        event,
        url,
        openPullRequestsInRightPanel ? threadRef : undefined,
      );
      if (openedInRightPanel && openPullRequestsInRightPanel && !isActive) {
        navigateToThread(threadRef);
      }
    },
    [
      isActive,
      navigateToThread,
      openPrLink,
      openPullRequestsInRightPanel,
      prStatus,
      currentLinkedPr,
      threadRef,
    ],
  );
  const stopPropagationOnPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => event.stopPropagation(),
    [],
  );
  const threadNavigationRef = useRef<HTMLDivElement | null>(null);
  const threadDetailsTooltipId = useId();
  const setFamilyCollapsed = useLastCodeSidebarFamiliesStore((state) => state.setCollapsed);
  const family = props.familyRow;
  const typedGroups = props.groupingStyle === "typed-groups";
  const subagentLabel =
    thread.lineage.relationshipToParent === "subagent" && thread.lineage.independent !== true
      ? `Subagent · ${lastcodeSidebarSubagentStatusLabel(thread, threadStatus)}${family.unavailableParentLabel ? ` · ${family.unavailableParentLabel}` : ""}`
      : null;
  const relationshipLabel = subagentLabel ?? (isAgentCreated ? "Agent-created" : null);
  const relationshipUnavailableLabel =
    family.unavailableParentLabel ??
    family.creatorGroupingWarning ??
    creatorDetails.unavailableLabel;
  const threadRowElement = (
    <div
      ref={threadNavigationRef}
      className={cn(
        "relative isolate flex h-8 w-full min-w-0 cursor-pointer select-none items-center gap-1 overflow-hidden rounded-md pr-2 text-left text-xs outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring group-data-[collapsible=icon]:hidden [&>span:last-child]:truncate [&>svg:not([class*='size-'])]:size-4 [&>svg]:shrink-0 [&>svg]:text-sidebar-muted-foreground",
        isActive
          ? "bg-sidebar-row-active font-medium text-sidebar-foreground hover:bg-sidebar-row-active"
          : isSelected
            ? "bg-sidebar-row-selected text-sidebar-foreground hover:bg-sidebar-row-active"
            : "text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
        typedGroups && family.descendantCount > 0 && !family.expanded && "h-10",
        isCleanupPending && "cursor-not-allowed opacity-65",
        isFileDragOver && "ring-1 ring-inset ring-primary/70",
      )}
    />
  );

  return (
    <SidebarMenuSubItem
      ref={rowRef}
      className="w-full mb-1"
      style={{ paddingLeft: 12 + Math.min(family.depth, 6) * 12 }}
      data-thread-item
      {...fileDropHandlers}
      onFocusCapture={() => {
        if (!hasActiveAnnotation) setThreadRowActive(true);
      }}
      onMouseEnter={() => {
        if (!hasActiveAnnotation) setThreadRowActive(true);
      }}
      onMouseLeave={handleMouseLeave}
      onBlurCapture={handleBlurCapture}
    >
      <LastCodeSidebarFamilyGuides depth={family.depth} />
      {/* A thread row is the LastCode sidebar's own control (a focusable div that hosts nested
          links and buttons), not a SidebarMenuSubButton, so it owns its look here. */}
      <ThreadAnnotationNavigationTrigger
        annotationActive={hasActiveAnnotation}
        handle={annotationPopoverHandle}
        id={annotationTriggerId}
        render={threadRowElement}
        role="button"
        tabIndex={0}
        aria-describedby={
          !hasActiveAnnotation && threadRowActive ? threadDetailsTooltipId : undefined
        }
        data-active={isActive}
        aria-label={
          relationshipLabel
            ? `${thread.title}, ${relationshipLabel}${creatorDescription ? `, ${creatorDescription}` : ""}${thread.persistent ? ", protected from archive and deletion" : ""}${!family.expanded && family.descendantCount ? `, ${lastcodeSidebarFamilySummary(family)}` : ""}`
            : undefined
        }
        data-slot="sidebar-menu-sub-button"
        data-sidebar="menu-sub-button"
        data-size="sm"
        data-testid={`thread-row-${thread.id}`}
        data-cleanup-pending={isCleanupPending}
        data-file-drag-over={isFileDragOver}
        aria-disabled={isCleanupPending || undefined}
        onClick={handleRowClick}
        onDoubleClick={handleRowDoubleClick}
        onKeyDown={handleRowKeyDown}
        onContextMenu={handleRowContextMenu}
      >
        {isCleanupPending && !hasActiveAnnotation ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  aria-label={`${thread.title} cleanup details`}
                  className="absolute inset-0 z-20 cursor-not-allowed"
                />
              }
            />
            <TooltipPopup
              align="start"
              side="right"
              sideOffset={4}
              variant="glass"
              viewportPadding="none"
            >
              <div className="text-left">{threadHoverDetails}</div>
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {family.descendantCount > 0 && family.projectExpanded ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  data-thread-selection-safe
                  aria-label={
                    family.expanded && family.collapseNavigatesToParent
                      ? `Collapse children and return to ${thread.title}`
                      : `${family.expanded ? "Collapse" : "Expand"} children of ${thread.title}`
                  }
                  aria-expanded={family.expanded}
                  className={cn(
                    "relative z-30 inline-flex size-4 shrink-0 items-center justify-center rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                    typedGroups && !family.expanded && !renameTarget && "-translate-y-1.5",
                  )}
                  onPointerDown={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    setFamilyCollapsed(threadKey, family.expanded);
                    if (family.expanded && family.collapseNavigatesToParent) {
                      void navigateToThread(threadRef);
                    }
                  }}
                />
              }
            >
              <ChevronRightIcon
                aria-hidden
                className={cn("size-3", family.expanded && "rotate-90")}
              />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {family.expanded && family.selectedDescendant
                ? family.collapseNavigatesToParent
                  ? "Collapse children and return to this thread"
                  : "Collapse children; keep the selected conversation visible"
                : lastcodeSidebarFamilySummary(family)}
            </TooltipPopup>
          </Tooltip>
        ) : (
          <span className="inline-flex size-4 shrink-0 items-center justify-center" aria-hidden>
            {family.descendantCount === 0 ? (
              <span className="size-[2px] rounded-full bg-sidebar-muted-foreground/45" />
            ) : null}
          </span>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          {cleanup === null && prStatus && pr && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <a
                    href={prStatus.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={prStatus.tooltip}
                    className={`inline-flex items-center justify-center ${prStatus.colorClass} cursor-pointer rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring`}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={handlePrClick}
                  >
                    <ChangeRequestStatusIcon
                      state={pr.state}
                      isDraft={pr.isDraft}
                      className="size-3"
                    />
                  </a>
                }
              />
              <TooltipPopup side="top">
                <PrStatusTooltipContent status={prStatus} />
              </TooltipPopup>
            </Tooltip>
          )}
          {!pr && currentLinkedPr ? (
            <a
              href={currentLinkedPr.url}
              target="_blank"
              rel="noopener noreferrer"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={handlePrClick}
              className="text-muted-foreground"
              aria-label={`PR #${currentLinkedPr.number}, status pending`}
            >
              <PullRequestGlyph.pullRequest className="size-3" />
            </a>
          ) : null}
          {thread.actionResume?.outcome === "running" &&
          actionRunningPresentation(thread.actionResume).state === "waiting" &&
          threadStatus?.label !== "Waiting" ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    aria-label={`Waiting for ${thread.actionResume.actionName}. ${actionRunningPresentation(thread.actionResume).summary}`}
                    className="inline-flex size-3.5 shrink-0 items-center justify-center text-warning-foreground"
                  />
                }
              >
                <span
                  data-lastcode-sidebar-unscaled-content
                  className="size-1.5 rounded-full bg-warning"
                />
              </TooltipTrigger>
              <TooltipPopup side="top">
                {actionRunningPresentation(thread.actionResume).summary}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {threadStatus && (
            <ThreadStatusLabel status={threadStatus} compact={props.compactStatusIndicators} />
          )}
          {canOperateThread && renameTarget ? (
            <LastCodeThreadTitleEditor
              key={renameTarget.session}
              threadRef={threadRef}
              title={thread.title}
              target={renameTarget}
              finishRename={editing.finishRename}
            />
          ) : (
            <>
              {thread.persistent && family.parentKey === null && !subagentLabel ? (
                <MessageSquareLockIcon aria-hidden className="size-3.5 shrink-0" />
              ) : null}
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-1">
                  <span
                    className={`min-w-0 flex-1 truncate text-sm ${thread.persistent ? "italic" : ""}`}
                    data-testid={`thread-title-${thread.id}`}
                  >
                    {thread.title}
                  </span>
                  {thread.persistent && (family.parentKey !== null || subagentLabel) ? (
                    <span className="shrink-0 text-3xs text-sidebar-muted-foreground">
                      Protected
                    </span>
                  ) : null}
                  {isAgentCreated || relationshipUnavailableLabel ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span
                            aria-label={relationshipDescription ?? relationshipLabel ?? undefined}
                            className={cn(
                              "inline-flex shrink-0 items-center gap-0.5 text-3xs",
                              typedGroups
                                ? "rounded border px-1 py-0.5"
                                : "text-sidebar-muted-foreground",
                              typedGroups && isAgentCreated && "border-dashed",
                            )}
                          />
                        }
                      >
                        {isAgentCreated ? <SparklesIcon aria-hidden className="size-3" /> : null}
                        {isAgentCreated && !props.compactStatusIndicators ? (
                          <span className="hidden @sm/lastcode-sidebar:inline">Agent-created</span>
                        ) : null}
                        {relationshipUnavailableLabel ? (
                          <TriangleAlertIcon
                            aria-hidden
                            className="size-3 text-warning-foreground"
                          />
                        ) : null}
                      </TooltipTrigger>
                      <TooltipPopup side="top">
                        {relationshipDescription}
                        {relationshipUnavailableLabel ? (
                          <div>{relationshipUnavailableLabel}</div>
                        ) : null}
                      </TooltipPopup>
                    </Tooltip>
                  ) : null}
                  {subagentLabel ? (
                    <span className="shrink-0 text-3xs text-sidebar-muted-foreground">
                      {lastcodeSidebarSubagentStatusLabel(thread, threadStatus)}
                    </span>
                  ) : null}
                  {!typedGroups && family.descendantCount > 0 && !family.expanded ? (
                    <>
                      {family.descendantsStatus ? (
                        <ThreadStatusLabel
                          status={family.descendantsStatus}
                          compact={props.compactStatusIndicators}
                        />
                      ) : null}
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <span className="shrink-0 text-3xs text-sidebar-muted-foreground" />
                          }
                        >
                          +{family.descendantCount}
                        </TooltipTrigger>
                        <TooltipPopup side="top">
                          {lastcodeSidebarFamilySummary(family)}
                        </TooltipPopup>
                      </Tooltip>
                    </>
                  ) : null}
                </span>
                {typedGroups && family.descendantCount > 0 && !family.expanded ? (
                  <span className="flex items-center gap-1 truncate text-3xs leading-3 text-sidebar-muted-foreground">
                    {family.descendantsStatus ? (
                      <ThreadStatusLabel status={family.descendantsStatus} compact />
                    ) : null}
                    <span className="truncate">{lastcodeSidebarFamilySummary(family)}</span>
                  </span>
                ) : null}
              </span>
              <ThreadDashboardIndicator items={thread.dashboardItems} />
            </>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {canOperatePreview && cleanup === null && discoveredPorts.length > 0 ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={`Open localhost:${discoveredPorts[0]?.port ?? ""}`}
                    className="inline-flex cursor-pointer items-center justify-center text-success-foreground outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                    onClick={handleOpenDiscoveredPort}
                  />
                }
              >
                <Globe2Icon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">
                Open localhost:{discoveredPorts[0]?.port}
                {discoveredPorts.length > 1 ? ` (+${discoveredPorts.length - 1})` : ""}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {terminalStatus ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    role="img"
                    aria-label={terminalStatus.label}
                    className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
                  />
                }
              >
                <TerminalIcon
                  className={`size-3 ${terminalStatus.pulse ? "motion-safe:animate-status-pulse" : ""}`}
                  onAnimationStart={synchronizeTerminalPulse}
                />
              </TooltipTrigger>
              <TooltipPopup side="top">{terminalStatus.label}</TooltipPopup>
            </Tooltip>
          ) : null}
          {/* These fixed tracks are the scanning columns for every thread row.
              Empty local/worktree cells stay mounted for ordinary timestamps,
              which cannot widen the grid and push either icon sideways. A
              transient jump hint replaces all three cells and uses a
              content-sized track so a custom shortcut cannot paint across
              visible row content or create an implicit grid row; the mobile
              grid retains its trailing action track. */}
          <div
            className={threadMetadataGridClassName}
            style={
              {
                "--thread-metadata-gap":
                  "calc(var(--spacing) * var(--lastcode-sidebar-content-zoom))",
              } as CSSProperties
            }
            data-testid={`thread-metadata-grid-${thread.id}`}
          >
            {jumpLabel === null ? (
              <>
                <span
                  className="inline-flex h-3 w-full items-center justify-center"
                  data-thread-metadata-column="worktree"
                >
                  {props.showWorktreeIndicators ? (
                    <ThreadWorktreeIndicator thread={thread} />
                  ) : null}
                </span>
                <span
                  className="inline-flex h-3 w-full items-center justify-center"
                  data-thread-metadata-column="environment"
                >
                  {showsThreadEnvironmentIcon ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span
                            aria-label={[
                              threadEnvironmentLabel ?? "Remote",
                              props.providerBadgePreferences.enabled
                                ? providerEntry?.displayName
                                : null,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                            className={`inline-flex shrink-0 items-center justify-center ${
                              isConfirmingArchive ? "invisible" : ""
                            }`}
                            data-lastcode-sidebar-unscaled-content
                          />
                        }
                      >
                        <ConnectedSidebarEnvironmentIcon
                          environmentId={thread.environmentId}
                          context="legacy-row"
                          color={environmentIconColor}
                          className="size-3"
                          provider={props.providerBadgePreferences.enabled ? providerEntry : null}
                          badgeSize={props.providerBadgePreferences.size}
                          badgeTransparency={props.providerBadgePreferences.transparency}
                        />
                      </TooltipTrigger>
                      <TooltipPopup side="top">
                        {threadEnvironmentLabel}
                        {props.providerBadgePreferences.enabled && providerEntry
                          ? ` · ${providerEntry.displayName}`
                          : null}
                      </TooltipPopup>
                    </Tooltip>
                  ) : null}
                </span>
              </>
            ) : null}
            {canOperateThread && !thread.persistent && cleanup === null ? (
              <LastCodeThreadArchiveControl
                thread={thread}
                confirming={isConfirmingArchive}
                editing={editing}
              />
            ) : null}
            <span
              className={threadMetaClassName}
              data-thread-metadata-column="timestamp"
              data-thread-metadata-mode={jumpLabel ? "jump" : "timestamp"}
            >
              <span className="inline-flex items-center gap-1">
                {jumpLabel ? (
                  hasActiveAnnotation && annotation ? (
                    <PopoverTrigger
                      aria-label={`${jumpLabel}; show annotation for ${thread.title}`}
                      handle={annotationPopoverHandle}
                      onPointerDown={stopPropagationOnPointerDown}
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") event.stopPropagation();
                      }}
                    >
                      <span className="inline-flex h-5 items-center rounded-full border border-dotted border-warning bg-warning/10 px-1.5 font-mono text-3xs font-medium tracking-tight text-warning-foreground shadow-sm">
                        {jumpLabel}
                      </span>
                    </PopoverTrigger>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span
                            aria-label={jumpLabel}
                            className="inline-flex h-5 items-center rounded-full border border-border/80 bg-background/90 px-1.5 font-mono text-3xs font-medium tracking-tight text-foreground shadow-sm"
                          />
                        }
                      >
                        {jumpLabel}
                      </TooltipTrigger>
                      <TooltipPopup side="top">{jumpLabel}</TooltipPopup>
                    </Tooltip>
                  )
                ) : hasActiveAnnotation && annotation ? (
                  <PopoverTrigger
                    aria-label={`Show annotation for ${thread.title}`}
                    handle={annotationPopoverHandle}
                    onPointerDown={stopPropagationOnPointerDown}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") event.stopPropagation();
                    }}
                  >
                    <span
                      className={`border-b border-dotted border-warning text-3xs tabular-nums ${
                        isHighlighted ? "text-foreground" : "text-secondary-label"
                      }`}
                      data-lastcode-sidebar-unscaled-content
                    >
                      {formatRelativeTimeLabel(
                        thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
                      )}
                    </span>
                  </PopoverTrigger>
                ) : (
                  <span
                    className={`text-3xs tabular-nums ${
                      isHighlighted ? "text-foreground" : "text-secondary-label"
                    }`}
                    data-lastcode-sidebar-unscaled-content
                  >
                    {formatRelativeTimeLabel(
                      thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
                    )}
                  </span>
                )}
              </span>
            </span>
          </div>
        </div>
      </ThreadAnnotationNavigationTrigger>
      {hasActiveAnnotation && annotation ? (
        <ThreadAnnotationHoverPopover
          annotation={annotation}
          cwd={gitCwd ?? undefined}
          handle={annotationPopoverHandle}
          navigationTriggerId={annotationTriggerId}
          onBodyChange={(body) => onSaveAnnotationBody(thread, body)}
          onEdit={() => {
            if (checkTaskPermission(thread.environmentId)) onEditAnnotation(thread);
          }}
          onResolve={() => onResolveAnnotation(thread)}
          threadDetails={threadHoverDetails}
          trailingContent={cleanupHoverDetails}
          threadRef={threadRef}
        />
      ) : null}
      <Tooltip
        disabled={hasActiveAnnotation}
        open={!hasActiveAnnotation && threadRowActive}
        onOpenChange={handleThreadDetailsTooltipOpenChange}
      >
        <TooltipPopup
          align="start"
          animated={false}
          anchor={threadNavigationRef}
          id={threadDetailsTooltipId}
          side="right"
          sideOffset={4}
          variant="glass"
          viewportPadding="none"
        >
          <div className="text-left">{threadHoverDetails}</div>
        </TooltipPopup>
      </Tooltip>
      <WorktreeCleanupFailureDialog
        thread={thread}
        open={cleanupFailureOpen}
        onOpenChange={setCleanupFailureOpen}
      />
    </SidebarMenuSubItem>
  );
});

interface SidebarProjectThreadListProps {
  groupingStyle: "minimal" | "typed-groups";
  lastcodeSidebarScale: LegacySidebarScale;
  compactStatusIndicators: boolean;
  showWorktreeIndicators: boolean;
  scaleStyle: CSSProperties;
  providerEntriesByEnvironmentId: ReadonlyMap<string, ReadonlyMap<string, ProviderInstanceEntry>>;
  environmentIconColors: Readonly<Record<string, EnvironmentIconColor>>;
  showLocalEnvironmentIcon: boolean;
  providerBadgePreferences: SidebarProviderBadgePreferences;
  projectCwd: string | null;
  projectKey: string;
  projectExpanded: boolean;
  hasOverflowingThreads: boolean;
  hiddenThreadStatus: ThreadStatusPill | null;
  orderedProjectThreadKeys: readonly string[];
  renderedItems: readonly LastCodeSidebarFamilyItem[];
  showEmptyThreadState: boolean;
  shouldShowThreadPanel: boolean;
  isThreadListExpanded: boolean;
  activeRouteThreadKey: string | null;
  openPullRequestsInRightPanel: boolean;
  threadJumpLabelByKey: ReadonlyMap<string, string>;
  renameTarget: LastCodeRenameTarget | null;
  editing: LastCodeThreadEditingCapabilities;
  archiveTarget: string | null;
  attachThreadListAutoAnimateRef: (node: HTMLElement | null) => void;
  handleThreadClick: (
    event: React.MouseEvent,
    threadRef: ScopedThreadRef,
    orderedProjectThreadKeys: readonly string[],
  ) => void;
  navigateToThread: (threadRef: ScopedThreadRef) => Promise<void>;
  onFileDropThreads: (threadRef: ScopedThreadRef, files: File[]) => void;
  handleMultiSelectContextMenu: (position: { x: number; y: number }) => Promise<void>;
  handleThreadContextMenu: (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
    hasStoppableProcesses: boolean,
  ) => Promise<void>;
  clearSelection: () => void;

  openPrLink: (
    event: React.MouseEvent<HTMLElement>,
    prUrl: string,
    threadRef?: ScopedThreadRef,
  ) => boolean;
  onEditAnnotation: (thread: SidebarThreadSummary) => void;
  onSaveAnnotationBody: (thread: SidebarThreadSummary, body: string) => Promise<boolean>;
  onResolveAnnotation: (thread: SidebarThreadSummary) => void;
  expandThreadListForProject: (projectKey: string) => void;
  collapseThreadListForProject: (projectKey: string) => void;
}

const SidebarProjectThreadList = memo(function SidebarProjectThreadList(
  props: SidebarProjectThreadListProps,
) {
  const {
    lastcodeSidebarScale,
    compactStatusIndicators,
    showWorktreeIndicators,
    scaleStyle,
    providerEntriesByEnvironmentId,
    environmentIconColors,
    showLocalEnvironmentIcon,
    providerBadgePreferences,
    projectCwd,
    projectKey,
    projectExpanded,
    hasOverflowingThreads,
    hiddenThreadStatus,
    orderedProjectThreadKeys,
    renderedItems,
    showEmptyThreadState,
    shouldShowThreadPanel,
    isThreadListExpanded,
    activeRouteThreadKey,
    openPullRequestsInRightPanel,
    threadJumpLabelByKey,
    renameTarget,
    editing,
    archiveTarget,
    attachThreadListAutoAnimateRef,
    handleThreadClick,
    navigateToThread,
    onFileDropThreads,
    handleMultiSelectContextMenu,
    handleThreadContextMenu,
    clearSelection,
    openPrLink,
    onEditAnnotation,
    onSaveAnnotationBody,
    onResolveAnnotation,
    expandThreadListForProject,
    collapseThreadListForProject,
  } = props;
  const showMoreButtonRender = useMemo(() => <button type="button" />, []);
  const showLessButtonRender = useMemo(() => <button type="button" />, []);
  const setFamilyCollapsed = useLastCodeSidebarFamiliesStore((state) => state.setCollapsed);

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
          if (item.type === "subagents") {
            return (
              <SidebarMenuSubItem key={item.key} className="w-full" data-thread-selection-safe>
                <LastCodeSidebarFamilyGuides depth={item.depth} />
                <button
                  type="button"
                  aria-label={
                    item.expanded && item.collapseNavigatesToParent
                      ? `Collapse subagents and return to ${item.parentTitle}`
                      : `${item.expanded ? "Collapse" : "Expand"} subagents of ${item.parentTitle}${!item.expanded && item.status ? ` · ${item.status.label}` : ""}`
                  }
                  aria-expanded={item.expanded}
                  className="flex h-8 w-full items-center gap-1 rounded-md pr-2 text-3xs text-sidebar-muted-foreground uppercase hover:bg-sidebar-row-hover focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                  style={{ paddingLeft: 12 + Math.min(item.depth, 6) * 12 }}
                  onClick={() => {
                    setFamilyCollapsed(item.key, item.expanded);
                    if (item.expanded && item.collapseNavigatesToParent) {
                      const parentRef = parseScopedThreadKey(item.parentKey);
                      if (parentRef) void navigateToThread(parentRef);
                    }
                  }}
                >
                  <ChevronRightIcon
                    aria-hidden
                    className={cn("size-3", item.expanded && "rotate-90")}
                  />
                  <BotIcon aria-hidden className="size-3" />
                  <span>Subagents</span>
                  <span className="text-secondary-label">{item.count}</span>
                  {!item.expanded && item.status ? (
                    <ThreadStatusLabel status={item.status} compact={compactStatusIndicators} />
                  ) : null}
                </button>
              </SidebarMenuSubItem>
            );
          }
          const familyRow = item.row;
          const thread = familyRow.thread;
          const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
          return (
            <React.Fragment key={threadKey}>
              {familyRow.groupHeading ? (
                <SidebarMenuSubItem className="w-full" data-thread-selection-safe>
                  <LastCodeSidebarFamilyGuides depth={familyRow.depth} />
                  <div
                    style={{ paddingLeft: Math.min(familyRow.depth, 6) * 12 + 32 }}
                    className="py-1 text-3xs text-sidebar-muted-foreground uppercase"
                  >
                    {familyRow.groupHeading}
                  </div>
                </SidebarMenuSubItem>
              ) : null}
              <SidebarThreadRow
                groupingStyle={props.groupingStyle}
                thread={thread}
                familyRow={familyRow}
                compactStatusIndicators={compactStatusIndicators}
                showWorktreeIndicators={showWorktreeIndicators}
                showLocalEnvironmentIcon={showLocalEnvironmentIcon}
                providerBadgePreferences={providerBadgePreferences}
                configuredEnvironmentIconColor={environmentIconColors[thread.environmentId]}
                projectCwd={projectCwd}
                providerEntriesByEnvironmentId={providerEntriesByEnvironmentId}
                orderedProjectThreadKeys={orderedProjectThreadKeys}
                isActive={activeRouteThreadKey === threadKey}
                openPullRequestsInRightPanel={openPullRequestsInRightPanel}
                jumpLabel={threadJumpLabelByKey.get(threadKey) ?? null}
                renameTarget={renameTarget?.key === threadKey ? renameTarget : null}
                editing={editing}
                archiveConfirmActive={archiveTarget === threadKey}
                handleThreadClick={handleThreadClick}
                navigateToThread={navigateToThread}
                onFileDropThreads={onFileDropThreads}
                handleMultiSelectContextMenu={handleMultiSelectContextMenu}
                handleThreadContextMenu={handleThreadContextMenu}
                clearSelection={clearSelection}
                openPrLink={openPrLink}
                onEditAnnotation={onEditAnnotation}
                onSaveAnnotationBody={onSaveAnnotationBody}
                onResolveAnnotation={onResolveAnnotation}
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
  compactStatusIndicators: boolean;
  showWorktreeIndicators: boolean;
  scaleStyle: CSSProperties;
  providerEntriesByEnvironmentId: ReadonlyMap<string, ReadonlyMap<string, ProviderInstanceEntry>>;
  desktopLocalEnvironmentIds: ReadonlySet<EnvironmentId>;
  knownEnvironmentIds: ReadonlySet<EnvironmentId>;
  environmentIconColors: Readonly<Record<string, EnvironmentIconColor>>;
  showLocalEnvironmentIcon: boolean;
  providerBadgePreferences: SidebarProviderBadgePreferences;
  project: SidebarProjectSnapshot;
  isThreadListExpanded: boolean;
  activeRouteThreadKey: string | null;
  openPullRequestsInRightPanel: boolean;
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
    compactStatusIndicators,
    showWorktreeIndicators,
    scaleStyle,
    providerEntriesByEnvironmentId,
    project,
    isThreadListExpanded,
    activeRouteThreadKey,
    openPullRequestsInRightPanel,
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
  const groupingStyle = useClientSettings((settings) => settings.legacySidebarThreadGroupingStyle);
  const threadSortOrder = useClientSettings<SidebarThreadSortOrder>(
    (settings) => settings.sidebarThreadSortOrder,
  );

  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isNoProjectGroup = project.projectKey === NO_PROJECT_GROUP_KEY;
  const loadBalancingEnabled = useClientSettings((settings) => settings.loadBalancingEnabled);
  const canAutoBalance =
    loadBalancingEnabled &&
    !isNoProjectGroup &&
    new Set(project.memberProjects.map((member) => member.environmentId)).size > 1;
  const projectEnvironmentIcons = useMemo(
    () =>
      projectEnvironmentIconEntries({
        members: project.memberProjects,
        primaryEnvironmentId,
        desktopLocalEnvironmentIds: props.desktopLocalEnvironmentIds,
        showLocalEnvironmentIcon: props.showLocalEnvironmentIcon,
      }),
    [
      primaryEnvironmentId,
      project.memberProjects,
      props.desktopLocalEnvironmentIds,
      props.showLocalEnvironmentIcon,
    ],
  );

  const sidebarThreadPreviewCount = useClientSettings<SidebarThreadPreviewCount>(
    (settings) => settings.sidebarThreadPreviewCount,
  );
  const router = useRouter();
  const queuePendingFileDrop = useSidebarPendingFileDropStore((s) => s.queuePendingFileDrop);
  const clearPendingFileDrop = useSidebarPendingFileDropStore((s) => s.clearPendingFileDrop);
  const { isMobile, setOpenMobile } = useSidebar();
  const setProjectExpanded = useUiStateStore((state) => state.setProjectExpanded);
  const toggleThreadSelection = useThreadSelectionStore((state) => state.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((state) => state.rangeSelectTo);
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const setSelectionAnchor = useThreadSelectionStore((state) => state.setAnchor);
  const openPrLink = useOpenPrLink();
  const sidebarThreads = useThreadShellsForProjectRefs(project.memberProjectRefs);
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
  // Keep a ref so callbacks can read the latest map without appearing in
  // dependency arrays (avoids invalidating every thread-row memo on each
  // thread-list change).
  const sidebarThreadByKeyRef = useRef(sidebarThreadByKey);
  sidebarThreadByKeyRef.current = sidebarThreadByKey;
  const projectThreads = sidebarThreads;
  const projectPreferenceKeys = useMemo(() => projectExpansionPreferenceKeys(project), [project]);
  const projectExpanded = useUiStateStore((state) =>
    resolveProjectExpanded(state.projectExpandedById, projectPreferenceKeys),
  );
  const threadLastVisitedAts = useUiStateStore(
    useShallow((state) =>
      projectThreads.map(
        (thread) =>
          state.threadLastVisitedAtById[
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
          ] ?? null,
      ),
    ),
  );
  const { renameTarget, archiveTarget, capabilities: editing } = useLastCodeThreadEditing();
  const annotations = useLastCodeThreadAnnotations();
  const [projectRenameTarget, setProjectRenameTarget] = useState<SidebarProjectGroupMember | null>(
    null,
  );
  const [projectGroupingTarget, setProjectGroupingTarget] =
    useState<SidebarProjectGroupMember | null>(null);
  const projectThreadKeys = useMemo(
    () =>
      [...sidebarThreadByKey.keys()].flatMap((key) => [key, lastcodeSidebarSubagentGroupKey(key)]),
    [sidebarThreadByKey],
  );
  const collapsedFamiliesByKey = useCollapsedLastCodeSidebarFamilies(projectThreadKeys);
  const { projectStatus, hiddenThreadStatus, familyProjection } = useMemo(() => {
    const lastVisitedAtByThreadKey = new Map(
      projectThreads.map((thread, index) => [
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        resolveThreadLastVisitedAt(thread.lastVisitedAt, threadLastVisitedAts[index] ?? undefined),
      ]),
    );
    const statusForThread = (thread: SidebarThreadSummary) => {
      const lastVisitedAt = lastVisitedAtByThreadKey.get(
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      );
      return resolveThreadStatusPill({
        thread: {
          ...thread,
          ...(lastVisitedAt !== null && lastVisitedAt !== undefined ? { lastVisitedAt } : {}),
        },
      });
    };
    const visibleProjectThreads = sortThreads(
      projectThreads.filter(threadShellIsVisible),
      threadSortOrder,
    );
    const familyProjection = projectLastCodeSidebarFamilies({
      threads: visibleProjectThreads,
      collapsedByKey: collapsedFamiliesByKey,
      activeThreadKey: activeRouteThreadKey,
      projectExpanded,
      previewCount: sidebarThreadPreviewCount,
      listExpanded: isThreadListExpanded,
      groupingStyle,
      statusForThread,
    });
    return {
      projectStatus: resolveProjectStatusIndicator(visibleProjectThreads.map(statusForThread)),
      hiddenThreadStatus: resolveProjectStatusIndicator(
        familyProjection.hiddenThreads.map(statusForThread),
      ),
      familyProjection,
    };
  }, [
    projectThreads,
    threadLastVisitedAts,
    threadSortOrder,
    collapsedFamiliesByKey,
    activeRouteThreadKey,
    projectExpanded,
    sidebarThreadPreviewCount,
    isThreadListExpanded,
    groupingStyle,
  ]);
  const {
    hasOverflowingThreads,
    renderedItems,
    showEmptyThreadState,
    shouldShowThreadPanel,
    orderedThreadKeys: orderedProjectThreadKeys,
  } = familyProjection;

  const handleProjectButtonClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
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
      if (useThreadSelectionStore.getState().hasSelection()) {
        clearSelection();
      }
      setProjectExpanded(projectPreferenceKeys, !projectExpanded);
    },
    [
      clearSelection,
      dragInProgressRef,
      projectExpanded,
      projectPreferenceKeys,
      setProjectExpanded,
      suppressProjectClickAfterDragRef,
      suppressProjectClickForContextMenuRef,
    ],
  );

  const handleProjectButtonKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (dragInProgressRef.current) {
        return;
      }
      setProjectExpanded(projectPreferenceKeys, !projectExpanded);
    },
    [dragInProgressRef, projectExpanded, projectPreferenceKeys, setProjectExpanded],
  );

  const handleProjectButtonPointerDownCapture = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      suppressProjectClickForContextMenuRef.current = false;
      if (
        isContextMenuPointerDown({
          button: event.button,
          ctrlKey: event.ctrlKey,
          isMac: isMacPlatform(navigator.platform),
        })
      ) {
        event.stopPropagation();
      }

      suppressProjectClickAfterDragRef.current = false;
    },
    [suppressProjectClickAfterDragRef, suppressProjectClickForContextMenuRef],
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
  const handleProjectButtonContextMenu = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      suppressProjectClickForContextMenuRef.current = true;
      void showProjectMenu({ x: event.clientX, y: event.clientY });
    },
    [showProjectMenu, suppressProjectClickForContextMenuRef],
  );

  const navigateToThread = useCallback(
    (threadRef: ScopedThreadRef) => {
      if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(scopedThreadKey(threadRef));
      if (isMobile) {
        setOpenMobile(false);
      }
      return router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [clearSelection, isMobile, router, setOpenMobile, setSelectionAnchor],
  );
  const handleThreadFileDrop = useCallback(
    async (threadRef: ScopedThreadRef, files: File[]) => {
      const dropId = queuePendingFileDrop({ threadRef, files });
      const targetPathname = router.buildLocation({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      }).pathname;
      if (targetPathname === router.state.location.pathname) return;
      try {
        await navigateToThread(threadRef);
        if (targetPathname !== router.state.location.pathname) {
          clearPendingFileDrop(dropId);
        }
      } catch {
        clearPendingFileDrop(dropId);
      }
    },
    [clearPendingFileDrop, navigateToThread, queuePendingFileDrop, router],
  );

  const handleThreadClick = useCallback(
    (
      event: React.MouseEvent,
      threadRef: ScopedThreadRef,
      orderedProjectThreadKeys: readonly string[],
    ) => {
      if (isSidebarNestedLinkClick(event.target)) return;
      const isMac = isMacPlatform(navigator.platform);
      if (
        isContextMenuPointerDown({
          button: event.button,
          ctrlKey: event.ctrlKey,
          isMac,
        })
      ) {
        event.preventDefault();
        return;
      }
      const isModClick = isMac ? event.metaKey : event.ctrlKey;
      const isShiftClick = event.shiftKey;
      const threadKey = scopedThreadKey(threadRef);
      const currentSelectionCount = useThreadSelectionStore.getState().selectedThreadKeys.size;

      if (isModClick) {
        event.preventDefault();
        toggleThreadSelection(threadKey);
        return;
      }

      if (isShiftClick) {
        event.preventDefault();
        rangeSelectTo(threadKey, orderedProjectThreadKeys);
        return;
      }

      // Ignore the trailing click of a plain double-click so it doesn't navigate
      // while a double-click is starting an inline rename. Placed after the
      // modifier branches so cmd/shift selection still processes every click.
      if (isTrailingDoubleClick(event.detail)) {
        return;
      }

      if (currentSelectionCount > 0) {
        clearSelection();
      }
      setSelectionAnchor(threadKey);
      if (isMobile) {
        setOpenMobile(false);
      }
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [
      clearSelection,
      isMobile,
      rangeSelectTo,
      router,
      setOpenMobile,
      setSelectionAnchor,
      toggleThreadSelection,
    ],
  );

  const handleMultiSelectContextMenu = useLastCodeBulkThreadMenu();

  const createThreadForProjectMember = useCallback(
    (member: SidebarProjectGroupMember, environmentSelection: "auto" | "manual" = "manual") => {
      if (isMobile) {
        setOpenMobile(false);
      }
      void (async () => {
        const result = await settlePromise(() =>
          handleNewThread(scopeProjectRef(member.environmentId, member.id), {
            environmentSelection,
          }),
        );
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not create thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [handleNewThread, isMobile, setOpenMobile],
  );

  const handleCreateThreadClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();

      if (project.memberProjects.length === 1) {
        createThreadForProjectMember(project.memberProjects[0]!);
        return;
      }

      void (async () => {
        const api = readLocalApi();
        if (!api) {
          return;
        }
        const clickedResult = await settlePromise(() =>
          api.contextMenu.show(
            [
              ...(canAutoBalance ? [{ id: "auto", label: "Auto balance" }] : []),
              ...project.memberProjects.map((member) => ({
                id: member.physicalProjectKey,
                label: formatProjectMemberActionLabel(member, project.groupedProjectCount),
              })),
            ],
            {
              x: event.clientX,
              y: event.clientY,
            },
          ),
        );
        if (clickedResult._tag === "Failure") {
          const error = squashAtomCommandFailure(clickedResult);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not choose environment",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
          return;
        }
        const clicked = clickedResult.value;
        if (!clicked) {
          return;
        }
        if (clicked === "auto") {
          createThreadForProjectMember(project.memberProjects[0]!, "auto");
          return;
        }
        const targetMember = project.memberProjects.find(
          (member) => member.physicalProjectKey === clicked,
        );
        if (!targetMember) {
          return;
        }
        createThreadForProjectMember(targetMember);
      })();
    },
    [
      canAutoBalance,
      createThreadForProjectMember,
      project.groupedProjectCount,
      project.memberProjects,
    ],
  );

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
    annotations.edit,
    navigateToThread,
    handleNewThread,
  );

  return (
    <>
      <div
        className="group/project-header relative"
        data-lastcode-sidebar-scale={lastcodeSidebarScale}
        style={{
          ...scaleStyle,
          marginLeft: "calc(8px * var(--lastcode-sidebar-content-zoom) - 8px)",
        }}
      >
        <SidebarMenuButton
          size="tree"
          ref={isManualProjectSorting ? dragHandleProps?.setActivatorNodeRef : undefined}
          className={isManualProjectSorting ? "cursor-grab active:cursor-grabbing" : undefined}
          {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.attributes : {})}
          {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.listeners : {})}
          onPointerDownCapture={handleProjectButtonPointerDownCapture}
          onClick={handleProjectButtonClick}
          onKeyDown={handleProjectButtonKeyDown}
          onContextMenu={handleProjectButtonContextMenu}
        >
          {!projectExpanded && projectStatus ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    aria-label={projectStatus.label}
                    className={`relative inline-flex size-4 shrink-0 items-center justify-center ${projectStatus.colorClass}`}
                  />
                }
              >
                <span className="absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover/project-header:opacity-0">
                  <span
                    data-lastcode-sidebar-unscaled-content
                    className={`size-[9px] rounded-full ${projectStatus.dotClass} ${
                      projectStatus.pulse ? "animate-status-pulse" : ""
                    }`}
                  />
                </span>
                <ChevronRightIcon className="absolute inset-0 m-auto size-3.5 text-icon-muted opacity-0 transition-opacity duration-150 group-hover/project-header:opacity-100" />
              </TooltipTrigger>
              <TooltipPopup side="top">{projectStatus.label}</TooltipPopup>
            </Tooltip>
          ) : (
            <span className="inline-flex size-4 shrink-0 items-center justify-center">
              <ChevronRightIcon
                className={`size-3.5 text-muted-foreground/70 transition-transform duration-150 ${projectExpanded ? "rotate-90" : ""}`}
              />
            </span>
          )}
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
          {/* Keeps the name clear of the environment badge and new-thread button overlaid on
              the row's end (two slots on touch, where both stay visible). */}
          <span
            aria-hidden
            className="w-4 shrink-0 max-sm:w-10"
            style={
              projectEnvironmentIcons.length > 0
                ? { width: `calc(1.75rem + ${Math.min(projectEnvironmentIcons.length, 3)}rem)` }
                : undefined
            }
          />
        </SidebarMenuButton>
        {/* Environment badges stay left of the New thread action so mixed
            groups remain inspectable without overlapping the action or title. */}
        {projectEnvironmentIcons.length > 0 && (
          <span
            aria-label={`Project environments: ${projectEnvironmentIcons.map((entry) => entry.label).join(", ")}`}
            className="pointer-events-none absolute top-1 right-(--project-environment-inset) inline-flex h-5 translate-x-full items-center gap-(--thread-metadata-gap) rounded-md max-sm:right-[calc(var(--project-environment-inset)+1.5rem*var(--lastcode-sidebar-content-zoom)+var(--thread-metadata-gap))]"
            style={
              {
                "--project-environment-inset":
                  "calc(0.5rem + 3.75rem * var(--lastcode-sidebar-content-zoom) + var(--thread-metadata-gap))",
                "--thread-metadata-gap":
                  "calc(var(--spacing) * var(--lastcode-sidebar-content-zoom))",
              } as CSSProperties
            }
          >
            {projectEnvironmentIcons
              .slice(0, projectEnvironmentIcons.length > 3 ? 2 : 3)
              .map((entry) => (
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
                      color={resolveEnvironmentIconColor(
                        props.environmentIconColors[entry.environmentId],
                        props.knownEnvironmentIds.has(entry.environmentId),
                      )}
                      className="size-3"
                    />
                  </TooltipTrigger>
                  <TooltipPopup side="top">{entry.label}</TooltipPopup>
                </Tooltip>
              ))}
            {projectEnvironmentIcons.length > 3 ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      role="img"
                      tabIndex={0}
                      aria-label={`${projectEnvironmentIcons.length - 2} more project environments`}
                      className="pointer-events-auto inline-flex size-3 items-center justify-center text-3xs text-icon-muted"
                      data-lastcode-sidebar-unscaled-content
                    />
                  }
                >
                  +{projectEnvironmentIcons.length - 2}
                </TooltipTrigger>
                <TooltipPopup side="top">
                  <div className="flex flex-col gap-1.5">
                    {projectEnvironmentIcons.slice(2).map((entry) => (
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
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <div className="pointer-events-none absolute top-[calc(50%+1px)] right-0.5 -translate-y-1/2 opacity-0 transition-opacity duration-150 max-sm:pointer-events-auto max-sm:opacity-100 group-hover/project-header:pointer-events-auto group-hover/project-header:opacity-100 group-focus-within/project-header:pointer-events-auto group-focus-within/project-header:opacity-100">
                <button
                  type="button"
                  aria-label={`Create new thread in ${project.displayName}`}
                  data-testid="new-thread-button"
                  className={SIDEBAR_ICON_ACTION_BUTTON_CLASS}
                  onClick={handleCreateThreadClick}
                >
                  <SquarePenIcon className="size-3.5" />
                </button>
              </div>
            }
          />
          <TooltipPopup side="top">
            {newThreadShortcutLabel ? `New thread (${newThreadShortcutLabel})` : "New thread"}
          </TooltipPopup>
        </Tooltip>
      </div>

      <SidebarProjectThreadList
        groupingStyle={groupingStyle}
        lastcodeSidebarScale={lastcodeSidebarScale}
        compactStatusIndicators={compactStatusIndicators}
        showWorktreeIndicators={showWorktreeIndicators}
        scaleStyle={scaleStyle}
        providerEntriesByEnvironmentId={providerEntriesByEnvironmentId}
        environmentIconColors={props.environmentIconColors}
        showLocalEnvironmentIcon={props.showLocalEnvironmentIcon}
        providerBadgePreferences={props.providerBadgePreferences}
        projectCwd={project.workspaceRoot}
        projectKey={project.projectKey}
        projectExpanded={projectExpanded}
        hasOverflowingThreads={hasOverflowingThreads}
        hiddenThreadStatus={hiddenThreadStatus}
        orderedProjectThreadKeys={orderedProjectThreadKeys}
        renderedItems={renderedItems}
        showEmptyThreadState={showEmptyThreadState}
        shouldShowThreadPanel={shouldShowThreadPanel}
        isThreadListExpanded={isThreadListExpanded}
        activeRouteThreadKey={activeRouteThreadKey}
        openPullRequestsInRightPanel={openPullRequestsInRightPanel}
        threadJumpLabelByKey={threadJumpLabelByKey}
        renameTarget={renameTarget}
        editing={editing}
        archiveTarget={archiveTarget}
        attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
        handleThreadClick={handleThreadClick}
        navigateToThread={navigateToThread}
        onFileDropThreads={handleThreadFileDrop}
        handleMultiSelectContextMenu={handleMultiSelectContextMenu}
        handleThreadContextMenu={handleThreadContextMenu}
        clearSelection={clearSelection}
        openPrLink={openPrLink}
        onEditAnnotation={annotations.edit}
        onSaveAnnotationBody={annotations.saveBody}
        onResolveAnnotation={(thread) => void annotations.resolve(thread)}
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

type SortableProjectHandleProps = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners" | "setActivatorNodeRef"
>;

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
  openPullRequestsInRightPanel: boolean;
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
  compactStatusIndicators: boolean;
  showWorktreeIndicators: boolean;
  projectTreeScaleStyle: CSSProperties;
  providerEntriesByEnvironmentId: ReadonlyMap<string, ReadonlyMap<string, ProviderInstanceEntry>>;
  desktopLocalEnvironmentIds: ReadonlySet<EnvironmentId>;
  knownEnvironmentIds: ReadonlySet<EnvironmentId>;
  environmentIconColors: Readonly<Record<string, EnvironmentIconColor>>;
  showLocalEnvironmentIcon: boolean;
  providerBadgePreferences: SidebarProviderBadgePreferences;
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
    openPullRequestsInRightPanel,
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
    compactStatusIndicators,
    showWorktreeIndicators,
    projectTreeScaleStyle,
    providerEntriesByEnvironmentId,
    desktopLocalEnvironmentIds,
    knownEnvironmentIds,
    environmentIconColors,
    showLocalEnvironmentIcon,
    providerBadgePreferences,
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
                        compactStatusIndicators={compactStatusIndicators}
                        showWorktreeIndicators={showWorktreeIndicators}
                        scaleStyle={projectTreeScaleStyle}
                        providerEntriesByEnvironmentId={providerEntriesByEnvironmentId}
                        desktopLocalEnvironmentIds={desktopLocalEnvironmentIds}
                        knownEnvironmentIds={knownEnvironmentIds}
                        environmentIconColors={environmentIconColors}
                        showLocalEnvironmentIcon={showLocalEnvironmentIcon}
                        providerBadgePreferences={providerBadgePreferences}
                        project={project}
                        isThreadListExpanded={expandedThreadListsByProject.has(project.projectKey)}
                        activeRouteThreadKey={
                          activeRouteProjectKey === project.projectKey ? routeThreadKey : null
                        }
                        openPullRequestsInRightPanel={openPullRequestsInRightPanel}
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
                compactStatusIndicators={compactStatusIndicators}
                showWorktreeIndicators={showWorktreeIndicators}
                scaleStyle={projectTreeScaleStyle}
                providerEntriesByEnvironmentId={providerEntriesByEnvironmentId}
                desktopLocalEnvironmentIds={desktopLocalEnvironmentIds}
                knownEnvironmentIds={knownEnvironmentIds}
                environmentIconColors={environmentIconColors}
                showLocalEnvironmentIcon={showLocalEnvironmentIcon}
                providerBadgePreferences={providerBadgePreferences}
                project={project}
                isThreadListExpanded={expandedThreadListsByProject.has(project.projectKey)}
                activeRouteThreadKey={
                  activeRouteProjectKey === project.projectKey ? routeThreadKey : null
                }
                openPullRequestsInRightPanel={openPullRequestsInRightPanel}
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
  const compactStatusIndicators = useClientSettings(
    (settings) => settings.compactLegacySidebarStatuses,
  );
  const showWorktreeIndicators = useClientSettings(
    (settings) => settings.showThreadWorktreeIndicators,
  );
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
        const projectThreads = sortThreads(
          (threadsByProjectKey.get(project.projectKey) ?? []).filter(threadShellIsVisible),
          sidebarThreadSortOrder,
        );
        const projectExpanded = resolveProjectExpanded(
          projectExpandedById,
          projectExpansionPreferenceKeys(project),
        );
        return projectLastCodeSidebarFamilies({
          threads: projectThreads,
          collapsedByKey: collapsedFamiliesByKey,
          activeThreadKey: routeThreadKey,
          projectExpanded,
          previewCount: sidebarThreadPreviewCount,
          listExpanded: expandedThreadListsByProject.has(project.projectKey),
          groupingStyle,
        }).orderedThreadKeys;
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
        openPullRequestsInRightPanel={routeThreadRef !== null}
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
        compactStatusIndicators={compactStatusIndicators}
        showWorktreeIndicators={showWorktreeIndicators}
        projectTreeScaleStyle={scaleStyle}
        providerEntriesByEnvironmentId={providerEntriesByEnvironmentId}
        desktopLocalEnvironmentIds={desktopLocalEnvironmentIds}
        knownEnvironmentIds={knownEnvironmentIds}
        environmentIconColors={environmentIconColors}
        showLocalEnvironmentIcon={showLocalEnvironmentIcon}
        providerBadgePreferences={providerBadgePreferences}
      />
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
