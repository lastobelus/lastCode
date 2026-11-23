import { T, useGT, useMessages } from "gt-react";
import {
  ARCHIVE_TYPED_IN_LABEL,
  buildThreadArchiveConfirmation,
  type ThreadArchiveFamily,
} from "@t3tools/client-runtime/state/thread-archive";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { readProject } from "../state/entities";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import type { SavedWorkspace, ThreadArchiveChildDisposition } from "@t3tools/contracts";
import { formatBytes } from "../lib/formatBytes";
import { LastCodeArchiveTemporaryProjects } from "./LastCodeArchiveTemporaryProjects";
import { LastCodeLinkedArchivePreview } from "./LastCodeLinkedArchivePreview";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";

export type WorkspaceLifecycleChoice = {
  readonly discard: boolean;
  readonly childDisposition?: ThreadArchiveChildDisposition;
  readonly includeTypedIn?: boolean;
};
type SavedCopies = {
  readonly snapshots: readonly SavedWorkspace[];
  readonly retainedSnapshots: readonly SavedWorkspace[];
};
type Request = {
  readonly title: string;
  readonly description: string;
  readonly copiesIncludingTypedIn?: SavedCopies;
  readonly canDiscard: boolean;
  readonly archiveFamily?: ThreadArchiveFamily;
  readonly resolve: (choice: WorkspaceLifecycleChoice | null) => void;
} & SavedCopies;
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));
let hostMounted = false;

