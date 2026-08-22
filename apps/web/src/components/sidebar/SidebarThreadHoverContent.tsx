import { CircleAlertIcon, GitBranchIcon, ServerIcon, TerminalIcon } from "lucide-react";

import type { ProviderInstanceEntry } from "../../providerInstances";
import type { SidebarThreadSummary } from "../../types";
import { cn } from "~/lib/utils";
import { ProjectFavicon } from "../ProjectFavicon";
import type { TerminalStatusIndicator } from "../ThreadStatusIndicators";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";

export interface SidebarThreadHoverContentProps {
  thread: SidebarThreadSummary;
  projectTitle: string | null;
  projectCwd: string | null;
  projectFaviconPath: string | null;
  environmentLabel: string | null;
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
            <ServerIcon className="size-3 shrink-0 stroke-muted-foreground" />
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
    </div>
  );
}
