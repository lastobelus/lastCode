import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useThreadActions } from "../../hooks/useThreadActions";

export type LastCodeThreadActions = Pick<
  ReturnType<typeof useThreadActions>,
  | "archiveThread"
  | "archiveThreads"
  | "unarchiveThread"
  | "deleteThread"
  | "setThreadPersistence"
  | "markThreadUnread"
>;
const ThreadActionsContext = createContext<LastCodeThreadActions | null>(null);
export function LastCodeThreadActionsProvider({ children }: { children: ReactNode }) {
  const {
    archiveThread,
    archiveThreads,
    unarchiveThread,
    deleteThread,
    setThreadPersistence,
    markThreadUnread,
  } = useThreadActions();
  const actions = useMemo(
    () => ({
      archiveThread,
      archiveThreads,
      unarchiveThread,
      deleteThread,
      setThreadPersistence,
      markThreadUnread,
    }),
    [
      archiveThread,
      archiveThreads,
      unarchiveThread,
      deleteThread,
      setThreadPersistence,
      markThreadUnread,
    ],
  );
  return <ThreadActionsContext.Provider value={actions}>{children}</ThreadActionsContext.Provider>;
}
export function useLastCodeThreadActions() {
  const actions = useContext(ThreadActionsContext);
  if (!actions) throw new Error("LastCode thread actions require their sidebar provider.");
  return actions;
}
