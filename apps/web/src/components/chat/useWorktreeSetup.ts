import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  CommandId,
  RunId,
  ScopedThreadRef,
  ThreadId,
  WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import {
  workspacePreparationRetryRunIds,
  emptyWorkspacePreparationRetryFailureId,
} from "@t3tools/client-runtime/state/turn-item-presentation";
import { useState } from "react";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useEnvironmentQuery } from "../../state/query";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import type { Thread } from "../../types";
import { focusTerminal } from "../../lib/terminalFocus";
import { resolveVisibleWorktreeSetup, resolveWorktreeSetupProgress } from "../ChatView.logic";
import { worktreeSetupAgentStarted } from "@t3tools/client-runtime/worktree-setup";

// Share in-flight preparation retries across ChatView instances.
const retryingWorkspacePreparationRunIds = new Set<string>();

export function useWorktreeSetup(input: {
  readonly routeThreadRef: ScopedThreadRef;
  // Use the draft id until promotion: bootstrap rotates the thread id.
  readonly ownerKey: string;
  readonly activeThread:
    | { readonly id: ThreadId; readonly worktreePath: string | null }
    | undefined;
  readonly threadRef: ScopedThreadRef | null;
  readonly serverProjection: ThreadStructure | null;
  readonly activityRun: Thread["latestRun"] | null;
  readonly localPreparing: boolean;
  readonly sendQueuesBehindSetup: boolean;
  readonly followUpSent: boolean;
}) {
  const {
    routeThreadRef,
    ownerKey,
    activeThread,
    threadRef,
    serverProjection,
    activityRun,
    localPreparing,
    sendQueuesBehindSetup,
    followUpSent,
  } = input;
  const cancelWorktreeSetup = useAtomCommand(vcsEnvironment.cancelWorktreeSetup, {
    reportFailure: false,
  });
  const retryWorkspacePreparation = useAtomCommand(threadEnvironment.retryWorkspacePreparation);
  const storeEnsureTerminal = useTerminalUiStateStore((state) => state.ensureTerminal);
  const [startedSetup, setStartedSetup] = useState<{
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly ownerKey: string;
  } | null>(null);
  // Retain the dropped snapshot until settled activity reaches the projection.
  const [heldSnapshot, setHeldSnapshot] = useState<WorktreeSetupSnapshot | null>(null);
  const started = startedSetup !== null && startedSetup.ownerKey === ownerKey;
  const target = started ? startedSetup : routeThreadRef;
  const runPreparing =
    activityRun?.status === "preparing" ||
    serverProjection?.thread.emptyWorkspacePreparationClaim !== undefined ||
    serverProjection?.thread.emptyWorkspacePreparation?.state === "claimed";
  const snapshotQuery = useEnvironmentQuery(
    started ||
      (activeThread?.id === routeThreadRef.threadId &&
        (localPreparing || runPreparing || activeThread.worktreePath !== null))
      ? vcsEnvironment.worktreeSetup({
          environmentId: target.environmentId,
          input: { threadId: target.threadId },
        })
      : null,
  );
  const latestSnapshot = snapshotQuery.data;
  const [heldFor, setHeldFor] = useState<{
    readonly routeThreadRef: ScopedThreadRef;
    readonly latestSnapshot: WorktreeSetupSnapshot | null | undefined;
  }>({ routeThreadRef, latestSnapshot: null });
  // ChatView recreates scoped refs during render; only their durable ids mark a route change.
  const routeChanged =
    heldFor.routeThreadRef.environmentId !== routeThreadRef.environmentId ||
    heldFor.routeThreadRef.threadId !== routeThreadRef.threadId;
  if (routeChanged || heldFor.latestSnapshot !== latestSnapshot) {
    setHeldFor({ routeThreadRef, latestSnapshot });
    if (routeChanged) {
      setHeldSnapshot(latestSnapshot?.threadId === target.threadId ? latestSnapshot : null);
    } else if (latestSnapshot) {
      setHeldSnapshot((current) =>
        current?.threadId === latestSnapshot.threadId && current.sequence > latestSnapshot.sequence
          ? current
          : latestSnapshot,
      );
    }
  }
  const { snapshot: liveSnapshot, isPreparingWorktree } = resolveWorktreeSetupProgress({
    threadId: target.threadId,
    localPreparing,
    runStatus: runPreparing ? "preparing" : activityRun?.status,
    latest: latestSnapshot,
    held: heldSnapshot,
  });
  const worktreeSetup = resolveVisibleWorktreeSetup({
    live: liveSnapshot,
    recorded: null,
    turnStarted: activityRun?.startedAt != null,
    followUpSent,
  });
  // After agent handoff, sends queue behind setup without awaiting its scripts.
  const blocksSend =
    !sendQueuesBehindSetup &&
    (worktreeSetup !== null
      ? worktreeSetup.phase === "running" && !worktreeSetupAgentStarted(worktreeSetup)
      : isPreparingWorktree);

  const retryableRunIdsKey = [
    ...workspacePreparationRetryRunIds(
      serverProjection?.runs ?? [],
      serverProjection?.turnItems ?? [],
    ),
  ].join("\n");
  const [retryableRunIds, setRetryableRunIds] = useState({
    key: retryableRunIdsKey,
    ids: new Set(retryableRunIdsKey === "" ? [] : (retryableRunIdsKey.split("\n") as RunId[])),
  });
  if (retryableRunIds.key !== retryableRunIdsKey) {
    setRetryableRunIds({
      key: retryableRunIdsKey,
      ids: new Set(retryableRunIdsKey === "" ? [] : (retryableRunIdsKey.split("\n") as RunId[])),
    });
  }

  const begin = useStableCallback(
    (thread: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null) =>
      setStartedSetup(thread === null ? null : { ...thread, ownerKey }),
  );
  const cancel = useStableCallback(async () => {
    if (!worktreeSetup || worktreeSetup.phase !== "running") return false;
    const result = await cancelWorktreeSetup({
      environmentId: target.environmentId,
      input: { threadId: worktreeSetup.threadId },
    });
    return result._tag === "Success" && result.value.cancelled;
  });
  const retryPreparation = useStableCallback(
    (runId: RunId | null, failureCommandId?: CommandId) => {
      const key = runId ?? failureCommandId;
      if (!threadRef || key === undefined || retryingWorkspacePreparationRunIds.has(key)) return;
      if (runId === null && failureCommandId === undefined) return;
      retryingWorkspacePreparationRunIds.add(key);
      void retryWorkspacePreparation({
        environmentId: threadRef.environmentId,
        input:
          runId === null
            ? { threadId: threadRef.threadId, runId: null, failureCommandId: failureCommandId! }
            : { threadId: threadRef.threadId, runId },
      }).finally(() => retryingWorkspacePreparationRunIds.delete(key));
    },
  );
  // Failed bootstrap deletes threads and terminals; expose terminals only for active threads.
  const setupThreadRef =
    worktreeSetup && threadRef && worktreeSetup.threadId === threadRef.threadId ? threadRef : null;
  const openSetupTerminal = setupThreadRef
    ? (terminalId: string) => {
        storeEnsureTerminal(setupThreadRef, terminalId, { open: true, active: true });
        focusTerminal(setupThreadRef, terminalId);
      }
    : null;

  return {
    worktreeSetup,
    isPreparingWorktree,
    blocksSend,
    retryableRunIds: retryableRunIds.ids,
    retryableEmptyFailureId: serverProjection
      ? emptyWorkspacePreparationRetryFailureId(serverProjection.thread)
      : null,
    begin,
    cancel,
    retryPreparation,
    openSetupTerminal,
  };
}
