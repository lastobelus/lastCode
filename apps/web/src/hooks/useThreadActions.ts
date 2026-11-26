import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { randomUUID } from "../lib/utils";
import {
  groupThreadDeletionTargets,
  useWorkspaceLifecycleConfirmation,
} from "./useWorkspaceLifecycleConfirmation";
import {
  parseScopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import {
  settlePromise,
  squashAtomCommandFailure,
  isAtomCommandInterrupted,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { canSnooze, threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  CommandId,
  EnvironmentAuthorizationError,
  EnvironmentId,
  type SavedWorkspaceDisposition,
  type ScopedThreadRef,
  ThreadId,
  sessionGrantsScope,
} from "@t3tools/contracts";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { msg } from "gt-react";
import { useRouter } from "@tanstack/react-router";

import { getFallbackThreadIdAfterDelete, pinOrderKeyBetween } from "../components/Sidebar.logic";
import { useComposerDraftStore } from "../composerDraftStore";
import { environmentSession, readEnvironmentScope } from "../state/session";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { orchestrationEnvironment } from "../state/orchestration";
import { projectEnvironment } from "../state/projects";
import { threadEnvironment } from "../state/threads";
import { vcsEnvironment } from "../state/vcs";
import { useNewThreadHandler } from "./useHandleNewThread";
import {
  readEnvironmentSupportsVisitedTracking,
  type ThreadReadOutcome,
} from "./threadReadActions";
import {
  loadArchivedThreadsForEnvironment,
  refreshArchivedThreadsForEnvironment,
} from "../lib/archivedThreadsState";
import { releaseComposerDraftUploads } from "../lib/composerDraftUploads";
import { announce } from "../lib/announce";
import { m } from "../i18n/messages";
import { purgeThreadHandoffs } from "../handoffs/handoffsStore";
import { readLocalApi } from "../localApi";
import {
  readDelegatedUnderParent,
  readEnvironmentServerConfigLoaded,
  readEnvironmentSupportsAutoSettleOptOut,
  readEnvironmentSupportsWorktreeCleanup,
  readEnvironmentThreadRefs,
  readProject,
  readThreadShell,
  readThreadShells,
} from "../state/entities";
import { useUiStateStore } from "../uiStateStore";
import { useDiffPanelStore } from "../diffPanelStore";
import { usePreviewMiniPlayerStore } from "../previewMiniPlayerStore";
import { clearThreadPreviewState } from "../previewStateStore";
import { useRightPanelStore } from "../rightPanelStore";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { formatWorktreePathForDisplay, getOrphanedWorktreePathForThread } from "../worktreeCleanup";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useClientSettings } from "./useSettings";
import * as ThreadUndo from "@t3tools/client-runtime/state/thread-undo";
import { showThreadUndoNotice } from "./showThreadUndoNotice";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { threadTriagePermitted, useOrchestrationCommand } from "../state/use-orchestration-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { createLastCodeThreadArchiveActions } from "./lastcodeThreadArchiveActions";
export { normalizeArchiveSelectedEntries } from "./lastcodeThreadArchiveActions";

export function shouldDeleteWorktreeClientSide(input: {
  readonly shouldDeleteWorktree: boolean;
  readonly supportsDurableWorktreeCleanup: boolean;
}): boolean {
  return input.shouldDeleteWorktree && !input.supportsDurableWorktreeCleanup;
}

export type DeleteThreadOptions = {
  readonly savedWorkspace?: SavedWorkspaceDisposition;
  readonly deletedThreadKeys?: ReadonlySet<string>;
  /** Shells supplied by archived-thread views, which are outside the active store. */
  readonly archivedThreads?: ReadonlyArray<EnvironmentThreadShell>;
};

export function resolveThreadTargetWithArchivedFallback<
  T extends Pick<EnvironmentThreadShell, "environmentId" | "id">,
>(
  target: ScopedThreadRef,
  activeThread: T | null,
  archivedThreads: ReadonlyArray<T> | undefined,
): { readonly thread: T; readonly threadRef: ScopedThreadRef } | null {
  const candidate =
    activeThread ??
    archivedThreads?.find(
      (thread) => thread.environmentId === target.environmentId && thread.id === target.threadId,
    );
  if (
    candidate === undefined ||
    candidate.environmentId !== target.environmentId ||
    candidate.id !== target.threadId
  ) {
    return null;
  }
  return { thread: candidate, threadRef: target };
}

export function collectThreadDeleteCandidates<
  T extends Pick<EnvironmentThreadShell, "environmentId" | "id" | "worktreePath">,
>(
  activeThreads: ReadonlyArray<T>,
  targetThread: T,
  archivedThreads: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const candidates = new Map<string, T>();
  for (const thread of [...activeThreads, ...archivedThreads, targetThread]) {
    candidates.set(`${thread.environmentId}:${thread.id}`, thread);
  }
  return [...candidates.values()];
}

export function resolveArchivedThreadsForDelete<T>(input: {
  readonly archivedThreads?: ReadonlyArray<T>;
  readonly worktreePath: string | null;
  readonly load: () => Promise<ReadonlyArray<T>>;
}): Promise<ReadonlyArray<T>> {
  if (input.archivedThreads !== undefined) return Promise.resolve(input.archivedThreads);
  if (input.worktreePath === null) return Promise.resolve([]);
  return input.load();
}

export class ThreadSettlementUnsupportedError extends Schema.TaggedError<ThreadSettlementUnsupportedError>()(
  "ThreadSettlementUnsupportedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return m(
      msg(
        "This environment's server does not support settling yet. Update the server to use Settle.",
      ),
    );
  }
}

export class ThreadSnoozeUnsupportedError extends Schema.TaggedError<ThreadSnoozeUnsupportedError>()(
  "ThreadSnoozeUnsupportedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return m(
      msg(
        "This environment's server does not support snoozing yet. Update the server to use Snooze.",
      ),
    );
  }
}

export class ThreadSnoozeBlockedError extends Schema.TaggedError<ThreadSnoozeBlockedError>()(
  "ThreadSnoozeBlockedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return m(
      msg("This thread is waiting on you. Respond to the pending request before snoozing it."),
    );
  }
}

