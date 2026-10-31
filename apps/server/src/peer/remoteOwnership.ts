import type { OrchestrationV2ThreadProjection, RemoteDelegationSelector } from "@t3tools/contracts";
import { delegatedTaskProgress } from "@t3tools/provider-core/server/subagentProjection";

export const sameRemoteDelegation = (
  left: RemoteDelegationSelector | undefined,
  right: RemoteDelegationSelector,
) =>
  left !== undefined &&
  left.delegationId === right.delegationId &&
  left.parentEnvironmentId === right.parentEnvironmentId &&
  left.parentThreadId === right.parentThreadId &&
  left.sourceTaskId === right.sourceTaskId;

export function remoteDelegationProgress(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "runs" | "messages" | "subagents" | "providerThreads"
  >,
  selector: RemoteDelegationSelector,
) {
  const runs = projection.runs.filter((run) =>
    sameRemoteDelegation(run.remoteDelegation, selector),
  );
  const ids = new Set(runs.map((run) => run.id));
  const providerIds = new Set(runs.map((run) => run.providerThreadId));
  const progress = delegatedTaskProgress({
    runs,
    messages: projection.messages.filter(
      (message) => message.runId !== null && ids.has(message.runId),
    ),
    subagents: projection.subagents.filter((task) => task.runId !== null && ids.has(task.runId)),
    providerThreads: projection.providerThreads.filter((thread) => providerIds.has(thread.id)),
  });
  // A held continuation is still work owed by this association.
  return runs.some((run) => run.status === "queued")
    ? { ...progress, state: "working" as const }
    : progress;
}

export const remoteDelegationMayStart = (
  thread: Pick<OrchestrationV2ThreadProjection["thread"], "remoteDelegations" | "linkOrigin">,
  run: Pick<OrchestrationV2ThreadProjection["runs"][number], "remoteDelegation">,
) =>
  run.remoteDelegation === undefined ||
  thread.remoteDelegations?.some(
    (entry) =>
      sameRemoteDelegation(entry, run.remoteDelegation!) &&
      entry.stage === "active" &&
      entry.linkSessionId === thread.linkOrigin?.sessionId,
  ) === true;
