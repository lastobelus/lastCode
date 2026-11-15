import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import { CheckCircle2Icon, PauseIcon, PlayIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { EnvironmentPresentation } from "../state/environments";
import { environmentPause } from "../state/environmentPause";
import { useAtomCommand } from "../state/use-atom-command";
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
import { Spinner } from "./ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { useActionEnvironmentPause } from "../state/actionResume";
import {
  actionResumeControlCopy,
  actionResumeUnknownPresentation,
  environmentPausePresentation,
  environmentPauseBlockerLabel,
} from "@t3tools/shared/actionResume";

type EnvironmentPauseControlProps = {
  environment: EnvironmentPresentation;
  onBackdrop?: boolean;
  size?: "titlebar-icon" | "icon-sm";
  showEnvironmentLabel?: boolean;
};

function pauseErrorMessage(failure: Parameters<typeof squashAtomCommandFailure>[0]) {
  const cause = squashAtomCommandFailure(failure);
  return typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string" &&
    cause.message.trim() !== ""
    ? cause.message
    : "The request failed. Try again.";
}

export function EnvironmentPauseNotice({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const { environment, phase, known, showUnknown } = useActionEnvironmentPause(environmentId);
  const [open, setOpen] = useState(false);
  if (environment === null || (phase === null && !showUnknown && !open)) return null;
  const presentation =
    known && phase !== null ? environmentPausePresentation(phase) : actionResumeUnknownPresentation;
  return (
    <div
      role="status"
      className="rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-sm"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 font-medium">
          {environment.label} · {presentation.label}
        </span>
        <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
          {actionResumeControlCopy.manage_pause.label}
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{presentation.detail}</p>
      {open ? (
        <EnvironmentPauseDialog
          key={environmentId}
          environmentId={environmentId}
          label={environment.label}
          connected={environment.connection.phase === "connected"}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

export function EnvironmentPauseControl(props: EnvironmentPauseControlProps) {
  if (props.environment.serverConfig?.environment.capabilities.environmentPause !== true)
    return null;
  return <EnvironmentPauseButton key={props.environment.environmentId} {...props} />;
}

function EnvironmentPauseButton({
  environment,
  onBackdrop = false,
  size = "icon-sm",
  showEnvironmentLabel = false,
}: EnvironmentPauseControlProps) {
  const result = useAtomValue(
    environmentPause.monitorStatus({ environmentId: environment.environmentId, input: {} }),
  );
  const intent = useAtomValue(environmentPause.intent(environment.environmentId));
  const session = Option.getOrNull(AsyncResult.value(result))?.session ?? null;
  const hasSession = intent !== null || session !== null;
  const shouldResume =
    intent === "start" || (intent !== "resume" && session !== null && session.phase !== "resuming");
  const enabled = environment.serverConfig?.settings.environmentPauseEnabled === true;
  const canStart = useAtomValue(environmentPause.start.permissionAtom(environment.environmentId));
  const canResume = useAtomValue(environmentPause.resume.permissionAtom(environment.environmentId));
  const start = useAtomCommand(environmentPause.start, { reportFailure: false });
  const resume = useAtomCommand(environmentPause.resume, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);
  if (!enabled && !hasSession) return null;
  const label = `${shouldResume ? "Resume" : "Pause"} ${environment.label}`;
  const disabled =
    environment.connection.phase !== "connected" ||
    (shouldResume ? !canResume : !enabled || !canStart);
  const execute = async () => {
    if (disabled) return;
    const version = ++requestVersion.current;
    setError(null);
    const outcome = await (shouldResume ? resume : start)({
      environmentId: environment.environmentId,
      input: {},
    });
    if (version === requestVersion.current && AsyncResult.isFailure(outcome)) {
      setError(pauseErrorMessage(outcome));
    }
  };

  return (
    <div className="relative z-10 flex shrink-0 items-center gap-1">
      {showEnvironmentLabel ? (
        <span className="text-sm text-muted-foreground">{environment.label}</span>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label={label}
              size={size}
              variant={onBackdrop ? "media-toggle" : "ghost-toggle"}
              disabled={disabled}
              onClick={() => void execute()}
            >
              {shouldResume ? <PlayIcon /> : <PauseIcon />}
            </Button>
          }
        />
        <TooltipPopup side="bottom">{label}</TooltipPopup>
      </Tooltip>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function EnvironmentPauseDialog({
  environmentId,
  label,
  connected,
  onClose,
}: {
  environmentId: EnvironmentId;
  label: string;
  connected: boolean;
  onClose: () => void;
}) {
  const target = { environmentId, input: {} };
  const [observedAfter] = useState(() => Date.now());
  const result = useAtomValue(environmentPause.activeStatus(target));
  const refresh = useAtomRefresh(environmentPause.activeStatus(target));
  const refreshInitial = useAtomRefresh(environmentPause.status(target));
  const status = Option.getOrNull(AsyncResult.value(result));
  const session = status?.session ?? null;
  const known =
    connected &&
    AsyncResult.isSuccess(result) &&
    result.timestamp >= observedAfter &&
    status?.observation === "known";
  const canResume = useAtomValue(environmentPause.resume.permissionAtom(environmentId));
  const canRetry = useAtomValue(environmentPause.retry.permissionAtom(environmentId));
  const intent = useAtomValue(environmentPause.intent(environmentId));
  const starting = intent === "start";
  const resume = useAtomCommand(environmentPause.resume, { reportFailure: false });
  const retry = useAtomCommand(environmentPause.retry, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);
  const pauseFailures = session?.targets.filter((thread) => thread.pause === "failed") ?? [];
  const resumeFailures =
    session?.targets.filter((thread) => thread.pause === "sent" && thread.resume === "failed") ??
    [];
  const resuming = intent === "resume" || (intent !== "start" && session?.phase === "resuming");
  const showRetryPause =
    session !== null &&
    session.phase !== "resuming" &&
    intent !== "resume" &&
    (pauseFailures.length > 0 || status?.quiet !== true);
  const unavailableRecipients =
    session?.targets.filter((thread) =>
      resuming
        ? thread.pause === "sent" && thread.resume === "unavailable"
        : thread.pause === "unavailable",
    ) ?? [];
  const quiet = known && status.quiet && pauseFailures.length === 0;
  const sawSession = useRef(false);
  // Delivery receipts may finish after Resume returns; close only after the server clears the session.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes the mounted pause dialog only after the server confirms that the previously observed session has cleared
  useEffect(() => {
    if (session !== null) sawSession.current = true;
    else if (known && sawSession.current) onClose();
  }, [known, onClose, session]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes the server pause-status atom when this dialog mounts so it observes the current connection
  useEffect(() => refreshInitial(), [refreshInitial]);

  const execute = async (action: "resume" | "retry") => {
    if (!connected || (action === "retry" ? !showRetryPause || !canRetry : !canResume)) return;
    setError(null);
    const outcome = await (action === "retry" ? retry : resume)(target);
    refresh();
    refreshInitial();
    if (AsyncResult.isFailure(outcome)) {
      setError(pauseErrorMessage(outcome));
    } else if (action === "resume" && outcome.value.session === null) {
      onClose();
    }
  };

  return (
    <Dialog open onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {session
              ? resuming
                ? "Resuming threads"
                : quiet
                  ? "Environment is quiet"
                  : "Pausing threads"
              : starting
                ? "Pausing threads"
                : label}
          </DialogTitle>
          <DialogDescription>
            {session
              ? resuming
                ? `Sending “resume” to the threads on ${label} that received Pause.`
                : `Automatic thread wake-ups on ${label} are held until you resume.`
              : starting
                ? "Checking thread activity…"
                : "Not paused."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            {!known ? (
              <p role="status" className="text-sm text-muted-foreground">
                {connected
                  ? AsyncResult.isFailure(result)
                    ? "Could not check thread activity. Reconnect or try again."
                    : "Checking thread activity…"
                  : "Waiting for the environment to reconnect. Its activity is unknown."}
              </p>
            ) : session ? (
              <div className="flex items-center gap-3" role="status" aria-live="polite">
                {quiet && !resuming ? (
                  <CheckCircle2Icon className="size-5 text-success" />
                ) : (
                  <Spinner size="lg" />
                )}
                <div>
                  <p className="font-medium tabular-nums">
                    {resuming
                      ? "Automatic thread wake-ups are back on"
                      : quiet
                        ? "All threads are quiet"
                        : `${status.activeThreadCount} active ${status.activeThreadCount === 1 ? "thread" : "threads"} remaining`}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {resuming
                      ? "Work that was held will start as threads become available."
                      : quiet
                        ? "You can go offline. Return here to resume the paused threads."
                        : status.activeThreadCount === 0 && status.blockers.length > 0
                          ? "Waiting for background work to finish. You can resume at any time."
                          : "Waiting for threads to stop. You can resume at any time."}
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {status.activeThreadCount} active{" "}
                {status.activeThreadCount === 1 ? "thread" : "threads"}. Pause sends each one “pause
                to go offline”.
              </p>
            )}
            {known && session && !resuming && status.blockers.length > 0 ? (
              <div className="space-y-1 text-sm text-muted-foreground">
                <p>Unfinished work</p>
                <ul className="list-inside list-disc">
                  {status.blockers.map((blocker) => {
                    const target =
                      "threadId" in blocker
                        ? session.targets.find((thread) => thread.threadId === blocker.threadId)
                        : undefined;
                    return (
                      <li key={JSON.stringify(blocker)}>
                        {environmentPauseBlockerLabel(blocker)}
                        {target ? ` · ${target.title}` : ""}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
            {(resuming ? resumeFailures : pauseFailures).length > 0 ? (
              <div role="alert" className="space-y-1 text-sm text-destructive">
                <p>
                  {resuming
                    ? "These threads didn’t get the resume message. Press Resume to try again."
                    : "These threads didn’t get the pause message and may still be running."}
                </p>
                <ul className="list-inside list-disc">
                  {(resuming ? resumeFailures : pauseFailures).map((thread) => (
                    <li key={thread.threadId}>
                      {thread.title}
                      {thread.error ? `: ${thread.error}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {unavailableRecipients.length > 0 ? (
              <div className="space-y-1 text-sm text-muted-foreground">
                <p>{resuming ? "Not resumed" : "No pause needed"}</p>
                <ul className="list-inside list-disc">
                  {unavailableRecipients.map((thread) => (
                    <li key={thread.threadId}>
                      {thread.title}
                      {thread.error ? `: ${thread.error}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            {!canResume ? (
              <p className="text-sm text-muted-foreground">
                This connection does not have permission to send thread messages.
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {showRetryPause ? (
            <Button
              variant="outline"
              disabled={!connected || !canRetry}
              onClick={() => void execute("retry")}
            >
              {pauseFailures.length > 0 ? "Retry pause" : "Pause remaining threads"}
            </Button>
          ) : null}
          {session || intent !== null ? (
            <Button disabled={!connected || !canResume} onClick={() => void execute("resume")}>
              <PlayIcon />
              Resume
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
