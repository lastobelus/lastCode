import type { ActionResumeState, ActionResumeStatus } from "@t3tools/contracts";
import {
  actionResultPresentation,
  actionRunningPresentation,
  actionWaitPresentation,
  actionResumeStatus,
} from "@t3tools/shared/actionResume";
import { CircleAlertIcon, TerminalIcon } from "lucide-react";
import { memo, useEffect, useState } from "react";

import { formatWorkingDurationLabel } from "@t3tools/client-runtime/state/models";
import { Button } from "../ui/button";
import { cn } from "~/lib/utils";
import { RotateCcwClockIcon } from "../icons/RotateCcwClockIcon";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

export function runningActionBanner({
  action,
  status,
  cancelling,
  canRead,
  canOperate,
  onCancel,
  onOpenTerminal,
}: {
  readonly action: ActionResumeState | null;
  readonly status: ActionResumeStatus | null;
  readonly cancelling: boolean;
  readonly canRead: boolean;
  readonly canOperate: boolean;
  readonly onCancel: () => void;
  readonly onOpenTerminal: () => void;
}): ComposerBannerStackItem | null {
  if (action === null) return null;
  return {
    id: `action-running:${action.runId}`,
    group: "environment",
    variant: actionWaitPresentation(action, status)?.tone ?? "info",
    icon: <RotateCcwClockIcon aria-hidden className="size-4" />,
    title: <ComposerActionResumeTitle action={action} />,
    description: <ComposerActionResumeDescription action={action} status={status} />,
    actions: canOperate ? (
      <ComposerActionResumeActions
        action={action}
        cancelling={cancelling}
        onCancel={onCancel}
        onOpenTerminal={onOpenTerminal}
      />
    ) : canRead ? (
      <Button size="xs" variant="ghost" onClick={onOpenTerminal}>
        Open terminal
      </Button>
    ) : undefined,
  };
}

export function pendingActionBanner({
  action,
  status,
  canRead,
  onOpenTerminal,
}: {
  readonly action: ActionResumeState | null;
  readonly status: ActionResumeStatus | null;
  readonly canRead: boolean;
  readonly onOpenTerminal: () => void;
}): ComposerBannerStackItem | null {
  if (action === null || action.outcome === "running" || action.delivery === "available")
    return null;
  const presentation = actionWaitPresentation(action, status);
  if (presentation === null) return null;
  const result = actionResultPresentation({
    lifecycleOutcome: action.outcome,
    validatedStatus: action.outcome,
    exitCode: action.exitCode,
    report: action.report ?? null,
    lastOutputLine: "",
  });
  const summary = result.summary.trim();
  const resultCopy = `${result.label}${summary ? `: ${summary}` : ""}`;
  return {
    id: `action-follow-up:${action.runId}`,
    group: "environment",
    role: "status",
    variant: presentation.tone,
    icon: <TerminalIcon aria-hidden className="size-4" />,
    title: `${action.actionName} · ${presentation.label}`,
    description: `${resultCopy}${/[.!?]$/.test(resultCopy) ? " " : ". "}${presentation.detail}`,
    actions: canRead ? (
      <Button size="xs" variant="ghost" onClick={onOpenTerminal}>
        Open terminal
      </Button>
    ) : undefined,
  };
}

export function interruptedActionBanner({
  action,
  status,
  canOperate,
  pending,
  onResume,
  onDiscard,
}: {
  readonly action: ActionResumeState | null;
  readonly status: ActionResumeStatus | null;
  readonly canOperate: boolean;
  readonly pending: "resume" | "discard" | null;
  readonly onResume: () => void;
  readonly onDiscard: () => void;
}): ComposerBannerStackItem | null {
  if (action === null) return null;
  const presentation = actionWaitPresentation(
    action,
    status ?? actionResumeStatus({ action, environmentPaused: false, hasPendingRequest: false }),
  );
  if (presentation === null) return null;
  const disabled = !canOperate || pending !== null;
  return {
    id: `action-interrupted:${action.runId}`,
    variant: "warning",
    icon: <CircleAlertIcon />,
    title: `${action.actionName} · ${presentation.label}`,
    description: presentation.detail,
    actions: (
      <div className="flex items-center gap-1.5">
        <Button size="xs" variant="ghost" disabled={disabled} onClick={onDiscard}>
          {pending === "discard" ? "Discarding..." : "Discard"}
        </Button>
        <Button size="xs" variant="outline" disabled={disabled} onClick={onResume}>
          {pending === "resume" ? "Resuming..." : "Resume agent"}
        </Button>
      </div>
    ),
  };
}

function ActionElapsed({ startedAt }: { readonly startedAt: string }) {
  const startedMs = Date.parse(startedAt);
  const [now, setNow] = useState(Date.now);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns a browser interval while mounted to refresh the elapsed action time and releases it on unmount
  useEffect(() => {
    if (Number.isNaN(startedMs)) return;
    const intervalId = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(intervalId);
  }, [startedMs]);

  if (Number.isNaN(startedMs)) return null;
  return <>{formatWorkingDurationLabel(now - startedMs)}</>;
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
      <span className="min-w-0 truncate font-semibold text-foreground">{action.actionName}</span>
    </span>
  );
});

export const ComposerActionResumeDescription = memo(function ComposerActionResumeDescription({
  action,
  status,
}: {
  readonly action: ActionResumeState;
  readonly status: ActionResumeStatus | null;
}) {
  const presentation = actionRunningPresentation(action);
  const detail = action.progress?.detail?.trim();
  const summary =
    presentation.summary.trim() === action.actionName.trim() ? null : presentation.summary;
  const context = [summary, detail].filter(Boolean).join(". ");
  const contextCopy = context ? `${context}${/[.!?]$/.test(context) ? " " : ". "}` : "";

  return (
    <span className="line-clamp-3">
      {contextCopy}
      {actionWaitPresentation(action, status)?.detail}
    </span>
  );
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
