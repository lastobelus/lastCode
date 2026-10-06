import { assert, it } from "@effect/vitest";
import { CommandId, ThreadId, type ThreadWorktreeCleanup } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

import {
  planDeletionWorktreeCleanup,
  planWorktreeCleanupTransition,
} from "./WorktreeCleanupPolicy.ts";

const threadId = ThreadId.make("cleanup-thread");
const now = "2026-10-02T00:00:00.000Z";
const cleanup: ThreadWorktreeCleanup = {
  status: "deleting",
  repositoryRoot: "/workspace/repo",
  worktreePath: "/workspace/feature",
  startedAt: now,
};
const thread = {
  id: threadId,
  deletedAt: null,
  worktreePath: cleanup.worktreePath,
  worktreeCleanup: null,
};
const deletion = {
  thread,
  deleteWorktree: true,
  repositoryRoot: cleanup.repositoryRoot,
  projects: [],
  activeThreads: [],
  cleanupOwners: [],
  now,
};

it("refuses removal while a project or another thread owns the worktree", () => {
  assert.isTrue(
    Result.isFailure(
      planDeletionWorktreeCleanup({
        ...deletion,
        projects: [{ id: "project" as never, workspaceRoot: "/workspace/feature/" }],
      }),
    ),
  );
  assert.isTrue(
    Result.isFailure(
      planDeletionWorktreeCleanup({
        ...deletion,
        activeThreads: [{ id: ThreadId.make("other"), worktreePath: cleanup.worktreePath }],
      }),
    ),
  );
});

it("preserves cleanup on duplicate deletion and queues behind the repository owner", () => {
  assert.deepStrictEqual(
    planDeletionWorktreeCleanup({
      ...deletion,
      deleteWorktree: false,
      thread: { ...thread, deletedAt: DateTime.makeUnsafe(now), worktreeCleanup: cleanup },
    }),
    Result.succeed(cleanup),
  );
  const next = planDeletionWorktreeCleanup({
    ...deletion,
    cleanupOwners: [
      {
        id: ThreadId.make("blocker"),
        worktreeCleanup: { ...cleanup, worktreePath: "/workspace/other" },
      },
    ],
  });
  assert.isTrue(Result.isSuccess(next));
  if (Result.isSuccess(next)) assert.equal(next.success?.status, "queued");
});

it("requires a failed cleanup to retry or abandon and rejects stale worker receipts", () => {
  const failed: ThreadWorktreeCleanup = {
    ...cleanup,
    status: "failed",
    failedAt: now,
    error: "remove failed",
  };
  const input = {
    thread: { ...thread, deletedAt: DateTime.makeUnsafe(now), worktreeCleanup: failed },
    cleanupOwners: [],
    now,
  };
  const retry = planWorktreeCleanupTransition({
    ...input,
    command: {
      type: "thread.worktree-cleanup.retry",
      commandId: CommandId.make("retry"),
      threadId,
    },
  });
  assert.deepStrictEqual(retry, Result.succeed(cleanup));
  const abandon = planWorktreeCleanupTransition({
    ...input,
    command: {
      type: "thread.worktree-cleanup.abandon",
      commandId: CommandId.make("abandon"),
      threadId,
    },
  });
  assert.deepStrictEqual(abandon, Result.succeed(null));
  assert.isTrue(
    Result.isFailure(
      planWorktreeCleanupTransition({
        ...input,
        thread: {
          ...input.thread,
          worktreeCleanup: { ...cleanup, startedAt: "2026-10-02T01:00:00.000Z" },
        },
        command: {
          type: "thread.worktree-cleanup.update",
          commandId: CommandId.make("stale"),
          threadId,
          expectedCleanup: cleanup,
          cleanup: null,
        },
      }),
    ),
  );
});
