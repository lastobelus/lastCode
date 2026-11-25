import {
  getInteractiveThreadParentThreadId,
  isOwnedSubagentThread,
  isProviderNativeSubagentThread,
  type EnvironmentId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadShell,
  type ThreadId,
  type ThreadOwnershipAction,
} from "@t3tools/contracts";
import { subagentHoldsCompletion } from "@t3tools/provider-core/server/subagentProjection";
import { getRecordedThreadOwner } from "@t3tools/shared/threadOwnership";
import * as Effect from "effect/Effect";
import type { ProjectionStoreV2 } from "./ProjectionStore.ts";

export function threadPlacementParentId(thread: OrchestrationV2ThreadShell): ThreadId | null {
  return isOwnedSubagentThread(thread)
    ? thread.lineage.parentThreadId
    : getInteractiveThreadParentThreadId(thread);
}

function defaultReturnParentId(
  thread: OrchestrationV2AppThread,
  owner: OrchestrationV2ThreadShell,
): ThreadId | null {
  // Clearing independence restores the execution parent even with explicit null placement.
  if (thread.lineage.relationshipToParent === "subagent" && thread.delegatedFrom == null)
    return thread.lineage.parentThreadId;
  if (
    thread.projectId !== owner.projectId ||
    owner.lineage.sideChat === true ||
    isProviderNativeSubagentThread(owner) ||
    thread.delegatedFrom != null
  )
    return null;
  return thread.creatorThreadId === owner.id ? owner.id : null;
}

type Task = Pick<OrchestrationV2Subagent, "status" | "result" | "completionDelivery">;

export function hasReleasedTaskResult(task: Task): boolean {
  const state = task.completionDelivery?.state;
  return (
    task.result !== null &&
    !subagentHoldsCompletion(task) &&
    (state === "acknowledged" || state === "delivered" || state === "disposed")
  );
}

const terminalRunStatuses = new Set<OrchestrationV2Run["status"]>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
]);

function hasOwnedContinuation(runs: ReadonlyArray<OrchestrationV2Run>): boolean {
  const liveRuns = new Set(
    runs.filter((run) => !terminalRunStatuses.has(run.status)).map((run) => run.id),
  );
  return runs.some(
    (run) =>
      (run.pullRequestWatchContinuation !== undefined && liveRuns.has(run.id)) ||
      run.actionObligations?.some(
        (row) =>
          row.state === "waiting" ||
          (row.state === "transferred" &&
            row.continuationRunId !== undefined &&
            liveRuns.has(row.continuationRunId)),
      ) ||
      run.pullRequestWatchObligations?.some(
        (row) => row.state === "active" || row.state === "terminal-pending",
      ),
  );
}

const promotionRefusal = {
  in_flight:
    "This task is still working for its requester. Wait for it to finish or cancel it with task_cancel, then promote it.",
  owner_unavailable: "The owner thread is missing, archived, or being archived.",
  unavailable: "This thread is unavailable for an ownership change.",
  wrong_action:
    "Promote requires an owned thread. Return to owner requires a thread released from its owner.",
} as const;

