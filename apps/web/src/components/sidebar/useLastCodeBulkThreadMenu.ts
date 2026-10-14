import { useCallback } from "react";
import { markThreadsReadState } from "../../hooks/threadReadActions";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { useClientSettings } from "~/hooks/useSettings";
import { readLocalApi } from "../../localApi";
import { readThreadShell } from "../../state/entities";
import { readEnvironmentScope } from "../../state/session";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { buildMultiSelectThreadContextMenuItems } from "../Sidebar.logic";
import { protectLegacyThreadActions } from "../lastcodeThreadPersistence.logic";
import { useLastCodeThreadActions } from "./LastCodeThreadActions";
import { checkTaskPermission } from "./lastcodeSidebarPermission";
import {
  archiveLastCodeSelection,
  deleteLastCodeSelection,
  warnPersistentBulkThread,
} from "./lastcodeBulkThreadOperations";

function readSelectedThreadEntry(threadKey: string) {
  const threadRef = parseScopedThreadKey(threadKey);
  const thread = threadRef ? readThreadShell(threadRef) : null;
  if (!threadRef || !thread) return undefined;
  return { threadKey, threadRef, thread };
}
function readSelectedThreadEntries(keys: readonly string[]) {
  return keys.flatMap((key) => {
    const entry = readSelectedThreadEntry(key);
    return entry && entry.thread.worktreeCleanup == null ? [entry] : [];
  });
}
function isSelectionMutation(action: string | null): action is "archive" | "delete" {
  return action === "archive" || action === "delete";
}
function selectionMenu(entries: ReturnType<typeof readSelectedThreadEntries>) {
  const canOperate = entries.every(({ threadRef }) =>
    readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope),
  );
  const persistent = entries.some(({ thread }) => thread.persistent === true);
  const items = protectLegacyThreadActions(
    buildMultiSelectThreadContextMenuItems({ count: entries.length }),
    persistent,
  ).map((item) =>
    isSelectionMutation(item.id) ? { ...item, disabled: item.disabled || !canOperate } : item,
  );
  return { items, persistent };
}

export function useLastCodeBulkThreadMenu() {
  const { archiveThreads, deleteThread, markThreadUnread, markThreadRead } =
    useLastCodeThreadActions();
  const appSettingsConfirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  return useCallback(
    async (position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const threadKeys = [...useThreadSelectionStore.getState().selectedThreadKeys];
      const selectedThreadEntries = readSelectedThreadEntries(threadKeys);
      const count = selectedThreadEntries.length;
      if (count === 0) return;
      const { items, persistent } = selectionMenu(selectedThreadEntries);
      const clicked = await api.contextMenu.show(items, position);

      if (!selectionActionPermitted(clicked, selectedThreadEntries, persistent)) return;

      if (clicked === "mark-unread" || clicked === "mark-read") {
        await markThreadsReadState(
          selectedThreadEntries.map(({ threadRef }) => threadRef),
          clicked === "mark-read" ? markThreadRead : markThreadUnread,
        );
        return;
      }

      if (clicked === "archive") {
        await archiveLastCodeSelection(threadKeys, selectedThreadEntries, {
          getEntry: readSelectedThreadEntry,
          canOperate: checkTaskPermission,
          removeFromSelection,
          archiveThreads,
        });
        return;
      }
      if (clicked !== "delete") return;
      await deleteLastCodeSelection(threadKeys, selectedThreadEntries, {
        getEntry: readSelectedThreadEntry,
        canOperate: checkTaskPermission,
        removeFromSelection,
        confirm: (message, options) => api.dialogs.confirm(message, options),
        confirmDeletion: appSettingsConfirmThreadDelete,
        deleteThread,
        threadExists: (ref) => readThreadShell(ref) !== null,
      });
    },
    [
      appSettingsConfirmThreadDelete,
      archiveThreads,
      deleteThread,
      markThreadUnread,
      markThreadRead,
      removeFromSelection,
    ],
  );
}

/** Only archive/delete require a fresh authority check after the native menu closes. */
function selectionActionPermitted(
  action: string | null,
  entries: ReturnType<typeof readSelectedThreadEntries>,
  persistent: boolean,
) {
  if (!isSelectionMutation(action)) return true;
  if (persistent) {
    warnPersistentBulkThread();
    return false;
  }
  return entries.every(({ threadRef }) => checkTaskPermission(threadRef.environmentId));
}
