import { ArrowRightLeftIcon, CircleAlertIcon, GitBranchIcon, TerminalIcon } from "lucide-react";
import type { ProjectIconOverride } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentIconColor } from "@t3tools/contracts/settings";
import { actionRunningPresentation } from "@t3tools/shared/actionResume";

import type { ProviderInstanceEntry } from "../../providerInstances";
import type { SidebarThreadSummary } from "../../types";
import { cn } from "~/lib/utils";
import { ProjectFavicon } from "../ProjectFavicon";
import type { TerminalStatusIndicator } from "../ThreadStatusIndicators";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { ConnectedEnvironmentIcon } from "../../environmentIcons";
import { RotateCcwClockIcon } from "../icons/RotateCcwClockIcon";
import { useSupportsMultiplePullRequests } from "~/hooks/useSupportsMultiplePullRequests";
import { ThreadPullRequestsMiniList } from "../ThreadStatusIndicators";
import { MiddleTruncate } from "../ui/middle-truncate";
import { useKnownTerminalSessions } from "../../state/terminalSessions";
import { useThreadPreviewLeases } from "../../state/previewHosting";
import { threadTerminalProcessLabels } from "./threadTerminalPresentation";

export interface SidebarThreadHoverContentProps {
  thread: SidebarThreadSummary;
  projectTitle: string | null;
  projectDisplayName?: string | null;
  projectCwd: string | null;
  projectFaviconPath: string | null;
  projectIcon?: ProjectIconOverride | null;
  environmentLabel: string | null;
  environmentIconColor?: EnvironmentIconColor | undefined;
  providerEntry: ProviderInstanceEntry | null;
  providerEntryByInstanceId?: ReadonlyMap<string, ProviderInstanceEntry> | undefined;
  showInstanceBadge: boolean;
  modelInstanceId: string;
  modelLabel: string;
  branchMismatch: {
    threadBranch: string;
    currentBranch: string;
  } | null;
  terminalStatus: TerminalStatusIndicator | null;
  terminalProcessCount: number;
  cleanupBlockerTitle?: string | null;
  showCleanup?: boolean;
}

function terminalProcessLabel(count: number): string {
  return `${count} terminal ${count === 1 ? "process" : "processes"} running`;
}

