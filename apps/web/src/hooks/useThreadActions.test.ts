import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getOrphanedWorktreePathForThread } from "../worktreeCleanup";
import {
  collectThreadDeleteCandidates,
  resolveArchivedThreadsForDelete,
  resolveThreadTargetWithArchivedFallback,
  shouldDeleteWorktreeClientSide,
  ThreadArchiveBlockedError,
} from "./useThreadActions";

describe("ThreadArchiveBlockedError", () => {
  it("keeps the blocked thread context with the fixed message", () => {
    const error = new ThreadArchiveBlockedError({
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
    });

    expect(error).toMatchObject({
      environmentId: "environment-1",
      threadId: "thread-1",
    });
    expect(error.message).toBe("Cannot archive a running thread.");
  });
});

describe("shouldDeleteWorktreeClientSide", () => {
  it("keeps the legacy client-side cleanup path for older servers", () => {
    expect(
      shouldDeleteWorktreeClientSide({
        shouldDeleteWorktree: true,
        supportsDurableWorktreeCleanup: false,
      }),
    ).toBe(true);
  });

  it("leaves cleanup to the durable server path when supported", () => {
    expect(
      shouldDeleteWorktreeClientSide({
        shouldDeleteWorktree: true,
        supportsDurableWorktreeCleanup: true,
      }),
    ).toBe(false);
  });

  it("does not remove a worktree when the user keeps it", () => {
    expect(
      shouldDeleteWorktreeClientSide({
        shouldDeleteWorktree: false,
        supportsDurableWorktreeCleanup: false,
      }),
    ).toBe(false);
  });
});

describe("resolveThreadTargetWithArchivedFallback", () => {
  const target = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
  };
  const archivedThread = {
    environmentId: target.environmentId,
    id: target.threadId,
    worktreePath: "/tmp/archived-worktree",
  };

  it("lets archived settings deletion use the archived shell", () => {
    expect(resolveThreadTargetWithArchivedFallback(target, null, [archivedThread])).toEqual({
      thread: archivedThread,
      threadRef: target,
    });
  });

  it("rejects a fallback shell from another target", () => {
    expect(
      resolveThreadTargetWithArchivedFallback(target, null, [
        { ...archivedThread, id: ThreadId.make("other-thread") },
      ]),
    ).toBeNull();
  });
});

describe("collectThreadDeleteCandidates", () => {
  it("keeps an archived sibling in orphan detection", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const target = {
      environmentId,
      id: ThreadId.make("thread-1"),
      worktreePath: "/tmp/shared-worktree",
    };
    const sibling = {
      environmentId,
      id: ThreadId.make("thread-2"),
      worktreePath: "/tmp/shared-worktree",
    };

    const candidates = collectThreadDeleteCandidates([], target, [sibling]);

    expect(candidates).toHaveLength(2);
    expect(candidates.map((thread) => thread.id)).toEqual(["thread-2", "thread-1"]);
    expect(getOrphanedWorktreePathForThread(candidates, target.id)).toBeNull();
  });
});

describe("resolveArchivedThreadsForDelete", () => {
  it("loads archived owners for a normal worktree deletion", async () => {
    const archivedThread = {
      environmentId: EnvironmentId.make("environment-1"),
      id: ThreadId.make("archived-owner"),
      worktreePath: "/tmp/shared-worktree",
    };

    await expect(
      resolveArchivedThreadsForDelete({
        worktreePath: "/tmp/shared-worktree",
        load: async () => [archivedThread],
      }),
    ).resolves.toEqual([archivedThread]);
  });

  it("uses supplied archived shells without loading them again", async () => {
    const load = () => Promise.reject(new Error("should not load"));

    await expect(
      resolveArchivedThreadsForDelete({
        archivedThreads: [],
        worktreePath: "/tmp/shared-worktree",
        load,
      }),
    ).resolves.toEqual([]);
  });
});