export function requestWorkspaceLifecycleDialog(
  request: Omit<Request, "resolve">,
): Promise<WorkspaceLifecycleChoice | null> {
  if (!hostMounted || useRequest.getState().request) return Promise.resolve(null);
  return new Promise((resolve) => useRequest.setState({ request: { ...request, resolve } }));
}
function finish(choice: WorkspaceLifecycleChoice | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(choice);
}
export function WorkspaceLifecycleDialogHost() {
  const request = useRequest((state) => state.request);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the mounted lifecycle dialog host and releases its outstanding request on unmount
  useEffect(() => {
    hostMounted = true;
    return () => {
      hostMounted = false;
      finish(null);
    };
  }, []);
  return request ? <WorkspaceLifecycleDialog request={request} /> : null;
}
function WorkspaceLifecycleDialog({ request }: { request: Request }) {
  const gt = useGT();
  const messages = useMessages();
  const [includeTypedIn, setIncludeTypedIn] = useState(false);
  const archiveFamily = request.archiveFamily
    ? buildThreadArchiveConfirmation(request.archiveFamily, messages, includeTypedIn)
    : undefined;
  const stopsLinkedWork = archiveFamily?.linkedMachines.some(
    ({ activeThreadIds, requiresStop }) => requiresStop || activeThreadIds.length > 0,
  );
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [discard, setDiscard] = useState(true);
  const { snapshots, retainedSnapshots } =
    (includeTypedIn && request.copiesIncludingTypedIn) || request;
  const count = snapshots.length;
  const bytes = snapshots.reduce((sum, snapshot) => sum + snapshot.bytes, 0);
  const current = snapshots.filter((snapshot) => snapshot.current).length;
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <AlertDialogPopup initialFocus={cancelRef}>
        <AlertDialogHeader>
          <AlertDialogTitle>{request.title}</AlertDialogTitle>
          <AlertDialogDescription>{request.description}</AlertDialogDescription>
          {archiveFamily && <p className="text-sm">{archiveFamily.description}</p>}
          {request.archiveFamily?.archivePreview && archiveFamily && (
            <ul
              className="max-h-48 space-y-1 overflow-y-auto text-sm"
              aria-label={gt("Threads to archive or keep open")}
            >
              {archiveFamily.threads.map(({ thread, label }) => {
                const { environmentId, projectId } = thread;
                const project =
                  environmentId === undefined || projectId === undefined
                    ? null
                    : readProject(scopeProjectRef(environmentId, projectId));
                return (
                  <li key={thread.id}>
                    {thread.title || gt("Untitled thread")} · {project?.title ?? projectId} ·{" "}
                    {label}
                  </li>
                );
              })}
            </ul>
          )}
          {archiveFamily && (
            <LastCodeLinkedArchivePreview machines={archiveFamily.linkedMachines} />
          )}
          {archiveFamily?.canIncludeTypedIn && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={includeTypedIn}
                onCheckedChange={(checked) => setIncludeTypedIn(checked === true)}
              />
              {messages(ARCHIVE_TYPED_IN_LABEL)}
            </label>
          )}
          {archiveFamily && <LastCodeArchiveTemporaryProjects {...archiveFamily} />}
          <p className="text-sm">
            {gt(
              "{count, plural, one {{count} saved copy} other {{count} saved copies}} · {current} current · {historical} historical · {bytes}",
              { count, current, historical: count - current, bytes: formatBytes(bytes) },
            )}
          </p>
          {count > 0 && (
            <ul
              aria-label={gt("Saved copies to discard")}
              className="max-h-48 space-y-2 overflow-y-auto text-xs select-text"
            >
              {snapshots.map((snapshot) => (
                <li key={`${snapshot.checkoutId}:${snapshot.snapshotId}`}>
                  <p>
                    {snapshot.title} ·{" "}
                    {snapshot.current
                      ? gt("Current", { $context: "saved workspace snapshot status" })
                      : gt("Historical", { $context: "saved workspace snapshot status" })}{" "}
                    · {formatBytes(snapshot.bytes)}
                  </p>
                  <p className="wrap-anywhere">
                    {snapshot.path} · {snapshot.snapshotId}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={discard}
              onCheckedChange={(checked) => setDiscard(checked === true)}
            />
            <span>
              <T>Discard saved workspace data</T>
            </span>
          </label>
          <p className="text-sm text-muted-foreground">
            {discard
              ? gt(
                  "Unsaved local files and notes in these saved copies will be permanently lost. Branches and checkpoints are kept. No restore is needed.",
                )
              : gt(
                  "Keep these saved copies for recovery in Settings → Storage → Saved workspaces.",
                )}
          </p>
          {retainedSnapshots.length > 0 && (
            <div className="space-y-2 text-sm">
              <p>
                {gt(
                  "{count, plural, one {{count} shared or protected saved copy will be retained.} other {{count} shared or protected saved copies will be retained.}}",
                  { count: retainedSnapshots.length },
                )}
              </p>
              <ul
                aria-label={gt("Saved copies retained")}
                className="max-h-32 space-y-1 overflow-y-auto text-xs select-text"
              >
                {retainedSnapshots.map((snapshot) => (
                  <li
                    key={`${snapshot.checkoutId}:${snapshot.snapshotId}`}
                    className="wrap-anywhere"
                  >
                    {snapshot.title} ·{" "}
                    {snapshot.current
                      ? gt("Current", { $context: "saved workspace snapshot status" })
                      : gt("Historical", { $context: "saved workspace snapshot status" })}{" "}
                    · {formatBytes(snapshot.bytes)} · {snapshot.snapshotId}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {discard && !request.canDiscard && (
            <p role="alert" className="text-sm text-destructive">
              <T>
                This connection cannot discard saved workspace data. Choose Keep for recovery by
                clearing the checkbox.
              </T>
            </p>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button ref={cancelRef} variant="outline" onClick={() => finish(null)}>
            <T>Cancel</T>
          </Button>
          <Button
            variant="destructive"
            disabled={(discard && !request.canDiscard) || archiveFamily?.blocked === true}
            onClick={() =>
              finish({
                discard,
                ...(includeTypedIn ? { includeTypedIn } : {}),
                ...(archiveFamily ? { childDisposition: archiveFamily.disposition } : {}),
              })
            }
          >
            {archiveFamily && stopsLinkedWork
              ? archiveFamily.confirmLabel
              : discard
                ? gt("Confirm and discard saved data")
                : gt("Confirm and keep for recovery")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