export function makeLastCodeThreadPromotion<E>(
  store: Pick<ProjectionStoreV2["Service"], "getThread" | "getThreadShell" | "getThreadRecords">,
  getEnvironmentId: Effect.Effect<EnvironmentId, E>,
) {
  const readOwner = (thread: OrchestrationV2AppThread) =>
    Effect.map(getEnvironmentId, (environmentId) => ({
      owner: getRecordedThreadOwner(thread, environmentId),
      environmentId,
    }));

  const read = Effect.fn("LastCodeThreadPromotion.read")(function* (threadId: ThreadId) {
    const thread = yield* store.getThread(threadId);
    const current = { thread, returnParentId: null };
    const { owner, environmentId } = yield* readOwner(thread);
    if (
      owner === null ||
      isProviderNativeSubagentThread(thread) ||
      thread.lineage.sideChat === true
    )
      return { ...current, availability: null } as const;
    const action: ThreadOwnershipAction =
      thread.lineage.independent === true ? "return_to_owner" : "promote";
    const ownerHere = owner.environmentId === environmentId;
    const availability = { action, ownerHere };
    if (thread.archivedAt !== null || thread.deletedAt !== null || thread.archivePending != null)
      return { ...current, availability: { ...availability, refusal: "unavailable" } } as const;

    if (action === "return_to_owner") {
      if (ownerHere) {
        const parent = yield* store.getThreadShell(owner.threadId);
        if (
          parent === null ||
          parent.archivedAt !== null ||
          parent.deletedAt !== null ||
          parent.archivePending?.status === "stopping"
        )
          return {
            ...current,
            availability: { ...availability, refusal: "owner_unavailable" },
          } as const;
        return {
          thread,
          returnParentId: defaultReturnParentId(thread, parent),
          availability: { ...availability, refusal: null },
        } as const;
      }
    } else if (thread.delegatedFrom != null || thread.lineage.relationshipToParent === "subagent") {
      const { runs } = yield* store.getThreadRecords(threadId, ["runs"]);
      if (hasOwnedContinuation(runs))
        return { ...current, availability: { ...availability, refusal: "in_flight" } } as const;
      if (thread.delegatedFrom != null) {
        const associations = thread.remoteDelegations ?? [];
        if (
          associations.length === 0 ||
          associations.some(
            (row) =>
              row.stage !== "disposed" && (row.stage !== "settled" || row.finalRun === undefined),
          )
        )
          return { ...current, availability: { ...availability, refusal: "in_flight" } } as const;
      } else {
        const { subagents } = yield* store
          .getThreadRecords(owner.threadId, ["subagents"], {
            subagentChildThreadIds: [threadId],
          })
          .pipe(
            Effect.catchTags({
              ProjectionStoreThreadNotFoundError: () => Effect.succeed({ subagents: [] }),
            }),
          );
        const tasks = subagents.filter((task) => task.origin === "app_owned");
        if (tasks.length === 0 || tasks.some((task) => !hasReleasedTaskResult(task)))
          return { ...current, availability: { ...availability, refusal: "in_flight" } } as const;
      }
    }
    return { ...current, availability: { ...availability, refusal: null } } as const;
  });

  const participants = Effect.fn("LastCodeThreadPromotion.participants")(function* (
    threadId: ThreadId,
  ) {
    const thread = yield* store.getThread(threadId);
    const { owner, environmentId } = yield* readOwner(thread);
    return owner?.environmentId === environmentId ? [threadId, owner.threadId] : [threadId];
  });

  const plan = Effect.fn("LastCodeThreadPromotion.plan")(function* (
    threadId: ThreadId,
    action: ThreadOwnershipAction,
  ) {
    const { thread, availability, returnParentId } = yield* read(threadId);
    if (availability?.action !== action) return yield* Effect.fail(promotionRefusal.wrong_action);
    if (availability.refusal !== null)
      return yield* Effect.fail(promotionRefusal[availability.refusal]);
    const { independent: _independent, ...lineage } = thread.lineage;
    const payload =
      action === "promote"
        ? {
            ...thread,
            lineage: { ...lineage, independent: true as const },
            groupedUnderThreadId: null,
            pinnedAt: null,
            pinOrderKey: null,
            activeOrderKey: null,
          }
        : {
            ...thread,
            lineage,
            groupedUnderThreadId:
              lineage.relationshipToParent === "subagent" ? null : returnParentId,
          };
    return {
      type: "thread.metadata-updated" as const,
      threadId,
      providerInstanceId: thread.providerInstanceId,
      occurredAt: thread.updatedAt,
      payload,
      previousGroupedUnderThreadId: getInteractiveThreadParentThreadId(thread),
      returnParentId,
    };
  });

  return { read, participants, plan };
}
