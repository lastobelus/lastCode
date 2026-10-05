import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { presentThreadRecovery } from "@t3tools/client-runtime/state/thread-recovery";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { CircleCheckIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

export function useThreadRecoveryBanner({
  thread,
  environmentId,
  onOpenThread,
}: {
  thread: EnvironmentThreadShell | null;
  environmentId: EnvironmentId;
  onOpenThread: (threadId: ThreadId) => void;
}): ComposerBannerStackItem | null {
  const recover = useAtomCommand(threadEnvironment.recoverThread, { reportFailure: false });
  const repair = useAtomCommand(threadEnvironment.repairThread, { reportFailure: false });
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const recovery = thread?.recovery;
  const key = `${environmentId}:${thread?.id}:${recovery?.runId}:${recovery?.attemptId}`;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const currentKey = useRef(key);
  useLayoutEffect(() => {
    currentKey.current = key;
  }, [key]);
  const presentation = presentThreadRecovery(recovery);
  if (
    !thread ||
    !recovery ||
    !presentation ||
    (recovery.status === "recovered" && dismissedKey === key)
  )
    return null;
  const pending = pendingKey === key;
  const runAction = async () => {
    if (pending || presentation.busy) return;
    if (recovery.repairThreadId) {
      onOpenThread(recovery.repairThreadId);
      return;
    }
    setPendingKey(key);
    setError(null);
    const input = { threadId: thread.id, runId: recovery.runId, attemptId: recovery.attemptId };
    try {
      if (presentation.action === "launch-repair") {
        const result = await repair({ environmentId, input });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        if (mounted.current && currentKey.current === key) onOpenThread(result.value.threadId);
      } else {
        const result = await recover({ environmentId, input });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      }
    } catch (cause) {
      setError({
        key,
        message: cause instanceof Error ? cause.message : "Could not recover this run.",
      });
    } finally {
      setPendingKey((value) => (value === key ? null : value));
    }
  };
  return {
    id: `thread-recovery:${key}`,
    priority: presentation.suppressWorking ? "activity" : "notice",
    variant: presentation.variant,
    role: "status",
    icon: recovery.status === "recovered" ? <CircleCheckIcon /> : <TriangleAlertIcon />,
    title: presentation.title,
    description: presentation.description,
    ...(error?.key === key
      ? {
          children: (
            <p role="alert" className="px-2 text-error">
              {error.message}
            </p>
          ),
        }
      : {}),
    ...(recovery.status === "recovered"
      ? { onDismiss: () => setDismissedKey(key), dismissLabel: "Dismiss recovery notice" }
      : {}),
    actions: presentation.label ? (
      <Button
        size="xs"
        variant="ghost"
        aria-disabled={pending || presentation.busy}
        aria-busy={pending || presentation.busy}
        title={presentation.description}
        onClick={() => void runAction()}
      >
        {pending
          ? presentation.action === "launch-repair"
            ? "Opening…"
            : recovery.status === "suspect"
              ? "Checking…"
              : "Recovering…"
          : presentation.label}
      </Button>
    ) : undefined,
  };
}
