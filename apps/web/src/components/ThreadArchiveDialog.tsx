import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import type {
  ScopedThreadRef,
  ThreadArchiveConsultationTarget,
  ThreadId,
} from "@t3tools/contracts";
import { threadArchiveConsultationUnavailableReason } from "@t3tools/client-runtime/state/thread-archive";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { buildThreadArchiveConfirmation } from "@t3tools/client-runtime/state/thread-archive";
import { Button } from "./ui/button";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";

export type ArchiveChildDisposition = "stop_and_archive" | "archive_after_review";
type Request = {
  readonly title: string;
  readonly family: Parameters<typeof buildThreadArchiveConfirmation<EnvironmentThreadShell>>[0];
  /** A failed attempt closes; the caller reports its original error. */
  readonly submit: (choice: ArchiveChildDisposition) => Promise<string | null>;
  readonly review?: (ref: ScopedThreadRef) => Promise<unknown>;
  readonly reviewFamilies?: readonly { readonly ref: ScopedThreadRef; readonly title: string }[];
  readonly consultation?: {
    readonly targets: readonly ThreadArchiveConsultationTarget[];
    readonly ask: (ownerThreadId: ThreadId) => Promise<string | null>;
    readonly environmentId: ScopedThreadRef["environmentId"];
  };
  readonly resolve: (choice: ArchiveChildDisposition | null) => void;
};
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));
let hostMounted = false;

export function requestThreadArchiveDialog(
  request: Omit<Request, "resolve">,
): Promise<ArchiveChildDisposition | null> {
  // A missing host must never turn a required confirmation into consent.
  if (!hostMounted || useRequest.getState().request) return Promise.resolve(null);
  return new Promise((resolve) => useRequest.setState({ request: { ...request, resolve } }));
}

function finish(choice: ArchiveChildDisposition | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(choice);
}

export function ThreadArchiveDialogHost() {
  const request = useRequest((state) => state.request);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the mounted dialog host and resolves its outstanding imperative request on unmount
  useEffect(() => {
    hostMounted = true;
    return () => {
      hostMounted = false;
      finish(null);
    };
  }, []);
  return request ? <ThreadArchiveDialog request={request} /> : null;
}

function ThreadArchiveDialog({ request }: { request: Request }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const submitting = useRef(false);
  const [choice, setChoice] = useState<ArchiveChildDisposition | null>(null);
  const [asking, setAsking] = useState<ThreadId | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const busy = choice !== null || asking !== null;
  const ask = async (ownerThreadId: ThreadId) => {
    if (submitting.current || !request.consultation) return;
    submitting.current = true;
    setAsking(ownerThreadId);
    setFeedback(null);
    try {
      const failure = await request.consultation.ask(ownerThreadId);
      if (failure === null) finish(null);
      else setFeedback(failure);
    } catch (error) {
      setFeedback(
        error instanceof Error ? error.message : "The question could not be sent. Try again.",
      );
    }
    submitting.current = false;
    setAsking(null);
  };
  const review = async (ref: ScopedThreadRef) => {
    if (submitting.current || !request.review) return;
    submitting.current = true;
    try {
      await request.review(ref);
      finish(null);
    } catch (error) {
      setFeedback(
        error instanceof Error ? error.message : "The conversation could not be opened. Try again.",
      );
    }
    submitting.current = false;
  };
  const confirmation = buildThreadArchiveConfirmation(request.family);
  const submit = async (next: ArchiveChildDisposition) => {
    if (submitting.current) return;
    submitting.current = true;
    setChoice(next);
    await (async () => {
      const failure = await request.submit(next);
      if (failure === null) finish(next);
      else finish(null);
    })()
      .catch(() => {
        finish(null);
      })
      .finally(() => {
        submitting.current = false;
        setChoice(null);
      });
  };
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting.current) finish(null);
      }}
    >
      <AlertDialogPopup initialFocus={cancelRef}>
        <AlertDialogHeader>
          <AlertDialogTitle>{request.title}</AlertDialogTitle>
          <AlertDialogDescription>{confirmation.description}</AlertDialogDescription>
          <ul
            aria-label="Threads needing attention"
            className="max-h-64 space-y-1 overflow-y-auto text-sm"
          >
            {confirmation.threads.map(({ thread, label }) => (
              <li
                key={`${thread.environmentId}:${thread.id}`}
                className="flex justify-between gap-3"
              >
                <span className="min-w-0 break-words">{thread.title || "Untitled thread"}</span>
                <span className="shrink-0 text-muted-foreground">{label}</span>
                {request.review && !request.reviewFamilies ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void review({ environmentId: thread.environmentId, threadId: thread.id })
                    }
                  >
                    Review
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          {request.reviewFamilies ? (
            <ul
              aria-label="Families to review"
              className="max-h-64 space-y-2 overflow-y-auto text-sm"
            >
              {request.reviewFamilies.map(({ ref, title }) => (
                <li
                  key={`${ref.environmentId}:${ref.threadId}`}
                  className="flex items-center justify-between gap-3"
                >
                  <span>{title || "Untitled thread"}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void review(ref)}
                  >
                    Review
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          {request.consultation ? (
            <ul aria-label="Agents to ask" className="max-h-64 space-y-3 overflow-y-auto text-sm">
              {request.consultation.targets.map((target) => {
                const reason = threadArchiveConsultationUnavailableReason(target);
                return (
                  <li key={target.ownerThreadId} className="space-y-1">
                    <div className="font-medium">{target.ownerTitle || "Untitled thread"}</div>
                    <ul className="space-y-1 text-muted-foreground">
                      {target.work.map((work) => (
                        <li
                          key={[work.threadId, work.taskId, work.runId, work.attemptId].join(":")}
                        >
                          {request.family.threads.find((thread) => thread.id === work.threadId)
                            ?.title || "Untitled thread"}
                          <span className="block break-all text-xs">
                            {[work.threadId, work.taskId, work.runId, work.attemptId]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {reason ? <p>{reason}</p> : null}
                    <div className="flex gap-2">
                      {request.review ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            void review({
                              environmentId: request.consultation!.environmentId,
                              threadId: target.ownerThreadId,
                            })
                          }
                        >
                          Review agent
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || reason !== null}
                        onClick={() => void ask(target.ownerThreadId)}
                      >
                        {asking === target.ownerThreadId ? "Sending…" : "Ask the agent"}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {feedback ? (
            <p role="status" className="text-sm text-destructive">
              {feedback}
            </p>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button ref={cancelRef} variant="outline" disabled={busy} onClick={() => finish(null)}>
            {confirmation.blocked ? "Close" : "Cancel"}
          </Button>
          {!confirmation.blocked ? (
            <Button
              variant={confirmation.active ? "destructive" : "default"}
              disabled={busy}
              onClick={() => void submit(confirmation.disposition)}
            >
              {choice !== null ? "Archiving…" : confirmation.confirmLabel}
            </Button>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
