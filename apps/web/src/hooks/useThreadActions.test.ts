import { CommandId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { getOrphanedWorktreePathForThread } from "../worktreeCleanup";
import {
  collectThreadDeleteCandidates,
  resolveArchivedThreadsForDelete,
  resolveThreadTargetWithArchivedFallback,
  shouldDeleteWorktreeClientSide,
  navigateAfterThreadDeletion,
  normalizeArchiveSelectedEntries,
} from "./useThreadActions";
import { toastManager } from "../components/ui/toast";
import { makeThreadFixture } from "../test-fixtures";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";

describe("archive retry selections", () => {
  it.each([false, true])(
    "retains the failed attempt when deduplicating its owner (owner first=%s)",
    (ownerFirst) => {
      const owner = makeThreadFixture({
        id: ThreadId.make("archive-owner"),
        environmentId: EnvironmentId.make("environment-test"),
      });
      const pending = {
        threadId: owner.id,
        commandId: CommandId.make("archive-request"),
        childDisposition: "promote" as const,
        childThreadIds: [],
        archiveThreadIds: [],
        promoteThreadIds: [],
        status: "failed" as const,
      };
      const child = { ...owner, id: ThreadId.make("failed-child"), archivePending: pending };
      const ownerRef = scopeThreadRef(owner.environmentId, owner.id);
      const childRef = scopeThreadRef(child.environmentId, child.id);
      const normalized = normalizeArchiveSelectedEntries(
        (ownerFirst ? [ownerRef, childRef] : [childRef, ownerRef]).map((threadRef) => ({
          threadKey: scopedThreadKey(threadRef),
          threadRef,
        })),
        (ref) => (ref.threadId === child.id ? child : owner),
      );
      expect(normalized).toEqual([
        {
          threadKey: scopedThreadKey(ownerRef),
          threadRef: ownerRef,
          expectedArchiveCommandId: pending.commandId,
        },
      ]);
      // The owner key dispatches the family operation; its disposition decides
      // whether the original child row leaves the selection.
      expect(normalized.map((entry) => entry.threadKey)).not.toContain(scopedThreadKey(childRef));
      expect(child.archivePending.childDisposition).toBe("promote");
    },
  );
  it("keeps same-id retry owners in different environments separate", () => {
    const first = scopeThreadRef(EnvironmentId.make("first-environment"), ThreadId.make("owner"));
    const second = scopeThreadRef(EnvironmentId.make("second-environment"), first.threadId);
    expect(
      normalizeArchiveSelectedEntries(
        [first, second].map((threadRef) => ({ threadRef, threadKey: scopedThreadKey(threadRef) })),
        () => null,
      ),
    ).toHaveLength(2);
  });
});

describe("navigateAfterThreadDeletion", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports a rejected navigation without failing the completed deletion", async () => {
    const addToast = vi.spyOn(toastManager, "add").mockReturnValue("navigation-error");

    await expect(
      navigateAfterThreadDeletion(() => Promise.reject(new Error("route unavailable"))),
    ).resolves.toBeUndefined();

    expect(addToast).toHaveBeenCalledOnce();
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Thread deleted, but navigation failed",
        description: "route unavailable",
      }),
    );
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
