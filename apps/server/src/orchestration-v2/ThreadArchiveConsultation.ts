import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import { hasUnfinishedArchiveWork, type ArchiveControls } from "./ThreadArchivePolicy.ts";
import type {
  OrchestrationV2AppThread,
  OrchestrationV2Run,
  OrchestrationV2Subagent,
  ThreadArchiveConsultationTarget,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

export interface ArchiveConsultationSnapshot extends Omit<
  ArchiveControls,
  "thread" | "runs" | "subagents"
> {
  readonly thread: Pick<
    OrchestrationV2AppThread,
    | "id"
    | "title"
    | "creationSource"
    | "lineage"
    | "archivedAt"
    | "deletedAt"
    | "archivePending"
    | "actionResume"
  >;
  readonly runs: ReadonlyArray<
    Pick<OrchestrationV2Run, "id" | "ordinal" | "status" | "activeAttemptId">
  >;
  readonly subagents: ReadonlyArray<
    Pick<
      OrchestrationV2Subagent,
      "id" | "origin" | "status" | "childThreadId" | "ownershipReleased"
    >
  >;
}

const active = (status: string) =>
  ["queued", "preparing", "starting", "running", "waiting"].includes(status);

const ownActivity = (record: ArchiveConsultationSnapshot) =>
  hasUnfinishedArchiveWork({ ...record, subagents: [] });

/** Visual grouping is not authority to inspect or cancel another agent's tasks. */
export const archiveConsultationTargets = Effect.fn("ThreadArchiveConsultation.targets")(function* <
  E,
>(
  activeThreadIds: ReadonlyArray<ThreadId>,
  read: (threadId: ThreadId) => Effect.Effect<ArchiveConsultationSnapshot | null, E>,
  available: (threadId: ThreadId) => Effect.Effect<boolean, E>,
): Effect.fn.Return<ReadonlyArray<ThreadArchiveConsultationTarget>, E> {
  const records = new Map<ThreadId, ArchiveConsultationSnapshot | null>();
  const load = Effect.fn("ThreadArchiveConsultation.load")(function* (threadId: ThreadId) {
    if (records.has(threadId)) return records.get(threadId) ?? null;
    const result = yield* read(threadId);
    records.set(threadId, result);
    return result;
  });
  const candidates: Array<{
    threadId: ThreadId;
    owner?: ArchiveConsultationSnapshot;
    taskId?: OrchestrationV2Subagent["id"];
  }> = [];
  for (const threadId of new Set(activeThreadIds)) {
    const record = yield* load(threadId);
    if (record === null) continue;
    const tasks = record.subagents.filter(
      (task) =>
        task.origin === "app_owned" &&
        task.childThreadId !== null &&
        task.ownershipReleased !== true &&
        isOrchestrationV2WorkActive(task.status),
    );
    // An idle owner held only by a stale child task can answer about that task.
    // It is not itself a busy execution that the question would queue behind.
    for (const task of tasks)
      candidates.push({ threadId: task.childThreadId!, owner: record, taskId: task.id });
    if (ownActivity(record) || tasks.length === 0) candidates.push({ threadId });
  }
  const targets = new Map<ThreadId, ThreadArchiveConsultationTarget>();
  for (const candidate of candidates) {
    const { threadId } = candidate;
    const blocked = yield* load(threadId);
    if (blocked === null && candidate.owner === undefined) continue;
    let owner = candidate.owner ?? blocked!;
    let taskId = candidate.taskId;
    const visited = new Set<ThreadId>([threadId]);
    while (
      candidate.owner === undefined &&
      owner.thread.lineage.relationshipToParent === "subagent" &&
      owner.thread.lineage.independent !== true &&
      owner.thread.lineage.parentThreadId !== null
    ) {
      const parentId = owner.thread.lineage.parentThreadId;
      if (visited.has(parentId)) break;
      visited.add(parentId);
      const parent = yield* load(parentId);
      if (parent === null) break;
      const tasks = parent.subagents.filter(
        (entry) =>
          entry.childThreadId === owner.thread.id &&
          entry.origin === "app_owned" &&
          entry.ownershipReleased !== true,
      );
      const task =
        tasks.findLast((entry) => isOrchestrationV2WorkActive(entry.status)) ?? tasks.at(-1);
      // Native mirrors share a session. App-owned children require a task edge;
      // lineage alone may be historical after ownership was released.
      if (owner.thread.creationSource !== "provider" && task === undefined) break;
      taskId = task?.id ?? taskId;
      owner = parent;
      if (owner.thread.creationSource !== "provider") break;
    }
    const unavailable =
      owner.thread.creationSource === "provider" ||
      owner.thread.archivedAt !== null ||
      owner.thread.deletedAt !== null ||
      !(yield* available(owner.thread.id));
    const busy =
      owner.thread.archivePending?.status === "stopping" ||
      ownActivity(owner) ||
      owner.thread.id === threadId;
    const unavailableReason = unavailable
      ? ("unavailable" as const)
      : busy
        ? ("busy" as const)
        : undefined;
    const runs = blocked?.runs.filter((run) => active(run.status)) ?? [];
    const work: ThreadArchiveConsultationTarget["work"] =
      runs.length === 0
        ? [{ threadId, ...(taskId === undefined ? {} : { taskId }) }]
        : runs.map((run) => ({
            threadId,
            ...(taskId === undefined ? {} : { taskId }),
            runId: run.id,
            ...(run.activeAttemptId === null ? {} : { attemptId: run.activeAttemptId }),
          }));
    const previous = targets.get(owner.thread.id);
    const unique = new Map(
      [...(previous?.work ?? []), ...work].map((entry) => [
        `${entry.threadId}:${entry.taskId ?? ""}:${entry.runId ?? ""}:${entry.attemptId ?? ""}`,
        entry,
      ]),
    );
    targets.set(owner.thread.id, {
      ownerThreadId: owner.thread.id,
      ownerTitle: owner.thread.title,
      work: [...unique.values()],
      ...(unavailableReason === undefined ? {} : { unavailableReason }),
    });
  }
  return [...targets.values()];
});
