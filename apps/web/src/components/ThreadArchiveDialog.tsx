import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { legacySidebarSubagentStatusLabel } from "./legacySidebarFamilies.logic";
import { resolveThreadStatusPill } from "./Sidebar.logic";
import { Button } from "./ui/button";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";

export type ArchiveChildDisposition = "stop_and_archive" | "promote";
type Request = {
  readonly title: string;
  readonly children: ReadonlyArray<EnvironmentThreadShell>;
  readonly activeChildren: ReadonlyArray<EnvironmentThreadShell>;
  readonly canPromote: boolean;
  readonly canStopAndArchive: boolean;
  readonly protectedCount: number;
  readonly nativeCount: number;
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
  const activeCount = request.activeChildren.length;
  const count = request.children.length;
  const listedChildren =
    request.activeChildren.length > 0
      ? request.activeChildren
      : request.protectedCount > 0
        ? request.children.filter((thread) => thread.persistent)
        : request.children;
  const depthOf = (thread: EnvironmentThreadShell) => {
    let depth = 0;
    const seen = new Set([thread.id]);
    let parentId = thread.lineage?.parentThreadId;
    while (parentId && !seen.has(parentId)) {
      const parent = request.children.find(
        (child) => child.environmentId === thread.environmentId && child.id === parentId,
      );
      if (!parent) break;
      seen.add(parentId);
      depth++;
      parentId = parent.lineage?.parentThreadId;
    }
    return Math.min(depth, 3);
  };
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
          <AlertDialogDescription>
            {activeCount > 0
              ? `${activeCount} ${activeCount === 1 ? "subagent is" : "subagents are"} still working or need${activeCount === 1 ? "s" : ""} your attention. `
              : request.protectedCount > 0
                ? "This family includes protected subagents. "
                : "The parent is still working and will stop when archived. "}
            Stopping archives all {count} {count === 1 ? "subagent" : "subagents"} with{" "}
            {request.title.includes("threads?") ? "these threads" : "this thread"}.
          </AlertDialogDescription>
          <ul
            aria-label={
              activeCount > 0
                ? "Active subagents"
                : request.protectedCount > 0
                  ? "Protected subagents"
                  : "Subagents"
            }
            className="space-y-1 text-sm"
          >
            {listedChildren.slice(0, 5).map((thread) => (
              <li
                key={`${thread.environmentId}:${thread.id}`}
                className="flex justify-between gap-3"
                style={{ paddingInlineStart: `${depthOf(thread)}rem` }}
              >
                <span className="min-w-0 truncate">{thread.title}</span>
                <span className="shrink-0 text-muted-foreground">
                  {thread.persistent
                    ? "Persistent"
                    : legacySidebarSubagentStatusLabel(thread, resolveThreadStatusPill({ thread }))}
                </span>
              </li>
            ))}
            {listedChildren.length > 5 ? (
              <li className="text-muted-foreground">+{listedChildren.length - 5} more</li>
            ) : null}
          </ul>
          {request.canPromote ? (
            <p className="text-sm text-muted-foreground">
              Keeping them separately preserves their work, queues, and pending requests.
            </p>
          ) : null}
          {request.nativeCount > 0 ? (
            <p className="text-sm text-muted-foreground">
              Provider subagents cannot run on their own and will stop with their owner.
            </p>
          ) : null}
          {request.protectedCount > 0 ? (
            <p className="text-sm text-muted-foreground">
              {request.canPromote
                ? "Persistent subagents are protected. Keep them separately to archive this thread."
                : "Persistent subagents are protected and cannot run separately. Remove their protection before archiving this family."}
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">
            Undo restores archived threads. Stopped work won't restart; promoted threads stay
            separate.
          </p>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button
            ref={cancelRef}
            variant="outline"
            disabled={choice !== null}
            onClick={() => finish(null)}
          >
            Cancel
          </Button>
          {request.canPromote ? (
            <Button
              variant="outline"
              disabled={choice !== null}
              onClick={() => void submit("promote")}
            >
              {choice === "promote" ? "Archiving…" : "Keep running separately"}
            </Button>
          ) : null}
          <Button
            variant="destructive"
            disabled={choice !== null || !request.canStopAndArchive}
            onClick={() => void submit("stop_and_archive")}
          >
            {choice === "stop_and_archive" ? "Archiving…" : "Stop and archive"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
