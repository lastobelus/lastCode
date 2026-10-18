import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useEnvironmentScope } from "../../state/session";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import type { LastCodeSidebarFamilyRow } from "../lastcodeSidebarFamilies.logic";
import { useSidebarRowSubscriptionLease } from "../Sidebar.logic";
import { WorktreeCleanupFailureDialog } from "../WorktreeCleanupFailureDialog";
import { useLastCodeSidebarPresentation } from "./LastCodeSidebarPresentation";
import { LastCodeThreadMetadataControls } from "./LastCodeThreadMetadataControls";
import { LastCodeThreadRowSurface } from "./LastCodeThreadRowSurface";
import { useLastCodeThreadNavigation } from "./useLastCodeThreadNavigation";
import {
  LastCodeThreadDetails,
  LastCodeThreadCleanupOverlay,
  type LastCodeThreadAnnotationActions,
} from "./LastCodeThreadDetails";
import {
  useLastCodeThreadRowGestures,
  useLastCodeThreadFileDrop,
  type LastCodeThreadRowMenus,
} from "./lastcodeThreadRowInteractions";
import { useLastCodeThreadIdentity } from "./useLastCodeThreadIdentity";
import { createLastCodeThreadHoverContents } from "./LastCodeThreadHoverDetails";
import { useLastCodeThreadStatus } from "./useLastCodeThreadStatus";
import { useLastCodeThreadDetails } from "./useLastCodeThreadDetails";
import { useLastCodeThreadFamily } from "./useLastCodeThreadFamily";
import { LastCodeThreadFamilyDisclosure } from "./LastCodeThreadFamily";
import { useLastCodeThreadSourceControl } from "./useLastCodeThreadSourceControl";
import { useLastCodeThreadProcesses } from "./useLastCodeThreadProcesses";
import { LastCodeThreadProcesses } from "./LastCodeThreadProcesses";
import { LastCodeThreadLeadingControls } from "./LastCodeThreadTitle";
import { LastCodeThreadRowLayout } from "./LastCodeThreadRowLayout";
import type {
  LastCodeRenameTarget,
  LastCodeThreadEditingCapabilities,
  useLastCodeThreadEditing,
} from "./useLastCodeThreadEditing";

interface LastCodeThreadRowProps {
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

function LastCodeThreadRow(props: LastCodeThreadRowProps) {
  const { isActive, renameTarget, editing, navigation } = props;
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
  const identity = useLastCodeThreadIdentity(
    props.familyRow,
    providerEntriesByEnvironmentId,
    environmentIconColors[thread.environmentId],
    providerBadgePreferences,
  );
  const sourceControl = useLastCodeThreadSourceControl(thread, leaseLiveStatus, props.projectCwd);
  const threadStatus = useLastCodeThreadStatus(thread);
  const canArchive = canOperateThread && !thread.persistent && cleanup === null;
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
  const gestures = useLastCodeThreadRowGestures(
    thread,
    navigation,
    props.menus,
    {
      selected: isSelected,
      hasStoppableProcesses: processes.hasStoppableProcesses,
      renameActive: renameTarget !== null,
    },
    editing.requestRename,
  );
  const family = props.familyRow;

  return (
    <LastCodeThreadRowLayout
      depth={family.depth}
      rowRef={rowRef}
      fileDropHandlers={fileDropHandlers}
      annotated={thread.annotation?.resolvedAt === null}
      lifetime={detailsLifetime}
    >
      <LastCodeThreadRowSurface
        family={family}
        relationship={familyPresentation}
        lifetime={detailsLifetime}
        gestures={gestures}
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
          jumpLabel={props.jumpLabel}
          highlighted={isActive || isSelected}
          archive={{
            allowed: canArchive,
            confirmationRequested: props.archiveConfirmActive,
            editing,
          }}
          annotationHandle={detailsLifetime.annotationPopoverHandle}
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
        gitCwd={sourceControl.gitCwd}
        content={threadHoverDetails}
        trailingContent={cleanupHoverDetails}
        annotations={props.annotations}
      />
      <WorktreeCleanupFailureDialog
        thread={thread}
        open={gestures.cleanupFailureOpen}
        onOpenChange={gestures.setCleanupFailureOpen}
      />
    </LastCodeThreadRowLayout>
  );
}

/** Bind project-owned state to targeted row props without broadening unrelated row invalidation. */
export function useLastCodeThreadRowRenderer(
  projectCwd: string | null,
  activeThreadKey: string | null,
  jumpLabels: ReadonlyMap<string, string>,
  editingState: ReturnType<typeof useLastCodeThreadEditing>,
  navigation: LastCodeThreadRowProps["navigation"],
  menus: LastCodeThreadRowProps["menus"],
  annotations: LastCodeThreadRowProps["annotations"],
) {
  const { renameTarget, archiveTarget, capabilities: editing } = editingState;
  return (familyRow: LastCodeSidebarFamilyRow) => (
    <LastCodeThreadRow
      familyRow={familyRow}
      projectCwd={projectCwd}
      isActive={activeThreadKey === familyRow.key}
      jumpLabel={jumpLabels.get(familyRow.key) ?? null}
      renameTarget={renameTarget?.key === familyRow.key ? renameTarget : null}
      editing={editing}
      archiveConfirmActive={archiveTarget === familyRow.key}
      navigation={navigation}
      menus={menus}
      annotations={annotations}
    />
  );
}
