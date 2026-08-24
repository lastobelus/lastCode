import { CommandId, type OrchestrationEvent, type ThreadWorktreeCleanup } from "@t3tools/contracts";
import { makeDrainableWorker, type DrainableWorker } from "@t3tools/shared/DrainableWorker";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from "../Services/ThreadDeletionReactor.ts";
import { forkParked } from "../../serverActivation.ts";

type ThreadDeletedEvent = Extract<OrchestrationEvent, { type: "thread.deleted" }>;
type PendingCleanup = Exclude<ThreadWorktreeCleanup, { readonly status: "failed" }>;
type CleanupJob = {
  readonly threadId: ThreadDeletedEvent["payload"]["threadId"];
  readonly cleanup: PendingCleanup;
  readonly needsTeardown: boolean;
};

export const logCleanupCauseUnlessInterrupted = <R, E>({
  effect,
  message,
  threadId,
}: {
  readonly effect: Effect.Effect<void, E, R>;
  readonly message: string;
  readonly threadId: ThreadDeletedEvent["payload"]["threadId"];
}): Effect.Effect<void, E, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      return Effect.logDebug(message, {
        threadId,
        cause: Cause.pretty(cause),
      });
    }),
  );

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const gitWorkflow = yield* GitWorkflowService;
  const projectionThreads = yield* ProjectionThreadRepository;
  const providerService = yield* ProviderService;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const crypto = yield* Crypto.Crypto;
  const cleanupWorkersRef = yield* Ref.make<ReadonlyMap<string, DrainableWorker<CleanupJob>>>(
    new Map(),
  );
  const enqueuedCleanupThreadIdsRef = yield* Ref.make<ReadonlySet<string>>(new Set());

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

  const stopProviderSession = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: providerService.stopSession({ threadId }),
      message: "thread deletion cleanup skipped provider session stop",
      threadId,
    });

  const closeThreadTerminals = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: terminalManager.close({ threadId, deleteHistory: true }),
      message: "thread deletion cleanup skipped terminal close",
      threadId,
    });

  const processThreadDeleted = Effect.fn("processThreadDeleted")(function* (
    event: ThreadDeletedEvent,
  ) {
    const { threadId } = event.payload;
    yield* stopProviderSession(threadId);
    yield* closeThreadTerminals(threadId);
  });

  const processThreadDeletedSafely = (event: ThreadDeletedEvent) =>
    processThreadDeleted(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread deletion reactor failed to process event", {
          eventType: event.type,
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processThreadDeletedSafely);

  const dispatchCleanup = Effect.fn("dispatchThreadWorktreeCleanup")(function* (
    threadId: CleanupJob["threadId"],
    cleanup: ThreadWorktreeCleanup | null,
  ) {
    yield* orchestrationEngine.dispatch({
      type: "thread.worktree-cleanup.update",
      commandId: yield* serverCommandId("worktree-cleanup-update"),
      threadId,
      cleanup,
    });
  });

  const processCleanup = Effect.fn("processThreadWorktreeCleanup")(function* (job: CleanupJob) {
    if (job.needsTeardown) {
      yield* stopProviderSession(job.threadId);
      yield* closeThreadTerminals(job.threadId);
    }

    const projected = yield* projectionThreads.getById({ threadId: job.threadId });
    if (Option.isNone(projected)) return;
    const current = projected.value.worktreeCleanup;
    if (current == null || current.status === "failed") return;

    const startedAt = yield* nowIso;
    const deleting = {
      status: "deleting" as const,
      repositoryRoot: current.repositoryRoot,
      worktreePath: current.worktreePath,
      startedAt: current.status === "deleting" ? current.startedAt : startedAt,
    };
    if (current.status === "queued") {
      yield* dispatchCleanup(job.threadId, deleting);
    }

    const normalizedWorktreePath = normalizeProjectPathForComparison(deleting.worktreePath);
    const activeOwner = (yield* projectionThreads.listActiveWorktreeOwners()).find(
      (candidate) =>
        candidate.threadId !== job.threadId &&
        normalizeProjectPathForComparison(candidate.worktreePath) === normalizedWorktreePath,
    );
    if (activeOwner !== undefined) {
      const failedAt = yield* nowIso;
      yield* dispatchCleanup(job.threadId, {
        ...deleting,
        status: "failed",
        failedAt,
        error: `Worktree '${deleting.worktreePath}' is now used by active thread '${activeOwner.threadId}'.`,
      });
      return;
    }

    const removal = yield* Effect.result(
      gitWorkflow.removeWorktree({
        cwd: deleting.repositoryRoot,
        path: deleting.worktreePath,
        force: true,
      }),
    );
    if (Result.isSuccess(removal)) {
      yield* dispatchCleanup(job.threadId, null).pipe(
        Effect.retry({ times: 2 }),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
          return Effect.logWarning("removed worktree but could not persist cleanup completion", {
            threadId: job.threadId,
            worktreePath: deleting.worktreePath,
            cause: Cause.pretty(cause),
          });
        }),
      );
      return;
    }

    const failedAt = yield* nowIso;
    yield* dispatchCleanup(job.threadId, {
      ...deleting,
      status: "failed",
      failedAt,
      error: removal.failure.message,
    });
  });

  const processCleanupSafely = (job: CleanupJob) =>
    processCleanup(job).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        const detail = Cause.pretty(cause);
        return Effect.gen(function* () {
          const failedAt = yield* nowIso;
          yield* dispatchCleanup(job.threadId, {
            status: "failed",
            repositoryRoot: job.cleanup.repositoryRoot,
            worktreePath: job.cleanup.worktreePath,
            startedAt: job.cleanup.status === "deleting" ? job.cleanup.startedAt : failedAt,
            failedAt,
            error: detail,
          }).pipe(
            Effect.catchCause((dispatchCause) =>
              Effect.logWarning("thread worktree cleanup failure could not be persisted", {
                threadId: job.threadId,
                worktreePath: job.cleanup.worktreePath,
                cleanupCause: detail,
                dispatchCause: Cause.pretty(dispatchCause),
              }),
            ),
          );
        });
      }),
    );

  const removeEnqueuedCleanupThreadId = (threadId: CleanupJob["threadId"]) =>
    Ref.update(enqueuedCleanupThreadIdsRef, (threadIds) => {
      const next = new Set(threadIds);
      next.delete(threadId);
      return next;
    });

  const getCleanupWorker = Effect.fn("getThreadWorktreeCleanupWorker")(function* (
    repositoryRoot: string,
  ) {
    const repositoryKey = normalizeProjectPathForComparison(repositoryRoot);
    const existing = (yield* Ref.get(cleanupWorkersRef)).get(repositoryKey);
    if (existing) return existing;
    const created = yield* makeDrainableWorker((job: CleanupJob) =>
      processCleanupSafely(job).pipe(Effect.ensuring(removeEnqueuedCleanupThreadId(job.threadId))),
    );
    return yield* Ref.modify(cleanupWorkersRef, (workers) => {
      const current = workers.get(repositoryKey);
      if (current) return [current, workers] as const;
      const next = new Map(workers);
      next.set(repositoryKey, created);
      return [created, next] as const;
    });
  });

  const enqueueCleanup = Effect.fn("enqueueThreadWorktreeCleanup")(function* (job: CleanupJob) {
    const accepted = yield* Ref.modify(enqueuedCleanupThreadIdsRef, (threadIds) => {
      if (threadIds.has(job.threadId)) return [false, threadIds] as const;
      const next = new Set(threadIds);
      next.add(job.threadId);
      return [true, next] as const;
    });
    if (!accepted) return;

    const cleanupWorker = yield* getCleanupWorker(job.cleanup.repositoryRoot);
    yield* cleanupWorker.enqueue(job);
  });

  const enqueueCleanupFromEvent = (event: OrchestrationEvent) => {
    if (event.type === "thread.deleted") {
      const cleanup = event.payload.worktreeCleanup;
      return cleanup == null || cleanup.status === "failed"
        ? Effect.void
        : enqueueCleanup({
            threadId: event.payload.threadId,
            cleanup,
            needsTeardown: false,
          });
    }
    if (event.type === "thread.worktree-cleanup-updated") {
      const cleanup = event.payload.cleanup;
      return cleanup == null || cleanup.status === "failed"
        ? Effect.void
        : enqueueCleanup({
            threadId: event.payload.threadId,
            cleanup,
            needsTeardown: false,
          });
    }
    return Effect.void;
  };

  const cleanupDrain = Effect.gen(function* () {
    const workers = yield* Ref.get(cleanupWorkersRef);
    yield* Effect.forEach(workers.values(), (cleanupWorker) => cleanupWorker.drain, {
      concurrency: "unbounded",
    });
  });

  const start: ThreadDeletionReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type === "thread.deleted") {
          return worker
            .enqueue(event)
            .pipe(Effect.andThen(worker.drain), Effect.andThen(enqueueCleanupFromEvent(event)));
        }
        return enqueueCleanupFromEvent(event);
      }),
    );

    yield* projectionThreads.listPendingWorktreeCleanup().pipe(
      Effect.flatMap((resumable) =>
        Effect.forEach(resumable, (thread) => {
          const cleanup = thread.worktreeCleanup;
          return cleanup == null || cleanup.status === "failed"
            ? Effect.void
            : enqueueCleanup({ threadId: thread.threadId, cleanup, needsTeardown: true });
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("thread worktree cleanup resume failed", {
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  return {
    start,
    drain: Effect.all([worker.drain, cleanupDrain]).pipe(Effect.asVoid),
  } satisfies ThreadDeletionReactorShape;
});

export const ThreadDeletionReactorLive = Layer.effect(ThreadDeletionReactor, make);
