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

// Physical pixels: outcome + PR + two gaps still leave at least 32px for the name.
// The row wraps metadata instead of shrinking this budget, including at sidebar zoom.
export const LASTCODE_THREAD_LEADING_MIN_WIDTH = 72;
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
/** Keep a distinct child outcome visible without repeating the row's leading status. */
function SubagentOutcome({
  label,
  leadingLabel,
}: {
  label: string;
  leadingLabel: string | undefined;
}) {
  if (label === leadingLabel) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={label}
            className="inline-flex shrink-0 items-center text-3xs text-sidebar-muted-foreground"
            style={{
              minWidth: "calc(14px * var(--lastcode-sidebar-content-zoom))",
              minHeight: "calc(14px * var(--lastcode-sidebar-content-zoom))",
            }}
          />
        }
      >
        <span
          data-lastcode-sidebar-unscaled-content
          className="inline-flex size-3.5 items-center justify-center @sm/lastcode-sidebar:hidden"
        >
          {label.slice(0, 1)}
        </span>
        <span className="hidden min-w-0 truncate @sm/lastcode-sidebar:inline">{label}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
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
  const subagentStatus = lastcodeSidebarSubagentStatusLabel(thread, threadStatus);
  return (
    <>
      {thread.persistent && family.parentKey === null && !subagentLabel ? (
        <MessageSquareLockIcon aria-hidden className="size-3.5 shrink-0" />
      ) : null}
      <span
        className="min-w-0 flex-1"
        style={{ minWidth: "calc(32px * var(--lastcode-sidebar-content-zoom))" }}
      >
        <span className="flex min-w-0 flex-wrap items-center gap-1">
          <span
            className={`min-w-0 flex-1 truncate text-sm ${thread.persistent ? "italic" : ""}`}
            style={{ minWidth: "calc(32px * var(--lastcode-sidebar-content-zoom))" }}
            data-testid={`thread-title-${thread.id}`}
          >
            {thread.title}
          </span>
          <span className="flex min-w-0 max-w-full flex-wrap items-center gap-1">
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
              <SubagentOutcome label={subagentStatus} leadingLabel={threadStatus?.label} />
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
        <span className="inline-flex min-w-0 max-w-[35%] overflow-hidden">
          <ThreadStatusLabel status={threadStatus} compact={compactStatusIndicators} />
        </span>
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
          <span className="contents">
            <ThreadDashboardIndicator items={thread.dashboardItems} />
          </span>
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
    <div
      className="@container/lastcode-thread-title flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1 text-left"
      style={{
        minWidth: `calc(${LASTCODE_THREAD_LEADING_MIN_WIDTH}px * var(--lastcode-sidebar-content-zoom))`,
      }}
    >
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
