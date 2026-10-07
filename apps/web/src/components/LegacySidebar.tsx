import { ThreadDashboardIndicator } from "./dashboard/ThreadDashboardIndicator";
import { describeHandoff } from "../handoffs/handoffMenu";
import { readThreadHandoffs } from "../handoffs/handoffsStore";
import { useOpenHandoff } from "../handoffs/useOpenHandoff";
import { useRightPanelStore } from "../rightPanelStore";
import { useSupportsMultiplePullRequests } from "~/hooks/useSupportsMultiplePullRequests";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/shared/threadPullRequests";
import { Spinner } from "~/components/ui/spinner";
import {
  ArchiveIcon,
  BotIcon,
  SparklesIcon,
  ArrowUpDownIcon,
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
import { SidebarDraftBlock } from "./Sidebar";
import {
  buildDraftActionMenuItems,
  buildStopThreadProcessesMenuItem,
  withThreadActionMenuDividers,
} from "./threadActionMenu.logic";
import { discardComposerDraft } from "../lib/discardComposerDraft";
import { useAtomValue } from "@effect/atom-react";
import { autoAnimate } from "@formkit/auto-animate";
import { actionRunningPresentation } from "@t3tools/shared/actionResume";
import React, {
  useCallback,
  useEffect,
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
  type ContextMenuItem,
  type EnvironmentId,
  ProjectId,
  type ScopedThreadRef,
  type ResolvedKeybindingsConfig,
  type SidebarProjectGroupingMode,
  ThreadId,
} from "@t3tools/contracts";
import {
  parseScopedThreadKey,
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  threadRuntimeCanArchive,
  threadShellIsVisible,
} from "@t3tools/client-runtime/state/models";
import { useNavigate, useParams, useRouter } from "@tanstack/react-router";
import {
  MAX_SIDEBAR_THREAD_PREVIEW_COUNT,
  MIN_SIDEBAR_THREAD_PREVIEW_COUNT,
  type EnvironmentIconColor,
  type LegacySidebarScale,
  type SidebarProjectSortOrder,
  type SidebarThreadPreviewCount,
  type SidebarThreadSortOrder,
} from "@t3tools/contracts/settings";
import { isDesktopLocalConnectionTarget, isWslConnectionTarget } from "../connection/desktopLocal";
import { useDesktopLocalBootstraps } from "../connection/useDesktopLocalBootstraps";
import { isElectron } from "../env";
import { useTerminalFocus } from "../hooks/useTerminalFocus";
import { useOpenPrLink } from "../lib/openPullRequestLink";
import { releaseProjectDraftUploads } from "../lib/composerDraftUploads";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isMacPlatform } from "../lib/utils";
import { useSidebarPendingFileDropStore } from "../sidebarPendingFileDropStore";
import { makeWorkspaceFileDropHandlers } from "./chat/workspaceFileDrop";
import {
  readProject,
  readThreadShell,
  readEnvironmentSupportsThreadAnnotations,
  readEnvironmentSupportsPersistence,
  useProject,
  useProjects,
  useThreadShells,
  useThreadShell,
  useThreadShellsForProjectRefs,
} from "../state/entities";
import {
  runThreadAnnotationBodySave,
  ThreadAnnotationEditorDialog,
  ThreadAnnotationHoverPopover,
} from "./thread-annotation/ThreadAnnotation";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { useThreadRunningTerminalIds } from "../state/terminalSessions";
import {
  usePreviewProcessControlsSupported,
  useStopThreadProcesses,
  useThreadPreviewLeases,
} from "../state/previewHosting";
import { useThreadDiscoveredPorts } from "../portDiscoveryState";
import { openDiscoveredPort } from "./preview/openDiscoveredPort";
import { useAtomCommand } from "../state/use-atom-command";
import { useEnvironmentQuery } from "../state/query";
import { previewEnvironment } from "../state/preview";
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
import { ensureLocalApi, readLocalApi } from "../localApi";
import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useDesktopUpdateState } from "../state/desktopUpdate";
import { legacySidebarScaleStyle } from "../legacySidebarScale";
import {
  ConnectedEnvironmentIcon,
  legacyThreadEnvironmentPresentation,
  projectEnvironmentIconEntries,
  resolveEnvironmentIconColor,
} from "../environmentIcons";

import { useThreadActions } from "../hooks/useThreadActions";
import { projectEnvironment } from "../state/projects";
import { threadEnvironment, useEnvironmentThread } from "../state/threads";
import { useEnvironment, useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import {
  buildThreadRouteParams,
  resolveActiveThreadRouteRef,
  resolveThreadRouteTarget,
} from "../threadRoutes";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { Kbd } from "./ui/kbd";
import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";
import { showDesktopUpdateDownloadedToast } from "./desktopUpdate.toast";
import {
  legacyThreadPersistenceAction,
  protectLegacyThreadActions,
} from "./legacyThreadPersistence.logic";
import { projectsContainPersistentThread } from "./projectPersistence.logic";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "./ui/menu";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "./ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
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
import {
  getThreadKeysToDeselectAfterDelete,
  useThreadSelectionStore,
} from "../threadSelectionStore";
import { isCommandPaletteOpen, openCommandPalette } from "../commandPaletteBus";
import {
  archiveSelectedThreadEntries,
  buildMultiSelectThreadContextMenuItems,
  collectUnprotectedBulkThreadEntries,
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
import { LegacySidebarThreadPicker } from "./sidebar/LegacySidebarThreadPicker";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useIsMobile } from "~/hooks/useMediaQuery";
import { CommandDialogTrigger } from "./ui/command";
import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import { primaryServerKeybindingsAtom, primaryServerProvidersAtom } from "../state/server";
import {
  derivePhysicalProjectKey,
  deriveProjectGroupingOverrideKey,
  getProjectOrderKey,
  selectProjectGroupingSettings,
} from "../logicalProject";
import type { SidebarThreadSummary } from "../types";
import {
  projectLegacySidebarFamilies,
  legacySidebarFamilySummary,
  legacySidebarCreatorDetails,
  legacySidebarIsAgentCreated,
  legacySidebarSubagentStatusLabel,
  legacySidebarSubagentGroupKey,
  type LegacySidebarFamilyItem,
  type LegacySidebarFamilyRow,
} from "./legacySidebarFamilies.logic";
import {
  useCollapsedLegacySidebarFamilies,
  useLegacySidebarFamiliesStore,
} from "./legacySidebarFamilies.store";
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
  resolveSidebarProjectSettingsKey,
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
const SIDEBAR_SORT_LABELS: Record<SidebarProjectSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
  manual: "Manual",
};
const SIDEBAR_THREAD_SORT_LABELS: Record<SidebarThreadSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
};
const SIDEBAR_LIST_ANIMATION_OPTIONS = {
  duration: 180,
  easing: "ease-out",
} as const;
const EMPTY_THREAD_JUMP_LABELS = new Map<string, string>();
const PROJECT_GROUPING_MODE_LABELS: Record<SidebarProjectGroupingMode, string> = {
  repository: "Group by repository",
  repository_path: "Group by repository path",
  separate: "Keep separate",
};
const SIDEBAR_ICON_ACTION_BUTTON_CLASS =
  "inline-flex h-6 min-w-6 cursor-pointer items-center justify-center rounded-md px-0.75 text-icon-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring";

