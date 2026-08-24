import type { SidebarThreadSummary } from "../types";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { ensureLocalApi } from "../localApi";
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

export function WorktreeCleanupFailureDialog(props: {
  thread: SidebarThreadSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const retry = useAtomCommand(threadEnvironment.retryWorktreeCleanup, { reportFailure: true });
  const abandon = useAtomCommand(threadEnvironment.abandonWorktreeCleanup, {
    reportFailure: true,
  });
  const cleanup = props.thread.worktreeCleanup;
  if (cleanup?.status !== "failed") return null;

  const details = [
    `Thread: ${props.thread.id} — ${props.thread.title}`,
    `Worktree: ${cleanup.worktreePath}`,
    `Repository: ${cleanup.repositoryRoot}`,
    `Failed: ${cleanup.failedAt}`,
    "",
    cleanup.error,
  ].join("\n");
  const keepWorktree = async () => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      [
        "Keep this worktree?",
        "LastCode will stop trying to remove it and dismiss this cleanup failure.",
        "You can still remove the worktree manually later.",
      ].join("\n"),
      { variant: "destructive" },
    );
    if (!confirmed) return;
    const result = await abandon({
      environmentId: props.thread.environmentId,
      input: { threadId: props.thread.id },
    });
    if (result._tag === "Success") props.onOpenChange(false);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Worktree cleanup failed</DialogTitle>
          <DialogDescription>
            The thread is deleted, but LastCode has not removed its worktree yet.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <div className="text-sm">
            <div className="font-medium">{props.thread.title}</div>
            <div className="font-mono text-xs text-muted-foreground">{props.thread.id}</div>
          </div>
          <div className="rounded-lg border border-border/70 bg-muted/40 p-3">
            <div className="mb-1 text-xs font-medium text-muted-foreground">Worktree</div>
            <div className="break-all font-mono text-xs">{cleanup.worktreePath}</div>
          </div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-red-500/25 bg-red-500/8 p-3 text-xs text-red-800 dark:text-red-200">
            {cleanup.error}
          </pre>
        </DialogPanel>
        <DialogFooter className="sm:flex-wrap">
          <Button type="button" variant="destructive-outline" onClick={() => void keepWorktree()}>
            Keep worktree
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => void navigator.clipboard.writeText(details)}
          >
            Copy details
          </Button>
          <Button
            type="button"
            onClick={() => {
              void retry({
                environmentId: props.thread.environmentId,
                input: { threadId: props.thread.id },
              }).then((result) => {
                if (result._tag === "Success") props.onOpenChange(false);
              });
            }}
          >
            Retry
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
