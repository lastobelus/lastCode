import type { ActionResumeState } from "@t3tools/contracts";
import { actionRunningPresentation } from "@t3tools/shared/actionResume";
import { TerminalIcon } from "lucide-react";
import { memo, useEffect, useState } from "react";

import { formatWorkingDurationLabel } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { cn } from "~/lib/utils";

function ActionElapsed({ startedAt }: { readonly startedAt: string }) {
  const startedMs = Date.parse(startedAt);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (Number.isNaN(startedMs)) return;
    const intervalId = window.setInterval(() => setTick((tick) => tick + 1), 1_000);
    return () => window.clearInterval(intervalId);
  }, [startedMs]);

  if (Number.isNaN(startedMs)) return null;
  return <>{formatWorkingDurationLabel(Date.now() - startedMs)}</>;
}

export const ComposerActionResumeTitle = memo(function ComposerActionResumeTitle({
  action,
}: {
  readonly action: ActionResumeState;
}) {
  const presentation = actionRunningPresentation(action);
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="shrink-0 font-normal text-muted-foreground">{presentation.label}</span>
      <span className="min-w-0 truncate font-semibold text-foreground">{presentation.summary}</span>
    </span>
  );
});

export const ComposerActionResumeDescription = memo(function ComposerActionResumeDescription({
  action,
}: {
  readonly action: ActionResumeState;
}) {
  const presentation = actionRunningPresentation(action);
  const detail = action.progress?.detail?.trim();
  const actionName = action.actionName.trim();
  const context = detail || (presentation.summary.trim() === actionName ? null : actionName);
  const contextCopy = context ? `${context}${/[.!?]$/.test(context) ? " " : ". "}` : "";

  return <span className="line-clamp-2">{contextCopy}Resumes when this thread is idle.</span>;
});

export const ComposerActionResumeActions = memo(function ComposerActionResumeActions({
  action,
  cancelling,
  onCancel,
  onOpenTerminal,
}: {
  readonly action: ActionResumeState;
  readonly cancelling: boolean;
  readonly onCancel: () => void;
  readonly onOpenTerminal: () => void;
}) {
  const presentation = actionRunningPresentation(action);
  return (
    <div className="flex max-w-full items-center justify-end gap-1.5">
      <span
        className={cn(
          "shrink-0 font-mono text-xs tabular-nums text-muted-foreground",
          presentation.state === "working" ? "text-info-foreground" : "text-warning-foreground",
        )}
        aria-label={`${presentation.label} elapsed time`}
      >
        <ActionElapsed startedAt={action.startedAt} />
      </span>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Open Action terminal"
        onClick={onOpenTerminal}
      >
        <TerminalIcon aria-hidden className="size-3.5" />
      </Button>
      <Button size="xs" variant="destructive-outline" disabled={cancelling} onClick={onCancel}>
        {cancelling ? "Cancelling..." : "Cancel"}
      </Button>
    </div>
  );
});
