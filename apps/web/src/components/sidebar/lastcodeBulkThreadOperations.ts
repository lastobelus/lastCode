import type { EnvironmentId, LocalApi, ScopedThreadRef } from "@t3tools/contracts";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { SidebarThreadSummary } from "../../types";
import type { LastCodeThreadActions } from "./LastCodeThreadActions";
import { getThreadKeysToDeselectAfterDelete } from "../../threadSelectionStore";
import { collectUnprotectedBulkThreadEntries, deleteSelectedThreadEntries } from "../Sidebar.logic";
import { reportThreadOperationFailure } from "./lastcodeThreadOperationResult";
import { stackedThreadToast, toastManager } from "../ui/toast";

export type SelectedThreadEntry = {
  threadKey: string;
  threadRef: ScopedThreadRef;
  thread: Pick<SidebarThreadSummary, "persistent" | "worktreeCleanup">;
};
type SelectionAccess = {
  getEntry: (key: string) => SelectedThreadEntry | undefined;
  canOperate: (environmentId: EnvironmentId) => boolean;
  removeFromSelection: (keys: readonly string[]) => void;
};
export function warnPersistentBulkThread() {
  toastManager.add(
    stackedThreadToast({
      type: "warning",
      title: "Persistent thread protected",
      description: "Disable persistence or move it to another thread first.",
    }),
  );
}
function currentOperableEntries(entries: readonly SelectedThreadEntry[], access: SelectionAccess) {
  const current = collectUnprotectedBulkThreadEntries({
    threadKeys: entries.map(({ threadKey }) => threadKey),
    getEntry: access.getEntry,
  });
  if (!current) {
    warnPersistentBulkThread();
    return null;
  }
  if (!current.every(({ threadRef }) => access.canOperate(threadRef.environmentId))) return null;
  if (current.some(({ thread }) => thread.worktreeCleanup != null)) return null;
  return current;
}
export async function archiveLastCodeSelection(
  originalKeys: readonly string[],
  entries: readonly SelectedThreadEntry[],
  access: SelectionAccess & { archiveThreads: LastCodeThreadActions["archiveThreads"] },
) {
  const current = currentOperableEntries(entries, access);
  if (!current) return;
  const outcome = await access.archiveThreads(current);
  if (!outcome) return;
  for (const failure of outcome.followupFailures)
    reportThreadOperationFailure(failure, "Thread archived, but navigation failed");
  if (outcome.mutationFailure) {
    access.removeFromSelection(outcome.archivedThreadKeys);
    reportThreadOperationFailure(outcome.mutationFailure, "Failed to archive threads");
    return;
  }
  access.removeFromSelection(originalKeys);
}
export async function deleteLastCodeSelection(
  originalKeys: readonly string[],
  entries: readonly SelectedThreadEntry[],
  access: SelectionAccess & {
    confirm: LocalApi["dialogs"]["confirm"];
    confirmDeletion: boolean;
    deleteThread: LastCodeThreadActions["deleteThread"];
    threadExists: (ref: ScopedThreadRef) => boolean;
  },
) {
  if (access.confirmDeletion && !(await confirmSelectionDeletion(entries.length, access.confirm)))
    return;
  if (!entries.every(({ threadRef }) => access.canOperate(threadRef.environmentId))) return;
  const current = currentOperableEntries(entries, access);
  if (!current) return;
  const { deletedThreadKeys, firstFailure } = await deleteSelectedThreadEntries({
    entries: current,
    delete: ({ threadRef }, deletedThreadKeys) =>
      access.deleteThread(threadRef, { deletedThreadKeys }),
  });
  if (firstFailure) reportThreadOperationFailure(firstFailure, "Failed to delete threads");
  access.removeFromSelection(
    getThreadKeysToDeselectAfterDelete(originalKeys, deletedThreadKeys, (key) => {
      const ref = parseScopedThreadKey(key);
      return ref !== null && access.threadExists(ref);
    }),
  );
}
function confirmSelectionDeletion(count: number, confirm: LocalApi["dialogs"]["confirm"]) {
  return confirm(
    [
      `Delete ${count} thread${count === 1 ? "" : "s"}?`,
      `This also deletes any of ${count === 1 ? "its" : "their"} subagents, including archived ones; unselected forks and independent threads are kept. This cannot be undone.`,
    ].join("\n"),
    { variant: "destructive" },
  );
}