/** Key that sorts before every arranged pinned thread, so a fresh pin lands
    at the top of the run. Undefined (keyless, sorts with the legacy block)
    when key math can't produce one — pinning must never fail on placement. */
function topOfPinnedRunOrderKey(): string | undefined {
  let firstKey: string | null = null;
  for (const shell of readThreadShells()) {
    if (shell.pinnedAt == null || shell.pinOrderKey == null) continue;
    if (firstKey === null || shell.pinOrderKey < firstKey) firstKey = shell.pinOrderKey;
  }
  return pinOrderKeyBetween(null, firstKey) ?? undefined;
}

export class ThreadAutoSettleOptOutUnsupportedError extends Schema.TaggedError<ThreadAutoSettleOptOutUnsupportedError>()(
  "ThreadAutoSettleOptOutUnsupportedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return m(
      msg(
        "This environment's server does not support turning auto-settle off per thread yet. Update the server to use it.",
      ),
    );
  }
}

export class ThreadPinningUnsupportedError extends Schema.TaggedError<ThreadPinningUnsupportedError>()(
  "ThreadPinningUnsupportedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return m(
      msg("This environment's server does not support pinning yet. Update the server to use Pin."),
    );
  }
}

export class ThreadPinReorderUnsupportedError extends Schema.TaggedError<ThreadPinReorderUnsupportedError>()(
  "ThreadPinReorderUnsupportedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return m(
      msg(
        "This environment's server does not support reordering pinned threads yet. Update the server to reorder pins.",
      ),
    );
  }
}

export class ThreadActiveReorderUnsupportedError extends Schema.TaggedError<ThreadActiveReorderUnsupportedError>()(
  "ThreadActiveReorderUnsupportedError",
  {
    environmentId: EnvironmentId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return m(msg("Update this environment's server to reorder active threads."));
  }
}

async function requestThreadUnpinConfirmation(input: {
  enabled: boolean;
  title: string | null;
  confirm: ((message: string) => Promise<boolean>) | null;
}) {
  const { confirm } = input;
  if (!input.enabled || confirm === null) {
    return AsyncResult.success(true);
  }

  return settlePromise(() =>
    confirm(
      [
        input.title === null
          ? m(msg('Unpin thread "this thread"?'))
          : m(msg('Unpin thread "{title}"?', { title: input.title })),
        m(msg("This will move the thread out of your pinned section.")),
      ].join("\n"),
    ),
  );
}

/** Report navigation separately so a completed deletion can still finish worktree cleanup. */
export async function navigateAfterThreadDeletion(navigate: () => Promise<void>) {
  const result = await settlePromise(navigate);
  if (result._tag === "Failure") {
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: m(msg("Thread deleted, but navigation failed")),
        description: thrownErrorMessage(error, m) ?? m(msg("An error occurred.")),
      }),
    );
  }
}

function readMarkerOutcome(
  result: AtomCommandResult<unknown, unknown>,
  report: boolean,
): ThreadReadOutcome {
  if (result._tag !== "Failure") return "applied";
  if (isAtomCommandInterrupted(result)) return "unchanged";
  const error = squashAtomCommandFailure(result);
  if (report)
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: m(msg("Read marker could not be saved")),
        description: error instanceof Error ? error.message : m(msg("Reconnect and try again.")),
      }),
    );
  return "failed";
}

/** Server-tracked unread markers sync across devices; older servers use the local marker. */
export function useMarkThreadUnread() {
  const markThreadUnreadMutation = useAtomCommand(threadEnvironment.markUnread);
  const markThreadUnreadLocal = useUiStateStore((state) => state.markThreadUnread);
  return async (target: ScopedThreadRef, report = true): Promise<ThreadReadOutcome> => {
    const thread = readThreadShell(target);
    const completedAt = thread?.latestRun?.completedAt;
    if (!completedAt || !Number.isFinite(Date.parse(completedAt))) {
      if (report)
        toastManager.add(
          stackedThreadToast({
            type: "info",
            title: m(msg("Nothing to mark unread")),
            description: m(msg("This thread has no completed reply yet.")),
          }),
        );
      return "unsupported";
    }
    if (readEnvironmentSupportsVisitedTracking(target.environmentId)) {
      const failure = threadOperationFailure(target);
      if (failure) return readMarkerOutcome(failure, report);
      const result = await markThreadUnreadMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId },
      });
      return readMarkerOutcome(result, report);
    }
    markThreadUnreadLocal(scopedThreadKey(target), completedAt);
    return "applied";
  };
}

/** Explicit acknowledgement uses the existing visit command, without provider activity. */
export function useMarkThreadRead() {
  const visit = useAtomCommand(threadEnvironment.visit);
  const markVisited = useUiStateStore((state) => state.markThreadVisited);
  return async (target: ScopedThreadRef, report = true): Promise<ThreadReadOutcome> => {
    const thread = readThreadShell(target);
    if (!thread) return "unchanged";
    const visitedAt = new Date(
      Math.max(
        Date.parse(thread.updatedAt),
        Date.parse(thread.latestRun?.completedAt ?? thread.updatedAt),
      ),
    ).toISOString();
    const tracksVisits = readEnvironmentSupportsVisitedTracking(target.environmentId);
    const previousVisit = tracksVisits
      ? thread.lastVisitedAt
      : useUiStateStore.getState().threadLastVisitedAtById[scopedThreadKey(target)];
    if (previousVisit && Date.parse(previousVisit) >= Date.parse(visitedAt)) return "unchanged";
    if (tracksVisits) {
      const failure = threadOperationFailure(target);
      if (failure) return readMarkerOutcome(failure, report);
      const result = await visit({
        environmentId: target.environmentId,
        input: { threadId: target.threadId, visitedAt },
      });
      return readMarkerOutcome(result, report);
    }
    markVisited(scopedThreadKey(target), visitedAt);
    return "applied";
  };
}