function SidebarThreadDetailPrewarmer({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  useEnvironmentThread(threadRef.environmentId, threadRef.threadId);
  return null;
}

function clampSidebarThreadPreviewCount(value: number): SidebarThreadPreviewCount {
  return Math.min(
    MAX_SIDEBAR_THREAD_PREVIEW_COUNT,
    Math.max(MIN_SIDEBAR_THREAD_PREVIEW_COUNT, value),
  ) as SidebarThreadPreviewCount;
}

function formatProjectMemberActionLabel(
  member: SidebarProjectGroupMember,
  groupedProjectCount: number,
): string {
  if (groupedProjectCount <= 1) {
    return member.title;
  }

  return member.environmentLabel
    ? `${member.environmentLabel} — ${member.workspaceRoot}`
    : member.workspaceRoot;
}

function projectExpansionPreferenceKeys(project: SidebarProjectSnapshot): string[] {
  return [
    project.projectKey,
    ...project.memberProjects.map((member) => member.physicalProjectKey),
    ...project.memberProjects.map((member) => legacyProjectCwdPreferenceKey(member.workspaceRoot)),
  ];
}

function projectGroupingModeDescription(mode: SidebarProjectGroupingMode): string {
  switch (mode) {
    case "repository":
      return "Projects from the same repository share one sidebar row.";
    case "repository_path":
      return "Projects group only when both the repository and repo-relative path match.";
    case "separate":
      return "Every project path gets its own sidebar row.";
  }
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
function LegacySidebarFamilyGuides({ depth }: { depth: number }) {
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
  familyRow: LegacySidebarFamilyRow;
  groupingStyle: "minimal" | "typed-groups";
  compactStatusIndicators: boolean;
  showWorktreeIndicators: boolean;
  showLocalEnvironmentIcon: boolean;
  configuredEnvironmentIconColor: EnvironmentIconColor | undefined;
  projectCwd: string | null;
  providerEntriesByEnvironmentId: ReadonlyMap<string, ReadonlyMap<string, ProviderInstanceEntry>>;
  orderedProjectThreadKeys: readonly string[];
  isActive: boolean;
  openPullRequestsInRightPanel: boolean;
  jumpLabel: string | null;
  appSettingsConfirmThreadArchive: boolean;
  renamingThreadKey: string | null;
  renamingTitle: string;
  setRenamingTitle: (title: string) => void;
  startThreadRename: (threadKey: string, title: string) => void;
  renamingInputRef: React.RefObject<HTMLInputElement | null>;
  renamingCommittedRef: React.RefObject<boolean>;
  confirmingArchiveThreadKey: string | null;
  setConfirmingArchiveThreadKey: React.Dispatch<React.SetStateAction<string | null>>;
  confirmArchiveButtonRefs: React.RefObject<Map<string, HTMLButtonElement>>;
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
  commitRename: (
    threadRef: ScopedThreadRef,
    newTitle: string,
    originalTitle: string,
  ) => Promise<void>;
  cancelRename: () => void;
  attemptArchiveThread: (threadRef: ScopedThreadRef) => Promise<void>;
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
    appSettingsConfirmThreadArchive,
    renamingThreadKey,
    renamingTitle,
    setRenamingTitle,
    startThreadRename,
    renamingInputRef,
    renamingCommittedRef,
    confirmingArchiveThreadKey,
    setConfirmingArchiveThreadKey,
    confirmArchiveButtonRefs,
    handleThreadClick,
    navigateToThread,
    handleMultiSelectContextMenu,
    handleThreadContextMenu,
    clearSelection,
    commitRename,
    cancelRename,
    attemptArchiveThread,
    openPrLink,
    onFileDropThreads,
    onEditAnnotation,
    onSaveAnnotationBody,
    onResolveAnnotation,
    providerEntriesByEnvironmentId,
    thread,
  } = props;
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
    showLocalEnvironmentIcon: props.showLocalEnvironmentIcon,
    environmentLabel: remoteEnvLabel,
  });
  const showsThreadEnvironmentIcon =
    environmentPresentation.showRowIcon &&
    props.familyRow.parentKey === null &&
    thread.lineage.relationshipToParent !== "subagent";
  const threadEnvironmentLabel =
    props.familyRow.parentKey !== null ? null : environmentPresentation.hoverLabel;
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
          input: { cwd: gitCwd },
        })
      : null,
  );
  const isHighlighted = isActive || isSelected;
  const handleOpenDiscoveredPort = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const port = discoveredPorts[0];
      if (!port) return;
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
    [discoveredPorts, navigateToThread, openPreview, threadRef],
  );
  const isThreadRunning = !threadRuntimeCanArchive(thread.runtime);
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
  const isConfirmingArchive = confirmingArchiveThreadKey === threadKey && !isThreadRunning;
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
  const isAgentCreated = legacySidebarIsAgentCreated(thread);
  const creatorRef = useMemo(
    () =>
      isAgentCreated && thread.creatorThreadId
        ? scopeThreadRef(thread.environmentId, thread.creatorThreadId)
        : null,
    [isAgentCreated, thread.environmentId, thread.creatorThreadId],
  );
  const creatorShell = useThreadShell(creatorRef);
  const creatorDetails = legacySidebarCreatorDetails(thread, creatorShell);
  const creatorDescription = creatorDetails.description;
  const lineageDescription =
    thread.lineage.relationshipToParent === "subagent"
      ? `Subagent · ${legacySidebarSubagentStatusLabel(thread, threadStatus)}${props.familyRow.unavailableParentLabel ? ` · ${props.familyRow.unavailableParentLabel}` : ""}`
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
    : !isThreadRunning
      ? "transition-opacity duration-150 group-hover/menu-sub-item:opacity-0 group-focus-within/menu-sub-item:opacity-0"
      : "";
  const threadMetaClassName = `pointer-events-none inline-flex w-full justify-end ${
    jumpLabel ? "col-start-1 row-start-1 z-10" : ""
  } ${threadMetaVisibilityClassName}`;
  const threadMetadataGridClassName = jumpLabel
    ? "grid shrink-0 grid-cols-[max-content] items-center max-sm:grid-cols-[max-content_calc(1.5rem*var(--legacy-sidebar-content-zoom))]"
    : "grid shrink-0 grid-cols-[repeat(2,calc(0.75rem*var(--legacy-sidebar-content-zoom)))_calc(3rem*var(--legacy-sidebar-content-zoom))] items-center gap-x-(--thread-metadata-gap) max-sm:grid-cols-[repeat(2,calc(0.75rem*var(--legacy-sidebar-content-zoom)))_calc(3rem*var(--legacy-sidebar-content-zoom))_calc(1.5rem*var(--legacy-sidebar-content-zoom))]";
  const [threadRowActive, setThreadRowActive] = useState(false);
  const clearConfirmingArchive = useCallback(() => {
    setConfirmingArchiveThreadKey((current) => (current === threadKey ? null : current));
  }, [setConfirmingArchiveThreadKey, threadKey]);
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
      if (cleanup !== null) return;
      // Already renaming this row: a double-click on the row chrome (outside the
      // input) must not restart and discard the in-progress edit.
      if (renamingThreadKey === threadKey) return;
      // On mobile the first tap navigates and closes the sidebar sheet, so the
      // inline rename can't be shown. Renaming there stays on the context menu.
      if (isMobile) return;
      // cmd/ctrl/shift double-clicks are multi-select intent, not rename.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      // Ignore double-clicks bubbling from nested controls (PR status, port,
      // archive buttons) — only the row body should enter inline rename.
      if ((event.target as HTMLElement).closest("button, a")) return;
      event.preventDefault();
      startThreadRename(threadKey, thread.title);
    },
    [cleanup, isMobile, renamingThreadKey, startThreadRename, threadKey, thread.title],
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
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (isCleanupFailed) {
        setCleanupFailureOpen(true);
        return;
      }
      if (isCleanupPending) return;
      navigateToThread(threadRef);
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
  const handleRenameInputRef = useCallback(
    (element: HTMLInputElement | null) => {
      if (element && renamingInputRef.current !== element) {
        renamingInputRef.current = element;
        element.focus();
        element.select();
      }
    },
    [renamingInputRef],
  );
  const handleRenameInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setRenamingTitle(event.target.value);
    },
    [setRenamingTitle],
  );
  const handleRenameInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        renamingCommittedRef.current = true;
        void commitRename(threadRef, renamingTitle, thread.title);
      } else if (event.key === "Escape") {
        event.preventDefault();
        renamingCommittedRef.current = true;
        cancelRename();
      }
    },
    [cancelRename, commitRename, renamingCommittedRef, renamingTitle, thread.title, threadRef],
  );
  const handleRenameInputBlur = useCallback(() => {
    if (!renamingCommittedRef.current) {
      void commitRename(threadRef, renamingTitle, thread.title);
    }
  }, [commitRename, renamingCommittedRef, renamingTitle, thread.title, threadRef]);
  // Keep clicks/double-clicks inside the rename input from bubbling to the row.
  // Without stopping `dblclick`, double-clicking to select a word would re-fire
  // the row's rename handler and reset the in-progress edit back to the title.
  const handleRenameInputClick = useCallback((event: React.MouseEvent<HTMLInputElement>) => {
    event.stopPropagation();
  }, []);
  const handleConfirmArchiveRef = useCallback(
    (element: HTMLButtonElement | null) => {
      if (element) {
        confirmArchiveButtonRefs.current.set(threadKey, element);
      } else {
        confirmArchiveButtonRefs.current.delete(threadKey);
      }
    },
    [confirmArchiveButtonRefs, threadKey],
  );
  const stopPropagationOnPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.stopPropagation();
    },
    [],
  );
  const handleConfirmArchiveClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      clearConfirmingArchive();
      if (thread.persistent) return;
      void attemptArchiveThread(threadRef);
    },
    [attemptArchiveThread, clearConfirmingArchive, thread.persistent, threadRef],
  );
  const handleStartArchiveConfirmation = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (thread.persistent) return;
      setConfirmingArchiveThreadKey(threadKey);
      requestAnimationFrame(() => {
        confirmArchiveButtonRefs.current.get(threadKey)?.focus();
      });
    },
    [confirmArchiveButtonRefs, setConfirmingArchiveThreadKey, thread.persistent, threadKey],
  );
  const handleArchiveImmediateClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (thread.persistent) return;
      void attemptArchiveThread(threadRef);
    },
    [attemptArchiveThread, thread.persistent, threadRef],
  );
  const threadDetailsTooltipHandle = useMemo(() => TooltipPrimitive.createHandle(), []);
  const setFamilyCollapsed = useLegacySidebarFamiliesStore((state) => state.setCollapsed);
  const family = props.familyRow;
  const typedGroups = props.groupingStyle === "typed-groups";
  const subagentLabel =
    thread.lineage.relationshipToParent === "subagent"
      ? `Subagent · ${legacySidebarSubagentStatusLabel(thread, threadStatus)}${family.unavailableParentLabel ? ` · ${family.unavailableParentLabel}` : ""}`
      : null;
  const relationshipLabel = subagentLabel ?? (isAgentCreated ? "Agent-created" : null);
  const relationshipUnavailableLabel =
    family.unavailableParentLabel ??
    family.creatorGroupingWarning ??
    creatorDetails.unavailableLabel;

  return (
    <SidebarMenuSubItem
      ref={rowRef}
      className="w-full mb-1"
      style={{ paddingLeft: 12 + Math.min(family.depth, 6) * 12 }}
      data-thread-item
      {...fileDropHandlers}
      onFocusCapture={() => setThreadRowActive(true)}
      onMouseEnter={() => setThreadRowActive(true)}
      onMouseLeave={handleMouseLeave}
      onBlurCapture={handleBlurCapture}
    >
      <LegacySidebarFamilyGuides depth={family.depth} />
      {/* A thread row is the legacy sidebar's own control (a focusable div that hosts nested
          links and buttons), not a SidebarMenuSubButton, so it owns its look here. */}
      <TooltipTrigger
        handle={threadDetailsTooltipHandle}
        render={<div />}
        role="button"
        tabIndex={0}
        data-active={isActive}
        aria-label={
          relationshipLabel
            ? `${thread.title}, ${relationshipLabel}${creatorDescription ? `, ${creatorDescription}` : ""}${thread.persistent ? ", protected from archive and deletion" : ""}${!family.expanded && family.descendantCount ? `, ${legacySidebarFamilySummary(family)}` : ""}`
            : undefined
        }
        data-slot="sidebar-menu-sub-button"
        data-sidebar="menu-sub-button"
        data-size="sm"
        data-testid={`thread-row-${thread.id}`}
        data-cleanup-pending={isCleanupPending}
        data-file-drag-over={isFileDragOver}
        aria-disabled={isCleanupPending || undefined}
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
                  aria-label={`${family.expanded ? "Collapse" : "Expand"} children of ${thread.title}`}
                  aria-expanded={family.expanded}
                  aria-disabled={family.selectedDescendant || undefined}
                  className={cn(
                    "relative z-30 inline-flex size-4 shrink-0 items-center justify-center rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
                    typedGroups &&
                      !family.expanded &&
                      renamingThreadKey !== threadKey &&
                      "-translate-y-1.5",
                  )}
                  onPointerDown={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (!family.selectedDescendant) setFamilyCollapsed(threadKey, family.expanded);
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
              {family.selectedDescendant
                ? "The selected child keeps this path open"
                : legacySidebarFamilySummary(family)}
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
                    className={`inline-flex items-center justify-center ${prStatus.colorClass} cursor-pointer rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring`}
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
                  data-legacy-sidebar-unscaled-content
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
          {renamingThreadKey === threadKey ? (
            <input
              ref={handleRenameInputRef}
              className="min-w-0 flex-1 truncate rounded border border-ring bg-transparent px-0.5 text-sm outline-none"
              value={renamingTitle}
              onChange={handleRenameInputChange}
              onKeyDown={handleRenameInputKeyDown}
              onBlur={handleRenameInputBlur}
              onClick={handleRenameInputClick}
              onDoubleClick={handleRenameInputClick}
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
                          <span className="hidden @sm/legacy-sidebar:inline">Agent-created</span>
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
                      {legacySidebarSubagentStatusLabel(thread, threadStatus)}
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
                        <TooltipPopup side="top">{legacySidebarFamilySummary(family)}</TooltipPopup>
                      </Tooltip>
                    </>
                  ) : null}
                </span>
                {typedGroups && family.descendantCount > 0 && !family.expanded ? (
                  <span className="flex items-center gap-1 truncate text-3xs leading-3 text-sidebar-muted-foreground">
                    {family.descendantsStatus ? (
                      <ThreadStatusLabel status={family.descendantsStatus} compact />
                    ) : null}
                    <span className="truncate">{legacySidebarFamilySummary(family)}</span>
                  </span>
                ) : null}
              </span>
              <ThreadDashboardIndicator items={thread.dashboardItems} />
            </>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {cleanup === null && discoveredPorts.length > 0 ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={`Open localhost:${discoveredPorts[0]?.port ?? ""}`}
                    className="inline-flex cursor-pointer items-center justify-center text-success-foreground outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
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
                  "calc(var(--spacing) * var(--legacy-sidebar-content-zoom))",
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
                            aria-label={threadEnvironmentLabel ?? "Remote"}
                            className={`inline-flex shrink-0 items-center justify-center ${
                              isConfirmingArchive ? "invisible" : ""
                            }`}
                            data-legacy-sidebar-unscaled-content
                          />
                        }
                      >
                        <ConnectedEnvironmentIcon
                          environmentId={thread.environmentId}
                          context="legacy-row"
                          color={environmentIconColor}
                          className="size-3"
                        />
                      </TooltipTrigger>
                      <TooltipPopup side="top">{threadEnvironmentLabel}</TooltipPopup>
                    </Tooltip>
                  ) : null}
                </span>
              </>
            ) : null}
            {isConfirmingArchive && !thread.persistent ? (
              <button
                ref={handleConfirmArchiveRef}
                type="button"
                data-thread-selection-safe
                data-testid={`thread-archive-confirm-${thread.id}`}
                aria-label={`Confirm archive ${thread.title}`}
                className="absolute top-1/2 right-1 inline-flex h-5 -translate-y-1/2 cursor-pointer items-center rounded-md bg-destructive/12 px-2 text-3xs font-medium text-destructive transition-colors hover:bg-destructive/18 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-destructive/40"
                onPointerDown={stopPropagationOnPointerDown}
                onClick={handleConfirmArchiveClick}
              >
                Confirm
              </button>
            ) : !thread.persistent && !isThreadRunning && cleanup === null ? (
              appSettingsConfirmThreadArchive ? (
                <div className="pointer-events-none absolute top-1/2 right-0.5 -translate-y-1/2 opacity-0 transition-opacity duration-150 max-sm:pointer-events-auto max-sm:opacity-100 group-hover/menu-sub-item:pointer-events-auto group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:pointer-events-auto group-focus-within/menu-sub-item:opacity-100">
                  <button
                    type="button"
                    data-thread-selection-safe
                    data-testid={`thread-archive-${thread.id}`}
                    aria-label={`Archive ${thread.title}`}
                    className={SIDEBAR_ICON_ACTION_BUTTON_CLASS}
                    onPointerDown={stopPropagationOnPointerDown}
                    onClick={handleStartArchiveConfirmation}
                  >
                    <ArchiveIcon className="size-3.5" />
                  </button>
                </div>
              ) : (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <div className="pointer-events-none absolute top-1/2 right-0.5 -translate-y-1/2 opacity-0 transition-opacity duration-150 max-sm:pointer-events-auto max-sm:opacity-100 group-hover/menu-sub-item:pointer-events-auto group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:pointer-events-auto group-focus-within/menu-sub-item:opacity-100">
                        <button
                          type="button"
                          data-thread-selection-safe
                          data-testid={`thread-archive-${thread.id}`}
                          aria-label={`Archive ${thread.title}`}
                          className={SIDEBAR_ICON_ACTION_BUTTON_CLASS}
                          onPointerDown={stopPropagationOnPointerDown}
                          onClick={handleArchiveImmediateClick}
                        >
                          <ArchiveIcon className="size-3.5" />
                        </button>
                      </div>
                    }
                  />
                  <TooltipPopup side="top">Archive</TooltipPopup>
                </Tooltip>
              )
            ) : null}
            <span
              className={threadMetaClassName}
              data-thread-metadata-column="timestamp"
              data-thread-metadata-mode={jumpLabel ? "jump" : "timestamp"}
            >
              <span className="inline-flex items-center gap-1">
                {jumpLabel ? (
                  hasActiveAnnotation && annotation ? (
                    <ThreadAnnotationHoverPopover
                      annotation={annotation}
                      cwd={gitCwd ?? undefined}
                      onBodyChange={(body) => onSaveAnnotationBody(thread, body)}
                      onEdit={() => onEditAnnotation(thread)}
                      onResolve={() => onResolveAnnotation(thread)}
                      rowActive={threadRowActive}
                      threadDetails={threadHoverDetails}
                      trailingContent={cleanupHoverDetails}
                      threadRef={threadRef}
                      trigger={
                        <span
                          aria-label={`${jumpLabel}; annotated`}
                          className="inline-flex h-5 items-center rounded-full border border-dotted border-warning bg-warning/10 px-1.5 font-mono text-3xs font-medium tracking-tight text-warning-foreground shadow-sm"
                        >
                          {jumpLabel}
                        </span>
                      }
                    />
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
                  <ThreadAnnotationHoverPopover
                    annotation={annotation}
                    cwd={gitCwd ?? undefined}
                    onBodyChange={(body) => onSaveAnnotationBody(thread, body)}
                    onEdit={() => onEditAnnotation(thread)}
                    onResolve={() => onResolveAnnotation(thread)}
                    rowActive={threadRowActive}
                    threadDetails={threadHoverDetails}
                    trailingContent={cleanupHoverDetails}
                    threadRef={threadRef}
                    trigger={
                      <span
                        className={`border-b border-dotted border-warning text-3xs tabular-nums ${
                          isHighlighted ? "text-foreground" : "text-secondary-label"
                        }`}
                        data-legacy-sidebar-unscaled-content
                      >
                        {formatRelativeTimeLabel(
                          thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
                        )}
                      </span>
                    }
                  />
                ) : (
                  <span
                    className={`text-3xs tabular-nums ${
                      isHighlighted ? "text-foreground" : "text-secondary-label"
                    }`}
                    data-legacy-sidebar-unscaled-content
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
      </TooltipTrigger>
      <Tooltip
        disabled={hasActiveAnnotation}
        handle={threadDetailsTooltipHandle}
        open={!hasActiveAnnotation && threadRowActive}
        onOpenChange={handleThreadDetailsTooltipOpenChange}
      >
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
  legacySidebarScale: LegacySidebarScale;
  compactStatusIndicators: boolean;
  showWorktreeIndicators: boolean;
  scaleStyle: CSSProperties;
  providerEntriesByEnvironmentId: ReadonlyMap<string, ReadonlyMap<string, ProviderInstanceEntry>>;
  environmentIconColors: Readonly<Record<string, EnvironmentIconColor>>;
  showLocalEnvironmentIcon: boolean;
  projectCwd: string | null;
  projectKey: string;
  projectExpanded: boolean;
  hasOverflowingThreads: boolean;
  hiddenThreadStatus: ThreadStatusPill | null;
  orderedProjectThreadKeys: readonly string[];
  renderedItems: readonly LegacySidebarFamilyItem[];
  showEmptyThreadState: boolean;
  shouldShowThreadPanel: boolean;
  isThreadListExpanded: boolean;
  activeRouteThreadKey: string | null;
  openPullRequestsInRightPanel: boolean;
  threadJumpLabelByKey: ReadonlyMap<string, string>;
  appSettingsConfirmThreadArchive: boolean;
  renamingThreadKey: string | null;
  renamingTitle: string;
  setRenamingTitle: (title: string) => void;
  startThreadRename: (threadKey: string, title: string) => void;
  renamingInputRef: React.RefObject<HTMLInputElement | null>;
  renamingCommittedRef: React.RefObject<boolean>;
  confirmingArchiveThreadKey: string | null;
  setConfirmingArchiveThreadKey: React.Dispatch<React.SetStateAction<string | null>>;
  confirmArchiveButtonRefs: React.RefObject<Map<string, HTMLButtonElement>>;
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
  commitRename: (
    threadRef: ScopedThreadRef,
    newTitle: string,
    originalTitle: string,
  ) => Promise<void>;
  cancelRename: () => void;
  attemptArchiveThread: (threadRef: ScopedThreadRef) => Promise<void>;
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
    legacySidebarScale,
    compactStatusIndicators,
    showWorktreeIndicators,
    scaleStyle,
    providerEntriesByEnvironmentId,
    environmentIconColors,
    showLocalEnvironmentIcon,
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
    appSettingsConfirmThreadArchive,
    renamingThreadKey,
    renamingTitle,
    setRenamingTitle,
    startThreadRename,
    renamingInputRef,
    renamingCommittedRef,
    confirmingArchiveThreadKey,
    setConfirmingArchiveThreadKey,
    confirmArchiveButtonRefs,
    attachThreadListAutoAnimateRef,
    handleThreadClick,
    navigateToThread,
    onFileDropThreads,
    handleMultiSelectContextMenu,
    handleThreadContextMenu,
    clearSelection,
    commitRename,
    cancelRename,
    attemptArchiveThread,
    openPrLink,
    onEditAnnotation,
    onSaveAnnotationBody,
    onResolveAnnotation,
    expandThreadListForProject,
    collapseThreadListForProject,
  } = props;
  const showMoreButtonRender = useMemo(() => <button type="button" />, []);
  const showLessButtonRender = useMemo(() => <button type="button" />, []);
  const setFamilyCollapsed = useLegacySidebarFamiliesStore((state) => state.setCollapsed);

  return (
    <ul
      ref={attachThreadListAutoAnimateRef}
      className="@container/legacy-sidebar relative flex min-w-0 flex-col before:pointer-events-none before:absolute before:inset-y-0 before:left-2 before:border-l before:border-sidebar-border group-data-[collapsible=icon]:hidden"
      data-sidebar="menu-sub"
      data-slot="sidebar-menu-sub"
      data-legacy-sidebar-scale={legacySidebarScale}
      style={{ ...scaleStyle, marginLeft: "calc(8px * var(--legacy-sidebar-content-zoom) - 8px)" }}
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
                <LegacySidebarFamilyGuides depth={item.depth} />
                <button
                  type="button"
                  aria-label={`${item.expanded ? "Collapse" : "Expand"} subagents of ${item.parentTitle}${!item.expanded && item.status ? ` · ${item.status.label}` : ""}`}
                  aria-expanded={item.expanded}
                  className="flex h-8 w-full items-center gap-1 rounded-md pr-2 text-3xs text-sidebar-muted-foreground uppercase hover:bg-sidebar-row-hover focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                  style={{ paddingLeft: 12 + Math.min(item.depth, 6) * 12 }}
                  onClick={() => {
                    if (!item.selectedDescendant) setFamilyCollapsed(item.key, item.expanded);
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
                  <LegacySidebarFamilyGuides depth={familyRow.depth} />
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
                configuredEnvironmentIconColor={environmentIconColors[thread.environmentId]}
                projectCwd={projectCwd}
                providerEntriesByEnvironmentId={providerEntriesByEnvironmentId}
                orderedProjectThreadKeys={orderedProjectThreadKeys}
                isActive={activeRouteThreadKey === threadKey}
                openPullRequestsInRightPanel={openPullRequestsInRightPanel}
                jumpLabel={threadJumpLabelByKey.get(threadKey) ?? null}
                appSettingsConfirmThreadArchive={appSettingsConfirmThreadArchive}
                renamingThreadKey={renamingThreadKey}
                renamingTitle={renamingTitle}
                setRenamingTitle={setRenamingTitle}
                startThreadRename={startThreadRename}
                renamingInputRef={renamingInputRef}
                renamingCommittedRef={renamingCommittedRef}
                confirmingArchiveThreadKey={confirmingArchiveThreadKey}
                setConfirmingArchiveThreadKey={setConfirmingArchiveThreadKey}
                confirmArchiveButtonRefs={confirmArchiveButtonRefs}
                handleThreadClick={handleThreadClick}
                navigateToThread={navigateToThread}
                onFileDropThreads={onFileDropThreads}
                handleMultiSelectContextMenu={handleMultiSelectContextMenu}
                handleThreadContextMenu={handleThreadContextMenu}
                clearSelection={clearSelection}
                commitRename={commitRename}
                cancelRename={cancelRename}
                attemptArchiveThread={attemptArchiveThread}
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
  legacySidebarScale: LegacySidebarScale;
  compactStatusIndicators: boolean;
  showWorktreeIndicators: boolean;
  scaleStyle: CSSProperties;
  providerEntriesByEnvironmentId: ReadonlyMap<string, ReadonlyMap<string, ProviderInstanceEntry>>;
  desktopLocalEnvironmentIds: ReadonlySet<EnvironmentId>;
  knownEnvironmentIds: ReadonlySet<EnvironmentId>;
  environmentIconColors: Readonly<Record<string, EnvironmentIconColor>>;
  showLocalEnvironmentIcon: boolean;
  project: SidebarProjectSnapshot;
  isThreadListExpanded: boolean;
  activeRouteThreadKey: string | null;
  openPullRequestsInRightPanel: boolean;
  newThreadShortcutLabel: string | null;
  handleNewThread: ReturnType<typeof useNewThreadHandler>;
  archiveThread: ReturnType<typeof useThreadActions>["archiveThread"];
  deleteThread: ReturnType<typeof useThreadActions>["deleteThread"];
  setThreadPersistence: ReturnType<typeof useThreadActions>["setThreadPersistence"];
  markThreadUnread: ReturnType<typeof useThreadActions>["markThreadUnread"];
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
    legacySidebarScale,
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
    archiveThread,
    deleteThread,
    markThreadUnread,
    setThreadPersistence,
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
  const handoffsMenuLimit = useClientSettings((s) => s.handoffsMenuLimit);
  const openHandoff = useOpenHandoff();
  const groupingStyle = useClientSettings((settings) => settings.legacySidebarThreadGroupingStyle);
  const threadSortOrder = useClientSettings<SidebarThreadSortOrder>(
    (settings) => settings.sidebarThreadSortOrder,
  );
  const appSettingsConfirmThreadDelete = useClientSettings<boolean>(
    (settings) => settings.confirmThreadDelete,
  );
  const appSettingsConfirmThreadArchive = useClientSettings<boolean>(
    (settings) => settings.confirmThreadArchive,
  );
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isNoProjectGroup = project.projectKey === NO_PROJECT_GROUP_KEY;
  const projectSettingsKey = resolveSidebarProjectSettingsKey({
    sidebarProjectKey: project.projectKey,
    targetProject: project,
    settings: projectGroupingSettings,
  });
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
  const deleteProject = useAtomCommand(projectEnvironment.delete, {
    reportFailure: false,
  });
  const updateProject = useAtomCommand(projectEnvironment.update, {
    reportFailure: false,
  });
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const upsertThreadAnnotation = useAtomCommand(threadEnvironment.upsertAnnotation, {
    reportFailure: false,
  });
  const resolveThreadAnnotation = useAtomCommand(threadEnvironment.resolveAnnotation, {
    reportFailure: false,
  });
  const stopThreadProcesses = useStopThreadProcesses();
  const updateSettings = useUpdateClientSettings();
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
  const removeFromSelection = useThreadSelectionStore((state) => state.removeFromSelection);
  const setSelectionAnchor = useThreadSelectionStore((state) => state.setAnchor);
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{
    threadId: ThreadId;
  }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Thread ID copied",
        description: ctx.threadId,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy thread ID",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{
    path: string;
  }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Path copied",
        description: ctx.path,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
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
  const [renamingThreadKey, setRenamingThreadKey] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const [confirmingArchiveThreadKey, setConfirmingArchiveThreadKey] = useState<string | null>(null);
  const [annotationEditorTarget, setAnnotationEditorTarget] = useState<SidebarThreadSummary | null>(
    null,
  );
  const [projectRenameTarget, setProjectRenameTarget] = useState<SidebarProjectGroupMember | null>(
    null,
  );
  const [projectRenameTitle, setProjectRenameTitle] = useState("");
  const [projectGroupingTarget, setProjectGroupingTarget] =
    useState<SidebarProjectGroupMember | null>(null);
  const [projectGroupingSelection, setProjectGroupingSelection] = useState<
    SidebarProjectGroupingMode | "inherit"
  >("inherit");
  const renamingCommittedRef = useRef(false);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);
  const confirmArchiveButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const memberProjectByScopedKey = useMemo(
    () =>
      new Map(
        project.memberProjects.map((member) => [
          scopedProjectKey(scopeProjectRef(member.environmentId, member.id)),
          member,
        ]),
      ),
    [project.memberProjects],
  );
  const memberThreadCountByPhysicalKey = useMemo(() => {
    const counts = new Map<string, number>(
      project.memberProjects.map((member) => [member.physicalProjectKey, 0] as const),
    );
    for (const thread of projectThreads) {
      const member = memberProjectByScopedKey.get(
        scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
      );
      if (!member) {
        continue;
      }
      counts.set(member.physicalProjectKey, (counts.get(member.physicalProjectKey) ?? 0) + 1);
    }
    return counts;
  }, [memberProjectByScopedKey, project.memberProjects, projectThreads]);

  const projectThreadKeys = useMemo(
    () =>
      [...sidebarThreadByKey.keys()].flatMap((key) => [key, legacySidebarSubagentGroupKey(key)]),
    [sidebarThreadByKey],
  );
  const collapsedFamiliesByKey = useCollapsedLegacySidebarFamilies(projectThreadKeys);
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
    const familyProjection = projectLegacySidebarFamilies({
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
    setProjectRenameTarget(member);
    setProjectRenameTitle(member.title);
  }, []);

  const openProjectGroupingDialog = useCallback(
    (member: SidebarProjectGroupMember) => {
      const overrideKey = deriveProjectGroupingOverrideKey(member);
      setProjectGroupingTarget(member);
      setProjectGroupingSelection(
        projectGroupingSettings.sidebarProjectGroupingOverrides?.[overrideKey] ?? "inherit",
      );
    },
    [projectGroupingSettings.sidebarProjectGroupingOverrides],
  );

  const removeProject = useCallback(
    async (member: SidebarProjectGroupMember) => {
      const memberProjectRef = scopeProjectRef(member.environmentId, member.id);
      const result = await deleteProject({
        environmentId: member.environmentId,
        input: {
          projectId: member.id,
          force: true,
        },
      });
      if (result._tag === "Failure") {
        return result;
      }
      const draftStore = useComposerDraftStore.getState();
      releaseProjectDraftUploads(
        memberProjectRef,
        sidebarThreads
          .filter(
            (thread) =>
              thread.environmentId === member.environmentId && thread.projectId === member.id,
          )
          .map((thread) => scopeThreadRef(thread.environmentId, thread.id)),
      );
      const projectDraftThread = draftStore.getDraftThreadByProjectRef(memberProjectRef);
      if (projectDraftThread) {
        draftStore.clearDraftThread(projectDraftThread.draftId);
      }
      draftStore.clearProjectDraftThreadId(memberProjectRef);
      return result;
    },
    [deleteProject, sidebarThreads],
  );

  const handleRemoveProject = useCallback(
    async (member: SidebarProjectGroupMember) => {
      const api = readLocalApi();
      if (!api) {
        return;
      }

      if (
        projectsContainPersistentThread({
          members: [member],
          threads: Array.from(sidebarThreadByKeyRef.current.values()),
        })
      ) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Persistent thread protected",
            description:
              "Disable persistence or move it to another thread before removing this project.",
          }),
        );
        return;
      }

      const memberProjectRef = scopeProjectRef(member.environmentId, member.id);
      const memberThreadCount = memberThreadCountByPhysicalKey.get(member.physicalProjectKey) ?? 0;
      if (memberThreadCount > 0) {
        const warningToastId = toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Project is not empty",
            description: "Delete all threads in this project before removing it.",
            actionVariant: "destructive",
            actionProps: {
              children: "Delete anyway",
              onClick: () => {
                void (async () => {
                  toastManager.close(warningToastId);
                  await new Promise<void>((resolve) => {
                    window.setTimeout(resolve, 180);
                  });

                  const latestProjectThreads = Array.from(
                    sidebarThreadByKeyRef.current.values(),
                  ).filter(
                    (thread) =>
                      thread.environmentId === memberProjectRef.environmentId &&
                      thread.projectId === memberProjectRef.projectId,
                  );
                  const confirmed = await api.dialogs.confirm(
                    latestProjectThreads.length > 0
                      ? [
                          `Remove project "${member.title}" and delete its ${latestProjectThreads.length} thread${
                            latestProjectThreads.length === 1 ? "" : "s"
                          }?`,
                          `Path: ${member.workspaceRoot}`,
                          ...(member.environmentLabel
                            ? [`Environment: ${member.environmentLabel}`]
                            : []),
                          "This permanently clears conversation history for those threads and any archived threads.",
                          "This removes only this project entry.",
                          "This action cannot be undone.",
                        ].join("\n")
                      : [
                          `Remove project "${member.title}"?`,
                          `Path: ${member.workspaceRoot}`,
                          ...(member.environmentLabel
                            ? [`Environment: ${member.environmentLabel}`]
                            : []),
                          "This permanently clears any archived conversation history.",
                          "This removes only this project entry.",
                        ].join("\n"),
                    { variant: "destructive" },
                  );
                  if (!confirmed) {
                    return;
                  }

                  const result = await removeProject(member);
                  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                    const error = squashAtomCommandFailure(result);
                    toastManager.add(
                      stackedThreadToast({
                        type: "error",
                        title: `Failed to remove "${member.title}"`,
                        description:
                          error instanceof Error
                            ? error.message
                            : "Unknown error removing project.",
                      }),
                    );
                  }
                })().catch((error) => {
                  const message =
                    error instanceof Error ? error.message : "Unknown error removing project.";
                  console.error("Failed to remove project", {
                    projectId: member.id,
                    environmentId: member.environmentId,
                    ...safeErrorLogAttributes(error),
                  });
                  toastManager.add(
                    stackedThreadToast({
                      type: "error",
                      title: `Failed to remove "${member.title}"`,
                      description: message,
                    }),
                  );
                });
              },
            },
          }),
        );
        return;
      }

      const message = [
        `Remove project "${member.title}"?`,
        `Path: ${member.workspaceRoot}`,
        ...(member.environmentLabel ? [`Environment: ${member.environmentLabel}`] : []),
        "This permanently clears any archived conversation history.",
        "This removes only this project entry.",
      ].join("\n");
      const confirmed = await api.dialogs.confirm(message, { variant: "destructive" });
      if (!confirmed) {
        return;
      }

      const result = await removeProject(member);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        const message = error instanceof Error ? error.message : "Unknown error removing project.";
        console.error("Failed to remove project", {
          projectId: member.id,
          environmentId: member.environmentId,
          ...safeErrorLogAttributes(error),
        });
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Failed to remove "${member.title}"`,
            description: message,
          }),
        );
      }
    },
    [memberThreadCountByPhysicalKey, removeProject],
  );

  const handleProjectButtonContextMenu = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      suppressProjectClickForContextMenuRef.current = true;
      void (async () => {
        const api = readLocalApi();
        if (!api) return;

        const actionHandlers = new Map<string, () => Promise<void> | void>();
        const isProjectRemovalBlocked = (member: SidebarProjectGroupMember) =>
          projectsContainPersistentThread({ members: [member], threads: sidebarThreads });
        const makeLeaf = (
          action: "rename" | "grouping" | "copy-path" | "delete",
          member: SidebarProjectGroupMember,
          options?: {
            destructive?: boolean;
            disabled?: boolean;
          },
        ): ContextMenuItem<string> => {
          const id = `${action}:${member.physicalProjectKey}`;
          actionHandlers.set(id, () => {
            switch (action) {
              case "rename":
                openProjectRenameDialog(member);
                return;
              case "grouping":
                openProjectGroupingDialog(member);
                return;
              case "copy-path":
                copyPathToClipboard(member.workspaceRoot, { path: member.workspaceRoot });
                return;
              case "delete":
                return handleRemoveProject(member);
            }
          });

          return {
            id,
            label: `${formatProjectMemberActionLabel(member, project.groupedProjectCount)}${
              action === "delete" && options?.disabled ? " (disable persistence first)" : ""
            }`,
            ...(options?.destructive ? { destructive: true } : {}),
            ...(options?.disabled ? { disabled: true } : {}),
          };
        };

        const buildTargetedItem = (
          action: "rename" | "grouping" | "copy-path" | "delete",
          label: string,
          options?: {
            destructive?: boolean;
            isDisabled?: (member: SidebarProjectGroupMember) => boolean;
          },
        ): ContextMenuItem<string> => {
          if (project.memberProjects.length === 1) {
            const singleMember = project.memberProjects[0]!;
            return {
              ...makeLeaf(action, singleMember, {
                ...(options?.destructive ? { destructive: true } : {}),
                ...(options?.isDisabled?.(singleMember) ? { disabled: true } : {}),
              }),
              label,
              ...(action === "delete" ? { icon: "trash" } : {}),
            };
          }

          return {
            id: `${action}:submenu`,
            label,
            ...(action === "delete" ? { icon: "trash" } : {}),
            children: project.memberProjects.map((member) =>
              makeLeaf(action, member, {
                ...(options?.destructive ? { destructive: true } : {}),
                ...(options?.isDisabled?.(member) ? { disabled: true } : {}),
              }),
            ),
          };
        };

        actionHandlers.set("open-dashboard", () => {
          if (isMobile) setOpenMobile(false);
          void router.navigate({
            to: "/dashboard",
            search: { environmentId: project.environmentId, projectId: project.id },
          });
        });

        actionHandlers.set("project-settings", () => {
          if (isMobile) setOpenMobile(false);
          void router.navigate({
            to: "/projects/$projectKey",
            params: { projectKey: projectSettingsKey },
          });
        });

        const clicked = await api.contextMenu.show(
          [
            ...(isNoProjectGroup
              ? []
              : [
                  buildTargetedItem("rename", "Rename"),
                  buildTargetedItem("grouping", "Group into..."),
                ]),
            buildTargetedItem("copy-path", "Copy Path"),
            { id: "open-dashboard", label: "Open dashboard", icon: "layout-dashboard" },
            { id: "project-settings", label: "Project settings", icon: "settings" },
            buildTargetedItem(
              "delete",
              project.memberProjects.length === 1 &&
                isProjectRemovalBlocked(project.memberProjects[0]!)
                ? "Remove (disable persistence first)"
                : "Remove",
              {
                destructive: true,
                isDisabled: isProjectRemovalBlocked,
              },
            ),
          ],
          {
            x: event.clientX,
            y: event.clientY,
          },
        );

        if (!clicked) {
          return;
        }

        await actionHandlers.get(clicked)?.();
      })();
    },
    [
      copyPathToClipboard,
      handleRemoveProject,
      isMobile,
      isNoProjectGroup,
      openProjectGroupingDialog,
      openProjectRenameDialog,
      project.groupedProjectCount,
      project.memberProjects,
      project.environmentId,
      project.id,
      projectSettingsKey,
      router,
      setOpenMobile,
      sidebarThreads,
      suppressProjectClickForContextMenuRef,
    ],
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

  const handleMultiSelectContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const threadKeys = [...useThreadSelectionStore.getState().selectedThreadKeys];
      if (threadKeys.length === 0) return;
      const readSelectedThreadEntry = (threadKey: string) => {
        const threadRef = parseScopedThreadKey(threadKey);
        const thread = threadRef ? readThreadShell(threadRef) : null;
        if (!threadRef || !thread || thread.worktreeCleanup != null) return undefined;
        return { threadKey, threadRef, thread };
      };
      const selectedThreadEntries = threadKeys.flatMap((threadKey) => {
        const entry = readSelectedThreadEntry(threadKey);
        return entry ? [entry] : [];
      });
      const count = selectedThreadEntries.length;
      if (count === 0) return;
      const hasRunningThread = selectedThreadEntries.some(
        ({ thread }) => !threadRuntimeCanArchive(thread.runtime),
      );

      const hasPersistentThread = selectedThreadEntries.some(
        ({ thread }) => thread.persistent === true,
      );
      const warnPersistentThreadProtected = () =>
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Persistent thread protected",
            description: "Disable persistence or move it to another thread first.",
          }),
        );
      const clicked = await api.contextMenu.show(
        protectLegacyThreadActions(
          buildMultiSelectThreadContextMenuItems({ count, hasRunningThread }),
          hasPersistentThread,
        ),
        position,
      );

      if (hasPersistentThread && (clicked === "archive" || clicked === "delete")) {
        warnPersistentThreadProtected();
        return;
      }

      if (clicked === "mark-unread") {
        for (const { threadRef } of selectedThreadEntries) {
          markThreadUnread(threadRef);
        }
        clearSelection();
        return;
      }

      if (clicked === "archive") {
        if (appSettingsConfirmThreadArchive) {
          const confirmed = await api.dialogs.confirm(
            `Archive ${count} thread${count === 1 ? "" : "s"}?`,
          );
          if (!confirmed) return;
        }

        const currentEntries = collectUnprotectedBulkThreadEntries({
          threadKeys,
          getEntry: readSelectedThreadEntry,
        });
        if (!currentEntries) {
          warnPersistentThreadProtected();
          return;
        }

        const archiveOutcome = await archiveSelectedThreadEntries({
          entries: currentEntries,
          archive: ({ threadRef }, onArchived) => archiveThread(threadRef, { onArchived }),
        });
        for (const failure of archiveOutcome.followupFailures) {
          if (isAtomCommandInterrupted(failure)) continue;
          const error = squashAtomCommandFailure(failure);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Thread archived, but navigation failed",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        if (archiveOutcome.mutationFailure) {
          removeFromSelection(archiveOutcome.archivedThreadKeys);
          if (!isAtomCommandInterrupted(archiveOutcome.mutationFailure)) {
            const error = squashAtomCommandFailure(archiveOutcome.mutationFailure);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to archive threads",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return;
        }
        removeFromSelection(threadKeys);
        return;
      }

      if (clicked !== "delete") return;

      if (appSettingsConfirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete ${count} thread${count === 1 ? "" : "s"}?`,
            "This permanently clears conversation history for these threads.",
          ].join("\n"),
          { variant: "destructive" },
        );
        if (!confirmed) return;
      }

      const currentEntries = collectUnprotectedBulkThreadEntries({
        threadKeys,
        getEntry: readSelectedThreadEntry,
      });
      if (!currentEntries) {
        warnPersistentThreadProtected();
        return;
      }

      // Only discount batch members after their deletions succeed.
      const deletedThreadKeys = new Set<string>();
      let firstError: unknown = null;
      for (const { threadKey, threadRef } of currentEntries) {
        const result = await deleteThread(threadRef, {
          deletedThreadKeys,
        });
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) break;
          firstError ??= squashAtomCommandFailure(result);
          continue;
        }
        deletedThreadKeys.add(threadKey);
      }
      if (firstError !== null) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to delete threads",
            description: firstError instanceof Error ? firstError.message : "An error occurred.",
          }),
        );
      }
      removeFromSelection(
        getThreadKeysToDeselectAfterDelete(threadKeys, deletedThreadKeys, (threadKey) => {
          const threadRef = parseScopedThreadKey(threadKey);
          return threadRef !== null && readThreadShell(threadRef) !== null;
        }),
      );
    },
    [
      appSettingsConfirmThreadArchive,
      appSettingsConfirmThreadDelete,
      archiveThread,
      clearSelection,
      deleteThread,
      markThreadUnread,
      removeFromSelection,
    ],
  );

  const createThreadForProjectMember = useCallback(
    (member: SidebarProjectGroupMember) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      void (async () => {
        // No options: branch, worktree, and env mode come from the user's
        // configured defaults, never from the currently viewed thread.
        const result = await settlePromise(() =>
          handleNewThread(scopeProjectRef(member.environmentId, member.id)),
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
            project.memberProjects.map((member) => ({
              id: member.physicalProjectKey,
              label: formatProjectMemberActionLabel(member, project.groupedProjectCount),
            })),
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
        const targetMember = project.memberProjects.find(
          (member) => member.physicalProjectKey === clicked,
        );
        if (!targetMember) {
          return;
        }
        createThreadForProjectMember(targetMember);
      })();
    },
    [createThreadForProjectMember, project.groupedProjectCount, project.memberProjects],
  );

  const attemptArchiveThread = useCallback(
    async (threadRef: ScopedThreadRef) => {
      if (readThreadShell(threadRef)?.persistent === true) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Persistent thread not archived",
            description: "Disable persistence or move it to another thread first.",
          }),
        );
        return;
      }
      const result = await archiveThread(threadRef);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to archive thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [archiveThread],
  );

  const cancelRename = useCallback(() => {
    setRenamingThreadKey(null);
    renamingInputRef.current = null;
  }, []);

  const saveAnnotationBody = useCallback(
    async (target: SidebarThreadSummary, body: string): Promise<boolean> => {
      return runThreadAnnotationBodySave(
        scopeThreadRef(target.environmentId, target.id),
        async () => {
          const result = await upsertThreadAnnotation({
            environmentId: target.environmentId,
            input: { threadId: target.id, body },
          });
          if (result._tag === "Success") return true;
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to save annotation",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return false;
        },
      );
    },
    [upsertThreadAnnotation],
  );

  const saveAnnotation = useCallback(
    async (body: string): Promise<boolean> => {
      if (!annotationEditorTarget) return false;
      return saveAnnotationBody(annotationEditorTarget, body);
    },
    [annotationEditorTarget, saveAnnotationBody],
  );

  const resolveAnnotation = useCallback(
    async (thread: SidebarThreadSummary) => {
      const result = await resolveThreadAnnotation({
        environmentId: thread.environmentId,
        input: { threadId: thread.id },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to resolve annotation",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [resolveThreadAnnotation],
  );

  const startThreadRename = useCallback((threadKey: string, title: string) => {
    setRenamingThreadKey(threadKey);
    setRenamingTitle(title);
    renamingCommittedRef.current = false;
  }, []);

  const commitRename = useCallback(
    async (threadRef: ScopedThreadRef, newTitle: string, originalTitle: string) => {
      const threadKey = scopedThreadKey(threadRef);
      const finishRename = () => {
        setRenamingThreadKey((current) => {
          if (current !== threadKey) return current;
          renamingInputRef.current = null;
          return null;
        });
      };

      const trimmed = newTitle.trim();
      if (trimmed.length === 0) {
        toastManager.add({
          type: "warning",
          title: "Thread title cannot be empty",
        });
        finishRename();
        return;
      }
      if (trimmed === originalTitle) {
        finishRename();
        return;
      }
      const result = await updateThreadMetadata({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          title: trimmed,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to rename thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
      finishRename();
    },
    [updateThreadMetadata],
  );

  const closeProjectRenameDialog = useCallback(() => {
    setProjectRenameTarget(null);
    setProjectRenameTitle("");
  }, []);

  const submitProjectRename = useCallback(async () => {
    if (!projectRenameTarget) {
      return;
    }

    const trimmed = projectRenameTitle.trim();
    if (trimmed.length === 0) {
      toastManager.add({
        type: "warning",
        title: "Project title cannot be empty",
      });
      return;
    }

    if (trimmed === projectRenameTarget.title) {
      closeProjectRenameDialog();
      return;
    }

    const result = await updateProject({
      environmentId: projectRenameTarget.environmentId,
      input: {
        projectId: projectRenameTarget.id,
        title: trimmed,
      },
    });
    if (result._tag === "Success") {
      closeProjectRenameDialog();
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to rename project",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  }, [closeProjectRenameDialog, projectRenameTarget, projectRenameTitle, updateProject]);

  const closeProjectGroupingDialog = useCallback(() => {
    setProjectGroupingTarget(null);
    setProjectGroupingSelection("inherit");
  }, []);

  const saveProjectGroupingPreference = useCallback(() => {
    if (!projectGroupingTarget) {
      return;
    }

    const overrideKey = deriveProjectGroupingOverrideKey(projectGroupingTarget);
    const nextOverrides = {
      ...projectGroupingSettings.sidebarProjectGroupingOverrides,
    };
    if (projectGroupingSelection === "inherit") {
      delete nextOverrides[overrideKey];
    } else {
      nextOverrides[overrideKey] = projectGroupingSelection;
    }
    updateSettings({
      sidebarProjectGroupingOverrides: nextOverrides,
    });
    closeProjectGroupingDialog();
  }, [
    closeProjectGroupingDialog,
    projectGroupingSelection,
    projectGroupingSettings.sidebarProjectGroupingOverrides,
    projectGroupingTarget,
    updateSettings,
  ]);

  const handleThreadContextMenu = useCallback(
    async (
      threadRef: ScopedThreadRef,
      position: { x: number; y: number },
      hasStoppableProcesses: boolean,
    ) => {
      const api = readLocalApi();
      if (!api) return;
      const threadKey = scopedThreadKey(threadRef);
      const thread = sidebarThreadByKeyRef.current.get(threadKey) ?? null;
      if (!thread) return;
      const threadProjectRef = scopeProjectRef(thread.environmentId, thread.projectId);
      const threadProject =
        readProject(threadProjectRef) ??
        memberProjectByScopedKey.get(scopedProjectKey(threadProjectRef));
      const threadProjectSettingsKey = threadProject
        ? resolveSidebarProjectSettingsKey({
            sidebarProjectKey: project.projectKey,
            targetProject: threadProject,
            settings: projectGroupingSettings,
          })
        : isNoProjectGroup
          ? null
          : project.projectKey;
      const threadWorkspacePath =
        thread.worktreePath ?? threadProject?.workspaceRoot ?? project.workspaceRoot ?? null;
      const supportsThreadAnnotations = readEnvironmentSupportsThreadAnnotations(
        thread.environmentId,
      );
      const supportsPersistence = readEnvironmentSupportsPersistence(thread.environmentId);
      const persistenceAction = legacyThreadPersistenceAction({
        persistent: thread.persistent === true,
        supported: supportsPersistence,
      });
      const stopProcessesAction = buildStopThreadProcessesMenuItem(hasStoppableProcesses);
      const canAnnotate = supportsThreadAnnotations && thread.latestUserMessageAt !== null;
      const creatorRef = thread.creatorThreadId
        ? scopeThreadRef(thread.environmentId, thread.creatorThreadId)
        : null;
      const creator = creatorRef ? readThreadShell(creatorRef) : null;
      const { groupingEligible: creatorGroupingEligible, canOpen: canOpenCreator } =
        legacySidebarCreatorDetails(thread, creator);
      const handoffs = readThreadHandoffs(threadRef);
      const handoffDescriptors = handoffs.slice(0, handoffsMenuLimit).map(describeHandoff);
      const clicked = await api.contextMenu.show(
        protectLegacyThreadActions(
          withThreadActionMenuDividers([
            ...(thread.branch
              ? [{ id: "new-thread-on-branch", label: `New thread on ${thread.branch}` }]
              : []),
            { id: "rename", label: "Rename thread" },
            ...(canAnnotate ? [{ id: "annotate", label: "Annotate thread…" }] : []),
            { id: "mark-unread", label: "Mark unread" },
            ...(creatorGroupingEligible
              ? [
                  {
                    id:
                      thread.creatorGrouping === "grouped"
                        ? "creator-independent"
                        : "creator-grouped",
                    label:
                      thread.creatorGrouping === "grouped"
                        ? "Show independently"
                        : "Group with creator",
                  },
                ]
              : []),
            ...(canOpenCreator ? [{ id: "open-creator", label: "Open creator thread" }] : []),
            ...(persistenceAction ? [persistenceAction] : []),
            ...(stopProcessesAction ? [stopProcessesAction] : []),
            { id: "copy-path", label: "Copy Path" },
            { id: "copy-thread-id", label: "Copy Thread ID" },
            { id: "open-dashboard", label: "Open dashboard", icon: "layout-dashboard" },
            {
              id: "project-settings",
              label: "Project settings",
              disabled: threadProjectSettingsKey === null,
            },
            { id: "handoffs-heading", label: "Handoffs", disabled: true, separatorBefore: true },
            ...(handoffDescriptors.length
              ? handoffDescriptors.map(({ entry, label }) => ({ id: `handoff:${entry.id}`, label }))
              : [{ id: "handoffs-empty", label: "No handoffs yet", disabled: true }]),
            ...(handoffs.length > handoffDescriptors.length
              ? [{ id: "handoff-show-all", label: "Show all…" }]
              : []),
            {
              id: "delete",
              separatorBefore: true,
              label: "Delete",
              destructive: true,
              icon: "trash",
            },
          ]),
          thread.persistent === true,
        ),
        position,
      );

      if (clicked === "handoff-show-all" || clicked?.startsWith("handoff:")) {
        if (isMobile) setOpenMobile(false);
        await router.navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: thread.environmentId, threadId: thread.id },
        });
        if (clicked === "handoff-show-all")
          useRightPanelStore.getState().open(threadRef, "handoffs");
        else {
          const entry = handoffs.find((candidate) => `handoff:${candidate.id}` === clicked);
          if (entry) await openHandoff(threadRef, entry);
        }
        return;
      }

      if (clicked === "creator-independent" || clicked === "creator-grouped") {
        if (!creatorGroupingEligible) return;
        const result = await updateThreadMetadata({
          environmentId: threadRef.environmentId,
          input: {
            threadId: threadRef.threadId,
            creatorGrouping: clicked === "creator-grouped" ? "grouped" : "independent",
          },
        });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to update creator grouping",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }
      if (clicked === "open-creator" && creatorRef && canOpenCreator) {
        await navigateToThread(creatorRef);
        return;
      }

      if (clicked === "open-dashboard") {
        if (isMobile) setOpenMobile(false);
        void router.navigate({
          to: "/dashboard",
          search: { environmentId: thread.environmentId, projectId: thread.projectId },
        });
        return;
      }

      if (clicked === "project-settings") {
        if (threadProjectSettingsKey === null) return;
        if (isMobile) setOpenMobile(false);
        void router.navigate({
          to: "/projects/$projectKey",
          params: { projectKey: threadProjectSettingsKey },
        });
        return;
      }

      if (clicked === "new-thread-on-branch") {
        // Explicit branch carry-over: reuse the thread's worktree when it
        // has one, otherwise its branch on the local checkout.
        const result = await settlePromise(() =>
          handleNewThread(scopeProjectRef(thread.environmentId, thread.projectId), {
            branch: thread.branch,
            worktreePath: thread.worktreePath,
            envMode: thread.worktreePath ? "worktree" : "local",
            startFromOrigin: false,
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
        return;
      }

      if (clicked === "rename") {
        startThreadRename(threadKey, thread.title);
        return;
      }

      if (clicked === "annotate") {
        setAnnotationEditorTarget(thread);
        return;
      }

      if (clicked === "mark-unread") {
        markThreadUnread(threadRef);
        return;
      }
      if (clicked === "stop-thread-processes") {
        await stopThreadProcesses(threadRef);
        return;
      }
      if (clicked === "mark-persistent" || clicked === "disable-persistence") {
        const result = await setThreadPersistence(threadRef, clicked === "mark-persistent");
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to update persistent thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }
      if (clicked === "copy-path") {
        if (!threadWorkspacePath) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Path unavailable",
              description: "This thread does not have a workspace path to copy.",
            }),
          );
          return;
        }
        copyPathToClipboard(threadWorkspacePath, { path: threadWorkspacePath });
        return;
      }
      if (clicked === "copy-thread-id") {
        copyThreadIdToClipboard(thread.id, { threadId: thread.id });
        return;
      }
      if (clicked !== "delete") return;
      if (thread.persistent) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Persistent thread not deleted",
            description: "Disable persistence or move it to another thread first.",
          }),
        );
        return;
      }
      if (appSettingsConfirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete thread "${thread.title}"?`,
            "This permanently clears conversation history for this thread.",
          ].join("\n"),
          { variant: "destructive" },
        );
        if (!confirmed) {
          return;
        }
      }
      const result = await deleteThread(threadRef);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to delete thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [
      appSettingsConfirmThreadDelete,
      handoffsMenuLimit,
      openHandoff,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      deleteThread,
      handleNewThread,
      isMobile,
      isNoProjectGroup,
      markThreadUnread,
      memberProjectByScopedKey,
      projectGroupingSettings,
      project.projectKey,
      project.workspaceRoot,
      router,
      setOpenMobile,
      setThreadPersistence,
      startThreadRename,
      stopThreadProcesses,
      updateThreadMetadata,
      navigateToThread,
    ],
  );

  return (
    <>
      <div
        className="group/project-header relative"
        data-legacy-sidebar-scale={legacySidebarScale}
        style={{
          ...scaleStyle,
          marginLeft: "calc(8px * var(--legacy-sidebar-content-zoom) - 8px)",
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
                    data-legacy-sidebar-unscaled-content
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
            className="pointer-events-none absolute top-1 right-(--project-environment-inset) inline-flex h-5 translate-x-full items-center gap-(--thread-metadata-gap) rounded-md max-sm:right-[calc(var(--project-environment-inset)+1.5rem*var(--legacy-sidebar-content-zoom)+var(--thread-metadata-gap))]"
            style={
              {
                "--project-environment-inset":
                  "calc(0.5rem + 3.75rem * var(--legacy-sidebar-content-zoom) + var(--thread-metadata-gap))",
                "--thread-metadata-gap":
                  "calc(var(--spacing) * var(--legacy-sidebar-content-zoom))",
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
                        data-legacy-sidebar-unscaled-content
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
                      data-legacy-sidebar-unscaled-content
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
        legacySidebarScale={legacySidebarScale}
        compactStatusIndicators={compactStatusIndicators}
        showWorktreeIndicators={showWorktreeIndicators}
        scaleStyle={scaleStyle}
        providerEntriesByEnvironmentId={providerEntriesByEnvironmentId}
        environmentIconColors={props.environmentIconColors}
        showLocalEnvironmentIcon={props.showLocalEnvironmentIcon}
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
        appSettingsConfirmThreadArchive={appSettingsConfirmThreadArchive}
        renamingThreadKey={renamingThreadKey}
        renamingTitle={renamingTitle}
        setRenamingTitle={setRenamingTitle}
        startThreadRename={startThreadRename}
        renamingInputRef={renamingInputRef}
        renamingCommittedRef={renamingCommittedRef}
        confirmingArchiveThreadKey={confirmingArchiveThreadKey}
        setConfirmingArchiveThreadKey={setConfirmingArchiveThreadKey}
        confirmArchiveButtonRefs={confirmArchiveButtonRefs}
        attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
        handleThreadClick={handleThreadClick}
        navigateToThread={navigateToThread}
        onFileDropThreads={handleThreadFileDrop}
        handleMultiSelectContextMenu={handleMultiSelectContextMenu}
        handleThreadContextMenu={handleThreadContextMenu}
        clearSelection={clearSelection}
        commitRename={commitRename}
        cancelRename={cancelRename}
        attemptArchiveThread={attemptArchiveThread}
        openPrLink={openPrLink}
        onEditAnnotation={setAnnotationEditorTarget}
        onSaveAnnotationBody={saveAnnotationBody}
        onResolveAnnotation={(thread) => void resolveAnnotation(thread)}
        expandThreadListForProject={expandThreadListForProject}
        collapseThreadListForProject={collapseThreadListForProject}
      />

      <ThreadAnnotationEditorDialog
        annotation={annotationEditorTarget?.annotation ?? null}
        open={annotationEditorTarget !== null}
        onOpenChange={(open) => {
          if (!open) setAnnotationEditorTarget(null);
        }}
        onSave={saveAnnotation}
      />

      <Dialog
        open={projectRenameTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeProjectRenameDialog();
          }
        }}
      >
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Rename project</DialogTitle>
            <DialogDescription>
              {projectRenameTarget
                ? `Update the title for ${projectRenameTarget.workspaceRoot}.`
                : "Update the project title."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Project title</span>
              <Input
                aria-label="Project title"
                value={projectRenameTitle}
                onChange={(event) => setProjectRenameTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void submitProjectRename();
                  }
                }}
              />
            </div>
            {projectRenameTarget?.environmentLabel ? (
              <p className="text-xs text-muted-foreground">
                Environment: {projectRenameTarget.environmentLabel}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={closeProjectRenameDialog}>
              Cancel
            </Button>
            <Button onClick={() => void submitProjectRename()}>Save</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={projectGroupingTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeProjectGroupingDialog();
          }
        }}
      >
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Project grouping</DialogTitle>
            <DialogDescription>
              {projectGroupingTarget
                ? `Choose how ${projectGroupingTarget.workspaceRoot} should be grouped in the sidebar.`
                : "Choose how this project should be grouped in the sidebar."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Grouping rule</span>
              <Select
                value={projectGroupingSelection}
                onValueChange={(value) => {
                  if (
                    value === "inherit" ||
                    value === "repository" ||
                    value === "repository_path" ||
                    value === "separate"
                  ) {
                    setProjectGroupingSelection(value);
                  }
                }}
              >
                <SelectTrigger className="w-full" aria-label="Project grouping rule">
                  <SelectValue>
                    {projectGroupingSelection === "inherit"
                      ? `Use global default (${PROJECT_GROUPING_MODE_LABELS[projectGroupingSettings.sidebarProjectGroupingMode]})`
                      : PROJECT_GROUPING_MODE_LABELS[projectGroupingSelection]}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="inherit">
                    Use global default
                  </SelectItem>
                  <SelectItem hideIndicator value="repository">
                    {PROJECT_GROUPING_MODE_LABELS.repository}
                  </SelectItem>
                  <SelectItem hideIndicator value="repository_path">
                    {PROJECT_GROUPING_MODE_LABELS.repository_path}
                  </SelectItem>
                  <SelectItem hideIndicator value="separate">
                    {PROJECT_GROUPING_MODE_LABELS.separate}
                  </SelectItem>
                </SelectPopup>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground">
              {projectGroupingSelection === "inherit"
                ? projectGroupingModeDescription(projectGroupingSettings.sidebarProjectGroupingMode)
                : projectGroupingModeDescription(projectGroupingSelection)}
            </p>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={closeProjectGroupingDialog}>
              Cancel
            </Button>
            <Button onClick={saveProjectGroupingPreference}>Save</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
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

function LocalSecondaryStatus() {
  const { environments } = useEnvironments();
  // The desktop reports which local secondary backends (e.g. the WSL backend)
  // exist; the hook polls because the bridge has no change event. A backend that
  // is still cold-booting has no httpBaseUrl yet and isn't in the catalog, so we
  // surface "Connecting" straight from the bootstrap list and clear it once the
  // matching environment reports a connected phase.
  const secondaries = useDesktopLocalBootstraps();

  // Connected desktop-local environments keyed by their backend URL so we can
  // match a bootstrap (which only knows the URL) to its connection phase.
  const localEnvByUrl = useMemo(() => {
    const map = new Map<string, { phase: string; error: string | null }>();
    for (const environment of environments) {
      if (
        isDesktopLocalConnectionTarget(environment.entry.target) &&
        environment.displayUrl !== null
      ) {
        map.set(environment.displayUrl, {
          phase: environment.connection.phase,
          error: environment.connection.error,
        });
      }
    }
    return map;
  }, [environments]);

  const connecting: string[] = [];
  const failed: Array<{ label: string; error: string | null }> = [];
  for (const bootstrap of secondaries) {
    const env =
      bootstrap.httpBaseUrl !== null ? localEnvByUrl.get(bootstrap.httpBaseUrl) : undefined;
    if (env?.phase === "connected") {
      continue;
    }
    if (env?.phase === "error") {
      failed.push({ label: bootstrap.label, error: env.error });
      continue;
    }
    connecting.push(bootstrap.label);
  }

  if (connecting.length === 0 && failed.length === 0) {
    return null;
  }

  return (
    <SidebarGroup>
      {connecting.length > 0 ? (
        <Alert variant="sidebar">
          <Spinner />
          <AlertTitle>Connecting {connecting.join(", ")}</AlertTitle>
        </Alert>
      ) : null}
      {failed.length > 0 ? (
        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertTitle>Couldn't connect {failed.map((entry) => entry.label).join(", ")}</AlertTitle>
          <AlertDescription>
            {failed
              .map((entry) => entry.error)
              .filter(Boolean)
              .join("; ") || "The backend didn't respond."}
          </AlertDescription>
        </Alert>
      ) : null}
    </SidebarGroup>
  );
}

type SortableProjectHandleProps = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners" | "setActivatorNodeRef"
>;

function ProjectSortMenu({
  projectSortOrder,
  threadSortOrder,
  threadPreviewCount,
  onProjectSortOrderChange,
  onThreadSortOrderChange,
  onThreadPreviewCountChange,
}: {
  projectSortOrder: SidebarProjectSortOrder;
  threadSortOrder: SidebarThreadSortOrder;
  threadPreviewCount: SidebarThreadPreviewCount;
  onProjectSortOrderChange: (sortOrder: SidebarProjectSortOrder) => void;
  onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
  onThreadPreviewCountChange: (count: SidebarThreadPreviewCount) => void;
}) {
  const handleThreadPreviewCountChange = useCallback(
    (nextValue: number | null) => {
      if (nextValue === null) {
        return;
      }

      const clampedValue = clampSidebarThreadPreviewCount(nextValue);
      if (clampedValue !== threadPreviewCount) {
        onThreadPreviewCountChange(clampedValue);
      }
    },
    [onThreadPreviewCountChange, threadPreviewCount],
  );

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={<Button size="icon-xs" variant="ghost-muted" aria-label="Sidebar options" />}
            />
          }
        >
          <ArrowUpDownIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="right">Sidebar options</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom">
        <MenuGroup>
          <div className="px-2 py-1 sm:text-xs font-medium text-muted-foreground">
            Sort projects
          </div>
          <MenuRadioGroup
            value={projectSortOrder}
            onValueChange={(value) => {
              onProjectSortOrderChange(value as SidebarProjectSortOrder);
            }}
          >
            {(Object.entries(SIDEBAR_SORT_LABELS) as Array<[SidebarProjectSortOrder, string]>).map(
              ([value, label]) => (
                <MenuRadioItem key={value} value={value}>
                  {label}
                </MenuRadioItem>
              ),
            )}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuGroup>
          <div className="px-2 pt-2 pb-1 sm:text-xs font-medium text-muted-foreground">
            Sort threads
          </div>
          <MenuRadioGroup
            value={threadSortOrder}
            onValueChange={(value) => {
              onThreadSortOrderChange(value as SidebarThreadSortOrder);
            }}
          >
            {(
              Object.entries(SIDEBAR_THREAD_SORT_LABELS) as Array<[SidebarThreadSortOrder, string]>
            ).map(([value, label]) => (
              <MenuRadioItem key={value} value={value}>
                {label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuGroup>
          <div className="px-2 pt-2 pb-1 text-muted-foreground sm:text-xs font-medium">
            Visible threads
          </div>
          <div className="px-2 py-1">
            <NumberField
              aria-label="Visible thread count"
              className="w-28"
              max={MAX_SIDEBAR_THREAD_PREVIEW_COUNT}
              min={MIN_SIDEBAR_THREAD_PREVIEW_COUNT}
              onValueChange={handleThreadPreviewCountChange}
              size="sm"
              step={1}
              value={threadPreviewCount}
            >
              <NumberFieldGroup>
                <NumberFieldDecrement
                  aria-label="Decrease visible thread count"
                  className="[&_svg]:size-3.5"
                />
                <NumberFieldInput
                  aria-label="Visible thread count"
                  inputMode="numeric"
                  onKeyDownCapture={(event) => {
                    event.stopPropagation();
                  }}
                />
                <NumberFieldIncrement
                  aria-label="Increase visible thread count"
                  className="[&_svg]:size-3.5"
                />
              </NumberFieldGroup>
            </NumberField>
          </div>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

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
      } ${isOver && !isDragging ? "ring-1 ring-primary/40" : ""}`}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
    >
      {children({ attributes, listeners, setActivatorNodeRef })}
    </li>
  );
}

interface SidebarProjectsContentProps {
  showArm64IntelBuildWarning: boolean;
  arm64IntelBuildWarningDescription: string | null;
  desktopUpdateButtonAction: "download" | "install" | "none";
  desktopUpdateButtonDisabled: boolean;
  desktopUpdateActionPending: boolean;
  handleDesktopUpdateButtonClick: () => void;
  projectSortOrder: SidebarProjectSortOrder;
  threadSortOrder: SidebarThreadSortOrder;
  threadPreviewCount: SidebarThreadPreviewCount;
  updateSettings: ReturnType<typeof useUpdateClientSettings>;
  openAddProject: () => void;
  isManualProjectSorting: boolean;
  projectDnDSensors: ReturnType<typeof useSensors>;
  projectCollisionDetection: CollisionDetection;
  handleProjectDragStart: (event: DragStartEvent) => void;
  handleProjectDragEnd: (event: DragEndEvent) => void;
  handleProjectDragCancel: (event: DragCancelEvent) => void;
  handleNewThread: ReturnType<typeof useNewThreadHandler>;
  archiveThread: ReturnType<typeof useThreadActions>["archiveThread"];
  deleteThread: ReturnType<typeof useThreadActions>["deleteThread"];
  setThreadPersistence: ReturnType<typeof useThreadActions>["setThreadPersistence"];
  markThreadUnread: ReturnType<typeof useThreadActions>["markThreadUnread"];
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
  legacySidebarScale: LegacySidebarScale;
  compactStatusIndicators: boolean;
  showWorktreeIndicators: boolean;
  projectTreeScaleStyle: CSSProperties;
  providerEntriesByEnvironmentId: ReadonlyMap<string, ReadonlyMap<string, ProviderInstanceEntry>>;
  desktopLocalEnvironmentIds: ReadonlySet<EnvironmentId>;
  knownEnvironmentIds: ReadonlySet<EnvironmentId>;
  environmentIconColors: Readonly<Record<string, EnvironmentIconColor>>;
  showLocalEnvironmentIcon: boolean;
}

// Drafts the user typed into but never sent, rendered above the projects
// list so the legacy sidebar reaches parity with the v2 sidebar: without
// these rows a draft started under this sidebar has no way back in and
// silently piles up in the v2 list. Self-contained (own store and route
// subscriptions) so per-keystroke composer updates re-render only this
// block and SidebarProjectsContent's memo stays intact. SidebarDraftBlock
// renders nothing at count 0, so the wrapping menu collapses to zero
// height and costs the empty sidebar no space.
function LegacySidebarDraftList() {
  const projects = useProjects();
  const { copyToClipboard } = useCopyToClipboard({ target: "draft details" });
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeDraftId = routeTarget?.kind === "draft" ? routeTarget.draftId : null;
  // The legacy list has no grouped display names on draft rows; the
  // project's own title is what its header shows for local projects.
  const projectTitleByKey = useMemo(
    () =>
      new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project.title])),
    [projects],
  );
  const projectByKey = useMemo(
    () => new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project])),
    [projects],
  );
  const navigateToDraft = useCallback(
    (draftId: DraftId) => {
      clearSelection();
      if (isMobile) {
        setOpenMobile(false);
      }
      void navigate({ to: "/draft/$draftId", params: { draftId } });
    },
    [clearSelection, isMobile, navigate, setOpenMobile],
  );
  const handleDraftContextMenu = useCallback(
    (draftId: DraftId, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        const session = useComposerDraftStore.getState().getDraftSession(draftId);
        if (!api || !session || session.promotedTo) return;
        const workspacePath =
          session.worktreePath ??
          projectByKey.get(`${session.environmentId}:${session.projectId}`)?.workspaceRoot;
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            buildDraftActionMenuItems({
              hasPath: Boolean(workspacePath),
              hasBranch: Boolean(session.branch),
              hasProject: false,
            }),
            position,
          ),
        );
        if (clicked._tag === "Failure") return;
        switch (clicked.value) {
          case "copy-path":
            if (workspacePath) copyToClipboard(workspacePath);
            return;
          case "copy-branch":
            if (session.branch) copyToClipboard(session.branch);
            return;
          case "discard": {
            // Sending can promote the draft while its menu is open.
            const current = useComposerDraftStore.getState().getDraftSession(draftId);
            if (current && !current.promotedTo) discardComposerDraft(draftId);
            return;
          }
        }
      })();
    },
    [copyToClipboard, projectByKey],
  );
  return (
    <SidebarMenu>
      <SidebarDraftBlock
        projectByKey={projectByKey}
        projectDisplayNameByKey={projectTitleByKey}
        scopedProjectKeys={null}
        routeDraftId={routeDraftId}
        onNavigateToDraft={navigateToDraft}
        onDraftContextMenu={handleDraftContextMenu}
      />
    </SidebarMenu>
  );
}

