import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import {
  archiveLastCodeSelection,
  deleteLastCodeSelection,
  type SelectedThreadEntry,
} from "./lastcodeBulkThreadOperations";
const add = vi.hoisted(() => vi.fn());
vi.mock("../ui/toast", () => ({
  stackedThreadToast: (value: unknown) => value,
  toastManager: { add },
}));
const entry = (id: string): SelectedThreadEntry => {
  const threadRef = scopeThreadRef(EnvironmentId.make("remote-member"), ThreadId.make(id));
  return {
    threadRef,
    threadKey: scopedThreadKey(threadRef),
    thread: { persistent: false, worktreeCleanup: null },
  };
};
const entries = [entry("one"), entry("two"), entry("three")];
const keys = entries.map((e) => e.threadKey);
type ArchiveAccess = Parameters<typeof archiveLastCodeSelection>[2];
type DeleteAccess = Parameters<typeof deleteLastCodeSelection>[2];
function access() {
  return {
    getEntry: vi.fn<ArchiveAccess["getEntry"]>((key) => entries.find((e) => e.threadKey === key)),
    canOperate: vi.fn<ArchiveAccess["canOperate"]>(() => true),
    removeFromSelection: vi.fn<ArchiveAccess["removeFromSelection"]>(),
    archiveThreads: vi.fn<ArchiveAccess["archiveThreads"]>(async () => ({
      archivedThreadKeys: keys,
      mutationFailure: null,
      followupFailures: [],
    })),
    deleteThread: vi.fn<DeleteAccess["deleteThread"]>(async () =>
      AsyncResult.success({ sequence: 1 }),
    ),
    confirm: vi.fn<DeleteAccess["confirm"]>(async () => true),
    confirmDeletion: true,
    threadExists: vi.fn<DeleteAccess["threadExists"]>(() => true),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
beforeEach(() => vi.clearAllMocks());
describe("bulk archive selection outcomes", () => {
  it("clears every original selected key after full success, including unresolved and cleanup rows", async () => {
    const d = access(),
      original = [...keys, "unresolved", "cleanup"];
    await archiveLastCodeSelection(original, entries, d);
    expect(d.archiveThreads).toHaveBeenCalledOnce();
    expect(d.archiveThreads).toHaveBeenCalledWith(entries);
    expect(d.removeFromSelection).toHaveBeenCalledWith(original);
  });
  it("clears only archived keys after partial failure and reports followup failures separately", async () => {
    const d = access();
    d.archiveThreads.mockResolvedValue({
      archivedThreadKeys: [keys[0]!],
      mutationFailure: AsyncResult.failure(Cause.die(new Error("Mutation"))),
      followupFailures: [
        AsyncResult.failure(Cause.die(new Error("Navigation"))),
        AsyncResult.failure(Cause.interrupt()),
      ],
    });
    await archiveLastCodeSelection(keys, entries, d);
    expect(d.removeFromSelection).toHaveBeenCalledWith([keys[0]]);
    expect(add.mock.calls.map(([toast]) => toast.title)).toEqual([
      "Thread archived, but navigation failed",
      "Failed to archive threads",
    ]);
  });
  it("preserves selection when the family confirmation is cancelled", async () => {
    const d = access();
    d.archiveThreads.mockResolvedValue(null);
    await archiveLastCodeSelection(keys, entries, d);
    expect(d.removeFromSelection).not.toHaveBeenCalled();
  });
  it("rereads current persistence, permissions and cleanup before the batch command", async () => {
    for (const reason of ["persistent", "permission", "cleanup"]) {
      const d = access();
      if (reason === "permission") d.canOperate.mockReturnValue(false);
      else
        d.getEntry.mockImplementation((key) => ({
          ...entries.find((e) => e.threadKey === key)!,
          thread:
            reason === "persistent"
              ? { persistent: true, worktreeCleanup: null }
              : {
                  ...entries[0]!.thread,
                  worktreeCleanup: {
                    status: "deleting",
                    repositoryRoot: "/workspace/example",
                    worktreePath: "/workspace/example-worktree",
                    startedAt: "2026-01-01T00:00:00Z",
                  },
                },
        }));
      await archiveLastCodeSelection(keys, entries, d);
      expect(d.archiveThreads).not.toHaveBeenCalled();
      expect(d.removeFromSelection).not.toHaveBeenCalled();
    }
  });
});
describe("bulk deletion checkpoints", () => {
  it("keeps sequential success discounts and clears deleted or missing keys only", async () => {
    const d = access(),
      discounts: string[][] = [];
    d.deleteThread.mockImplementation(async (ref, options) => {
      discounts.push([...(options?.deletedThreadKeys ?? [])]);
      return ref.threadId === entries[1]!.threadRef.threadId
        ? AsyncResult.failure(Cause.die(new Error("Rejected")))
        : AsyncResult.success({ sequence: 1 });
    });
    await deleteLastCodeSelection([...keys, "unresolved"], entries, d);
    expect(discounts).toEqual([[], [keys[0]], [keys[0]]]);
    expect(d.removeFromSelection).toHaveBeenCalledWith([keys[0], keys[2], "unresolved"]);
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Failed to delete threads", description: "Rejected" }),
    );
  });
  it("stops on interruption and keeps unprocessed rows selected without a toast", async () => {
    const d = access();
    d.deleteThread
      .mockResolvedValueOnce(AsyncResult.success({ sequence: 1 }))
      .mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt()));
    await deleteLastCodeSelection(keys, entries, d);
    expect(d.deleteThread).toHaveBeenCalledTimes(2);
    expect(d.removeFromSelection).toHaveBeenCalledWith([keys[0]]);
    expect(add).not.toHaveBeenCalled();
  });
  it("cancels without reading current entries or deleting", async () => {
    const d = access();
    d.confirm.mockResolvedValue(false);
    await deleteLastCodeSelection(keys, entries, d);
    expect(d.getEntry).not.toHaveBeenCalled();
    expect(d.deleteThread).not.toHaveBeenCalled();
  });
  it("rechecks permissions after a deferred confirmation", async () => {
    const d = access(),
      dialog = deferred<boolean>();
    d.confirm.mockReturnValue(dialog.promise);
    const pending = deleteLastCodeSelection(keys, entries, d);
    d.canOperate.mockReturnValue(false);
    dialog.resolve(true);
    await pending;
    expect(d.deleteThread).not.toHaveBeenCalled();
    expect(d.getEntry).not.toHaveBeenCalled();
  });
  it("protects current persistence after a deferred confirmation", async () => {
    const d = access(),
      dialog = deferred<boolean>();
    d.confirm.mockReturnValue(dialog.promise);
    const pending = deleteLastCodeSelection(keys, entries, d);
    d.getEntry.mockReturnValue({
      ...entries[0]!,
      thread: { persistent: true, worktreeCleanup: null },
    });
    dialog.resolve(true);
    await pending;
    expect(d.deleteThread).not.toHaveBeenCalled();
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Persistent thread protected" }),
    );
  });
});