export function SidebarThreadHoverContent(props: SidebarThreadHoverContentProps) {
  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(props.thread.environmentId);
  const driverKind = props.providerEntry?.driverKind ?? null;
  const projectDisplayName = props.projectDisplayName ?? props.projectTitle;
  const sessions = useKnownTerminalSessions({
    environmentId: props.thread.environmentId,
    threadId: props.thread.id,
  });
  const previews = useThreadPreviewLeases(
    scopeThreadRef(props.thread.environmentId, props.thread.id),
  );
  const terminalLabels = threadTerminalProcessLabels(
    (sessions ?? []).flatMap((session) => (session.state.summary ? [session.state.summary] : [])),
    previews,
  );
  const previousProviderNames = props.thread.providerInstanceHistory
    .filter((instanceId) => instanceId !== props.modelInstanceId)
    .map(
      (instanceId) => props.providerEntryByInstanceId?.get(instanceId)?.displayName ?? instanceId,
    );
  const actionPresentation =
    props.thread.actionResume?.outcome === "running"
      ? actionRunningPresentation(props.thread.actionResume)
      : null;

  return (
    <div className="flex min-w-0 max-w-80 flex-col gap-2 p-(--floating-content-inset)">
      <div className="min-w-0 truncate text-xs leading-tight font-medium text-foreground">
        {props.thread.title}
      </div>
      {props.thread.persistent ? (
        <div className="text-xs text-muted-foreground">
          Persistent thread · protected from archive and deletion
        </div>
      ) : null}
      <div className="grid gap-1.5 pl-0.5 text-xs text-muted-foreground">
        {projectDisplayName ? (
          <div className="flex min-w-0 items-center gap-2">
            <ProjectFavicon
              project={{
                environmentId: props.thread.environmentId,
                workspaceRoot: props.projectCwd ?? "",
                title: props.projectTitle ?? "",
                faviconPath: props.projectFaviconPath,
                projectIcon: props.projectIcon ?? null,
              }}
              className="size-3 shrink-0"
            />
            <div className="min-w-0 truncate text-foreground/75">{projectDisplayName}</div>
          </div>
        ) : null}
        {props.environmentLabel ? (
          <div className="flex min-w-0 items-center gap-2">
            {props.thread.lineage.relationshipToParent !== "subagent" ? (
              <ConnectedEnvironmentIcon
                environmentId={props.thread.environmentId}
                context="hover"
                color={props.environmentIconColor}
                className="size-3 shrink-0"
              />
            ) : null}
            <div className="min-w-0 truncate text-foreground/75">{props.environmentLabel}</div>
          </div>
        ) : null}
        {props.thread.branch ? (
          <div className="flex min-w-0 items-center gap-2">
            <GitBranchIcon className="size-3 shrink-0 stroke-muted-foreground" />
            <div className="min-w-0 text-foreground/75">
              <MiddleTruncate value={props.thread.branch} className="flex" />
            </div>
          </div>
        ) : null}
        {props.branchMismatch ? (
          <div className="flex min-w-0 items-start gap-2 text-warning">
            <CircleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0 stroke-current" />
            <div className="min-w-0 flex-1 wrap-break-word leading-5">
              You're currently checked out on another branch.
            </div>
          </div>
        ) : null}
        {driverKind ? (
          <div className="flex min-w-0 items-center gap-2">
            <ProviderInstanceIcon
              driverKind={driverKind}
              displayName={
                props.providerEntry?.displayName ??
                props.thread.runtime?.providerName ??
                props.modelInstanceId
              }
              accentColor={props.providerEntry?.accentColor}
              acpRegistryAgentId={props.providerEntry?.acpRegistryAgentId}
              acpRegistryIconUrl={props.providerEntry?.acpRegistryIconUrl}
              showBadge={props.showInstanceBadge && props.providerEntry?.accentColor !== undefined}
              badgeContent="none"
              badgeClassName="h-2 min-w-2 px-0"
              iconClassName="size-3 shrink-0 grayscale opacity-60"
            />
            <div className="min-w-0 truncate text-foreground/75">
              {props.showInstanceBadge && props.providerEntry
                ? `${props.modelLabel} · ${props.providerEntry.displayName}`
                : props.modelLabel}
            </div>
          </div>
        ) : null}
        {previousProviderNames.length > 0 ? (
          <div className="flex min-w-0 items-center gap-2">
            <ArrowRightLeftIcon className="size-3 shrink-0 stroke-muted-foreground" />
            <div className="min-w-0 truncate text-foreground/75">
              Handed off from {previousProviderNames.join(", ")}
            </div>
          </div>
        ) : null}
        {props.terminalStatus || terminalLabels.length > 0 ? (
          <div className="flex min-w-0 items-start gap-2">
            <TerminalIcon
              aria-hidden
              className={cn("mt-0.5 size-3 shrink-0", props.terminalStatus?.colorClass)}
            />
            <div className="grid min-w-0 gap-1 text-foreground/75">
              {props.terminalStatus ? (
                <div>{terminalProcessLabel(props.terminalProcessCount)}</div>
              ) : null}
              {terminalLabels.map((terminal) => (
                <div key={terminal.terminalId} className="wrap-anywhere">
                  {terminal.label}
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {actionPresentation ? (
          <div
            className={cn(
              "flex min-w-0 items-center gap-2",
              actionPresentation.state === "working"
                ? "text-info-foreground"
                : "text-warning-foreground",
            )}
          >
            <RotateCcwClockIcon aria-hidden className="size-3 shrink-0" />
            <div className="min-w-0 truncate">
              {actionPresentation.label}: {actionPresentation.summary}
            </div>
          </div>
        ) : null}
        {props.thread.runtime?.lastError ? (
          <div
            className={cn(
              "flex min-w-0 items-center gap-2",
              props.thread.runtime.lastErrorClass === "usage_limit"
                ? "text-warning"
                : "text-error-foreground",
            )}
          >
            <CircleAlertIcon className="size-3 shrink-0 stroke-current" />
            <div className="min-w-0 truncate">
              {props.thread.runtime.lastErrorClass === "usage_limit"
                ? "Usage limit reached"
                : "Error occurred"}
            </div>
          </div>
        ) : null}
      </div>
      {supportsMultiplePullRequests && props.thread.pullRequests.length > 0 ? (
        <div className="border-t border-border/60 pt-2 pl-0.5 text-xs text-muted-foreground">
          <ThreadPullRequestsMiniList pullRequests={props.thread.pullRequests} />
        </div>
      ) : null}
      {props.showCleanup === false ? null : (
        <SidebarThreadCleanupHoverContent
          thread={props.thread}
          blockerTitle={props.cleanupBlockerTitle ?? null}
        />
      )}
    </div>
  );
}

export function SidebarThreadCleanupHoverContent(props: {
  thread: SidebarThreadSummary;
  blockerTitle: string | null;
  standalone?: boolean;
}) {
  const cleanup = props.thread.worktreeCleanup;
  if (cleanup == null || cleanup.status === "failed") return null;

  return (
    <div
      className={cn(
        !props.standalone && "-mx-(--floating-content-inset) -mb-(--floating-content-inset)",
        "border-t border-warning/25 bg-warning px-(--floating-content-inset) py-2 text-xs text-warning-foreground",
      )}
    >
      {cleanup.status === "deleting" ? (
        <>
          <div className="font-medium">Deleting worktree</div>
          <div className="mt-1 break-all font-mono text-3xs text-left [text-wrap-style:auto] opacity-80">
            {cleanup.worktreePath}
          </div>
        </>
      ) : (
        <>
          <div className="font-medium">Waiting for cleanup</div>
          <div className="mt-1 truncate">
            {cleanup.blockedByThreadId}
            {props.blockerTitle ? ` — ${props.blockerTitle}` : ""}
          </div>
        </>
      )}
    </div>
  );
}