const SidebarProjectsContent = memo(function SidebarProjectsContent(
  props: SidebarProjectsContentProps,
) {
  const {
    showArm64IntelBuildWarning,
    arm64IntelBuildWarningDescription,
    desktopUpdateButtonAction,
    desktopUpdateButtonDisabled,
    desktopUpdateActionPending,
    handleDesktopUpdateButtonClick,
    projectSortOrder,
    threadSortOrder,
    threadPreviewCount,
    updateSettings,
    openAddProject,
    isManualProjectSorting,
    projectDnDSensors,
    projectCollisionDetection,
    handleProjectDragStart,
    handleProjectDragEnd,
    handleProjectDragCancel,
    handleNewThread,
    archiveThread,
    deleteThread,
    markThreadUnread,
    setThreadPersistence,
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
    legacySidebarScale,
    compactStatusIndicators,
    showWorktreeIndicators,
    projectTreeScaleStyle,
    providerEntriesByEnvironmentId,
    desktopLocalEnvironmentIds,
    knownEnvironmentIds,
    environmentIconColors,
    showLocalEnvironmentIcon,
  } = props;

  const handleProjectSortOrderChange = useCallback(
    (sortOrder: SidebarProjectSortOrder) => {
      updateSettings({ sidebarProjectSortOrder: sortOrder });
    },
    [updateSettings],
  );
  const handleThreadSortOrderChange = useCallback(
    (sortOrder: SidebarThreadSortOrder) => {
      updateSettings({ sidebarThreadSortOrder: sortOrder });
    },
    [updateSettings],
  );
  const handleThreadPreviewCountChange = useCallback(
    (count: SidebarThreadPreviewCount) => {
      updateSettings({ sidebarThreadPreviewCount: count });
    },
    [updateSettings],
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
                <LegacySidebarThreadPicker projectGroups={sortedProjects} />
              </div>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      }
    >
      {showArm64IntelBuildWarning && arm64IntelBuildWarningDescription ? (
        <SidebarGroup>
          <Alert variant="warning">
            <TriangleAlertIcon />
            <AlertTitle>Intel build on Apple Silicon</AlertTitle>
            <AlertDescription>{arm64IntelBuildWarningDescription}</AlertDescription>
            {desktopUpdateButtonAction !== "none" ? (
              <AlertAction>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={desktopUpdateButtonDisabled || desktopUpdateActionPending}
                  onClick={handleDesktopUpdateButtonClick}
                >
                  {desktopUpdateButtonAction === "download"
                    ? "Download ARM build"
                    : "Install ARM build"}
                </Button>
              </AlertAction>
            ) : null}
          </Alert>
        </SidebarGroup>
      ) : null}
      <LocalSecondaryStatus />
      <SidebarGroup>
        <LegacySidebarDraftList />
        <div className="mb-1 flex items-center justify-between pl-2 pr-1.5">
          <span className="text-xs font-medium text-sidebar-muted-foreground/80">Projects</span>
          <div className="flex items-center gap-1">
            <ProjectSortMenu
              projectSortOrder={projectSortOrder}
              threadSortOrder={threadSortOrder}
              threadPreviewCount={threadPreviewCount}
              onProjectSortOrderChange={handleProjectSortOrderChange}
              onThreadSortOrderChange={handleThreadSortOrderChange}
              onThreadPreviewCountChange={handleThreadPreviewCountChange}
            />
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
                        legacySidebarScale={legacySidebarScale}
                        compactStatusIndicators={compactStatusIndicators}
                        showWorktreeIndicators={showWorktreeIndicators}
                        scaleStyle={projectTreeScaleStyle}
                        providerEntriesByEnvironmentId={providerEntriesByEnvironmentId}
                        desktopLocalEnvironmentIds={desktopLocalEnvironmentIds}
                        knownEnvironmentIds={knownEnvironmentIds}
                        environmentIconColors={environmentIconColors}
                        showLocalEnvironmentIcon={showLocalEnvironmentIcon}
                        project={project}
                        isThreadListExpanded={expandedThreadListsByProject.has(project.projectKey)}
                        activeRouteThreadKey={
                          activeRouteProjectKey === project.projectKey ? routeThreadKey : null
                        }
                        openPullRequestsInRightPanel={openPullRequestsInRightPanel}
                        newThreadShortcutLabel={newThreadShortcutLabel}
                        handleNewThread={handleNewThread}
                        archiveThread={archiveThread}
                        deleteThread={deleteThread}
                        setThreadPersistence={setThreadPersistence}
                        markThreadUnread={markThreadUnread}
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
                legacySidebarScale={legacySidebarScale}
                compactStatusIndicators={compactStatusIndicators}
                showWorktreeIndicators={showWorktreeIndicators}
                scaleStyle={projectTreeScaleStyle}
                providerEntriesByEnvironmentId={providerEntriesByEnvironmentId}
                desktopLocalEnvironmentIds={desktopLocalEnvironmentIds}
                knownEnvironmentIds={knownEnvironmentIds}
                environmentIconColors={environmentIconColors}
                showLocalEnvironmentIcon={showLocalEnvironmentIcon}
                project={project}
                isThreadListExpanded={expandedThreadListsByProject.has(project.projectKey)}
                activeRouteThreadKey={
                  activeRouteProjectKey === project.projectKey ? routeThreadKey : null
                }
                openPullRequestsInRightPanel={openPullRequestsInRightPanel}
                newThreadShortcutLabel={newThreadShortcutLabel}
                handleNewThread={handleNewThread}
                archiveThread={archiveThread}
                deleteThread={deleteThread}
                setThreadPersistence={setThreadPersistence}
                markThreadUnread={markThreadUnread}
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
            data-legacy-sidebar-scale={legacySidebarScale}
            style={projectTreeScaleStyle}
          >
            No projects yet
          </div>
        )}
      </SidebarGroup>
    </SidebarContent>
  );
});

