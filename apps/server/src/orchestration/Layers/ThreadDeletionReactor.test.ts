import {
  GitCommandError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type ThreadWorktreeCleanup,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";

import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import {
  ProjectionThreadRepository,
  type ProjectionThread,
} from "../../persistence/Services/ProjectionThreads.ts";
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

describe("durable worktree cleanup", () => {
  effectIt.live("resumes same-repository cleanup in order and persists failures", () =>
    Effect.gen(function* () {
      const root = "/repo";
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
          repositoryRoot: root,
          worktreePath: "/worktrees/second",
          queuedAt: "2026-08-23T00:00:01.000Z",
          blockedByThreadId: first.threadId,
        },
        "2026-08-23T00:00:01.000Z",
      );
      const third = cleanupRow(
        "cleanup-third",
        {
          status: "queued",
          repositoryRoot: root,
          worktreePath: "/worktrees/third",
          queuedAt: "2026-08-23T00:00:02.000Z",
          blockedByThreadId: second.threadId,
        },
        "2026-08-23T00:00:02.000Z",
      );
      const rows = new Map([
        [first.threadId, first],
        [second.threadId, second],
        [third.threadId, third],
      ]);
      const removals: string[] = [];
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
          listPendingWorktreeCleanup: () => Effect.succeed([first, second, third]),
        }),
        Layer.mock(GitWorkflowService)({
          removeWorktree: ({ path }) =>
            Effect.gen(function* () {
              removals.push(path);
              if (path === second.worktreePath) {
                return yield* new GitCommandError({
                  operation: "remove worktree",
                  command: "git worktree remove",
                  cwd: root,
                  detail: "permission denied",
                });
              }
            }),
        }),
        Layer.mock(ProviderService)({ stopSession: () => Effect.void }),
        Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
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

      expect(removals).toEqual(["/worktrees/first", "/worktrees/second", "/worktrees/third"]);
      expect(
        updates.map((command) => [command.threadId, command.cleanup?.status ?? "complete"]),
      ).toEqual([
        [first.threadId, "complete"],
        [second.threadId, "deleting"],
        [second.threadId, "failed"],
        [third.threadId, "deleting"],
        [third.threadId, "complete"],
      ]);
      expect(updates[2]?.cleanup).toMatchObject({
        status: "failed",
        error: expect.stringContaining("permission denied"),
      });
    }),
  );
});
