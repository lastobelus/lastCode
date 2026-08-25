import type { ActionResumeState } from "@t3tools/contracts";
import { TerminalIcon, XIcon } from "lucide-react";
import { memo, useEffect, useState } from "react";

import { formatWorkingDurationLabel } from "../Sidebar.logic";
import { RotateCcwClockIcon } from "../icons/RotateCcwClockIcon";
import { Button } from "../ui/button";
import { cn } from "~/lib/utils";

export interface ComposerResumableAction {
  readonly action: ActionResumeState;
  readonly command: string | null;
}

function ActionElapsed({ startedAt }: { readonly startedAt: string }) {
  const startedMs = Date.parse(startedAt);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (Number.isNaN(startedMs)) return;
    const intervalId = window.setInterval(() => setTick((tick) => tick + 1), 1_000);
    return () => window.clearInterval(intervalId);
  }, [startedMs]);

  if (Number.isNaN(startedMs)) return null;
  return (
    <span className="font-mono tabular-nums">
      {formatWorkingDurationLabel(Date.now() - startedMs)}
    </span>
  );
}

export const ComposerActionResumeBadge = memo(function ComposerActionResumeBadge({
  action,
  expanded,
  onToggle,
  placement = "tab",
}: {
  readonly action: ComposerResumableAction;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly placement?: "inline" | "tab";
}) {
  const label = `${action.action.actionName} is running and will resume the agent when the thread is idle`;

  if (placement === "inline") {
    return (
      <Button
        size="micro"
        variant="ghost-muted"
        aria-expanded={expanded}
        aria-label={label}
        className="shrink-0 gap-1 px-1.5 text-yellow-700 dark:text-yellow-300"
        onClick={onToggle}
        onPointerDown={(event) => event.preventDefault()}
      >
        <RotateCcwClockIcon aria-hidden className="size-3 shrink-0" />
        <span className="max-w-32 truncate">{action.action.actionName}</span>
        <ActionElapsed startedAt={action.action.startedAt} />
      </Button>
    );
  }

  return (
    <div
      className="chat-composer-shoulder-tab absolute -top-7 left-4 right-4 z-0 flex h-8 items-center rounded-t-xl border border-b-0 px-2 pb-1 text-xs leading-none text-yellow-700 dark:text-yellow-300"
      data-composer-action-resume-badge="true"
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={label}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 self-stretch text-left hover:text-yellow-800 dark:hover:text-yellow-200"
        onClick={onToggle}
        onPointerDown={(event) => event.preventDefault()}
      >
        <RotateCcwClockIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-medium text-foreground/85">
          {action.action.actionName}
        </span>
        <span className="shrink-0 text-muted-foreground">Running</span>
        <ActionElapsed startedAt={action.action.startedAt} />
      </button>
    </div>
  );
});

export const ComposerActionResumeDrawer = memo(function ComposerActionResumeDrawer({
  action,
  cancelling,
  onCancel,
  onCollapse,
  onOpenTerminal,
}: {
  readonly action: ComposerResumableAction;
  readonly cancelling: boolean;
  readonly onCancel: () => void;
  readonly onCollapse: () => void;
  readonly onOpenTerminal: () => void;
}) {
  return (
    <div
      className="chat-composer-top-drawer"
      data-chat-composer-action-resume-drawer="true"
      data-variant="warning"
    >
      <div className="flex items-center gap-2 px-3 py-2 sm:px-4">
        <button
          type="button"
          aria-expanded="true"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 self-stretch text-left text-xs hover:text-foreground"
          onClick={onCollapse}
          onPointerDown={(event) => event.preventDefault()}
        >
          <RotateCcwClockIcon
            aria-hidden
            className="size-3.5 shrink-0 text-yellow-700 dark:text-yellow-300"
          />
          <span className="min-w-0 flex-1 truncate font-medium text-foreground">
            {action.action.actionName}
          </span>
          <span className="inline-flex shrink-0 items-center gap-1.5 text-yellow-700 dark:text-yellow-300">
            <span aria-hidden className="size-1.5 rounded-full bg-yellow-500 dark:bg-yellow-300" />
            Running for <ActionElapsed startedAt={action.action.startedAt} />
          </span>
        </button>
        <Button
          size="icon-micro"
          variant="ghost-muted"
          aria-label="Collapse Action details"
          className="shrink-0"
          onClick={onCollapse}
          onPointerDown={(event) => event.preventDefault()}
        >
          <XIcon aria-hidden className="size-3" />
        </Button>
      </div>
      <div className="grid gap-3 px-3 pb-3 text-xs sm:grid-cols-[minmax(0,1fr)_minmax(12rem,0.65fr)] sm:px-4">
        <div className="min-w-0">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Command
          </div>
          <code
            className={cn(
              "block min-w-0 truncate rounded-md border border-border/70 bg-background/45 px-2 py-1.5 font-mono text-[11px] text-foreground/80",
              action.command === null && "italic text-muted-foreground",
            )}
          >
            {action.command ?? "Command unavailable"}
          </code>
        </div>
        <div>
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            What happens next
          </div>
          <p className="leading-4 text-muted-foreground">
            The Action runs independently. When it finishes, LastCode resumes the agent once this
            thread is idle.
          </p>
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t border-border/70 px-3 py-2 sm:px-4">
        <Button size="xs" variant="outline" onClick={onOpenTerminal}>
          <TerminalIcon aria-hidden className="size-3.5" />
          Open terminal
        </Button>
        <Button size="xs" variant="destructive-outline" disabled={cancelling} onClick={onCancel}>
          {cancelling ? "Cancelling..." : "Cancel Action"}
        </Button>
      </div>
    </div>
  );
});
