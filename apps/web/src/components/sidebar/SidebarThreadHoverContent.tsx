import { CircleAlertIcon, GitBranchIcon, TerminalIcon } from "lucide-react";
import type { EnvironmentIconColor } from "@t3tools/contracts/settings";

import type { ProviderInstanceEntry } from "../../providerInstances";
import type { SidebarThreadSummary } from "../../types";
import { cn } from "~/lib/utils";
import { ProjectFavicon } from "../ProjectFavicon";
import type { TerminalStatusIndicator } from "../ThreadStatusIndicators";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { EnvironmentIcon } from "../../environmentIcons";

export interface SidebarThreadHoverContentProps {
  thread: SidebarThreadSummary;
  projectTitle: string | null;
  projectCwd: string | null;
  projectFaviconPath: string | null;
  environmentLabel: string | null;
  environmentIconKind?: "monitor" | "server";
  environmentIconColor?: EnvironmentIconColor | undefined;
  providerEntry: ProviderInstanceEntry | null;
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
  const driverKind = props.providerEntry?.driverKind ?? null;

  return (
    <div className="flex min-w-0 max-w-80 flex-col gap-2 p-[var(--floating-content-inset)]">
      <div className="min-w-0 truncate text-xs leading-none font-medium text-foreground">
        {props.thread.title}
      </div>
      <div className="grid gap-1.5 pl-0.5 text-xs text-muted-foreground">
        {props.projectTitle ? (
          <div className="flex min-w-0 items-center gap-2">
            <ProjectFavicon
              environmentId={props.thread.environmentId}
              cwd={props.projectCwd ?? ""}
              faviconPath={props.projectFaviconPath}
              className="size-3 shrink-0 stroke-muted-foreground"
            />
            <div className="min-w-0 truncate text-foreground/75">{props.projectTitle}</div>
          </div>
        ) : null}
        {props.environmentLabel ? (
          <div className="flex min-w-0 items-center gap-2">
            <EnvironmentIcon
              kind={props.environmentIconKind ?? "server"}
              context="hover"
              color={props.environmentIconColor}
              className="size-3 shrink-0"
            />
            <div className="min-w-0 truncate text-foreground/75">{props.environmentLabel}</div>
          </div>
        ) : null}
        {props.thread.branch ? (
          <div className="flex min-w-0 items-center gap-2">
            <GitBranchIcon className="size-3 shrink-0 stroke-muted-foreground" />
            <div className="min-w-0 truncate text-foreground/75">{props.thread.branch}</div>
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
                props.thread.session?.providerName ??
                props.modelInstanceId
              }
              accentColor={props.providerEntry?.accentColor}
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
        {props.terminalStatus ? (
          <div className="flex min-w-0 items-center gap-2">
            <TerminalIcon
              aria-hidden
              className={cn("size-3 shrink-0", props.terminalStatus.colorClass)}
            />
            <div className="min-w-0 truncate text-foreground/75">
              {terminalProcessLabel(props.terminalProcessCount)}
            </div>
          </div>
        ) : null}
        {props.thread.session?.lastError ? (
          <div className="flex min-w-0 items-center gap-2 text-red-600 dark:text-red-400">
            <CircleAlertIcon className="size-3 shrink-0 stroke-current" />
            <div className="min-w-0 truncate">Error occurred</div>
          </div>
        ) : null}
      </div>
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
        !props.standalone &&
          "-mx-[var(--floating-content-inset)] -mb-[var(--floating-content-inset)]",
        "border-t border-orange-600/25 bg-orange-400 px-[var(--floating-content-inset)] py-2 text-xs text-foreground dark:bg-orange-400 dark:text-background",
      )}
    >
      {cleanup.status === "deleting" ? (
        <>
          <div className="font-medium">Deleting worktree</div>
          <div className="mt-1 break-all font-mono text-[10px] text-left [text-wrap-style:auto] opacity-80">
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
