import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
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
  const confirmation = buildThreadArchiveConfirmation(request.family);
  const submit = async (next: ArchiveChildDisposition) => {
    if (submitting.current) return;
    submitting.current = true;
    setChoice(next);
    try {
      const failure = await request.submit(next);
      if (failure === null) finish(next);
      else finish(null);
    } catch {
      finish(null);
    } finally {
      submitting.current = false;
      setChoice(null);
    }
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
              </li>
            ))}
          </ul>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button
            ref={cancelRef}
            variant="outline"
            disabled={choice !== null}
            onClick={() => finish(null)}
          >
            {confirmation.blocked ? "Close" : "Cancel"}
          </Button>
          {!confirmation.blocked ? (
            <Button
              variant={confirmation.active ? "destructive" : "default"}
              disabled={choice !== null}
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
