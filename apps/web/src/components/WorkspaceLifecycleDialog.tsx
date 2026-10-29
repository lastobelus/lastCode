import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import type { SavedWorkspace, ThreadArchiveChildDisposition } from "@t3tools/contracts";
import { formatBytes } from "../lib/formatBytes";
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
};
type Request = {
  readonly title: string;
  readonly description: string;
  readonly snapshots: readonly SavedWorkspace[];
  readonly retainedSnapshots: readonly SavedWorkspace[];
  readonly canDiscard: boolean;
  readonly archiveFamily?: {
    readonly description: string;
    readonly disposition: ThreadArchiveChildDisposition;
    readonly blocked: boolean;
  };
  readonly resolve: (choice: WorkspaceLifecycleChoice | null) => void;
};
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
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [discard, setDiscard] = useState(true);
  const count = request.snapshots.length;
  const bytes = request.snapshots.reduce((sum, snapshot) => sum + snapshot.bytes, 0);
  const current = request.snapshots.filter((snapshot) => snapshot.current).length;
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
          {request.archiveFamily && <p className="text-sm">{request.archiveFamily.description}</p>}
          <p className="text-sm">
            {count} saved {count === 1 ? "copy" : "copies"} · {current} current · {count - current}{" "}
            historical · {formatBytes(bytes)}
          </p>
          {count > 0 && (
            <ul
              aria-label="Saved copies to discard"
              className="max-h-48 space-y-2 overflow-y-auto text-xs select-text"
            >
              {request.snapshots.map((snapshot) => (
                <li key={`${snapshot.checkoutId}:${snapshot.snapshotId}`}>
                  <p>
                    {snapshot.title} · {snapshot.current ? "Current" : "Historical"} ·{" "}
                    {formatBytes(snapshot.bytes)}
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
            <span>Discard saved workspace data</span>
          </label>
          <p className="text-sm text-muted-foreground">
            {discard
              ? "Unsaved local files and notes in these saved copies will be permanently lost. Branches and checkpoints are kept. No restore is needed."
              : "Keep these saved copies for recovery in Settings → Storage → Saved workspaces."}
          </p>
          {request.retainedSnapshots.length > 0 && (
            <div className="space-y-2 text-sm">
              <p>
                {request.retainedSnapshots.length} shared or protected saved{" "}
                {request.retainedSnapshots.length === 1 ? "copy will" : "copies will"} be retained.
              </p>
              <ul
                aria-label="Saved copies retained"
                className="max-h-32 space-y-1 overflow-y-auto text-xs select-text"
              >
                {request.retainedSnapshots.map((snapshot) => (
                  <li
                    key={`${snapshot.checkoutId}:${snapshot.snapshotId}`}
                    className="wrap-anywhere"
                  >
                    {snapshot.title} · {snapshot.current ? "Current" : "Historical"} ·{" "}
                    {formatBytes(snapshot.bytes)} · {snapshot.snapshotId}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {discard && !request.canDiscard && (
            <p role="alert" className="text-sm text-destructive">
              This connection cannot discard saved workspace data. Choose Keep for recovery by
              clearing the checkbox.
            </p>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button ref={cancelRef} variant="outline" onClick={() => finish(null)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={(discard && !request.canDiscard) || request.archiveFamily?.blocked === true}
            onClick={() =>
              finish({
                discard,
                ...(request.archiveFamily
                  ? { childDisposition: request.archiveFamily.disposition }
                  : {}),
              })
            }
          >
            {discard ? "Confirm and discard saved data" : "Confirm and keep for recovery"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
