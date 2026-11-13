import type { EnvironmentId, LocalApi, ScopedThreadRef } from "@t3tools/contracts";
import type { SidebarThreadSummary } from "../../types";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { reportThreadOperationFailure } from "./lastcodeThreadOperationResult";
import { stackedThreadToast, toastManager } from "../ui/toast";

export type ThreadDeletionDependencies = {
  canOperate: (environmentId: EnvironmentId) => boolean;
  confirm: LocalApi["dialogs"]["confirm"];
  confirmDeletion: boolean;
  readThread: (ref: ScopedThreadRef) => Pick<SidebarThreadSummary, "persistent"> | null | undefined;
  deleteThread: (ref: ScopedThreadRef) => Promise<AtomCommandResult<unknown, unknown>>;
};
export async function deleteLastCodeThread(
  threadRef: ScopedThreadRef,
  thread: Pick<SidebarThreadSummary, "title" | "persistent">,
  dependencies: ThreadDeletionDependencies,
) {
  if (!dependencies.canOperate(threadRef.environmentId)) return;
  if (thread.persistent) {
    warnPersistentThreadDeletion();
    return;
  }
  if (
    dependencies.confirmDeletion &&
    !(await dependencies.confirm(
      [
        `Delete thread "${thread.title}"?`,
        "This also deletes any of its subagents, including archived ones; other forks and independent threads are kept. This cannot be undone.",
      ].join("\n"),
      { variant: "destructive" },
    ))
  )
    return;
  if (!dependencies.canOperate(threadRef.environmentId)) return;
  if (dependencies.readThread(threadRef)?.persistent === true) {
    warnPersistentThreadDeletion();
    return;
  }
  reportThreadOperationFailure(
    await dependencies.deleteThread(threadRef),
    "Failed to delete thread",
  );
}
function warnPersistentThreadDeletion() {
  toastManager.add(
    stackedThreadToast({
      type: "warning",
      title: "Persistent thread not deleted",
      description: "Disable persistence or move it to another thread first.",
    }),
  );
}
