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
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        onThreadError(
          threadRef.threadId,
          error instanceof Error ? error.message : "Failed to cancel the running Action.",
        );
      }
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

  const resumeAgent = useStableCallback(async () => {
    if (threadRef === null || key === null) return;
    setPending({ key, operation: "resume" });
    const result = await resume({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    if (result._tag === "Failure") {
      setPending((current) =>
        current?.key === key && current.operation === "resume" ? null : current,
      );
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        onThreadError(
          threadRef.threadId,
          error instanceof Error ? error.message : "Failed to resume the interrupted Action.",
        );
      }
    }
  });
  const discardResult = useStableCallback(async () => {
    if (threadRef === null || key === null) return;
    setPending({ key, operation: "discard" });
    const result = await discard({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    if (result._tag === "Failure") {
      setPending((current) =>
        current?.key === key && current.operation === "discard" ? null : current,
      );
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        onThreadError(
          threadRef.threadId,
          error instanceof Error ? error.message : "Failed to discard the interrupted Action.",
        );
      }
    }
  });
  return {
    action: interrupted,
    canOperate,
    pending: pending?.key === key ? pending.operation : null,
    onResume: () => void resumeAgent(),
    onDiscard: () => void discardResult(),
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
