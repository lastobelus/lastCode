import { MessageSquareLockIcon } from "lucide-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { actionRunningPresentation } from "@t3tools/shared/actionResume";
import { useClientSetting } from "~/hooks/useSettings";
import { ThreadStatusLabel } from "../ThreadStatusIndicators";
import type { ThreadStatusPill } from "../Sidebar.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDashboardIndicator } from "../dashboard/ThreadDashboardIndicator";
import {
  lastcodeSidebarSubagentStatusLabel,
  type LastCodeSidebarFamilyRow,
} from "../lastcodeSidebarFamilies.logic";
import type { SidebarThreadSummary } from "../../types";
import { LastCodeThreadTitleEditor } from "./LastCodeThreadTitleEditor";
import {
  LastCodeThreadRelationshipBadge,
  LastCodeThreadFamilySummary,
} from "./LastCodeThreadFamily";
import type { LastCodeThreadFamilyPresentation } from "./useLastCodeThreadFamily";
import type {
  LastCodeRenameTarget,
  LastCodeThreadEditingCapabilities,
} from "./useLastCodeThreadEditing";
import { LastCodeThreadSourceControl } from "./LastCodeThreadSourceControl";
import type { LastCodeThreadSourceControlSnapshot } from "./useLastCodeThreadSourceControl";
import type { ScopedThreadRef } from "@t3tools/contracts";
function WaitingAction({
  thread,
  threadStatus,
}: {
  thread: SidebarThreadSummary;
  threadStatus: ThreadStatusPill | null;
}) {
  return (
    <>
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
    </>
  );
}
function TitleText({
  family,
  presentation,
  threadStatus,
}: {
  family: LastCodeSidebarFamilyRow;
  presentation: LastCodeThreadFamilyPresentation;
  threadStatus: ThreadStatusPill | null;
}) {
  const thread = family.thread;
  const subagentLabel = presentation.subagentLabel;
  return (
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
          <span className="flex min-w-0 max-w-[40%] items-center gap-1 overflow-hidden">
            {thread.persistent && (family.parentKey !== null || subagentLabel) ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      aria-label="Protected"
                      className="shrink-0 text-3xs text-sidebar-muted-foreground"
                    />
                  }
                >
                  <MessageSquareLockIcon
                    aria-hidden
                    className="size-3 @sm/lastcode-sidebar:hidden"
                  />
                  <span aria-hidden className="hidden @sm/lastcode-sidebar:inline">
                    Protected
                  </span>
                </TooltipTrigger>
                <TooltipPopup side="top">Protected from archive and deletion</TooltipPopup>
              </Tooltip>
            ) : null}
            <LastCodeThreadRelationshipBadge presentation={presentation} />
            {subagentLabel ? (
              <span className="sr-only min-w-0 text-3xs text-sidebar-muted-foreground @sm/lastcode-sidebar:not-sr-only @sm/lastcode-sidebar:truncate">
                {lastcodeSidebarSubagentStatusLabel(thread, threadStatus)}
              </span>
            ) : null}
            <LastCodeThreadFamilySummary family={family} display="inline" />
          </span>
        </span>
        <LastCodeThreadFamilySummary family={family} display="line" />
      </span>
    </>
  );
}
export function LastCodeThreadTitle({
  family,
  presentation,
  threadStatus,
  renameTarget,
  editing,
}: {
  family: LastCodeSidebarFamilyRow;
  presentation: LastCodeThreadFamilyPresentation;
  threadStatus: ThreadStatusPill | null;
  renameTarget: LastCodeRenameTarget | null;
  editing: LastCodeThreadEditingCapabilities;
}) {
  const thread = family.thread;
  const compactStatusIndicators = useClientSetting("compactLegacySidebarStatuses");
  return (
    <>
      <WaitingAction thread={thread} threadStatus={threadStatus} />
      {threadStatus && (
        <>
          <span className="inline-flex shrink-0 @sm/lastcode-sidebar:hidden">
            <ThreadStatusLabel status={threadStatus} compact />
          </span>
          <span className="hidden min-w-0 max-w-[35%] overflow-hidden @sm/lastcode-sidebar:inline-flex">
            <ThreadStatusLabel status={threadStatus} compact={compactStatusIndicators} />
          </span>
        </>
      )}
      {renameTarget ? (
        <LastCodeThreadTitleEditor
          key={renameTarget.session}
          threadRef={scopeThreadRef(thread.environmentId, thread.id)}
          title={thread.title}
          target={renameTarget}
          finishRename={editing.finishRename}
        />
      ) : (
        <>
          <TitleText family={family} presentation={presentation} threadStatus={threadStatus} />
          <ThreadDashboardIndicator items={thread.dashboardItems} />
        </>
      )}
    </>
  );
}

/** Compose PR and title controls without adding a second source-control subscription. */
export function LastCodeThreadLeadingControls({
  family,
  presentation,
  threadStatus,
  renameTarget,
  editing,
  sourceControl,
  active,
  navigateToThread,
}: {
  family: LastCodeSidebarFamilyRow;
  presentation: LastCodeThreadFamilyPresentation;
  threadStatus: ThreadStatusPill | null;
  renameTarget: LastCodeRenameTarget | null;
  editing: LastCodeThreadEditingCapabilities;
  sourceControl: LastCodeThreadSourceControlSnapshot;
  active: boolean;
  navigateToThread: (ref: ScopedThreadRef) => Promise<void>;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
      <LastCodeThreadSourceControl
        thread={family.thread}
        sourceControl={sourceControl}
        isActive={active}
        navigateToThread={navigateToThread}
      />
      <LastCodeThreadTitle
        family={family}
        presentation={presentation}
        threadStatus={threadStatus}
        renameTarget={renameTarget}
        editing={editing}
      />
    </div>
  );
}
