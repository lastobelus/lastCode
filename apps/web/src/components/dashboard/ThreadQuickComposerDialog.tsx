import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { recoveryQueuesFollowUps } from "@t3tools/client-runtime/state/thread-recovery";
import { CommandId, type ScopedThreadRef } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useLayoutEffect, useRef, useState } from "react";

import { newMessageId, randomUUID } from "../../lib/utils";
import { readThreadShell, useThreadShell } from "../../state/entities";
import { useConnectedEnvironmentIds } from "../../state/environments";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
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
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  createQuickMessageSender,
  quickMessageBlockReason,
} from "./ThreadQuickComposerDialog.logic";

export function ThreadQuickComposerDialog({
  target,
  onOpenChange,
  onSent,
}: {
  target: ScopedThreadRef | null;
  onOpenChange: (open: boolean) => void;
  onSent?: (target: ScopedThreadRef) => void;
}) {
  const thread = useThreadShell(target);
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [sender] = useState(() => createQuickMessageSender(startTurn));
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [sendingKeys, setSendingKeys] = useState<ReadonlySet<string>>(new Set());
  const sendingKeysRef = useRef(new Set<string>());
  const activeTargetRef = useRef(target);
  useLayoutEffect(() => {
    activeTargetRef.current = target;
  }, [target]);
  const key = target ? scopedThreadKey(target) : "";
  const text = drafts[key] ?? "";
  const sending = sendingKeys.has(key);
  const unacknowledged = sender.hasUnacknowledgedMessage(key);
  const connected = target !== null && connectedEnvironmentIds.includes(target.environmentId);
  const blockReason = quickMessageBlockReason(thread, connected, unacknowledged);
  const queueing =
    threadRuntimeIsActive(thread?.runtime) ||
    recoveryQueuesFollowUps(thread?.recovery, thread?.runtime?.activeRunId);

  const submit = async () => {
    if (!target || !text.trim() || sending || blockReason) return;
    const sendTarget = target;
    const sendKey = scopedThreadKey(sendTarget);
    if (sendingKeysRef.current.has(sendKey)) return;
    const liveThread = readThreadShell(sendTarget);
    const liveBlockReason = quickMessageBlockReason(
      liveThread,
      connected,
      sender.hasUnacknowledgedMessage(sendKey),
    );
    if (liveBlockReason) {
      setErrors((current) => ({ ...current, [sendKey]: liveBlockReason }));
      return;
    }
    sendingKeysRef.current.add(sendKey);
    setSendingKeys((current) => new Set(current).add(sendKey));
    setErrors((current) => ({ ...current, [sendKey]: undefined }));
    try {
      const result = await sender.submit(sendKey, () => {
        // Retries reuse the saved input and never need a current thread shell.
        if (!liveThread) throw new Error("Thread unavailable.");
        return {
          environmentId: sendTarget.environmentId,
          input: {
            commandId: CommandId.make(randomUUID()),
            threadId: sendTarget.threadId,
            message: { messageId: newMessageId(), role: "user", text, attachments: [] },
            runtimeMode: liveThread.runtimeMode,
            interactionMode: liveThread.interactionMode,
            // Queueing also starts an idle thread, without steering a turn that began meanwhile.
            dispatchMode: "queue",
          },
        };
      });
      if (!result) return;
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setErrors((current) => ({
          ...current,
          [sendKey]: isAtomCommandInterrupted(result)
            ? "The send was interrupted. Retry to confirm delivery."
            : failure instanceof Error
              ? failure.message
              : "Could not confirm delivery. Retry this message.",
        }));
        return;
      }
      setDrafts((current) => ({ ...current, [sendKey]: "" }));
      toastManager.add({
        type: "success",
        title: "Message accepted",
        description: liveThread?.title ?? thread?.title ?? "Thread",
      });
      if (activeTargetRef.current && scopedThreadKey(activeTargetRef.current) === sendKey) {
        onOpenChange(false);
      }
      onSent?.(sendTarget);
    } catch (error) {
      setErrors((current) => ({
        ...current,
        [sendKey]:
          error instanceof Error
            ? error.message
            : "Could not confirm delivery. Retry this message.",
      }));
    } finally {
      sendingKeysRef.current.delete(sendKey);
      setSendingKeys((current) => {
        const next = new Set(current);
        next.delete(sendKey);
        return next;
      });
    }
  };

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Message thread</DialogTitle>
          <DialogDescription>{thread?.title ?? "Thread unavailable"}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {queueing
                ? "Your message will run after the current turn."
                : "Your message will start a new turn."}
            </p>
            <Textarea
              aria-label="Message"
              placeholder="Send a quick follow-up…"
              value={text}
              readOnly={sending || unacknowledged}
              disabled={blockReason !== null}
              onChange={(event) => {
                const value = event.target.value;
                setDrafts((current) => ({ ...current, [key]: value }));
              }}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  (event.metaKey || event.ctrlKey) &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            {blockReason && (
              <p role="status" className="text-sm text-muted-foreground">
                {blockReason}
              </p>
            )}
            {errors[key] && (
              <p role="alert" className="text-sm text-destructive">
                {errors[key]}
              </p>
            )}
            {unacknowledged && !sending && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Retry confirms the same message without sending it twice. Delivery was not
                  confirmed. Check the thread before sending a new version.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (sender.discardAttempt(key)) {
                      setErrors((current) => ({ ...current, [key]: undefined }));
                    }
                  }}
                >
                  Edit as a new message
                </Button>
              </div>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          {target && (
            <Button
              variant="outline"
              render={
                <Link to="/$environmentId/$threadId" params={buildThreadRouteParams(target)} />
              }
            >
              Open thread
            </Button>
          )}
          <Button
            disabled={sending || !text.trim() || blockReason !== null}
            onClick={() => void submit()}
          >
            {sending
              ? "Sending…"
              : unacknowledged
                ? "Retry send"
                : queueing
                  ? "Queue message"
                  : "Send message"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
