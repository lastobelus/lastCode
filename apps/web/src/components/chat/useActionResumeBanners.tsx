import {
  AuthOrchestrationOperateScope,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  type ActionResumeState,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

import { useStableCallback } from "../../hooks/useStableCallback";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { terminalEnvironment } from "../../state/terminal";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import { interruptedActionBanner, runningActionBanner } from "./ComposerActionResume";

interface ActionResumeBannerInput {
  readonly routeThreadRef: ScopedThreadRef;
  readonly threadRef: ScopedThreadRef | null;
  readonly action: ActionResumeState | null;
  readonly onRequestTerminalFocus: () => void;
  readonly onThreadError: (threadId: ThreadId | null, error: string | null) => void;
}

// The callback belongs to the route that started the command, including after await.
function reportActionFailure(
  result: AtomCommandResult<unknown, unknown>,
  threadId: ThreadId,
  onThreadError: ActionResumeBannerInput["onThreadError"],
  fallback: string,
) {
  if (result._tag !== "Failure") return;
  if (isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  onThreadError(threadId, error instanceof Error ? error.message : fallback);
}

function useRunningActionControl({
  threadRef,
  action,
  onRequestTerminalFocus,
  onThreadError,
}: ActionResumeBannerInput) {
  const closeTerminal = useAtomCommand(terminalEnvironment.close, { reportFailure: false });
  const ensureTerminal = useTerminalUiStateStore((state) => state.ensureTerminal);
  const [cancellingRunId, setCancellingRunId] = useState<string | null>(null);
  const running = action?.outcome === "running" ? action : null;
  const environmentId = threadRef?.environmentId ?? null;
  const canRead = useEnvironmentScope(environmentId, AuthTerminalReadScope);
  const canOperate = useEnvironmentScope(environmentId, AuthTerminalOperateScope);

  const openTerminal = useStableCallback(() => {
    if (threadRef === null || running === null) return;
    if (!readEnvironmentScope(threadRef.environmentId, AuthTerminalReadScope)) return;
    ensureTerminal(threadRef, running.terminalId, { open: true, active: true });
    onRequestTerminalFocus();
  });
  const cancel = useStableCallback(async () => {
    if (threadRef === null || running === null) return;
    if (!readEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope)) return;
    const runId = running.runId;
    if (cancellingRunId === runId) return;
    setCancellingRunId(runId);
    try {
      // Action cancellation keeps output history; normal terminal closing deletes it.
      const result = await closeTerminal({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, terminalId: running.terminalId },
      });
      reportActionFailure(
        result,
        threadRef.threadId,
        onThreadError,
        "Failed to cancel the running Action.",
      );
    } finally {
      setCancellingRunId((current) => (current === runId ? null : current));
    }
  });
  return {
    action: running,
    cancelling: running !== null && cancellingRunId === running.runId,
    canRead,
    canOperate,
    onOpenTerminal: openTerminal,
    onCancel: () => void cancel(),
  };
}

function useInterruptedActionDelivery({
  routeThreadRef,
  threadRef,
  action,
  onThreadError,
}: ActionResumeBannerInput) {
  const resume = useOrchestrationCommand(threadEnvironment.resumeAction, { reportFailure: false });
  const discard = useOrchestrationCommand(threadEnvironment.discardAction, {
    reportFailure: false,
  });
  const canOperate = useEnvironmentScope(
    threadRef?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const interrupted = action?.delivery === "available" ? action : null;
  const key = interrupted ? `${scopedThreadKey(routeThreadRef)}:${interrupted.runId}` : null;
  const [pending, setPending] = useState<{ key: string; operation: "resume" | "discard" } | null>(
    null,
  );
  if (pending !== null && pending.key !== key) setPending(null);

  const deliver = useStableCallback(async (operation: "resume" | "discard") => {
    if (threadRef === null || key === null) return;
    setPending({ key, operation });
    const request = {
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    };
    const result = await (operation === "resume" ? resume(request) : discard(request));
    if (result._tag === "Failure") {
      setPending((current) =>
        current?.key === key && current.operation === operation ? null : current,
      );
    }
    reportActionFailure(
      result,
      threadRef.threadId,
      onThreadError,
      `Failed to ${operation} the interrupted Action.`,
    );
  });
  return {
    action: interrupted,
    canOperate,
    pending: pending?.key === key ? pending.operation : null,
    onResume: () => void deliver("resume"),
    onDiscard: () => void deliver("discard"),
  };
}

export function useActionResumeBanners(input: ActionResumeBannerInput) {
  const running = useRunningActionControl(input);
  const interrupted = useInterruptedActionDelivery(input);
  return {
    runningBanner: runningActionBanner(running),
    interruptedBanner: interruptedActionBanner(interrupted),
  };
}
