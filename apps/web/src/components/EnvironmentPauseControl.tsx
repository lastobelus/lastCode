import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { environmentPauseResumeComplete, type EnvironmentId } from "@t3tools/contracts";
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

type EnvironmentPauseControlProps = {
  environment: EnvironmentPresentation;
  onBackdrop?: boolean;
  size?: "titlebar-icon" | "icon-sm";
  showEnvironmentLabel?: boolean;
};

/** Every entry point stays bound to one machine, including while its dialog is open. */
export function EnvironmentPauseControl(props: EnvironmentPauseControlProps) {
  if (props.environment.serverConfig?.environment.capabilities.environmentPause !== true)
    return null;
  return <EnvironmentPauseButton {...props} />;
}

function EnvironmentPauseButton({
  environment,
  onBackdrop = false,
  size = "icon-sm",
  showEnvironmentLabel = false,
}: EnvironmentPauseControlProps) {
  const [open, setOpen] = useState(false);
  const result = useAtomValue(
    environmentPause.monitorStatus({ environmentId: environment.environmentId, input: {} }),
  );
  const hasSession = Option.getOrNull(AsyncResult.value(result))?.session != null;
  const enabled = environment.serverConfig?.settings.environmentPauseEnabled === true;
  if (!enabled && !hasSession && !open) return null;
  const label = hasSession ? `Pause and resume ${environment.label}` : `Pause ${environment.label}`;

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
              onClick={() => setOpen(true)}
            >
              {hasSession ? <PlayIcon /> : <PauseIcon />}
            </Button>
          }
        />
        <TooltipPopup side="bottom">{label}</TooltipPopup>
      </Tooltip>
      {open ? (
        <EnvironmentPauseDialog
          key={`${environment.environmentId}:${environment.connection.phase}`}
          environmentId={environment.environmentId}
          label={environment.label}
          connected={environment.connection.phase === "connected"}
          enabled={enabled}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

function EnvironmentPauseDialog({
  environmentId,
  label,
  connected,
  enabled,
  onClose,
}: {
  environmentId: EnvironmentId;
  label: string;
  connected: boolean;
  enabled: boolean;
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
  const canStart = useAtomValue(environmentPause.start.permissionAtom(environmentId));
  const canRetry = useAtomValue(environmentPause.retry.permissionAtom(environmentId));
  const canResume = useAtomValue(environmentPause.resume.permissionAtom(environmentId));
  const start = useAtomCommand(environmentPause.start, { reportFailure: false });
  const retry = useAtomCommand(environmentPause.retry, { reportFailure: false });
  const resume = useAtomCommand(environmentPause.resume, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pauseFailures = session?.targets.filter((thread) => thread.pause === "failed") ?? [];
  const resumeFailures = session?.targets.filter((thread) => thread.resume === "failed") ?? [];
  const resuming = session?.phase === "resuming";
  const unavailableRecipients =
    session?.targets.filter(
      (thread) => thread.pause === "unavailable" || (resuming && thread.resume === "unavailable"),
    ) ?? [];
  const quiet = known && status.quiet && pauseFailures.length === 0;
  const canCancelPause =
    known &&
    session !== null &&
    !resuming &&
    !quiet &&
    session.targets.every((thread) => thread.pause !== "pending");
  const sawSession = useRef(false);
  // Delivery receipts may finish after Resume returns; close only after the server clears the session.
  useEffect(() => {
    if (session !== null) sawSession.current = true;
    else if (known && sawSession.current) onClose();
  }, [known, onClose, session]);
  useEffect(() => refreshInitial(), [refreshInitial]);

  const execute = async (action: "start" | "retry" | "resume") => {
    setPending(true);
    setError(null);
    await (async () => {
      const outcome = await (action === "start" ? start : action === "retry" ? retry : resume)(
        target,
      );
      refresh();
      refreshInitial();
      if (AsyncResult.isFailure(outcome)) {
        setError(
          action === "resume"
            ? "Could not resume the environment. Reconnect and try again."
            : "Could not send the pause request. Reconnect and try again.",
        );
      } else if (action === "resume" && outcome.value.session === null) {
        onClose();
      }
    })().finally(() => {
      setPending(false);
    });
  };

  return (
    <Dialog open onOpenChange={(nextOpen) => !nextOpen && !pending && onClose()}>
      <DialogPopup showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>
            {session
              ? resuming
                ? "Resuming threads"
                : quiet
                  ? "Environment is quiet"
                  : "Pausing threads"
              : `Pause ${label}?`}
          </DialogTitle>
          <DialogDescription>
            {session
              ? resuming
                ? `Resume requests for ${label}.`
                : `Automatic thread wake-ups on ${label} are held until you resume.`
              : `Ask all active threads on ${label} to pause safely before you go offline. Automatic thread wake-ups will wait until you resume, even if the environment reconnects. Resume will message those same threads when you return.`}
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
                      ? "Automatic thread wake-ups are enabled"
                      : quiet
                        ? "All threads are quiet"
                        : `${status.activeThreadCount} active ${status.activeThreadCount === 1 ? "thread" : "threads"} remaining`}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {resuming
                      ? "Held work will continue as threads become available."
                      : quiet
                        ? "You can go offline. Return here to resume the paused threads."
                        : status.activeThreadCount === 0 && status.blockers.length > 0
                          ? "Waiting for background work to finish."
                          : "Waiting for threads to finish their pause requests."}
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {status.activeThreadCount} active{" "}
                {status.activeThreadCount === 1 ? "thread will" : "threads will"} receive “pause to
                go offline”.
              </p>
            )}
            {pauseFailures.length > 0 || resumeFailures.length > 0 ? (
              <div role="alert" className="space-y-1 text-sm text-destructive">
                <p>
                  {resuming
                    ? "Some resume messages could not be sent."
                    : "Some pause messages could not be sent."}
                </p>
                <ul className="list-inside list-disc">
                  {(resuming ? resumeFailures : pauseFailures).map((thread) => (
                    <li key={thread.threadId}>{thread.title}</li>
                  ))}
                </ul>
                <p>Retry sends only the messages that are still missing.</p>
              </div>
            ) : null}
            {unavailableRecipients.length > 0 ? (
              <div className="space-y-1 text-sm text-muted-foreground">
                <p>
                  Archived or deleted threads cannot receive {resuming ? "resume" : "pause"}{" "}
                  requests.
                </p>
                <ul className="list-inside list-disc">
                  {unavailableRecipients.map((thread) => (
                    <li key={thread.threadId}>{thread.title}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            {known && !canStart && !canResume ? (
              <p className="text-sm text-muted-foreground">
                This connection does not have permission to send thread messages.
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            {session ? "Close" : "Cancel"}
          </Button>
          {canCancelPause ? (
            <Button
              variant="outline"
              disabled={pending || !canResume}
              onClick={() => void execute("resume")}
            >
              Cancel pause
            </Button>
          ) : null}
          {!session ? (
            <Button
              disabled={pending || !known || !enabled || !canStart}
              onClick={() => void execute("start")}
            >
              {pending ? <Spinner /> : <PauseIcon />}
              Pause threads
            </Button>
          ) : resuming && environmentPauseResumeComplete(session) ? (
            <Button
              disabled={pending || !known || !enabled || !canStart}
              onClick={() => void execute("start")}
            >
              {pending ? <Spinner /> : <PauseIcon />}
              Pause again
            </Button>
          ) : resuming || quiet ? (
            <Button
              disabled={pending || !known || !canResume}
              onClick={() => void execute("resume")}
            >
              {pending ? <Spinner /> : <PlayIcon />}
              {resuming ? "Retry resume" : "Resume"}
            </Button>
          ) : (
            <Button disabled={pending || !known || !canRetry} onClick={() => void execute("retry")}>
              {pending ? <Spinner /> : <PauseIcon />}
              {pauseFailures.length > 0 ? "Retry pause messages" : "Pause remaining threads"}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
