import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { environmentPauseResumeComplete, type EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import { CheckCircle2Icon, PauseIcon, PlayIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { environmentPause } from "../../state/environmentPause";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** One explicit environment per operation, even when the sidebar combines environments. */
export function EnvironmentPauseControl({ onBackdrop }: { onBackdrop: boolean }) {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [selectedId, setSelectedId] = useState<EnvironmentId | null>(null);
  const [open, setOpen] = useState(false);
  // A slow shared read discovers sessions started on another client, even when disabled.
  const statuses = useAtomValue(
    useMemo(
      () =>
        Atom.make(
          (get) =>
            new Map(
              environments
                .filter(
                  (environment) =>
                    environment.serverConfig?.environment.capabilities.environmentPause === true,
                )
                .map((environment) => [
                  environment.environmentId,
                  get(
                    environmentPause.monitorStatus({
                      environmentId: environment.environmentId,
                      input: {},
                    }),
                  ),
                ]),
            ),
        ),
      [environments],
    ),
  );
  const choices = environments.filter((environment) => {
    const status = statuses.get(environment.environmentId);
    const retained = status ? Option.getOrNull(AsyncResult.value(status))?.session : null;
    return environment.serverConfig?.settings.environmentPauseEnabled === true || retained != null;
  });
  const selected =
    choices.find((environment) => environment.environmentId === selectedId) ??
    choices.find((environment) => {
      const result = statuses.get(environment.environmentId);
      return result && Option.getOrNull(AsyncResult.value(result))?.session != null;
    }) ??
    choices.find((environment) => environment.environmentId === primaryEnvironmentId) ??
    choices[0];
  if (open && !selected) setOpen(false);
  if (!selected) return null;
  const hasSession = choices.some((environment) => {
    const status = statuses.get(environment.environmentId);
    return status && Option.getOrNull(AsyncResult.value(status))?.session != null;
  });
  const label = hasSession ? "Environment pause and resume" : "Pause environment";

  return (
    <div className="relative z-10 flex shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label={label}
              size="titlebar-icon"
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
          key={`${selected.environmentId}:${selected.connection.phase}`}
          environmentId={selected.environmentId}
          label={selected.label}
          connected={selected.connection.phase === "connected"}
          enabled={selected.serverConfig?.settings.environmentPauseEnabled === true}
          choices={choices.map((environment) => ({
            id: environment.environmentId,
            label: environment.label,
          }))}
          onSelect={setSelectedId}
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
  choices,
  onSelect,
  onClose,
}: {
  environmentId: EnvironmentId;
  label: string;
  connected: boolean;
  enabled: boolean;
  choices: readonly { id: EnvironmentId; label: string }[];
  onSelect: (environmentId: EnvironmentId) => void;
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
  const unavailableRecipients =
    session?.targets.filter((thread) => thread.resume === "unavailable") ?? [];
  const resuming = session?.phase === "resuming";
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
    try {
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
    } finally {
      setPending(false);
    }
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
              : "Pause environment?"}
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
            {choices.length > 1 ? (
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="pause-environment">
                  Environment
                </label>
                <Select
                  value={environmentId}
                  onValueChange={(value) => {
                    const choice = choices.find((candidate) => candidate.id === value);
                    if (choice) onSelect(choice.id);
                  }}
                  disabled={pending}
                >
                  <SelectTrigger id="pause-environment" className="w-full">
                    <SelectValue>{label}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {choices.map((choice) => (
                      <SelectItem key={choice.id} value={choice.id}>
                        {choice.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            ) : null}
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
            {resuming && unavailableRecipients.length > 0 ? (
              <div className="space-y-1 text-sm text-muted-foreground">
                <p>Archived or deleted threads cannot receive resume requests.</p>
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
