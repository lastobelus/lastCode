import { CommandId, type OrchestrationEvent, type ThreadWorktreeCleanup } from "@t3tools/contracts";
import { makeDrainableWorker, type DrainableWorker } from "@t3tools/shared/DrainableWorker";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from "../Services/ThreadDeletionReactor.ts";
import { forkParked } from "../../serverActivation.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";

type ThreadDeletedEvent = Extract<OrchestrationEvent, { type: "thread.deleted" }>;
type PendingCleanup = Exclude<ThreadWorktreeCleanup, { readonly status: "failed" }>;
type CleanupJob = {
  readonly threadId: ThreadDeletedEvent["payload"]["threadId"];
  readonly cleanup: PendingCleanup;
  readonly needsTeardown: boolean;
};
type CleanupWorkerEntry = {
  readonly repositoryKey: string;
  readonly worker: DrainableWorker<CleanupJob>;
  readonly generation: Ref.Ref<number>;
};

const CLEANUP_WORKER_IDLE_TIMEOUT = Duration.minutes(1);

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
  const projectionProjects = yield* ProjectionProjectRepository;
  const projectionThreads = yield* ProjectionThreadRepository;
  const providerService = yield* ProviderService;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const fileSystem = yield* FileSystem.FileSystem;
  const vcsDriverRegistry = yield* Effect.serviceOption(VcsDriverRegistry.VcsDriverRegistry);
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const cleanupWorkersRef = yield* Ref.make<ReadonlyMap<string, CleanupWorkerEntry>>(new Map());
  const cleanupWorkersMutex = yield* Semaphore.make(1);
  const enqueuedCleanupThreadIdsRef = yield* Ref.make<ReadonlySet<string>>(new Set());
  const failedThreadTeardownIdsRef = yield* Ref.make<ReadonlySet<string>>(new Set());

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const canonicalPathForComparison = (value: string) =>
    fileSystem.realPath(value).pipe(
      Effect.map(normalizeProjectPathForComparison),
      Effect.orElseSucceed(() => normalizeProjectPathForComparison(value)),
    );
  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

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

  const cleanupPersistenceRetrySchedule = Schedule.exponential("1 second").pipe(
    Schedule.modifyDelay(({ duration }) =>
      Effect.succeed(Duration.min(duration, Duration.seconds(30))),
    ),
  );
  const dispatchCleanupWithRetry = (
    threadId: CleanupJob["threadId"],
    cleanup: ThreadWorktreeCleanup | null,
  ) =>
    dispatchCleanup(threadId, cleanup).pipe(
      Effect.retry({ schedule: cleanupPersistenceRetrySchedule }),
    );

  const clearFailedThreadTeardown = (threadId: CleanupJob["threadId"]) =>
    Ref.update(failedThreadTeardownIdsRef, (threadIds) => {
      const next = new Set(threadIds);
      next.delete(threadId);
      return next;
    });

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

  const stopProviderSessionStrict = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    providerService
      .stopSession({ threadId })
      .pipe(Effect.catchTag("ProviderSessionNotFoundError", () => Effect.void));

  const closeThreadTerminalsStrict = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    terminalManager.close({ threadId, deleteHistory: true });

  const processThreadDeleted = Effect.fn("processThreadDeleted")(function* (
    event: ThreadDeletedEvent,
  ) {
    const { threadId } = event.payload;
    yield* stopProviderSession(threadId);
    yield* closeThreadTerminals(threadId);
  });

  const processThreadDeletedSafely = (event: ThreadDeletedEvent) => {
    const cleanup = event.payload.worktreeCleanup;
    const hasPendingWorktreeCleanup = cleanup != null && cleanup.status !== "failed";
    const teardown = hasPendingWorktreeCleanup
      ? Effect.gen(function* () {
          yield* stopProviderSessionStrict(event.payload.threadId);
          yield* closeThreadTerminalsStrict(event.payload.threadId);
        })
      : processThreadDeleted(event);

    return teardown.pipe(
      Effect.tap(() =>
        hasPendingWorktreeCleanup ? clearFailedThreadTeardown(event.payload.threadId) : Effect.void,
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        if (!hasPendingWorktreeCleanup || cleanup == null) {
          return Effect.logWarning("thread deletion reactor failed to process event", {
            eventType: event.type,
            threadId: event.payload.threadId,
            cause: Cause.pretty(cause),
          });
        }
        return Effect.gen(function* () {
          yield* Ref.update(failedThreadTeardownIdsRef, (threadIds) => {
            const next = new Set(threadIds);
            next.add(event.payload.threadId);
            return next;
          });
          const failedAt = yield* nowIso;
          yield* dispatchCleanupWithRetry(event.payload.threadId, {
            status: "failed",
            repositoryRoot: cleanup.repositoryRoot,
            ...(cleanup.repositoryKey === undefined
              ? {}
              : { repositoryKey: cleanup.repositoryKey }),
            worktreePath: cleanup.worktreePath,
            startedAt: cleanup.status === "deleting" ? cleanup.startedAt : failedAt,
            failedAt,
            error: Cause.pretty(cause),
          });
        });
      }),
    );
  };

  const worker = yield* makeDrainableWorker(processThreadDeletedSafely);

  const processCleanup = Effect.fn("processThreadWorktreeCleanup")(function* (job: CleanupJob) {
    if (job.needsTeardown) {
      yield* stopProviderSessionStrict(job.threadId);
      yield* closeThreadTerminalsStrict(job.threadId);
      yield* clearFailedThreadTeardown(job.threadId);
    }

    const projected = yield* projectionThreads.getById({ threadId: job.threadId });
    if (Option.isNone(projected)) return;
    const current = projected.value.worktreeCleanup;
    if (current == null || current.status === "failed") return;

    const startedAt = yield* nowIso;
    const deleting = {
      status: "deleting" as const,
      repositoryRoot: current.repositoryRoot,
      ...(current.repositoryKey === undefined ? {} : { repositoryKey: current.repositoryKey }),
      worktreePath: current.worktreePath,
      startedAt: current.status === "deleting" ? current.startedAt : startedAt,
    };
    if (current.status === "queued") {
      yield* dispatchCleanup(job.threadId, deleting);
    }

    const normalizedWorktreePath = yield* canonicalPathForComparison(deleting.worktreePath);
    const activeProjects = yield* Effect.forEach(
      yield* projectionProjects.listAll(),
      (project) =>
        canonicalPathForComparison(project.workspaceRoot).pipe(
          Effect.map((workspaceRoot) => ({ project, workspaceRoot })),
        ),
      { concurrency: "unbounded" },
    );
    const activeProject = activeProjects.find(
      ({ project, workspaceRoot }) =>
        project.deletedAt === null && workspaceRoot === normalizedWorktreePath,
    )?.project;
    if (activeProject !== undefined) {
      const failedAt = yield* nowIso;
      yield* dispatchCleanup(job.threadId, {
        ...deleting,
        status: "failed",
        failedAt,
        error: `Worktree '${deleting.worktreePath}' is now used as the workspace root of active project '${activeProject.projectId}'.`,
      });
      return;
    }
    const activeOwners = yield* Effect.forEach(
      yield* projectionThreads.listActiveWorktreeOwners(),
      (owner) =>
        canonicalPathForComparison(owner.worktreePath).pipe(
          Effect.map((worktreePath) => ({ owner, worktreePath })),
        ),
      { concurrency: "unbounded" },
    );
    const activeOwner = activeOwners.find(
      ({ owner, worktreePath }) =>
        owner.threadId !== job.threadId && worktreePath === normalizedWorktreePath,
    )?.owner;
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
    // A restart can observe `deleting` after Git removed the worktree but
    // before the completion event was persisted. Git quite reasonably rejects
    // a second removal of an unregistered path, so an absent path is already
    // the desired end state and should complete the durable cleanup.
    const alreadyRemoved =
      Result.isFailure(removal) && !(yield* fileSystem.exists(deleting.worktreePath));
    if (Result.isSuccess(removal) || alreadyRemoved) {
      yield* dispatchCleanupWithRetry(job.threadId, null);
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
          yield* dispatchCleanupWithRetry(job.threadId, {
            status: "failed",
            repositoryRoot: job.cleanup.repositoryRoot,
            ...(job.cleanup.repositoryKey === undefined
              ? {}
              : { repositoryKey: job.cleanup.repositoryKey }),
            worktreePath: job.cleanup.worktreePath,
            startedAt: job.cleanup.status === "deleting" ? job.cleanup.startedAt : failedAt,
            failedAt,
            error: detail,
          });
        });
      }),
    );

  const removeEnqueuedCleanupThreadId = (threadId: CleanupJob["threadId"]) =>
    Ref.update(enqueuedCleanupThreadIdsRef, (threadIds) => {
      const next = new Set(threadIds);
      next.delete(threadId);
      return next;
    });

  const resolveCleanupRepositoryKey = Effect.fn("resolveCleanupRepositoryKey")(function* (
    cleanup: PendingCleanup,
  ) {
    const persistedKey = cleanup.repositoryKey;

    if (Option.isNone(vcsDriverRegistry)) {
      return normalizeProjectPathForComparison(persistedKey ?? cleanup.repositoryRoot);
    }

    const handle = yield* vcsDriverRegistry.value
      .resolve({ cwd: cleanup.repositoryRoot })
      .pipe(Effect.option);
    const metadataPath = Option.isNone(handle) ? null : handle.value.repository.metadataPath;
    if (metadataPath === null) {
      return normalizeProjectPathForComparison(persistedKey ?? cleanup.repositoryRoot);
    }
    const resolvedMetadataPath = path.isAbsolute(metadataPath)
      ? path.normalize(metadataPath)
      : path.resolve(cleanup.repositoryRoot, metadataPath);
    const canonicalMetadataPath = yield* fileSystem
      .realPath(resolvedMetadataPath)
      .pipe(Effect.orElseSucceed(() => resolvedMetadataPath));
    return normalizeProjectPathForComparison(canonicalMetadataPath);
  });

  const getCleanupWorker = Effect.fn("getThreadWorktreeCleanupWorker")(function* (
    cleanup: PendingCleanup,
  ) {
    const repositoryKey = yield* resolveCleanupRepositoryKey(cleanup);
    const existing = (yield* Ref.get(cleanupWorkersRef)).get(repositoryKey);
    if (existing) return existing;
    const created = yield* makeDrainableWorker((job: CleanupJob) =>
      processCleanupSafely(job).pipe(Effect.ensuring(removeEnqueuedCleanupThreadId(job.threadId))),
    );
    const entry: CleanupWorkerEntry = {
      repositoryKey,
      worker: created,
      generation: yield* Ref.make(0),
    };
    yield* Ref.update(cleanupWorkersRef, (workers) => {
      const next = new Map(workers);
      next.set(repositoryKey, entry);
      return next;
    });
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(CLEANUP_WORKER_IDLE_TIMEOUT);
          const generation = yield* cleanupWorkersMutex.withPermit(Ref.get(entry.generation));
          // Drain outside the global mutex so a long cleanup for one
          // repository cannot block unrelated repositories from enqueueing.
          yield* entry.worker.drain;
          const retired = yield* cleanupWorkersMutex.withPermit(
            Effect.gen(function* () {
              const current = (yield* Ref.get(cleanupWorkersRef)).get(repositoryKey);
              if (current !== entry || (yield* Ref.get(entry.generation)) !== generation) {
                return false;
              }
              yield* Ref.update(cleanupWorkersRef, (workers) => {
                const next = new Map(workers);
                if (next.get(repositoryKey) === entry) next.delete(repositoryKey);
                return next;
              });
              return true;
            }),
          );
          if (retired) {
            yield* entry.worker.shutdown;
            return;
          }
        }
      }),
    );
    return entry;
  });

  const enqueueCleanup = Effect.fn("enqueueThreadWorktreeCleanup")(function* (job: CleanupJob) {
    const accepted = yield* Ref.modify(enqueuedCleanupThreadIdsRef, (threadIds) => {
      if (threadIds.has(job.threadId)) return [false, threadIds] as const;
      const next = new Set(threadIds);
      next.add(job.threadId);
      return [true, next] as const;
    });
    if (!accepted) return;

    yield* cleanupWorkersMutex.withPermit(
      Effect.gen(function* () {
        const entry = yield* getCleanupWorker(job.cleanup);
        yield* Ref.update(entry.generation, (generation) => generation + 1);
        yield* entry.worker.enqueue(job);
      }),
    );
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
      if (cleanup == null || cleanup.status === "failed") return Effect.void;
      return enqueueCleanup({
        threadId: event.payload.threadId,
        cleanup,
        // Cleanup updates include retries after a persisted teardown failure.
        // Repeating idempotent teardown is safer than relying on process-local
        // memory, especially when the retry arrives after a server restart.
        needsTeardown: true,
      });
    }
    return Effect.void;
  };

  const cleanupDrain = Effect.gen(function* () {
    const workers = yield* Ref.get(cleanupWorkersRef);
    yield* Effect.forEach(workers.values(), (entry) => entry.worker.drain, {
      concurrency: "unbounded",
    });
  });

  const start: ThreadDeletionReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type === "thread.deleted") {
          return worker
            .enqueue(event)
            .pipe(
              Effect.andThen(worker.drain),
              Effect.andThen(
                Ref.get(failedThreadTeardownIdsRef).pipe(
                  Effect.flatMap((failedThreadIds) =>
                    failedThreadIds.has(event.payload.threadId)
                      ? Effect.void
                      : enqueueCleanupFromEvent(event),
                  ),
                ),
              ),
            );
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