/**
 * Clears a thread's Woke marker by recording a visit at the wake time.
 * Servers with visited tracking own the watermark (thread.visit keeps the
 * later of the stored and supplied values, so this syncs to every device);
 * older servers keep the browser-local watermark.
 */
export function useAcknowledgeThreadWoke() {
  const visitThreadMutation = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const markThreadVisited = useUiStateStore((state) => state.markThreadVisited);
  return (target: ScopedThreadRef, wokeAt: string) => {
    if (readEnvironmentSupportsVisitedTracking(target.environmentId)) {
      void visitThreadMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId, visitedAt: wokeAt },
      });
      return;
    }
    markThreadVisited(scopedThreadKey(target), wokeAt);
  };
}

// These Undos restore a thread's place in the list, which archiving or deleting it ends.
const LIST_PLACEMENT_UNDO_KINDS = ["settle", "snooze", "pin"];

function expireThreadUndos(target: ScopedThreadRef, kinds: readonly string[]) {
  for (const kind of kinds) ThreadUndo.invalidate(kind, scopedThreadKey(target));
}

function clearDeletedThreadPanelState(ref: ScopedThreadRef) {
  clearThreadPreviewState(ref);
  useRightPanelStore.getState().removeThread(ref);
  useDiffPanelStore.getState().removeThread(ref);
  usePreviewMiniPlayerStore.getState().removeThread(ref);
}

/** A No project thread that already has its own folder, on a server that can promote it. */
export function canTurnThreadIntoProject(threadRef: ScopedThreadRef): boolean {
  const thread = readThreadShell(threadRef);
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(threadRef.environmentId);
  if (!thread?.worktreePath || config?.environment.capabilities.threadProjectFromScratch !== true) {
    return false;
  }
  const project = readProject({
    environmentId: threadRef.environmentId,
    projectId: thread.projectId,
  });
  return project !== null && isScratchProject(project, config.scratchWorkspaceRoot);
}

function threadOperationFailure(target: ScopedThreadRef) {
  return readEnvironmentScope(target.environmentId, AuthOrchestrationOperateScope)
    ? null
    : AsyncResult.failure(
        Cause.fail(
          new EnvironmentAuthorizationError({
            message: m(msg("This connection cannot change threads.")),
            requiredScope: AuthOrchestrationOperateScope,
          }),
        ),
      );
}

