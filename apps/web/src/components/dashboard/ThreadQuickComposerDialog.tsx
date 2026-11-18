import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { recoveryQueuesFollowUps } from "@t3tools/client-runtime/state/thread-recovery";
import { CommandId, type ScopedThreadRef } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { msg, T, useGT, useMessages } from "gt-react";
import { useLayoutEffect, useRef, useState } from "react";

import { m } from "~/i18n/messages";

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

type QuickMessageError = { copy: string } | { text: string };

const keepMessage = (message: string) => message;

export function ThreadQuickComposerDialog({
  target,
  onOpenChange,
  onSent,
}: {
  target: ScopedThreadRef | null;
  onOpenChange: (open: boolean) => void;
  onSent?: (target: ScopedThreadRef) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const thread = useThreadShell(target);
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [sender] = useState(() => createQuickMessageSender(startTurn));
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, QuickMessageError | undefined>>({});
  const [sendingKeys, setSendingKeys] = useState<ReadonlySet<string>>(new Set());
  const sendingKeysRef = useRef(new Set<string>());
  const activeTargetRef = useRef(target);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the in-flight send request tied to the committed dialog target so its completion only closes that target
  useLayoutEffect(() => {
    activeTargetRef.current = target;
  }, [target]);
  const key = target ? scopedThreadKey(target) : "";
  const text = drafts[key] ?? "";
  const sending = sendingKeys.has(key);
  const unacknowledged = sender.hasUnacknowledgedMessage(key);
  const connected = target !== null && connectedEnvironmentIds.includes(target.environmentId);
  // Keep delivery guards independent of localized text.
  const blockReason = quickMessageBlockReason(thread, connected, unacknowledged, keepMessage);
  const error = errors[key];
  const errorText = error && ("copy" in error ? messages(error.copy) : error.text);
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
      keepMessage,
    );
    if (liveBlockReason) {
      setErrors((current) => ({ ...current, [sendKey]: { copy: liveBlockReason } }));
      return;
    }
    sendingKeysRef.current.add(sendKey);
    setSendingKeys((current) => new Set(current).add(sendKey));
    setErrors((current) => ({ ...current, [sendKey]: undefined }));
    await (async () => {
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
            ? { copy: msg("The send was interrupted. Retry to confirm delivery.") }
            : failure instanceof Error
              ? { text: failure.message }
              : { copy: msg("Could not confirm delivery. Retry this message.") },
        }));
        return;
      }
      setDrafts((current) => ({ ...current, [sendKey]: "" }));
      toastManager.add({
        type: "success",
        title: m(msg("Message accepted")),
        description:
          liveThread?.title ?? thread?.title ?? m(msg("Thread", { $context: "a conversation" })),
      });
      if (activeTargetRef.current && scopedThreadKey(activeTargetRef.current) === sendKey) {
        onOpenChange(false);
      }
      onSent?.(sendTarget);
    })()
      .catch((error: unknown) => {
        setErrors((current) => ({
          ...current,
          [sendKey]:
            error instanceof Error
              ? { text: error.message }
              : { copy: msg("Could not confirm delivery. Retry this message.") },
        }));
      })
      .finally(() => {
        sendingKeysRef.current.delete(sendKey);
        setSendingKeys((current) => {
          const next = new Set(current);
          next.delete(sendKey);
          return next;
        });
      });
  };

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            <T>Message thread</T>
          </DialogTitle>
          <DialogDescription>{thread?.title ?? gt("Thread unavailable")}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {queueing
                ? gt("Your message will run after the current turn.")
                : gt("Your message will start a new turn.")}
            </p>
            <Textarea
              aria-label={gt("Message", { $context: "text of a chat message" })}
              placeholder={gt("Send a quick follow-up…")}
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
                {messages(blockReason)}
              </p>
            )}
            {errorText && (
              <p role="alert" className="text-sm text-destructive">
                {errorText}
              </p>
            )}
            {unacknowledged && !sending && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  <T>
                    Retry confirms the same message without sending it twice. Delivery was not
                    confirmed. Check the thread before sending a new version.
                  </T>
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
                  <T>Edit as a new message</T>
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
              <T>Open thread</T>
            </Button>
          )}
          <Button
            disabled={sending || !text.trim() || blockReason !== null}
            onClick={() => void submit()}
          >
            {sending
              ? gt("Sending…")
              : unacknowledged
                ? gt("Retry send")
                : queueing
                  ? gt("Queue message")
                  : gt("Send message")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
