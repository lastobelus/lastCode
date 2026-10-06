import { CommandId, ThreadId, type ThreadWorktreeCleanup } from "@t3tools/contracts";
import { makeDrainableWorker, type DrainableWorker } from "@t3tools/shared/DrainableWorker";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as PreviewHosting from "../preview/Hosting.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEventStore from "../persistence/Services/OrchestrationEventStore.ts";
import * as LegacyImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderSessions from "./ProviderSessionManager.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";

type PendingCleanup = Exclude<ThreadWorktreeCleanup, { readonly status: "failed" }>;
type CleanupJob = { readonly threadId: ThreadId; readonly cleanup: PendingCleanup };

export class WorktreeCleanupError extends Schema.TaggedError<WorktreeCleanupError>()(
  "WorktreeCleanupError",
  {
    threadId: ThreadId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Unable to clean up the worktree for ${this.threadId}.`;
  }
}
export class WorktreeCleanupService extends Context.Service<
  WorktreeCleanupService,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
    readonly reconcile: Effect.Effect<void, WorktreeCleanupError, Scope.Scope>;
  }
>()("t3/orchestration-v2/WorktreeCleanupService") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const legacyImporter = yield* LegacyImporter.LegacyV1ThreadImporter;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const sessions = yield* ProviderSessions.ProviderSessionManagerV2;
  const previews = yield* PreviewHosting.PreviewHosting;
  const terminals = yield* TerminalManager.TerminalManager;
  const git = yield* GitWorkflow.GitWorkflowService;
  const events = yield* OrchestrationEventStore.OrchestrationEventStore;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcs = yield* VcsDriverRegistry.VcsDriverRegistry;
  const crypto = yield* Crypto.Crypto;
  const workers = new Map<string, DrainableWorker<CleanupJob>>();
  const enqueued = new Set<ThreadId>();
  const mutex = yield* Semaphore.make(1);
  const started = yield* Ref.make(false);
  const persistenceRetry = Schedule.exponential("1 second").pipe(
    Schedule.modifyDelay(({ duration }) =>
      Effect.succeed(Duration.min(duration, Duration.seconds(30))),
    ),
  );
  const canonical = (value: string) =>
    fs.realPath(value).pipe(
      Effect.orElseSucceed(() => value),
      Effect.map(normalizeProjectPathForComparison),
    );
  const containsPath = (directory: string, candidate: string) => {
    const relative = path.relative(directory, candidate);
    return (
      relative === "" ||
      (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
    );
  };

  const update = Effect.fn("WorktreeCleanupService.update")(function* (
    threadId: ThreadId,
    expected: ThreadWorktreeCleanup,
    cleanup: ThreadWorktreeCleanup | null,
  ) {
    // One id survives transient persistence retries so a committed receipt is replayed.
    const commandId = CommandId.make(`cleanup:${yield* crypto.randomUUIDv4}`);
    return yield* threads
      .dispatch({
        type: "thread.worktree-cleanup.update",
        commandId,
        threadId,
        expectedCleanup: expected,
        cleanup,
      })
      .pipe(
        Effect.retry({
          schedule: persistenceRetry,
          while: () =>
            projections.getThread(threadId).pipe(
              Effect.map(
                (thread) => JSON.stringify(thread.worktreeCleanup) === JSON.stringify(expected),
              ),
              Effect.orElseSucceed(() => true),
            ),
        }),
        Effect.asVoid,
      );
  });

  const process = Effect.fn("WorktreeCleanupService.process")(function* (job: CleanupJob) {
    let cleanup: ThreadWorktreeCleanup | null | undefined = job.cleanup;
    const execute = Effect.gen(function* () {
      const projection = yield* projections.getThreadRecords(job.threadId, ["providerSessions"]);
      cleanup = projection.thread.worktreeCleanup;
      if (projection.thread.deletedAt === null || cleanup == null || cleanup.status === "failed")
        return;
      yield* previews.removeThread(job.threadId);
      // Outbox detach receipts can lag the tombstone. Explicit idempotent teardown
      // makes removal wait for the actual provider and terminal handles to close.
      yield* Effect.forEach(
        projection.providerSessions,
        (session) =>
          sessions.teardownThread({
            providerSessionId: session.id,
            threadId: job.threadId,
            detail: "Worktree cleanup.",
          }),
        { discard: true },
      );
      yield* terminals.close({ threadId: job.threadId, deleteHistory: true });
      if (cleanup.status === "queued") {
        const deleting: ThreadWorktreeCleanup = {
          status: "deleting",
          repositoryRoot: cleanup.repositoryRoot,
          ...(cleanup.repositoryKey === undefined ? {} : { repositoryKey: cleanup.repositoryKey }),
          worktreePath: cleanup.worktreePath,
          startedAt: DateTime.formatIso(yield* DateTime.now),
        };
        yield* update(job.threadId, cleanup, deleting);
        cleanup = deleting;
      }
      const currentCleanup = cleanup;
      yield* withWorkspaceLease(
        path.resolve(currentCleanup.worktreePath),
        Effect.gen(function* () {
          const normalized = yield* canonical(currentCleanup.worktreePath);
          const retainedPreviewPaths = yield* Effect.forEach(
            yield* previews.protectedWorkspacePaths(),
            canonical,
            { concurrency: 8 },
          );
          if (retainedPreviewPaths.some((protectedPath) => containsPath(normalized, protectedPath)))
            return yield* Effect.fail("The worktree is retained by another active preview.");
          const projectOwners = yield* Effect.forEach(
            yield* projects.listShells(),
            (project) =>
              canonical(project.workspaceRoot).pipe(Effect.map((root) => ({ project, root }))),
            { concurrency: 8 },
          );
          if (projectOwners.some(({ root }) => root === normalized))
            return yield* Effect.fail("The worktree is now an active project root.");
          const shell = yield* projections.getShellSnapshot();
          const threadOwners = yield* Effect.forEach(
            [...shell.threads, ...shell.archivedThreads].filter(
              (thread) => thread.id !== job.threadId && thread.worktreePath !== null,
            ),
            (thread) =>
              canonical(thread.worktreePath!).pipe(Effect.map((root) => ({ thread, root }))),
            { concurrency: 8 },
          );
          if (threadOwners.some(({ root }) => root === normalized))
            return yield* Effect.fail("The worktree is now owned by another thread.");
          yield* git.removeWorktree({
            cwd: currentCleanup.repositoryRoot,
            path: currentCleanup.worktreePath,
            force: true,
            allowMissing: true,
          });
          // Persist completion before the queue advances. A restart after physical
          // removal is safe because allowMissing turns replay into the same success.
          yield* update(job.threadId, currentCleanup, null);
        }),
      );
    });
    yield* execute.pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.gen(function* () {
            if (cleanup == null || cleanup.status === "failed") return;
            const failedAt = DateTime.formatIso(yield* DateTime.now);
            yield* update(job.threadId, cleanup, {
              status: "failed",
              repositoryRoot: cleanup.repositoryRoot,
              ...(cleanup.repositoryKey === undefined
                ? {}
                : { repositoryKey: cleanup.repositoryKey }),
              worktreePath: cleanup.worktreePath,
              startedAt: cleanup.status === "deleting" ? cleanup.startedAt : failedAt,
              failedAt,
              error: Cause.pretty(cause),
            }).pipe(
              Effect.catchCause((persistenceCause) =>
                Effect.logError("Worktree cleanup failure receipt could not be persisted", {
                  threadId: job.threadId,
                  cause: persistenceCause,
                }),
              ),
            );
          }),
      ),
      Effect.ensuring(Effect.sync(() => enqueued.delete(job.threadId))),
    );
  });

  const enqueue = Effect.fn("WorktreeCleanupService.enqueue")(function* (job: CleanupJob) {
    if (enqueued.has(job.threadId)) return;
    const handle = yield* vcs.resolve({ cwd: job.cleanup.repositoryRoot });
    const metadata = handle.repository.metadataPath;
    if (metadata === null)
      return yield* Effect.fail("Repository common metadata path is unavailable.");
    const key = yield* fs
      .realPath(path.resolve(job.cleanup.repositoryRoot, metadata))
      .pipe(Effect.map(normalizeProjectPathForComparison));
    yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        if (enqueued.has(job.threadId)) return;
        let worker = workers.get(key);
        if (worker === undefined) {
          worker = yield* makeDrainableWorker(process);
          workers.set(key, worker);
        }
        enqueued.add(job.threadId);
        yield* worker.enqueue(job);
      }),
    );
  });

  const sweep = Effect.fn("WorktreeCleanupService.sweep")(function* () {
    const pending = yield* projections.getWorktreeCleanupThreads;
    const ordered = [...pending].sort((a, b) => {
      const ac = a.worktreeCleanup;
      const bc = b.worktreeCleanup;
      if (ac?.status === "deleting" && bc?.status !== "deleting") return -1;
      if (bc?.status === "deleting" && ac?.status !== "deleting") return 1;
      const at = ac?.status === "queued" ? ac.queuedAt : ac?.startedAt;
      const bt = bc?.status === "queued" ? bc.queuedAt : bc?.startedAt;
      return (at ?? "").localeCompare(bt ?? "");
    });
    for (const thread of ordered) {
      if (
        thread.deletedAt === null ||
        thread.worktreeCleanup == null ||
        thread.worktreeCleanup.status === "failed"
      )
        continue;
      const cleanup = thread.worktreeCleanup;
      yield* enqueue({ threadId: thread.id, cleanup }).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.gen(function* () {
              const failedAt = DateTime.formatIso(yield* DateTime.now);
              yield* update(thread.id, cleanup, {
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
            }),
        ),
      );
    }
  });
  // Only startup/manual reconciliation scans the historical tables. Ongoing events use V2.
  const reconcile = legacyImporter.reconcileShells.pipe(Effect.andThen(sweep()));
  const start: WorktreeCleanupService["Service"]["start"] = () =>
    Effect.gen(function* () {
      if (yield* Ref.getAndSet(started, true)) return;
      const sequence = yield* events.latestApplicationSequence.pipe(Effect.orDie);
      yield* forkParked(
        Effect.gen(function* () {
          yield* reconcile.pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Worktree cleanup startup scan failed", { cause }),
            ),
          );
          yield* events.streamApplicationEvents({ afterSequence: sequence }).pipe(
            Stream.filter(
              (event) =>
                !("aggregateKind" in event) &&
                (event.event.type === "thread.deleted" ||
                  event.event.type === "thread.metadata-updated"),
            ),
            Stream.runForEach(() =>
              sweep().pipe(
                Effect.catchCause((cause) =>
                  Effect.logError("Worktree cleanup scan failed", { cause }),
                ),
              ),
            ),
            Effect.orDie,
          );
        }),
      );
    });
  return WorktreeCleanupService.of({
    start,
    reconcile: reconcile.pipe(
      Effect.mapError(
        (cause) => new WorktreeCleanupError({ threadId: ThreadId.make("cleanup-scan"), cause }),
      ),
    ),
    drain: Effect.suspend(() =>
      Effect.forEach([...workers.values()], (worker) => worker.drain, {
        discard: true,
        concurrency: "unbounded",
      }),
    ),
  });
});

export const layer = Layer.effect(WorktreeCleanupService, make);
