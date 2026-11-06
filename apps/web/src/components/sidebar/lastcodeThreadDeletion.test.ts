import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { deleteLastCodeThread, type ThreadDeletionDependencies } from "./lastcodeThreadDeletion";

const add = vi.hoisted(() => vi.fn());
vi.mock("../ui/toast", () => ({
  stackedThreadToast: (value: unknown) => value,
  toastManager: { add },
}));
const ref = scopeThreadRef(EnvironmentId.make("remote-member"), ThreadId.make("same-id"));
const thread = { title: "Parent", persistent: false };
function dependencies() {
  return {
    canOperate: vi.fn<ThreadDeletionDependencies["canOperate"]>(() => true),
    confirm: vi.fn<ThreadDeletionDependencies["confirm"]>(async () => true),
    confirmDeletion: true,
    readThread: vi.fn<ThreadDeletionDependencies["readThread"]>(() => thread),
    deleteThread: vi.fn<ThreadDeletionDependencies["deleteThread"]>(async () =>
      AsyncResult.success(undefined),
    ),
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
describe("single thread deletion checkpoints", () => {
  it("rejects initial permission before confirmation or current-state reads", async () => {
    const d = dependencies();
    d.canOperate.mockReturnValue(false);
    await deleteLastCodeThread(ref, thread, d);
    expect(d.canOperate).toHaveBeenCalledWith(ref.environmentId);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.readThread).not.toHaveBeenCalled();
    expect(d.deleteThread).not.toHaveBeenCalled();
  });
  it("protects the menu snapshot even if current persistence has changed", async () => {
    const d = dependencies();
    await deleteLastCodeThread(ref, { ...thread, persistent: true }, d);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.readThread).not.toHaveBeenCalled();
    expect(d.deleteThread).not.toHaveBeenCalled();
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Persistent thread not deleted" }),
    );
  });
  it("cancels without another permission check or mutation", async () => {
    const d = dependencies();
    d.confirm.mockResolvedValue(false);
    await deleteLastCodeThread(ref, thread, d);
    expect(d.canOperate).toHaveBeenCalledOnce();
    expect(d.readThread).not.toHaveBeenCalled();
    expect(d.deleteThread).not.toHaveBeenCalled();
    expect(d.confirm).toHaveBeenCalledWith(
      expect.stringContaining(
        "including archived ones; other forks and independent threads are kept",
      ),
      { variant: "destructive" },
    );
  });
  it("rereads permission after a deferred confirmation", async () => {
    const d = dependencies(),
      dialog = deferred<boolean>();
    d.confirm.mockReturnValue(dialog.promise);
    const pending = deleteLastCodeThread(ref, thread, d);
    expect(d.deleteThread).not.toHaveBeenCalled();
    d.canOperate.mockReturnValue(false);
    dialog.resolve(true);
    await pending;
    expect(d.canOperate).toHaveBeenCalledTimes(2);
    expect(d.readThread).not.toHaveBeenCalled();
    expect(d.deleteThread).not.toHaveBeenCalled();
  });
  it("rereads persistence against the exact environment after confirmation", async () => {
    const d = dependencies(),
      dialog = deferred<boolean>();
    d.confirm.mockReturnValue(dialog.promise);
    const pending = deleteLastCodeThread(ref, thread, d);
    d.readThread.mockReturnValue({ persistent: true });
    dialog.resolve(true);
    await pending;
    expect(d.readThread).toHaveBeenCalledWith(ref);
    expect(d.deleteThread).not.toHaveBeenCalled();
  });
  it("keeps both permission checks and the current-state read when confirmation is disabled", async () => {
    const d = dependencies();
    d.confirmDeletion = false;
    await deleteLastCodeThread(ref, thread, d);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.canOperate).toHaveBeenCalledTimes(2);
    expect(d.readThread).toHaveBeenCalledWith(ref);
    expect(d.deleteThread).toHaveBeenCalledWith(ref);
  });
  it("leaves missing-state rejection to the existing mutation command", async () => {
    const d = dependencies();
    d.readThread.mockReturnValue(undefined);
    await deleteLastCodeThread(ref, thread, d);
    expect(d.deleteThread).toHaveBeenCalledWith(ref);
  });
  it("reports mutation failure but suppresses interruption", async () => {
    const d = dependencies();
    d.deleteThread.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("Rejected"))));
    await deleteLastCodeThread(ref, thread, d);
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Failed to delete thread", description: "Rejected" }),
    );
    add.mockClear();
    d.deleteThread.mockResolvedValue(AsyncResult.failure(Cause.interrupt()));
    await deleteLastCodeThread(ref, thread, d);
    expect(add).not.toHaveBeenCalled();
  });
  it("preserves dialog rejection without sending a mutation", async () => {
    const d = dependencies();
    d.confirm.mockRejectedValue(new Error("Dialog unavailable"));
    await expect(deleteLastCodeThread(ref, thread, d)).rejects.toThrow("Dialog unavailable");
    expect(d.deleteThread).not.toHaveBeenCalled();
  });
});
