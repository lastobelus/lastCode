import {
  CommandId,
  EventId,
  GitCommandError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type ThreadWorktreeCleanup,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";

import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import { ProviderAdapterProcessError } from "../../provider/Errors.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import {
  ProjectionThreadRepository,
  type ProjectionThread,
} from "../../persistence/Services/ProjectionThreads.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import {
  logCleanupCauseUnlessInterrupted,
  ThreadDeletionReactorLive,
} from "./ThreadDeletionReactor.ts";

describe("logCleanupCauseUnlessInterrupted", () => {
  const threadId = ThreadId.make("thread-deletion-reactor-test");

  it("swallows ordinary cleanup failures", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});

function cleanupRow(
  id: string,
  cleanup: ThreadWorktreeCleanup,
  deletedAt: string,
): ProjectionThread {
  return {
    threadId: ThreadId.make(id),
    projectId: ProjectId.make("project-cleanup"),
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: id,
    worktreePath: cleanup.worktreePath,
    latestTurnId: null,
    createdAt: deletedAt,
    updatedAt: deletedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    ...({ unsettledAt: null } as Record<"unsettledAt", null>),
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    annotation: null,
    worktreeCleanup: cleanup,
    latestUserMessageId: null,
    latestUserMessageAt: null,
    pendingApprovalCount: 0,
    pendingUserInputCount: 0,
    hasActionableProposedPlan: 0,
    deletedAt,
  };
}

function deletedEventFor(
  thread: ProjectionThread,
  eventId: string,
  sequence: number,
): Extract<OrchestrationEvent, { type: "thread.deleted" }> {
  return {
    sequence,
    eventId: EventId.make(eventId),
    aggregateKind: "thread",
    aggregateId: thread.threadId,
    type: "thread.deleted",
    occurredAt: "2026-08-23T00:00:00.000Z",
    commandId: CommandId.make(`${eventId}-command`),
    causationEventId: null,
    correlationId: CommandId.make(`${eventId}-correlation`),
    metadata: {},
    payload: {
      threadId: thread.threadId,
      deletedAt: "2026-08-23T00:00:00.000Z",
      worktreeCleanup: thread.worktreeCleanup ?? undefined,
    },
  };
}

function cleanupUpdatedEventFor(
  thread: ProjectionThread,
  eventId: string,
  sequence: number,
): Extract<OrchestrationEvent, { type: "thread.worktree-cleanup-updated" }> {
  return {
    sequence,
    eventId: EventId.make(eventId),
    aggregateKind: "thread",
    aggregateId: thread.threadId,
    type: "thread.worktree-cleanup-updated",
    occurredAt: "2026-08-23T00:00:00.000Z",
    commandId: CommandId.make(`${eventId}-command`),
    causationEventId: null,
    correlationId: CommandId.make(`${eventId}-correlation`),
    metadata: {},
    payload: {
      threadId: thread.threadId,
      cleanup: thread.worktreeCleanup!,
      updatedAt: "2026-08-23T00:00:00.000Z",
    },
  };
}

describe("durable worktree cleanup", () => {
  effectIt.live("tears down the thread before removing its worktree and retries completion", () =>
    Effect.gen(function* () {
      const thread = cleanupRow(
        "cleanup-event",
        {
          status: "deleting",
          repositoryRoot: "/repo",
          worktreePath: "/worktrees/event",
          startedAt: "2026-08-23T00:00:00.000Z",
        },
        "2026-08-23T00:00:00.000Z",
      );
      const deletedEvent: Extract<OrchestrationEvent, { type: "thread.deleted" }> = {
        sequence: 1,
        eventId: EventId.make("event-thread-deleted"),
        aggregateKind: "thread",
        aggregateId: thread.threadId,
        type: "thread.deleted",
        occurredAt: "2026-08-23T00:00:00.000Z",
        commandId: CommandId.make("command-thread-deleted"),
        causationEventId: null,
        correlationId: CommandId.make("command-thread-deleted"),
        metadata: {},
        payload: {
          threadId: thread.threadId,
          deletedAt: "2026-08-23T00:00:00.000Z",
          worktreeCleanup: thread.worktreeCleanup ?? undefined,
        },
      };
      const rows = new Map([[thread.threadId, thread]]);
      const operations: string[] = [];
      const teardownStarted = yield* Deferred.make<void, never>();
      const releaseTeardown = yield* Deferred.make<void, never>();
      const removed = yield* Deferred.make<void>();
      const completionDispatchFailed = yield* Deferred.make<void>();
      let completionDispatchAttempts = 0;
      const dependencies = Layer.mergeAll(
        Layer.mock(OrchestrationEngineService)({
          streamDomainEvents: Stream.make(deletedEvent),
          latestSequence: Effect.succeed(1),
          readEvents: () => Stream.empty,
          dispatch: (command) => {
            if (
              command.type === "thread.worktree-cleanup.update" &&
              command.cleanup === null &&
              completionDispatchAttempts++ === 0
            ) {
              return Deferred.succeed(completionDispatchFailed, undefined).pipe(
                Effect.andThen(
                  Effect.fail(
                    new PersistenceSqlError({
                      operation: "test.dispatchCleanup",
                      detail: "transient persistence failure",
                    }),
                  ),
                ),
              );
            }
            if (command.type === "thread.worktree-cleanup.update") {
              const row = rows.get(command.threadId);
              if (row) rows.set(command.threadId, { ...row, worktreeCleanup: command.cleanup });
            }
            return Effect.succeed({ sequence: 2 });
          },
        }),
        Layer.mock(ProjectionThreadRepository)({
          getById: ({ threadId }) => Effect.succeed(Option.fromUndefinedOr(rows.get(threadId))),
          listPendingWorktreeCleanup: () => Effect.succeed([]),
          listActiveWorktreeOwners: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectionProjectRepository)({
          listAll: () => Effect.succeed([]),
        }),
        Layer.mock(GitWorkflowService)({
          removeWorktree: ({ path }) =>
            Effect.sync(() => operations.push(`remove:${path}`)).pipe(
              Effect.andThen(Deferred.succeed(removed, undefined)),
            ),
        }),
        Layer.mock(ProviderService)({
          stopSession: ({ threadId }) =>
            Effect.sync(() => void operations.push(`stop:${threadId}`)).pipe(
              Effect.andThen(Deferred.succeed(teardownStarted, undefined)),
              Effect.andThen(Deferred.await(releaseTeardown)),
            ),
        }),
        Layer.mock(TerminalManager.TerminalManager)({
          close: ({ threadId }) => Effect.sync(() => void operations.push(`close:${threadId}`)),
        }),
        NodeServices.layer,
      );
      const testDependencies = Layer.merge(TestClock.layer(), dependencies);
      const testLayer = ThreadDeletionReactorLive.pipe(
        Layer.provide(testDependencies),
        Layer.merge(testDependencies),
      );

      yield* Effect.gen(function* () {
        const reactor = yield* ThreadDeletionReactor;
        yield* reactor.start();
        yield* Deferred.await(teardownStarted);
        const drainCompleted = yield* Deferred.make<void, never>();
        const drain = yield* Effect.forkChild(
          reactor.drain.pipe(Effect.andThen(Deferred.succeed(drainCompleted, undefined))),
        );
        expect(yield* Deferred.isDone(drainCompleted)).toBe(false);
        yield* Deferred.succeed(releaseTeardown, undefined);
        yield* Deferred.await(removed);
        yield* Deferred.await(completionDispatchFailed);
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(drain);
      }).pipe(Effect.provide(testLayer));

      expect(operations).toEqual([
        `stop:${thread.threadId}`,
        `close:${thread.threadId}`,
        "remove:/worktrees/event",
      ]);
    }),
  );

  effectIt.live("blocks worktree removal when teardown fails and retries failed persistence", () =>
    Effect.gen(function* () {
      const thread = cleanupRow(
        "cleanup-teardown-failed",
        {
          status: "deleting",
          repositoryRoot: "/repo",
          worktreePath: "/worktrees/teardown-failed",
          startedAt: "2026-08-23T00:00:00.000Z",
        },
        "2026-08-23T00:00:00.000Z",
      );
      const deletedEvent: Extract<OrchestrationEvent, { type: "thread.deleted" }> = {
        sequence: 1,
        eventId: EventId.make("event-thread-deleted-teardown-failed"),
        aggregateKind: "thread",
        aggregateId: thread.threadId,
        type: "thread.deleted",
        occurredAt: "2026-08-23T00:00:00.000Z",
        commandId: CommandId.make("command-thread-deleted-teardown-failed"),
        causationEventId: null,
        correlationId: CommandId.make("command-thread-deleted-teardown-failed"),
        metadata: {},
        payload: {
          threadId: thread.threadId,
          deletedAt: "2026-08-23T00:00:00.000Z",
          worktreeCleanup: thread.worktreeCleanup ?? undefined,
        },
      };
      const rows = new Map([[thread.threadId, thread]]);
      const operations: string[] = [];
      const teardownFailed = yield* Deferred.make<void>();
      const failureDispatchFailed = yield* Deferred.make<void>();
      let failureDispatchAttempts = 0;
      const updates: Array<
        Extract<OrchestrationCommand, { type: "thread.worktree-cleanup.update" }>
      > = [];
      const dependencies = Layer.mergeAll(
        Layer.mock(OrchestrationEngineService)({
          streamDomainEvents: Stream.make(deletedEvent),
          latestSequence: Effect.succeed(1),
          readEvents: () => Stream.empty,
          dispatch: (command) => {
            if (
              command.type === "thread.worktree-cleanup.update" &&
              command.cleanup?.status === "failed" &&
              failureDispatchAttempts++ === 0
            ) {
              return Deferred.succeed(failureDispatchFailed, undefined).pipe(
                Effect.andThen(
                  Effect.fail(
                    new PersistenceSqlError({
                      operation: "test.dispatchCleanupFailure",
                      detail: "transient persistence failure",
                    }),
                  ),
                ),
              );
            }
            if (command.type === "thread.worktree-cleanup.update") {
              updates.push(command);
              const row = rows.get(command.threadId);
              if (row) rows.set(command.threadId, { ...row, worktreeCleanup: command.cleanup });
            }
            return Effect.succeed({ sequence: updates.length });
          },
        }),
        Layer.mock(ProjectionThreadRepository)({
          getById: ({ threadId }) => Effect.succeed(Option.fromUndefinedOr(rows.get(threadId))),
          listPendingWorktreeCleanup: () => Effect.succeed([]),
          listActiveWorktreeOwners: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectionProjectRepository)({
          listAll: () => Effect.succeed([]),
        }),
        Layer.mock(GitWorkflowService)({
          removeWorktree: () => Effect.sync(() => operations.push("remove-worktree")),
        }),
        Layer.mock(ProviderService)({
          stopSession: ({ threadId }) =>
            Effect.sync(() => operations.push(`stop:${threadId}`)).pipe(
              Effect.andThen(Deferred.succeed(teardownFailed, undefined)),
              Effect.andThen(
                Effect.fail(
                  new ProviderAdapterProcessError({
                    provider: "codex",
                    threadId: String(threadId),
                    detail: "provider process did not stop",
                  }),
                ),
              ),
            ),
        }),
        Layer.mock(TerminalManager.TerminalManager)({
          close: ({ threadId }) => Effect.sync(() => operations.push(`close:${threadId}`)),
        }),
        NodeServices.layer,
      );
      const testDependencies = Layer.merge(TestClock.layer(), dependencies);
      const testLayer = ThreadDeletionReactorLive.pipe(
        Layer.provide(testDependencies),
        Layer.merge(testDependencies),
      );

      yield* Effect.gen(function* () {
        const reactor = yield* ThreadDeletionReactor;
        yield* reactor.start();
        const drain = yield* Effect.forkChild(reactor.drain);
        yield* Deferred.await(teardownFailed);
        yield* Deferred.await(failureDispatchFailed);
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(drain);
      }).pipe(Effect.provide(testLayer));

      expect(operations).toEqual([`stop:${thread.threadId}`]);
      expect(failureDispatchAttempts).toBe(2);
      expect(updates).toHaveLength(1);
      expect(updates[0]?.cleanup).toMatchObject({
        status: "failed",
        error: expect.stringContaining("ProviderAdapterProcessError"),
      });
    }),
  );

  effectIt.live("retires idle workers and serializes jobs on a recreated worker", () =>
    Effect.gen(function* () {
      const root = "/repo";
      const first = cleanupRow(
        "cleanup-retire-first",
        {
          status: "deleting",
          repositoryRoot: root,
          worktreePath: "/worktrees/retire-first",
          startedAt: "2026-08-23T00:00:00.000Z",
        },
        "2026-08-23T00:00:00.000Z",
      );
      const second = cleanupRow(
        "cleanup-retire-second",
        {
          status: "deleting",
          repositoryRoot: root,
          worktreePath: "/worktrees/retire-second",
          startedAt: "2026-08-23T00:00:01.000Z",
        },
        "2026-08-23T00:00:01.000Z",
      );
      const third = cleanupRow(
        "cleanup-retire-third",
        {
          status: "deleting",
          repositoryRoot: root,
          worktreePath: "/worktrees/retire-third",
          startedAt: "2026-08-23T00:00:02.000Z",
        },
        "2026-08-23T00:00:02.000Z",
      );
      const rows = new Map([
        [first.threadId, first],
        [second.threadId, second],
        [third.threadId, third],
      ]);
      const events = yield* PubSub.unbounded<OrchestrationEvent>();
      const firstRemoved = yield* Deferred.make<void>();
      const secondStarted = yield* Deferred.make<void>();
      const thirdStarted = yield* Deferred.make<void>();
      const releaseSecond = yield* Deferred.make<void>();
      const removalOrder: string[] = [];
      let activeRemovals = 0;
      let maxActiveRemovals = 0;
      const dependencies = Layer.mergeAll(
        Layer.mock(OrchestrationEngineService)({
          streamDomainEvents: Stream.fromPubSub(events),
          latestSequence: Effect.succeed(0),
          readEvents: () => Stream.empty,
          dispatch: (command) => {
            if (command.type === "thread.worktree-cleanup.update") {
              const row = rows.get(command.threadId);
              if (row) rows.set(command.threadId, { ...row, worktreeCleanup: command.cleanup });
            }
            return Effect.succeed({ sequence: removalOrder.length });
          },
        }),
        Layer.mock(ProjectionThreadRepository)({
          getById: ({ threadId }) => Effect.succeed(Option.fromUndefinedOr(rows.get(threadId))),
          listPendingWorktreeCleanup: () => Effect.succeed([]),
          listActiveWorktreeOwners: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectionProjectRepository)({
          listAll: () => Effect.succeed([]),
        }),
        Layer.mock(GitWorkflowService)({
          removeWorktree: ({ path }) =>
            Effect.gen(function* () {
              activeRemovals += 1;
              maxActiveRemovals = Math.max(maxActiveRemovals, activeRemovals);
              if (path === first.worktreePath) {
                yield* Deferred.succeed(firstRemoved, undefined);
              } else if (path === second.worktreePath) {
                yield* Deferred.succeed(secondStarted, undefined);
                yield* Deferred.await(releaseSecond);
              } else if (path === third.worktreePath) {
                yield* Deferred.succeed(thirdStarted, undefined);
              }
              removalOrder.push(path);
            }).pipe(Effect.ensuring(Effect.sync(() => (activeRemovals -= 1)))),
        }),
        Layer.mock(ProviderService)({
          stopSession: () => Effect.void,
        }),
        Layer.mock(TerminalManager.TerminalManager)({
          close: () => Effect.void,
        }),
        NodeServices.layer,
      );
      const testDependencies = Layer.merge(TestClock.layer(), dependencies);
      const testLayer = ThreadDeletionReactorLive.pipe(
        Layer.provide(testDependencies),
        Layer.merge(testDependencies),
      );

      yield* Effect.gen(function* () {
        const reactor = yield* ThreadDeletionReactor;
        yield* reactor.start();
        yield* Effect.yieldNow;
        yield* PubSub.publish(events, deletedEventFor(first, "event-retire-first", 1));
        yield* Deferred.await(firstRemoved);
        yield* reactor.drain;

        // The first repository worker has been idle long enough to retire.
        yield* TestClock.adjust("1 minute");
        yield* PubSub.publish(events, cleanupUpdatedEventFor(second, "event-retire-second", 2));
        yield* PubSub.publish(events, cleanupUpdatedEventFor(third, "event-retire-third", 3));
        yield* Deferred.await(secondStarted);
        expect(yield* Deferred.isDone(thirdStarted)).toBe(false);
        yield* Deferred.succeed(releaseSecond, undefined);
        yield* Deferred.await(thirdStarted);
        yield* reactor.drain;
      }).pipe(Effect.provide(testLayer));

      expect(removalOrder).toEqual([first.worktreePath, second.worktreePath, third.worktreePath]);
      expect(maxActiveRemovals).toBe(1);
    }),
  );

  effectIt.live("resumes same-repository cleanup in order and persists failures", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const activeProjectRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-active-project-root-",
      });
      const aliasParent = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-active-project-alias-",
      });
      const activeProjectAlias = path.join(aliasParent, "workspace");
      yield* fileSystem.symlink(activeProjectRoot, activeProjectAlias);
      const root = "/repo-a";
      const existingWorktreePath = process.cwd();
      const first = cleanupRow(
        "cleanup-first",
        {
          status: "deleting",
          repositoryRoot: root,
          worktreePath: "/worktrees/first",
          startedAt: "2026-08-23T00:00:00.000Z",
        },
        "2026-08-23T00:00:00.000Z",
      );
      const second = cleanupRow(
        "cleanup-second",
        {
          status: "queued",
          repositoryRoot: "/repo-b",
          worktreePath: existingWorktreePath,
          queuedAt: "2026-08-23T00:00:01.000Z",
          blockedByThreadId: first.threadId,
        },
        "2026-08-23T00:00:01.000Z",
      );
      const third = cleanupRow(
        "cleanup-third",
        {
          status: "queued",
          repositoryRoot: "/repo-c",
          worktreePath: "/worktrees/third",
          queuedAt: "2026-08-23T00:00:02.000Z",
          blockedByThreadId: second.threadId,
        },
        "2026-08-23T00:00:02.000Z",
      );
      const fourth = cleanupRow(
        "cleanup-already-removed",
        {
          status: "deleting",
          repositoryRoot: "/repo-d",
          worktreePath: "/worktrees/already-removed",
          startedAt: "2026-08-23T00:00:03.000Z",
        },
        "2026-08-23T00:00:03.000Z",
      );
      const fifth = cleanupRow(
        "cleanup-active-project-root",
        {
          status: "deleting",
          repositoryRoot: "/repo-e",
          worktreePath: activeProjectAlias,
          startedAt: "2026-08-23T00:00:04.000Z",
        },
        "2026-08-23T00:00:04.000Z",
      );
      const activeOwner = {
        threadId: ThreadId.make("active-owner"),
        worktreePath: third.worktreePath ?? "/worktrees/third",
      };
      const rows = new Map([
        [first.threadId, first],
        [second.threadId, second],
        [third.threadId, third],
        [fourth.threadId, fourth],
        [fifth.threadId, fifth],
      ]);
      const removals: string[] = [];
      const operations: string[] = [];
      const updates: Array<
        Extract<OrchestrationCommand, { type: "thread.worktree-cleanup.update" }>
      > = [];

      const dependencies = Layer.mergeAll(
        Layer.mock(OrchestrationEngineService)({
          streamDomainEvents: Stream.never,
          latestSequence: Effect.succeed(0),
          readEvents: () => Stream.empty,
          dispatch: (command) => {
            if (command.type === "thread.worktree-cleanup.update") {
              updates.push(command);
              const row = rows.get(command.threadId);
              if (row) rows.set(command.threadId, { ...row, worktreeCleanup: command.cleanup });
            }
            return Effect.succeed({ sequence: updates.length });
          },
        }),
        Layer.mock(ProjectionThreadRepository)({
          getById: ({ threadId }) => Effect.succeed(Option.fromUndefinedOr(rows.get(threadId))),
          listPendingWorktreeCleanup: () => Effect.succeed([first, second, third, fourth, fifth]),
          listActiveWorktreeOwners: () => Effect.succeed([activeOwner]),
        }),
        Layer.mock(ProjectionProjectRepository)({
          listAll: () =>
            Effect.succeed([
              {
                projectId: ProjectId.make("active-project"),
                title: "Active project",
                workspaceRoot: activeProjectRoot,
                defaultModelSelection: null,
                defaultThreadEnvMode: null,
                scripts: [],
                createdAt: "2026-08-23T00:00:00.000Z",
                updatedAt: "2026-08-23T00:00:00.000Z",
                deletedAt: null,
              },
            ]),
        }),
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          resolve: () =>
            Effect.succeed({
              kind: "git" as const,
              repository: {
                kind: "git" as const,
                rootPath: "/checkout",
                metadataPath: "/shared-repository/.git",
                freshness: {
                  source: "live-local" as const,
                  observedAt: DateTime.makeUnsafe("2026-08-23T00:00:00.000Z"),
                  expiresAt: Option.none(),
                },
              },
              driver: null as never,
            }),
        }),
        Layer.mock(GitWorkflowService)({
          removeWorktree: ({ path, allowMissing }) =>
            Effect.gen(function* () {
              removals.push(path);
              operations.push(`remove:${path}`);
              if (path === second.worktreePath) {
                return yield* new GitCommandError({
                  operation: "remove worktree",
                  command: "git worktree remove",
                  cwd: root,
                  detail: "permission denied",
                });
              }
              if (path === fourth.worktreePath && allowMissing !== true) {
                return yield* new GitCommandError({
                  operation: "remove worktree",
                  command: "git worktree remove",
                  cwd: root,
                  detail: "not a working tree",
                });
              }
            }),
        }),
        Layer.mock(ProviderService)({
          stopSession: ({ threadId }) =>
            Effect.sync(() => void operations.push(`stop:${threadId}`)),
        }),
        Layer.mock(TerminalManager.TerminalManager)({
          close: ({ threadId }) => Effect.sync(() => void operations.push(`close:${threadId}`)),
        }),
        NodeServices.layer,
      );
      const testLayer = ThreadDeletionReactorLive.pipe(
        Layer.provide(dependencies),
        Layer.merge(dependencies),
      );

      yield* Effect.gen(function* () {
        const reactor = yield* ThreadDeletionReactor;
        yield* reactor.start();
        yield* reactor.drain;
      }).pipe(Effect.provide(testLayer));

      expect(removals).toEqual([
        "/worktrees/first",
        second.worktreePath,
        "/worktrees/already-removed",
      ]);
      expect(operations).toEqual([
        `stop:${first.threadId}`,
        `close:${first.threadId}`,
        "remove:/worktrees/first",
        `stop:${second.threadId}`,
        `close:${second.threadId}`,
        `remove:${second.worktreePath}`,
        `stop:${third.threadId}`,
        `close:${third.threadId}`,
        `stop:${fourth.threadId}`,
        `close:${fourth.threadId}`,
        "remove:/worktrees/already-removed",
        `stop:${fifth.threadId}`,
        `close:${fifth.threadId}`,
      ]);
      expect(
        updates.map((command) => [command.threadId, command.cleanup?.status ?? "complete"]),
      ).toEqual([
        [first.threadId, "complete"],
        [second.threadId, "deleting"],
        [second.threadId, "failed"],
        [third.threadId, "deleting"],
        [third.threadId, "failed"],
        [fourth.threadId, "complete"],
        [fifth.threadId, "failed"],
      ]);
      expect(updates[2]?.cleanup).toMatchObject({
        status: "failed",
        error: expect.stringContaining("permission denied"),
      });
      expect(updates[4]?.cleanup).toMatchObject({
        status: "failed",
        error: expect.stringContaining("active-owner"),
      });
      expect(updates[5]?.cleanup).toBeNull();
      expect(updates[6]?.cleanup).toMatchObject({
        status: "failed",
        error: expect.stringContaining("active-project"),
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
