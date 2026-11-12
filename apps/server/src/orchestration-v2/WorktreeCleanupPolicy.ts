import type {
  OrchestrationV2AppThread,
  OrchestrationV2Command,
  OrchestrationProjectShell,
  ThreadId,
  ThreadWorktreeCleanup,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Result from "effect/Result";

export type CleanupOwner = {
  readonly id: ThreadId;
  readonly worktreeCleanup?: ThreadWorktreeCleanup | null;
};

function pendingCleanup(
  input: {
    readonly threadId: ThreadId;
    readonly cleanup: ThreadWorktreeCleanup;
    readonly now: string;
  },
  owners: ReadonlyArray<CleanupOwner>,
): ThreadWorktreeCleanup {
  const key = normalizeProjectPathForComparison(
    input.cleanup.repositoryKey ?? input.cleanup.repositoryRoot,
  );
  const blocker = owners.find(
    (owner) =>
      owner.id !== input.threadId &&
      owner.worktreeCleanup != null &&
      owner.worktreeCleanup.status !== "failed" &&
      normalizeProjectPathForComparison(
        owner.worktreeCleanup.repositoryKey ?? owner.worktreeCleanup.repositoryRoot,
      ) === key,
  );
  const { repositoryRoot, repositoryKey, worktreePath } = input.cleanup;
  const paths = {
    repositoryRoot,
    ...(repositoryKey === undefined ? {} : { repositoryKey }),
    worktreePath,
  };
  return blocker === undefined
    ? { ...paths, status: "deleting", startedAt: input.now }
    : { ...paths, status: "queued", queuedAt: input.now, blockedByThreadId: blocker.id };
}

/** Preserve an existing tombstone's cleanup; only a new deletion may request removal. */
export function planDeletionWorktreeCleanup(input: {
  readonly thread: Pick<
    OrchestrationV2AppThread,
    "id" | "deletedAt" | "worktreePath" | "worktreeCleanup"
  >;
  readonly deleteWorktree?: boolean;
  readonly repositoryKey?: string;
  readonly repositoryRoot: string;
  readonly projects: ReadonlyArray<Pick<OrchestrationProjectShell, "id" | "workspaceRoot">>;
  readonly activeThreads: ReadonlyArray<Pick<OrchestrationV2AppThread, "id" | "worktreePath">>;
  readonly cleanupOwners: ReadonlyArray<CleanupOwner>;
  readonly now: string;
}): Result.Result<ThreadWorktreeCleanup | null, string> {
  if (input.thread.deletedAt !== null) return Result.succeed(input.thread.worktreeCleanup ?? null);
  if (input.deleteWorktree !== true) return Result.succeed(null);
  const path = input.thread.worktreePath;
  if (path === null)
    return Result.fail(`Thread '${input.thread.id}' does not own a worktree to delete.`);
  const normalized = normalizeProjectPathForComparison(path);
  const project = input.projects.find(
    (project) => normalizeProjectPathForComparison(project.workspaceRoot) === normalized,
  );
  if (project !== undefined)
    return Result.fail(
      `Worktree '${path}' is still used as the workspace root of project '${project.id}'.`,
    );
  const owner = input.activeThreads.find(
    (thread) =>
      thread.id !== input.thread.id &&
      thread.worktreePath !== null &&
      normalizeProjectPathForComparison(thread.worktreePath) === normalized,
  );
  if (owner !== undefined)
    return Result.fail(`Worktree '${path}' is still used by thread '${owner.id}'.`);
  return Result.succeed(
    pendingCleanup(
      {
        threadId: input.thread.id,
        now: input.now,
        cleanup: {
          status: "deleting",
          repositoryRoot: input.repositoryRoot,
          ...(input.repositoryKey === undefined ? {} : { repositoryKey: input.repositoryKey }),
          worktreePath: path,
          startedAt: input.now,
        },
      },
      input.cleanupOwners,
    ),
  );
}

/** Exact expected state prevents a delayed worker receipt from clearing a newer retry. */
export function planWorktreeCleanupTransition(input: {
  readonly thread: Pick<OrchestrationV2AppThread, "id" | "deletedAt" | "worktreeCleanup">;
  readonly command: Extract<
    OrchestrationV2Command,
    {
      readonly type:
        | "thread.worktree-cleanup.retry"
        | "thread.worktree-cleanup.abandon"
        | "thread.worktree-cleanup.update";
    }
  >;
  readonly cleanupOwners: ReadonlyArray<CleanupOwner>;
  readonly now: string;
}): Result.Result<ThreadWorktreeCleanup | null, string> {
  const current = input.thread.worktreeCleanup;
  if (input.thread.deletedAt === null || current == null)
    return Result.fail("Thread no longer has worktree cleanup.");
  if (input.command.type !== "thread.worktree-cleanup.update") {
    if (current.status !== "failed")
      return Result.fail("Only a failed worktree cleanup may be retried or abandoned.");
    return Result.succeed(
      input.command.type === "thread.worktree-cleanup.abandon"
        ? null
        : pendingCleanup(
            { threadId: input.thread.id, cleanup: current, now: input.now },
            input.cleanupOwners,
          ),
    );
  }
  const expected = input.command.expectedCleanup;
  const same =
    current.repositoryRoot === expected.repositoryRoot &&
    current.repositoryKey === expected.repositoryKey &&
    current.worktreePath === expected.worktreePath &&
    current.status === expected.status &&
    (current.status === "queued"
      ? current.queuedAt === (expected as typeof current).queuedAt
      : current.startedAt ===
        (expected as Exclude<ThreadWorktreeCleanup, { status: "queued" }>).startedAt);
  if (!same) return Result.fail("Worktree cleanup changed before this worker receipt.");
  const next = input.command.cleanup;
  if (
    next !== null &&
    (next.repositoryRoot !== current.repositoryRoot ||
      next.repositoryKey !== current.repositoryKey ||
      next.worktreePath !== current.worktreePath)
  )
    return Result.fail("Cleanup paths cannot change during processing.");
  const valid =
    current.status === "queued"
      ? next?.status === "deleting" || next?.status === "failed"
      : current.status === "deleting" &&
        (next === null || next.status === "deleting" || next.status === "failed");
  return valid ? Result.succeed(next) : Result.fail("Invalid worktree cleanup transition.");
}
