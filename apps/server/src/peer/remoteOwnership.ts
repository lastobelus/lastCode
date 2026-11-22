import {
  OrchestratorMcpFailure,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
  type RemoteDelegationSelector,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { delegatedTaskProgress } from "@t3tools/provider-core/server/subagentProjection";

const releasedThreadRefusal =
  "This thread was promoted. Use Return to owner before delegating another task to it.";

export class RemoteDelegationReleasedThreadError extends Schema.TaggedError<RemoteDelegationReleasedThreadError>()(
  "RemoteDelegationReleasedThreadError",
  {},
) {
  override get message() {
    return releasedThreadRefusal;
  }
}

export const checkNewRemoteDelegation = (
  commandType: string,
  thread: Pick<OrchestrationV2ThreadProjection["thread"], "lineage">,
) =>
  commandType === "remote_delegation.prepare" && thread.lineage.independent === true
    ? Effect.fail(new RemoteDelegationReleasedThreadError())
    : Effect.void;

export function releasedRemotePreparationFailure(error: {
  readonly _tag: string;
  readonly detail?: string;
}): OrchestratorMcpFailure | undefined {
  if (
    error._tag === "RemoteDelegationReleasedThreadError" ||
    (error._tag === "OrchestratorCommandPreviouslyRejectedError" &&
      error.detail === releasedThreadRefusal)
  ) {
    return new OrchestratorMcpFailure({
      code: "capability_denied",
      message: releasedThreadRefusal,
    });
  }
}

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
  const providerIds = new Set(
    runs.filter((run) => run.startedAt !== null).map((run) => run.providerThreadId),
  );
  const progress = delegatedTaskProgress(
    {
      runs,
      messages: projection.messages.filter(
        (message) => message.runId !== null && ids.has(message.runId),
      ),
      subagents: projection.subagents.filter((task) => task.runId !== null && ids.has(task.runId)),
      providerThreads: projection.providerThreads.filter((thread) => providerIds.has(thread.id)),
    },
    ids,
  );
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

type DispatchMode = Extract<
  OrchestrationV2Command,
  { readonly type: "message.dispatch" }
>["dispatchMode"];

export function remoteWorktreeDispatchMode(
  baseRef: string | undefined,
  projection: {
    readonly thread: Pick<OrchestrationV2ThreadProjection["thread"], "worktreePath">;
    readonly runs: ReadonlyArray<unknown>;
  },
): Result.Result<DispatchMode, string> {
  if (baseRef === undefined) return Result.succeed({ type: "queue_after_active" });
  if (projection.thread.worktreePath !== null || projection.runs.length > 0) {
    return Result.fail("An isolated remote task needs an unused thread to prepare its worktree.");
  }
  return Result.succeed({
    type: "defer_start",
    workspaceStrategy: {
      type: "worktree",
      baseRef,
      startFromOrigin: false,
      requireExactBase: true,
    },
  });
}