export default function LegacySidebar() {
  const projects = useProjects();
  const sidebarThreads = useThreadShells();
  const collapsedFamiliesByKey = useLegacySidebarFamiliesStore((state) => state.collapsedByKey);
  const projectExpandedById = useUiStateStore((store) => store.projectExpandedById);
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const reorderProjects = useUiStateStore((store) => store.reorderProjects);
  const navigate = useNavigate();
  const sidebarThreadSortOrder = useClientSettings((s) => s.sidebarThreadSortOrder);
  const groupingStyle = useClientSettings((s) => s.legacySidebarThreadGroupingStyle);
  const sidebarProjectSortOrder = useClientSettings((s) => s.sidebarProjectSortOrder);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const sidebarThreadPreviewCount = useClientSettings((s) => s.sidebarThreadPreviewCount);
  const legacySidebarScale = useClientSettings<LegacySidebarScale>((s) => s.legacySidebarScale);
  const compactStatusIndicators = useClientSettings(
    (settings) => settings.compactLegacySidebarStatuses,
  );
  const showWorktreeIndicators = useClientSettings(
    (settings) => settings.showThreadWorktreeIndicators,
  );
  const environmentIconColors = useClientSettings((s) => s.environmentIconColors);
  const showLocalEnvironmentIcon = useClientSettings((s) => s.showLocalEnvironmentIcon);
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const scaleStyle = useMemo(
    () => legacySidebarScaleStyle(legacySidebarScale),
    [legacySidebarScale],
  );
  const updateSettings = useUpdateClientSettings();
  const handleNewThread = useNewThreadHandler();
  const { archiveThread, deleteThread, markThreadUnread, setThreadPersistence } =
    useThreadActions();
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
  const desktopUpdateState = useDesktopUpdateState();
  const [desktopUpdateActionPending, setDesktopUpdateActionPending] = useState(false);
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
        return projectLegacySidebarFamilies({
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

  const desktopUpdateButtonDisabled = isDesktopUpdateButtonDisabled(desktopUpdateState);
  const desktopUpdateButtonAction = desktopUpdateState
    ? resolveDesktopUpdateButtonAction(desktopUpdateState)
    : "none";
  const showArm64IntelBuildWarning =
    isElectron && shouldShowArm64IntelBuildWarning(desktopUpdateState);
  const arm64IntelBuildWarningDescription =
    desktopUpdateState && showArm64IntelBuildWarning
      ? getArm64IntelBuildWarningDescription(desktopUpdateState)
      : null;
  const commandPaletteShortcutLabel = isMobile
    ? null
    : shortcutLabelForCommand(keybindings, "commandPalette.toggle", newThreadShortcutLabelOptions);
  const handleDesktopUpdateButtonClick = useCallback(async () => {
    const bridge = window.desktopBridge;
    if (!bridge || !desktopUpdateState) return;
    if (
      desktopUpdateButtonDisabled ||
      desktopUpdateButtonAction === "none" ||
      desktopUpdateActionPending
    ) {
      return;
    }

    setDesktopUpdateActionPending(true);

    if (desktopUpdateButtonAction === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          if (result.completed) {
            showDesktopUpdateDownloadedToast(bridge, result.state);
          }
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not download update",
              description: actionError,
            }),
          );
        })
        .catch((error) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not start update download",
              description: error instanceof Error ? error.message : "An unexpected error occurred.",
            }),
          );
        })
        .finally(() => setDesktopUpdateActionPending(false));
      return;
    }

    if (desktopUpdateButtonAction === "install") {
      let confirmed = false;
      try {
        confirmed = await ensureLocalApi().dialogs.confirm(
          getDesktopUpdateInstallConfirmationMessage(desktopUpdateState),
        );
      } catch (error) {
        setDesktopUpdateActionPending(false);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not confirm update",
            description: error instanceof Error ? error.message : "Update confirmation failed.",
          }),
        );
        return;
      }
      if (!confirmed) {
        setDesktopUpdateActionPending(false);
        return;
      }
      void bridge
        .installUpdate()
        .then((result) => {
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: actionError,
            }),
          );
        })
        .catch((error) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: error instanceof Error ? error.message : "An unexpected error occurred.",
            }),
          );
        })
        .finally(() => setDesktopUpdateActionPending(false));
    }
  }, [
    desktopUpdateActionPending,
    desktopUpdateButtonAction,
    desktopUpdateButtonDisabled,
    desktopUpdateState,
  ]);

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
        showArm64IntelBuildWarning={showArm64IntelBuildWarning}
        arm64IntelBuildWarningDescription={arm64IntelBuildWarningDescription}
        desktopUpdateButtonAction={desktopUpdateButtonAction}
        desktopUpdateButtonDisabled={desktopUpdateButtonDisabled}
        desktopUpdateActionPending={desktopUpdateActionPending}
        handleDesktopUpdateButtonClick={handleDesktopUpdateButtonClick}
        projectSortOrder={sidebarProjectSortOrder}
        threadSortOrder={sidebarThreadSortOrder}
        threadPreviewCount={sidebarThreadPreviewCount}
        updateSettings={updateSettings}
        openAddProject={openAddProjectCommandPalette}
        isManualProjectSorting={isManualProjectSorting}
        projectDnDSensors={projectDnDSensors}
        projectCollisionDetection={projectCollisionDetection}
        handleProjectDragStart={handleProjectDragStart}
        handleProjectDragEnd={handleProjectDragEnd}
        handleProjectDragCancel={handleProjectDragCancel}
        handleNewThread={handleNewThread}
        archiveThread={archiveThread}
        deleteThread={deleteThread}
        setThreadPersistence={setThreadPersistence}
        markThreadUnread={markThreadUnread}
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
        legacySidebarScale={legacySidebarScale}
        compactStatusIndicators={compactStatusIndicators}
        showWorktreeIndicators={showWorktreeIndicators}
        projectTreeScaleStyle={scaleStyle}
        providerEntriesByEnvironmentId={providerEntriesByEnvironmentId}
        desktopLocalEnvironmentIds={desktopLocalEnvironmentIds}
        knownEnvironmentIds={knownEnvironmentIds}
        environmentIconColors={environmentIconColors}
        showLocalEnvironmentIcon={showLocalEnvironmentIcon}
      />
      <SidebarChromeFooter />
    </>
  );
}
