import type { SidebarThreadSummary } from "../types";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { ensureLocalApi } from "../localApi";
import { namedClipboardTarget, useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { m } from "../i18n/messages";
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
import { stackedThreadToast, toastManager } from "./ui/toast";

export function WorktreeCleanupFailureDialog(props: {
  thread: SidebarThreadSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const retry = useAtomCommand(threadEnvironment.retryWorktreeCleanup, { reportFailure: true });
  const abandon = useAtomCommand(threadEnvironment.abandonWorktreeCleanup, {
    reportFailure: true,
  });
  const { copyToClipboard } = useCopyToClipboard({
    target: namedClipboardTarget("worktree cleanup details"),
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: m(msg("Could not copy worktree cleanup details")),
          description:
            error instanceof Error ? error.message : m(msg("An error occurred while copying.")),
        }),
      );
    },
  });
  const cleanup = props.thread.worktreeCleanup;
  if (cleanup?.status !== "failed") return null;

  const details = [
    `Thread: ${props.thread.id}: ${props.thread.title}`,
    `Worktree: ${cleanup.worktreePath}`,
    `Repository: ${cleanup.repositoryRoot}`,
    `Failed: ${cleanup.failedAt}`,
    "",
    cleanup.error,
  ].join("\n");
  const keepWorktree = async () => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      m(
        msg(
          "Keep this worktree?\n{product} will stop trying to remove it and dismiss this cleanup failure.\nYou can still remove the worktree manually later.",
          { product: "LastCode" },
        ),
      ),
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
          <DialogTitle>
            <T>Worktree cleanup failed</T>
          </DialogTitle>
          <DialogDescription>
            <T>
              The thread is deleted, but <Var>LastCode</Var> has not removed its worktree yet.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-3">
            <div className="text-sm">
              <div className="font-medium">{props.thread.title}</div>
              <div className="font-mono text-xs text-muted-foreground">{props.thread.id}</div>
            </div>
            <div className="rounded-lg border border-border/70 bg-muted/40 p-3">
              <div className="mb-1 text-xs font-medium text-muted-foreground">
                <T>Worktree</T>
              </div>
              <div className="break-all font-mono text-xs">{cleanup.worktreePath}</div>
            </div>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-error/25 bg-error/8 p-3 text-xs text-error-foreground">
              {cleanup.error}
            </pre>
          </div>
        </DialogPanel>
        <DialogFooter className="sm:flex-wrap">
          <Button type="button" variant="destructive-outline" onClick={() => void keepWorktree()}>
            <T>Keep worktree</T>
          </Button>
          <Button type="button" variant="outline" onClick={() => copyToClipboard(details)}>
            <T>Copy details</T>
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
            <T>Retry</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
import { msg, T, Var } from "gt-react";