export function useThreadActions() {
  const workspaceLifecycle = useWorkspaceLifecycleConfirmation();
  const deleteThreadBatch = useAtomCommand(serverEnvironment.deleteThreads, {
    reportFailure: false,
  });
  const sendArchiveQuestion = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const archiveThreadMutation = useOrchestrationCommand(threadEnvironment.archive, {
    reportFailure: false,
  });
  const unarchiveThreadMutation = useOrchestrationCommand(threadEnvironment.unarchive, {
    reportFailure: false,
  });
  const setThreadPersistenceMutation = useOrchestrationCommand(threadEnvironment.setPersistence, {
    reportFailure: false,
  });
  const deleteThreadMutation = useOrchestrationCommand(threadEnvironment.delete, {
    reportFailure: false,
  });
  const settleThreadMutation = useOrchestrationCommand(
    threadEnvironment.settle,
    { reportFailure: false },
    threadTriagePermitted,
  );
  const unsettleThreadMutation = useOrchestrationCommand(
    threadEnvironment.unsettle,
    { reportFailure: false },
    threadTriagePermitted,
  );
  const pinThreadMutation = useOrchestrationCommand(threadEnvironment.pin, {
    reportFailure: false,
  });
  const unpinThreadMutation = useOrchestrationCommand(threadEnvironment.unpin, {
    reportFailure: false,
  });
  const setThreadAutoSettleMutation = useOrchestrationCommand(threadEnvironment.setAutoSettle, {
    reportFailure: false,
  });
  const reorderPinnedThreadMutation = useOrchestrationCommand(threadEnvironment.reorderPin, {
    reportFailure: false,
  });
  const reorderActiveThreadMutation = useOrchestrationCommand(threadEnvironment.reorderActive, {
    reportFailure: false,
  });
  const snoozeThreadMutation = useOrchestrationCommand(
    threadEnvironment.snooze,
    { reportFailure: false },
    threadTriagePermitted,
  );
  const unsnoozeThreadMutation = useOrchestrationCommand(
    threadEnvironment.unsnooze,
    { reportFailure: false },
    threadTriagePermitted,
  );
  const markThreadUnread = useMarkThreadUnread();
  const createProjectFromThread = useAtomCommand(projectEnvironment.createFromThread, {
    reportFailure: false,
  });
  const markThreadRead = useMarkThreadRead();
  const stopThreadSession = useOrchestrationCommand(threadEnvironment.stopSession);
  const removeWorktree = useAtomCommand(vcsEnvironment.removeWorktree, {
    reportFailure: false,
  });
  const loadSessionState = useAtomQueryRunner(environmentSession.sessionStateAtom, {
    reportFailure: false,
  });
  const loadWorktreeThreadIds = useAtomQueryRunner(orchestrationEnvironment.worktreeThreadIds, {
    reportFailure: false,
    refresh: true,
  });
  const loadThreadFamily = useAtomQueryRunner(orchestrationEnvironment.threadFamily, {
    reportFailure: false,
    refresh: true,
  });
  const loadArchiveFamily = useAtomCommand(threadEnvironment.loadArchiveFamily, {
    reportFailure: false,
  });
  const refreshVcsStatus = useAtomCommand(vcsEnvironment.refreshStatus, {
    reportFailure: false,
  });
  const sidebarThreadSortOrder = useClientSettings((settings) => settings.sidebarThreadSortOrder);
  const confirmThreadDelete = useClientSettings((settings) => settings.confirmThreadDelete);
  const confirmThreadArchive = useClientSettings((settings) => settings.confirmThreadArchive);
  const confirmThreadUnpin = useClientSettings((settings) => settings.confirmThreadUnpin);
  const clearComposerDraftForThread = useComposerDraftStore((store) => store.clearDraftThread);
  const clearProjectDraftThreadById = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadById,
  );
  const clearTerminalUiState = useTerminalUiStateStore((state) => state.clearTerminalUiState);
  const markThreadVisited = useUiStateStore((state) => state.markThreadVisited);
  const router = useRouter();
  const handleNewThread = useNewThreadHandler();

  const resolveThreadTarget = (target: ScopedThreadRef) => {
    const thread = readThreadShell(target);
    if (!thread) {
      return null;
    }
    return {
      thread,
      threadRef: target,
    };
  };
  const getCurrentRouteThreadRef = () => {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveThreadRouteRef(currentRouteParams);
  };

  const { archiveThread, archiveThreads, unarchiveThread } = createLastCodeThreadArchiveActions({
    sendArchiveQuestion,
    workspaceLifecycle,
    archiveThreadMutation,
    unarchiveThreadMutation,
    loadArchiveFamily,
    confirmThreadArchive,
    markThreadVisited,
    router,
    handleNewThread,
    getCurrentRouteThreadRef,
    threadOperationFailure,
    expireThreadUndos,
  });

  const setThreadPersistence = (target: ScopedThreadRef, persistent: boolean) =>
    setThreadPersistenceMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, persistent },
    });

  const prepareThreadDeletion = async (target: ScopedThreadRef, opts: DeleteThreadOptions = {}) => {
    const permissionFailure = threadOperationFailure(target);
    if (permissionFailure) return permissionFailure;
    const resolved = resolveThreadTargetWithArchivedFallback(
      target,
      resolveThreadTarget(target)?.thread ?? null,
      opts.archivedThreads,
    );
    if (!resolved) return AsyncResult.success(null);
    const { thread, threadRef } = resolved;
    const archivedThreadsResult = await settlePromise(() =>
      resolveArchivedThreadsForDelete({
        ...(opts.archivedThreads === undefined ? {} : { archivedThreads: opts.archivedThreads }),
        worktreePath: thread.worktreePath,
        load: () => loadArchivedThreadsForEnvironment(threadRef.environmentId),
      }),
    );
    if (archivedThreadsResult._tag === "Failure") {
      return archivedThreadsResult;
    }
    const archivedThreads = archivedThreadsResult.value;
    const activeThreads = readEnvironmentThreadRefs(threadRef.environmentId).flatMap((ref) => {
      const shell = readThreadShell(ref);
      return shell === null ? [] : [shell];
    });
    const threads = collectThreadDeleteCandidates(activeThreads, thread, archivedThreads);
    const threadProject = readProject({
      environmentId: threadRef.environmentId,
      projectId: thread.projectId,
    });
    const deletedIds =
      opts.deletedThreadKeys && opts.deletedThreadKeys.size > 0
        ? new Set<ThreadId>(
            [...opts.deletedThreadKeys].flatMap((threadKey) => {
              const ref = parseScopedThreadKey(threadKey);
              return ref && ref.environmentId === threadRef.environmentId ? [ref.threadId] : [];
            }),
          )
        : undefined;
    // Deleting a thread also deletes its side chats, which share its worktree.
    const removedIds = new Set<ThreadId>(deletedIds);
    for (const entry of threads) {
      if (entry.lineage.sideChat === true && entry.lineage.parentThreadId === threadRef.threadId) {
        removedIds.add(entry.id);
      }
    }
    const survivingThreads = threads.filter(
      (entry) => entry.id === threadRef.threadId || !removedIds.has(entry.id),
    );
    const supportsDurableWorktreeCleanup = readEnvironmentSupportsWorktreeCleanup(
      threadRef.environmentId,
    );
    const environmentConfig = appAtomRegistry
      .get(environmentServerConfigsAtom)
      .get(threadRef.environmentId);
    let orphanedWorktreePath = getOrphanedWorktreePathForThread(
      survivingThreads,
      threadRef.threadId,
    );
    // A shell that leaves idle subagent children out cannot prove nobody else uses the worktree,
    // so the server's list decides. A failed read keeps the worktree.
    if (orphanedWorktreePath !== null && environmentConfig?.shellThreadFamilies === true) {
      const occupants = await loadWorktreeThreadIds({
        environmentId: threadRef.environmentId,
        input: { worktreePath: orphanedWorktreePath },
      });
      if (
        occupants._tag !== "Success" ||
        occupants.value.threadIds.some(
          (threadId) => threadId !== threadRef.threadId && !removedIds.has(threadId),
        )
      ) {
        orphanedWorktreePath = null;
      }
    }
    const displayWorktreePath = orphanedWorktreePath
      ? formatWorktreePathForDisplay(orphanedWorktreePath)
      : null;
    const localApi = readLocalApi();
    let canDeleteWorktree = false;
    if (
      (thread.source.worktreeSuspension === undefined ||
        thread.source.worktreeSuspension.state === "active") &&
      orphanedWorktreePath !== null &&
      threadProject !== null &&
      !isScratchProject(threadProject, environmentConfig?.scratchWorkspaceRoot) &&
      localApi
    ) {
      const sessionResult = await loadSessionState(threadRef.environmentId);
      const permissionFailure = threadOperationFailure(threadRef);
      if (permissionFailure) return permissionFailure;
      canDeleteWorktree =
        sessionResult._tag === "Success" &&
        sessionGrantsScope(sessionResult.value, AuthSourceControlWriteScope);
    }
    let shouldDeleteWorktree = false;
    const environmentSettings = environmentConfig?.settings;
    const automaticWorktreeCleanup = environmentSettings
      ? resolveWorktreeCleanup(environmentSettings, thread.projectId).worktreeOnDelete
      : false;
    if (canDeleteWorktree && localApi && !automaticWorktreeCleanup) {
      const confirmationResult = await settlePromise(() =>
        localApi.dialogs.confirm(
          [
            m(msg("This thread is the only one linked to this worktree:")),
            displayWorktreePath ?? orphanedWorktreePath,
            "",
            m(msg("Delete the worktree too?")),
          ].join("\n"),
          { variant: "destructive" },
        ),
      );
      if (confirmationResult._tag === "Failure") {
        return confirmationResult;
      }
      shouldDeleteWorktree = confirmationResult.value;
    }

    if (thread.runtime !== null) {
      await stopThreadSession({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      });
    }

    return AsyncResult.success({
      thread,
      threadRef,
      threads,
      deletedIds,
      shouldDeleteWorktree,
      supportsDurableWorktreeCleanup,
      orphanedWorktreePath,
      displayWorktreePath,
      threadProject,
    });
  };
  const deleteThread = async (target: ScopedThreadRef, opts: DeleteThreadOptions = {}) => {
    const prepared = await prepareThreadDeletion(target, opts);
    if (prepared._tag === "Failure") return prepared;
    const resolved = prepared.value;
    if (!resolved) {
      // Thread not in main store (e.g. archived thread) — dispatch delete directly.
      let threads = readEnvironmentThreadRefs(target.environmentId).flatMap((ref) => {
        const shell = readThreadShell(ref);
        return shell === null ? [] : [{ id: shell.id, lineage: shell.lineage }];
      });
      if (
        appAtomRegistry.get(environmentServerConfigsAtom).get(target.environmentId)
          ?.shellThreadFamilies
      ) {
        const family = await loadThreadFamily({
          environmentId: target.environmentId,
          input: { threadId: target.threadId },
        });
        if (family._tag === "Success") threads = [...family.value.threads];
      }
      const result = await deleteThreadMutation({
        environmentId: target.environmentId,
        input: {
          threadId: target.threadId,
          ...(opts.savedWorkspace === undefined ? {} : { savedWorkspace: opts.savedWorkspace }),
        },
      });
      if (result._tag === "Success") {
        for (const ref of [
          target,
          ...threads
            .filter(
              (entry) =>
                entry.lineage.sideChat === true && entry.lineage.parentThreadId === target.threadId,
            )
            .map((entry) => scopeThreadRef(target.environmentId, entry.id)),
        ]) {
          releaseComposerDraftUploads(ref);
          clearComposerDraftForThread(ref);
        }
        expireThreadUndos(target, [...LIST_PLACEMENT_UNDO_KINDS, "archive"]);
        purgeThreadHandoffs(target);
        refreshArchivedThreadsForEnvironment(target.environmentId);
        clearTerminalUiState(target);
        clearDeletedThreadPanelState(target);
      }
      return result;
    }
    const {
      thread,
      threadRef,
      threads,
      deletedIds,
      shouldDeleteWorktree,
      supportsDurableWorktreeCleanup,
      orphanedWorktreePath,
      displayWorktreePath,
      threadProject,
    } = resolved;
    const deletedThreadIds = deletedIds ?? new Set<ThreadId>();
    const currentRouteThreadRef = getCurrentRouteThreadRef();
    const shouldNavigateToFallback =
      currentRouteThreadRef !== null &&
      currentRouteThreadRef.threadId === threadRef.threadId &&
      currentRouteThreadRef.environmentId === threadRef.environmentId;
    const fallbackThreadId = getFallbackThreadIdAfterDelete({
      threads,
      deletedThreadId: threadRef.threadId,
      deletedThreadIds,
      sortOrder: sidebarThreadSortOrder,
      now: new Date().toISOString(),
      delegatedUnderParent: readDelegatedUnderParent(),
    });
    let navigatedDuringDelete = false;
    // The missing-thread redirect and the index draft replace this entry; any other history
    // action while the delete is pending is the user's own choice, which must win.
    const stopWatchingHistory = router.history.subscribe(({ action }) => {
      if (action.type !== "REPLACE") navigatedDuringDelete = true;
    });
    const deleteResult = await deleteThreadMutation({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        ...(shouldDeleteWorktree && supportsDurableWorktreeCleanup ? { deleteWorktree: true } : {}),
        ...(opts.savedWorkspace === undefined ? {} : { savedWorkspace: opts.savedWorkspace }),
      },
    }).finally(stopWatchingHistory);
    if (deleteResult._tag === "Failure") {
      return deleteResult;
    }
    expireThreadUndos(threadRef, [...LIST_PLACEMENT_UNDO_KINDS, "archive"]);
    purgeThreadHandoffs(threadRef);
    refreshArchivedThreadsForEnvironment(threadRef.environmentId);
    releaseComposerDraftUploads(threadRef);
    clearComposerDraftForThread(threadRef);
    // The server deletes the thread's side chats with it.
    for (const entry of threads) {
      if (entry.lineage.sideChat !== true || entry.lineage.parentThreadId !== threadRef.threadId) {
        continue;
      }
      const sideChatRef = scopeThreadRef(threadRef.environmentId, entry.id);
      releaseComposerDraftUploads(sideChatRef);
      clearComposerDraftForThread(sideChatRef);
    }
    clearProjectDraftThreadById(
      scopeProjectRef(threadRef.environmentId, thread.projectId),
      threadRef,
    );
    clearTerminalUiState(threadRef);
    clearDeletedThreadPanelState(threadRef);

    if (shouldNavigateToFallback && !navigatedDuringDelete) {
      const fallbackThread = fallbackThreadId
        ? readThreadShell(scopeThreadRef(threadRef.environmentId, fallbackThreadId))
        : null;
      await navigateAfterThreadDeletion(() =>
        fallbackThread
          ? router.navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(
                scopeThreadRef(fallbackThread.environmentId, fallbackThread.id),
              ),
              replace: true,
            })
          : router.navigate({ to: "/", replace: true }),
      );
    }

    if (
      !shouldDeleteWorktreeClientSide({
        shouldDeleteWorktree,
        supportsDurableWorktreeCleanup,
      }) ||
      !orphanedWorktreePath ||
      !threadProject
    ) {
      return deleteResult;
    }

    const removeResult = readEnvironmentScope(threadRef.environmentId, AuthSourceControlWriteScope)
      ? await removeWorktree({
          environmentId: threadRef.environmentId,
          input: {
            cwd: threadProject.workspaceRoot,
            path: orphanedWorktreePath,
            force: true,
          },
        })
      : AsyncResult.failure(
          Cause.fail(
            new EnvironmentAuthorizationError({
              message: m(msg("This connection can no longer remove worktrees.")),
              requiredScope: AuthSourceControlWriteScope,
            }),
          ),
        );
    const refreshResult =
      removeResult._tag === "Success"
        ? await refreshVcsStatus({
            environmentId: threadRef.environmentId,
            input: { cwd: threadProject.workspaceRoot },
          })
        : null;
    const cleanupFailure =
      removeResult._tag === "Failure"
        ? removeResult
        : refreshResult?._tag === "Failure"
          ? refreshResult
          : null;
    if (cleanupFailure) {
      const removalFailed = removeResult._tag === "Failure";
      const error = squashAtomCommandFailure(cleanupFailure);
      const message = thrownErrorMessage(error, m) ?? m(msg("An error occurred."));
      console.error("Worktree cleanup failed after thread deletion", {
        threadId: threadRef.threadId,
        projectCwd: threadProject.workspaceRoot,
        worktreePath: orphanedWorktreePath,
        error,
      });
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: removalFailed
            ? m(msg("Failed to delete worktree"))
            : m(msg("Worktree deleted, but Git status refresh failed")),
          description: removalFailed
            ? m(
                msg("Could not remove {path}. {message}", {
                  path: displayWorktreePath ?? orphanedWorktreePath,
                  message,
                }),
              )
            : message,
        }),
      );
      // Cleanup has its own toast; reporting its failure would falsely imply deletion failed.
    }

    return deleteResult;
  };

  const unsettleThread = async (target: ScopedThreadRef, restoreUnsettledAt?: string | null) => {
    if (!readEnvironmentServerConfigLoaded(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadSettlementUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    ThreadUndo.invalidate("settle", scopedThreadKey(target));
    // reason "user" pins active until real activity, suppressing auto-settle.
    return unsettleThreadMutation({
      environmentId: target.environmentId,
      input: {
        threadId: target.threadId,
        reason: "user",
        ...(restoreUnsettledAt === undefined ? {} : { restoreUnsettledAt }),
      },
    });
  };

  /** Turns automatic settlement (inactivity, merged PR) on or off for one thread. */
  const setThreadAutoSettle = async (target: ScopedThreadRef, enabled: boolean) => {
    if (!readEnvironmentSupportsAutoSettleOptOut(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadAutoSettleOptOutUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    return setThreadAutoSettleMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, enabled },
    });
  };

  const sendPin = async (target: ScopedThreadRef, opts: { orderKey?: string } = {}) => {
    if (!readEnvironmentServerConfigLoaded(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadPinningUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    const orderKey = opts.orderKey ?? topOfPinnedRunOrderKey();
    ThreadUndo.invalidate("pin", scopedThreadKey(target));
    // Pinning clears snooze, so older Settled or Snoozed undos would fight this pin.
    ThreadUndo.invalidate("settle", scopedThreadKey(target));
    ThreadUndo.invalidate("snooze", scopedThreadKey(target));
    return pinThreadMutation({
      environmentId: target.environmentId,
      input: {
        threadId: target.threadId,
        ...(orderKey !== undefined ? { orderKey } : {}),
      },
    });
  };

  const pinThread = async (target: ScopedThreadRef, opts: { orderKey?: string } = {}) => {
    const result = await sendPin(target, opts);
    if (result._tag === "Success") announce(m(msg("Pinned 1 thread")));
    return result;
  };

  const unpinThread = async (target: ScopedThreadRef) => {
    if (!readEnvironmentServerConfigLoaded(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadPinningUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    const thread = readThreadShell(target);
    const undoPlan = ThreadUndo.planThreadUndo("unpin", thread);
    const action = ThreadUndo.begin("pin", scopedThreadKey(target));
    const result = await unpinThreadMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId },
    });
    if (result._tag === "Success" && action.isCurrent()) {
      showThreadUndoNotice({
        action: "Unpinned",
        claim: action,
        undo: () => runUndoPlan(target, undoPlan),
        failureTitle: m(msg("Failed to undo unpin")),
      });
    } else {
      action.finish();
    }
    return result;
  };

  const settleThread = async (target: ScopedThreadRef) => {
    if (!readEnvironmentServerConfigLoaded(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadSettlementUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    const resolved = resolveThreadTarget(target);
    const nowIso = new Date().toISOString();
    const wokeAt = resolved ? threadWokeAt(resolved.thread, { now: nowIso }) : null;
    const undoPlan = ThreadUndo.planThreadUndo("settle", resolved?.thread);
    // An older unpin/snooze Undo would re-pin or re-snooze, and the server
    // treats either as a promotion that un-settles; settling supersedes them.
    ThreadUndo.invalidate("pin", scopedThreadKey(target));
    ThreadUndo.invalidate("snooze", scopedThreadKey(target));
    const action = ThreadUndo.begin("settle", scopedThreadKey(target));
    const result = await settleThreadMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId },
    });
    if (result._tag !== "Success") {
      action.finish();
      return result;
    }
    if (wokeAt !== null) {
      markThreadVisited(scopedThreadKey(target), wokeAt);
    }
    showThreadUndoNotice({
      action: "Settled",
      claim: action,
      undo: () => runUndoPlan(target, undoPlan),
      failureTitle: m(msg("Failed to undo settle")),
    });
    return result;
  };

  const confirmAndUnpinThread = async (target: ScopedThreadRef) => {
    const permissionFailure = threadOperationFailure(target);
    if (permissionFailure) return permissionFailure;
    const localApi = readLocalApi();
    const resolved = resolveThreadTarget(target);
    const confirmationResult = await requestThreadUnpinConfirmation({
      enabled: confirmThreadUnpin,
      title: resolved?.thread.title ?? null,
      confirm: localApi ? (message) => localApi.dialogs.confirm(message) : null,
    });
    if (confirmationResult._tag === "Failure") {
      return confirmationResult;
    }
    if (!confirmationResult.value) {
      return AsyncResult.success(undefined);
    }
    return unpinThread(target);
  };

  const reorderPinnedThread = async (target: ScopedThreadRef, orderKey: string) => {
    if (!readEnvironmentServerConfigLoaded(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadPinReorderUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    ThreadUndo.invalidate("pin", scopedThreadKey(target));
    return reorderPinnedThreadMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, orderKey },
    });
  };

  const reorderActiveThread = async (target: ScopedThreadRef, orderKey: string) => {
    if (!readEnvironmentServerConfigLoaded(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadActiveReorderUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    return reorderActiveThreadMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, orderKey },
    });
  };

  const unsnoozeThread = async (target: ScopedThreadRef) => {
    if (!readEnvironmentServerConfigLoaded(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadSnoozeUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    ThreadUndo.invalidate("snooze", scopedThreadKey(target));
    return unsnoozeThreadMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, reason: "user" },
    });
  };

  const snoozeThread = async (target: ScopedThreadRef, snoozedUntil: string) => {
    if (!readEnvironmentServerConfigLoaded(target.environmentId)) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadSnoozeUnsupportedError({
            environmentId: target.environmentId,
            threadId: target.threadId,
          }),
        ),
      );
    }
    const resolved = resolveThreadTarget(target);
    if (resolved && !canSnooze(resolved.thread, { now: new Date().toISOString() })) {
      return AsyncResult.failure(
        Cause.fail(
          new ThreadSnoozeBlockedError({
            environmentId: resolved.threadRef.environmentId,
            threadId: resolved.threadRef.threadId,
          }),
        ),
      );
    }
    const action = ThreadUndo.begin("snooze", scopedThreadKey(target));
    const result = await snoozeThreadMutation({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, snoozedUntil },
    });
    if (result._tag !== "Success") {
      action.finish();
      return result;
    }
    // Snooze hides the row, so keep its confirmation in the sidebar.
    showThreadUndoNotice({
      action: "Snoozed",
      claim: action,
      undo: () => runUndoPlan(target, ThreadUndo.planThreadUndo("snooze")),
      failureTitle: m(msg("Failed to wake thread")),
    });
    return result;
  };

  const runUndoPlan = (target: ScopedThreadRef, plan: ThreadUndo.ThreadUndoPlan) => {
    let cancelledOnDevice = false;
    return ThreadUndo.executeThreadUndo(
      plan,
      async (step) => {
        if (cancelledOnDevice) return AsyncResult.success(undefined);
        switch (step.action) {
          case "unsettle": {
            const result = await unsettleThread(target, step.restoreUnsettledAt);
            cancelledOnDevice =
              result._tag === "Success" && ThreadUndo.cancelledOnDevice(result.value);
            return result;
          }
          case "unsnooze":
            return unsnoozeThread(target);
          case "pin":
            return sendPin(target, step.orderKey === undefined ? {} : { orderKey: step.orderKey });
          case "reorderActive":
            return reorderActiveThread(target, step.orderKey);
          case "snooze":
            return snoozeThreadMutation({
              environmentId: target.environmentId,
              input: { threadId: target.threadId, snoozedUntil: step.snoozedUntil },
            });
        }
      },
      (result) => result._tag === "Success",
    );
  };

  const confirmAndDeleteThread = async (
    target: ScopedThreadRef,
    knownTitleOrOptions: string | Pick<DeleteThreadOptions, "archivedThreads"> = {},
  ) => {
    const knownTitle = typeof knownTitleOrOptions === "string" ? knownTitleOrOptions : undefined;
    const opts: Pick<DeleteThreadOptions, "archivedThreads"> =
      typeof knownTitleOrOptions === "string" ? {} : knownTitleOrOptions;
    const permissionFailure = threadOperationFailure(target);
    if (permissionFailure) return permissionFailure;
    const localApi = readLocalApi();
    const resolved = resolveThreadTargetWithArchivedFallback(
      target,
      resolveThreadTarget(target)?.thread ?? null,
      opts.archivedThreads,
    );

    const title = resolved?.thread.title ?? knownTitle ?? null;
    const confirmationTitle =
      title === null
        ? m(msg('Delete thread "this thread"?'))
        : m(msg('Delete thread "{title}"?', { title }));
    if (workspaceLifecycle.supported(target.environmentId)) {
      const confirmation = await settlePromise(() =>
        workspaceLifecycle.confirm(
          [
            {
              environmentId: target.environmentId,
              input: {
                operation: "delete",
                target: { kind: "threads", threadIds: [target.threadId] },
              },
            },
          ],
          {
            title: confirmationTitle,
            description: m(
              msg(
                "This also deletes its subagents, including archived ones. Other forks and independent threads are kept. Conversation deletion cannot be undone.",
              ),
            ),
          },
        ),
      );
      if (confirmation._tag === "Failure") return confirmation;
      if (confirmation.value === null) return AsyncResult.success(undefined);
      return deleteThread(target, {
        ...opts,
        ...(confirmation.value.dispositions[0]
          ? { savedWorkspace: confirmation.value.dispositions[0] }
          : {}),
      });
    }
    if (confirmThreadDelete && localApi) {
      const confirmationResult = await settlePromise(() =>
        localApi.dialogs.confirm(
          [
            confirmationTitle,
            m(
              msg(
                "This also deletes any of its subagents, including archived ones; other forks and independent threads are kept. This cannot be undone.",
              ),
            ),
          ].join("\n"),
          { variant: "destructive" },
        ),
      );
      if (confirmationResult._tag === "Failure") {
        return confirmationResult;
      }
      if (!confirmationResult.value) {
        return AsyncResult.success(undefined);
      }
    }

    return deleteThread(target, opts);
  };

  const deleteThreads = async (
    targets: readonly ScopedThreadRef[],
    confirmation: NonNullable<Awaited<ReturnType<typeof workspaceLifecycle.confirm>>>,
  ) => {
    const deletedThreadKeys = new Set<string>();
    let firstFailure: AtomCommandResult<unknown, unknown> | null = null;
    batches: for (const batch of confirmation.batches) {
      if (batch.input.operation !== "delete" || batch.input.target.kind !== "threads") continue;
      const threadIds = batch.input.target.threadIds;
      const refs = threadIds.map((threadId) => scopeThreadRef(batch.environmentId, threadId));
      const exactTargets = targets.filter((target) => target.environmentId === batch.environmentId);
      if (
        exactTargets.length !== refs.length ||
        exactTargets.some((target) => !threadIds.includes(target.threadId))
      ) {
        firstFailure =
          firstFailure ??
          AsyncResult.failure(
            Cause.fail(
              new Error("The selected threads changed. Review the complete selection again."),
            ),
          );
        break;
      }
      if (!workspaceLifecycle.supported(batch.environmentId)) {
        for (const ref of refs) {
          const result = await deleteThread(ref, { deletedThreadKeys });
          if (result._tag === "Failure") {
            if (isAtomCommandInterrupted(result)) break batches;
            firstFailure = firstFailure ?? result;
            continue;
          }
          deletedThreadKeys.add(scopedThreadKey(ref));
        }
        continue;
      }
      const prepared: NonNullable<
        Extract<
          Awaited<ReturnType<typeof prepareThreadDeletion>>,
          { readonly _tag: "Success" }
        >["value"]
      >[] = [];
      const requests: { threadId: ThreadId; deleteWorktree?: boolean }[] = [];
      const plannedKeys = new Set<string>();
      let preparationFailed = false;
      for (const ref of refs) {
        const result = await prepareThreadDeletion(ref, { deletedThreadKeys: plannedKeys });
        if (result._tag === "Failure") {
          firstFailure = firstFailure ?? result;
          preparationFailed = true;
          break;
        }
        if (result.value !== null) prepared.push(result.value);
        requests.push({
          threadId: ref.threadId,
          ...(result.value?.shouldDeleteWorktree && result.value.supportsDurableWorktreeCleanup
            ? { deleteWorktree: true }
            : {}),
        });
        plannedKeys.add(scopedThreadKey(ref));
      }
      if (preparationFailed) break;
      const navigationThreads = readEnvironmentThreadRefs(batch.environmentId).flatMap((ref) => {
        const thread = readThreadShell(ref);
        return thread ? [thread] : [];
      });
      const result = await deleteThreadBatch({
        environmentId: batch.environmentId,
        input: {
          commandId: CommandId.make(randomUUID()),
          threads: requests,
          savedWorkspace: batch.savedWorkspace,
        },
      });
      if (result._tag === "Failure") {
        firstFailure = firstFailure ?? result;
        break;
      }
      for (const id of result.value.deletedThreadIds) {
        const ref = scopeThreadRef(batch.environmentId, id);
        expireThreadUndos(ref, [...LIST_PLACEMENT_UNDO_KINDS, "archive"]);
        deletedThreadKeys.add(scopedThreadKey(ref));
        const thread =
          prepared.find((entry) => entry.threadRef.threadId === id)?.thread ?? readThreadShell(ref);
        purgeThreadHandoffs(ref);
        releaseComposerDraftUploads(ref);
        clearComposerDraftForThread(ref);
        clearTerminalUiState(ref);
        clearThreadPreviewState(ref);
        if (thread)
          clearProjectDraftThreadById(scopeProjectRef(batch.environmentId, thread.projectId), ref);
      }
      refreshArchivedThreadsForEnvironment(batch.environmentId);
      const route = getCurrentRouteThreadRef();
      if (route && deletedThreadKeys.has(scopedThreadKey(route))) {
        const fallbackId = getFallbackThreadIdAfterDelete({
          threads: navigationThreads,
          deletedThreadId: route.threadId,
          deletedThreadIds: new Set(result.value.deletedThreadIds),
          sortOrder: sidebarThreadSortOrder,
          now: new Date().toISOString(),
          delegatedUnderParent: readDelegatedUnderParent(),
        });
        const fallback = fallbackId
          ? readThreadShell(scopeThreadRef(batch.environmentId, fallbackId))
          : null;
        await navigateAfterThreadDeletion(() =>
          fallback
            ? router.navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(scopeThreadRef(batch.environmentId, fallback.id)),
                replace: true,
              })
            : router.navigate({ to: "/", replace: true }),
        );
      }
      for (const entry of prepared) {
        if (
          !deletedThreadKeys.has(scopedThreadKey(entry.threadRef)) ||
          !shouldDeleteWorktreeClientSide(entry) ||
          !entry.orphanedWorktreePath ||
          !entry.threadProject
        )
          continue;
        const removed = await removeWorktree({
          environmentId: batch.environmentId,
          input: {
            cwd: entry.threadProject.workspaceRoot,
            path: entry.orphanedWorktreePath,
            force: true,
          },
        });
        if (removed._tag === "Failure")
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: m(msg("Threads deleted, but worktree cleanup failed")),
              description: String(squashAtomCommandFailure(removed)),
            }),
          );
      }
      if (result.value.failureMessage !== undefined) {
        firstFailure =
          firstFailure ?? AsyncResult.failure(Cause.fail(new Error(result.value.failureMessage)));
        break;
      }
    }
    return { deletedThreadKeys, firstFailure };
  };

  const confirmThreadDeletion = async (targets: readonly ScopedThreadRef[]) => {
    const result = await settlePromise(() =>
      workspaceLifecycle.confirm(groupThreadDeletionTargets(targets), {
        title: m(
          msg("{count, plural, one {Delete {count} thread?} other {Delete {count} threads?}}", {
            count: targets.length,
          }),
        ),
        description: m(
          msg(
            "This also deletes their subagents, including archived ones. Unselected forks and independent threads are kept. Conversation deletion cannot be undone.",
          ),
        ),
      }),
    );
    return result;
  };
  return {
    confirmThreadDeletion,
    deleteThreads,
    archiveThread,
    archiveThreads,
    unarchiveThread,
    setThreadPersistence,
    deleteThread,
    confirmAndDeleteThread,
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    unpinThread,
    confirmAndUnpinThread,
    reorderPinnedThread,
    reorderActiveThread,
    markThreadUnread,
    markThreadRead,
    setThreadAutoSettle,
    turnThreadIntoProject: (target: ScopedThreadRef) =>
      createProjectFromThread({
        environmentId: target.environmentId,
        input: { threadId: target.threadId },
      }),
  };
}
