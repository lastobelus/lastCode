import {
  parseScopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { canSnooze, threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  archiveRetryThreadId,
  THREAD_ARCHIVE_UPDATE_REQUIRED_MESSAGE,
} from "@t3tools/client-runtime/state/thread-archive";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  type CommandId,
  EnvironmentAuthorizationError,
  EnvironmentId,
  type ScopedThreadRef,
  type ThreadArchiveChildDisposition,
  ThreadId,
  sessionGrantsScope,
} from "@t3tools/contracts";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useMemo, useRef } from "react";

import {
  archiveSelectedThreadEntries,
  getFallbackThreadIdAfterDelete,
  pinOrderKeyBetween,
} from "../components/Sidebar.logic";
import { useComposerDraftStore } from "../composerDraftStore";
import { environmentSession, readEnvironmentScope } from "../state/session";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { threadEnvironment } from "../state/threads";
import { vcsEnvironment } from "../state/vcs";
import { useNewThreadHandler } from "./useHandleNewThread";
import {
  loadArchivedThreadsForEnvironment,
  refreshArchivedThreadsForEnvironment,
} from "../lib/archivedThreadsState";
import { releaseComposerDraftUploads } from "../lib/composerDraftUploads";
import { purgeThreadHandoffs } from "../handoffs/handoffsStore";
import { readLocalApi } from "../localApi";
import {
  readEnvironmentSupportsAutoSettleOptOut,
  readEnvironmentSupportsPinning,
  readEnvironmentSupportsPinReorder,
  readEnvironmentSupportsActiveReorder,
  readEnvironmentSupportsSettlement,
  readEnvironmentSupportsArchiveFamilies,
  readEnvironmentSupportsSnooze,
  readEnvironmentSupportsWorktreeCleanup,
  readEnvironmentSupportsVisitedTracking,
  readEnvironmentThreadRefs,
  readProject,
  readThreadShell,
  readThreadShells,
} from "../state/entities";
import { useUiStateStore } from "../uiStateStore";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { formatWorktreePathForDisplay, getOrphanedWorktreePathForThread } from "../worktreeCleanup";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useClientSettings } from "./useSettings";
import * as ThreadUndo from "./threadUndo";
import { showThreadUndoNotice } from "./showThreadUndoNotice";
import { useAtomCommand } from "../state/use-atom-command";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { requestThreadArchiveDialog } from "../components/ThreadArchiveDialog";

/** Failed participants share one retry owner, even when that owner is already archived. */
export function normalizeArchiveSelectedEntries<
  T extends { threadKey: string; threadRef: ScopedThreadRef },
>(
  selected: readonly T[],
  readThread: (
    target: ScopedThreadRef,
  ) => Pick<EnvironmentThreadShell, "id" | "archivePending"> | null,
) {
  const owners = new Map<string, T & { expectedArchiveCommandId?: CommandId }>();
  for (const entry of selected) {
    const thread = readThread(entry.threadRef);
    const threadRef = thread
      ? scopeThreadRef(entry.threadRef.environmentId, archiveRetryThreadId(thread))
      : entry.threadRef;
    const threadKey = scopedThreadKey(threadRef);
    const expectedArchiveCommandId =
      thread?.archivePending?.status === "failed" ? thread.archivePending.commandId : undefined;
    const existing = owners.get(threadKey);
    if (
      !existing ||
      (existing.expectedArchiveCommandId === undefined && expectedArchiveCommandId !== undefined)
    )
      owners.set(threadKey, {
        ...(existing ?? entry),
        threadKey,
        threadRef,
        ...(expectedArchiveCommandId === undefined ? {} : { expectedArchiveCommandId }),
      });
  }
  return [...owners.values()];
}

function archiveThreadPreflightError(thread: EnvironmentThreadShell) {
  if (thread.persistent === true)
    return new Error(
      "This thread is persistent. Remove its persistent protection before archiving it.",
    );
  return null;
}

export function shouldDeleteWorktreeClientSide(input: {
  readonly shouldDeleteWorktree: boolean;
  readonly supportsDurableWorktreeCleanup: boolean;
}): boolean {
  return input.shouldDeleteWorktree && !input.supportsDurableWorktreeCleanup;
}

export type DeleteThreadOptions = {
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
    return "This environment's server does not support settling yet. Update the server to use Settle.";
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
    return "This environment's server does not support snoozing yet. Update the server to use Snooze.";
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
    return "This thread is waiting on you. Respond to the pending request before snoozing it.";
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
    return "This environment's server does not support turning auto-settle off per thread yet. Update the server to use it.";
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
    return "This environment's server does not support pinning yet. Update the server to use Pin.";
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
    return "This environment's server does not support reordering pinned threads yet. Update the server to reorder pins.";
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
    return "Update this environment's server to reorder active threads.";
  }
}

export async function requestThreadUnpinConfirmation(input: {
  enabled: boolean;
  title: string;
  confirm: ((message: string) => Promise<boolean>) | null;
}) {
  const { confirm } = input;
  if (!input.enabled || confirm === null) {
    return AsyncResult.success(true);
  }

  return settlePromise(() =>
    confirm(
      [
        `Unpin thread "${input.title}"?`,
        "This will move the thread out of your pinned section.",
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
        title: "Thread deleted, but navigation failed",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }
}

/**
 * Marks a thread unread. Servers with visited tracking own the unread marker
 * (thread.mark-unread rewinds the server-side visited watermark, syncing the
 * marker to every device); older servers keep the browser-local marker.
 */
function useMarkThreadUnread() {
  const markThreadUnreadMutation = useAtomCommand(threadEnvironment.markUnread, {
    reportFailure: false,
  });
  const markThreadUnreadLocal = useUiStateStore((state) => state.markThreadUnread);
  return useCallback(
    (target: ScopedThreadRef) => {
      if (readEnvironmentSupportsVisitedTracking(target.environmentId)) {
        void markThreadUnreadMutation({
          environmentId: target.environmentId,
          input: { threadId: target.threadId },
        });
        return;
      }
      const thread = readThreadShell(target);
      markThreadUnreadLocal(scopedThreadKey(target), thread?.latestRun?.completedAt);
    },
    [markThreadUnreadLocal, markThreadUnreadMutation],
  );
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
  return useCallback(
    (target: ScopedThreadRef, wokeAt: string) => {
      if (readEnvironmentSupportsVisitedTracking(target.environmentId)) {
        void visitThreadMutation({
          environmentId: target.environmentId,
          input: { threadId: target.threadId, visitedAt: wokeAt },
        });
        return;
      }
      markThreadVisited(scopedThreadKey(target), wokeAt);
    },
    [markThreadVisited, visitThreadMutation],
  );
}

function threadOperationFailure(target: ScopedThreadRef) {
  return readEnvironmentScope(target.environmentId, AuthOrchestrationOperateScope)
    ? null
    : AsyncResult.failure(
        Cause.fail(
          new EnvironmentAuthorizationError({
            message: "This connection cannot change threads.",
            requiredScope: AuthOrchestrationOperateScope,
          }),
        ),
      );
}

export function useThreadActions() {
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
  const settleThreadMutation = useOrchestrationCommand(threadEnvironment.settle, {
    reportFailure: false,
  });
  const unsettleThreadMutation = useOrchestrationCommand(threadEnvironment.unsettle, {
    reportFailure: false,
  });
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
  const snoozeThreadMutation = useOrchestrationCommand(threadEnvironment.snooze, {
    reportFailure: false,
  });
  const unsnoozeThreadMutation = useOrchestrationCommand(threadEnvironment.unsnooze, {
    reportFailure: false,
  });
  const markThreadUnread = useMarkThreadUnread();
  const stopThreadSession = useOrchestrationCommand(threadEnvironment.stopSession);
  const removeWorktree = useAtomCommand(vcsEnvironment.removeWorktree, {
    reportFailure: false,
  });
  const loadSessionState = useAtomQueryRunner(environmentSession.sessionStateAtom, {
    reportFailure: false,
  });
  const loadArchiveFamily = useAtomQueryRunner(threadEnvironment.archiveFamilyAtom, {
    reportFailure: false,
    refresh: true,
  });
  type ArchiveFamily = Extract<
    Awaited<ReturnType<typeof loadArchiveFamily>>,
    { _tag: "Success" }
  >["value"];
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
  // Keep a ref so archiveThread can call handleNewThread without appearing in
  // its dependency array — handleNewThread is inherently unstable (depends on
  // the projects list) and would otherwise cascade new references into every
  // sidebar row via archiveThread → attemptArchiveThread.
  const handleNewThreadRef = useRef(handleNewThread);
  handleNewThreadRef.current = handleNewThread;

  const resolveThreadTarget = useCallback((target: ScopedThreadRef) => {
    const thread = readThreadShell(target);
    if (!thread) {
      return null;
    }
    return {
      thread,
      threadRef: target,
    };
  }, []);
  const getCurrentRouteThreadRef = useCallback(() => {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveThreadRouteRef(currentRouteParams);
  }, [router]);

  const unarchiveThread = useCallback(
    async (
      target: ScopedThreadRef,
      opts: { navigate?: boolean; expectedArchiveCommandId?: CommandId } = {},
    ) => {
      if (opts.expectedArchiveCommandId === undefined)
        ThreadUndo.invalidate("archive", scopedThreadKey(target));
      const result = await unarchiveThreadMutation({
        environmentId: target.environmentId,
        input: {
          threadId: target.threadId,
          ...(opts.expectedArchiveCommandId === undefined
            ? {}
            : { expectedArchiveCommandId: opts.expectedArchiveCommandId }),
        },
      });
      if (result._tag === "Failure") {
        return result;
      }
      refreshArchivedThreadsForEnvironment(target.environmentId);
      if (opts.navigate) {
        return settlePromise(() =>
          router.navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(target),
          }),
        );
      }
      return result;
    },
    [router, unarchiveThreadMutation],
  );

  const archiveThread = useCallback(
    async (
      target: ScopedThreadRef,
      opts: {
        onArchived?: () => void;
        confirmed?: boolean;
        expectedArchiveCommandId?: CommandId;
        familyChoice?: {
          childDisposition: ThreadArchiveChildDisposition;
          expectedChildThreadIds: readonly ThreadId[];
        };
        familyOwner?: EnvironmentThreadShell;
        familySnapshot?: ArchiveFamily;
      } = {},
    ) => {
      const permissionFailure = threadOperationFailure(target);
      if (permissionFailure) return permissionFailure;
      if (!readEnvironmentSupportsArchiveFamilies(target.environmentId))
        return AsyncResult.failure(Cause.fail(new Error(THREAD_ARCHIVE_UPDATE_REQUIRED_MESSAGE)));
      const resolved =
        opts.familyOwner?.id === target.threadId &&
        opts.familyOwner.environmentId === target.environmentId
          ? { thread: opts.familyOwner, threadRef: target }
          : resolveThreadTarget(target);
      if (!resolved) return AsyncResult.success(undefined);
      const expectedArchiveCommandId =
        opts.expectedArchiveCommandId ??
        (resolved.thread.archivePending?.status === "failed"
          ? resolved.thread.archivePending.commandId
          : undefined);
      const retry = expectedArchiveCommandId !== undefined;
      const threadRef = scopeThreadRef(target.environmentId, archiveRetryThreadId(resolved.thread));
      let thread = resolved.thread;
      const familyChoice = retry && !opts.familyOwner ? undefined : opts.familyChoice;

      const currentRouteThreadRef = getCurrentRouteThreadRef();
      let action: ReturnType<typeof ThreadUndo.begin> | undefined;
      // Bulk actions already read every family before gathering one shared choice.
      const familyResult = familyChoice
        ? null
        : await loadArchiveFamily({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId },
          });
      if (familyResult?._tag === "Failure") return familyResult;
      if (familyResult?._tag === "Success") {
        const owner = familyResult.value.threads.find(
          (candidate) =>
            candidate.id === threadRef.threadId &&
            candidate.environmentId === threadRef.environmentId,
        );
        if (!owner)
          return AsyncResult.failure(
            Cause.fail(
              new Error(
                "The archive owner is no longer available. Refresh the thread list before retrying.",
              ),
            ),
          );
        thread = owner;
      }
      const family = familyResult === null ? (opts.familySnapshot ?? null) : familyResult.value;
      const preflightError = archiveThreadPreflightError(thread);
      if (preflightError) return AsyncResult.failure(Cause.fail(preflightError));

      const expectedChildThreadIds = family?.childThreadIds ?? [];
      const mutate = (childDisposition?: ThreadArchiveChildDisposition) => {
        action?.finish();
        action = ThreadUndo.begin("archive", scopedThreadKey(threadRef));
        return archiveThreadMutation({
          environmentId: threadRef.environmentId,
          input: {
            threadId: threadRef.threadId,
            ...(expectedArchiveCommandId === undefined ? {} : { expectedArchiveCommandId }),
            ...(familyChoice ??
              (family !== null
                ? {
                    childDisposition: childDisposition ?? "archive_if_idle",
                    expectedChildThreadIds,
                  }
                : {})),
          },
        });
      };
      let archiveResult: Awaited<ReturnType<typeof mutate>> | undefined;
      if (!familyChoice && family?.requiresConfirmation) {
        const choice = await requestThreadArchiveDialog({
          title: `Archive "${thread.title}"?`,
          family,
          submit: async (selected) => {
            archiveResult = await mutate(selected);
            if (archiveResult._tag === "Success") return null;
            const error = squashAtomCommandFailure(archiveResult);
            const message =
              error instanceof Error ? error.message : "The archive did not complete.";
            return message;
          },
        });
        if (choice === null) {
          action?.finish();
          if (archiveResult?._tag === "Failure") return archiveResult;
          return AsyncResult.failure(Cause.interrupt());
        }
      } else {
        if (!opts.confirmed && !familyChoice && confirmThreadArchive) {
          const confirmed = await readLocalApi()?.dialogs.confirm(
            `Archive thread "${thread.title}"${family !== null && family.children.length > 0 ? ` and its ${family.children.length} child threads` : ""}?`,
          );
          if (!confirmed) {
            action?.finish();
            return AsyncResult.failure(Cause.interrupt());
          }
        }
        archiveResult = await mutate();
      }
      if (archiveResult === undefined || action === undefined) {
        action?.finish();
        return AsyncResult.success(undefined);
      }
      if (archiveResult._tag === "Failure") {
        action.finish();
        return archiveResult;
      }
      const shouldNavigateToDraft =
        currentRouteThreadRef !== null &&
        currentRouteThreadRef.environmentId === threadRef.environmentId &&
        (currentRouteThreadRef.threadId === threadRef.threadId ||
          currentRouteThreadRef.threadId === target.threadId ||
          (family?.childThreadIds.includes(currentRouteThreadRef.threadId) ?? false));
      const wokeAt = threadWokeAt(thread, { now: new Date().toISOString() });
      if (wokeAt !== null) {
        markThreadVisited(scopedThreadKey(threadRef), wokeAt);
      }
      purgeThreadHandoffs(threadRef);
      refreshArchivedThreadsForEnvironment(threadRef.environmentId);
      opts.onArchived?.();
      showThreadUndoNotice({
        action: "Archived",
        claim: action,
        // Undo also brings the reader back when archiving moved them to a draft.
        undo: () => unarchiveThread(threadRef, { navigate: shouldNavigateToDraft }),
        failureTitle: "Failed to undo archive",
      });

      if (shouldNavigateToDraft) {
        const navigationResult = await settlePromise(() =>
          handleNewThreadRef.current(scopeProjectRef(thread.environmentId, thread.projectId)),
        );
        if (navigationResult._tag === "Failure") {
          return navigationResult;
        }
        return archiveResult;
      }

      return archiveResult;
    },
    [
      archiveThreadMutation,
      loadArchiveFamily,
      confirmThreadArchive,
      getCurrentRouteThreadRef,
      markThreadVisited,
      resolveThreadTarget,
      unarchiveThread,
    ],
  );

  const archiveThreads = useCallback(
    async (selected: ReadonlyArray<{ threadKey: string; threadRef: ScopedThreadRef }>) => {
      const unsupported = selected.some(
        ({ threadRef }) => !readEnvironmentSupportsArchiveFamilies(threadRef.environmentId),
      );
      if (unsupported)
        return {
          archivedThreadKeys: [],
          mutationFailure: AsyncResult.failure(
            Cause.fail(new Error(THREAD_ARCHIVE_UPDATE_REQUIRED_MESSAGE)),
          ),
          followupFailures: [],
        };
      const normalizedEntries = normalizeArchiveSelectedEntries(selected, readThreadShell);
      const families: Array<
        (typeof normalizedEntries)[number] & {
          family: ArchiveFamily;
          owner: EnvironmentThreadShell;
        }
      > = [];
      for (const entry of normalizedEntries) {
        const result = await loadArchiveFamily({
          environmentId: entry.threadRef.environmentId,
          input: { threadId: entry.threadRef.threadId },
        });
        if (result._tag === "Failure")
          return {
            archivedThreadKeys: [],
            mutationFailure: result,
            followupFailures: [],
          };
        const owner = result.value.threads.find(
          (candidate) =>
            candidate.id === entry.threadRef.threadId &&
            candidate.environmentId === entry.threadRef.environmentId,
        );
        if (!owner)
          return {
            archivedThreadKeys: [],
            mutationFailure: AsyncResult.failure(
              Cause.fail(
                new Error(
                  "The archive owner is no longer available. Refresh the thread list before retrying.",
                ),
              ),
            ),
            followupFailures: [],
          };
        families.push({
          ...entry,
          family: result.value,
          owner,
        });
      }
      // A selected descendant is handled by its selected ancestor's family operation.
      const entries = families.filter(
        (entry) =>
          !families.some(
            (other) =>
              other.threadRef.environmentId === entry.threadRef.environmentId &&
              other.family.childThreadIds.includes(entry.threadRef.threadId),
          ),
      );
      for (const { owner } of entries) {
        const error = archiveThreadPreflightError(owner);
        if (error)
          return {
            archivedThreadKeys: [],
            mutationFailure: AsyncResult.failure(Cause.fail(error)),
            followupFailures: [],
          };
      }
      const children = [
        ...new Map(
          entries.flatMap(({ threadRef, family }) =>
            family.children.map(
              (child) => [`${threadRef.environmentId}:${child.id}`, child] as const,
            ),
          ),
        ).values(),
      ];
      let outcome:
        | Awaited<
            ReturnType<
              typeof archiveSelectedThreadEntries<
                (typeof entries)[number],
                Awaited<ReturnType<typeof archiveThread>>
              >
            >
          >
        | undefined;
      const entriesByKey = new Map(entries.map((entry) => [entry.threadKey, entry]));
      const perform = async (choice: ThreadArchiveChildDisposition) => {
        const attempt = await archiveSelectedThreadEntries({
          entries,
          archive: (entry, onArchived) => {
            const { threadRef, family, owner, expectedArchiveCommandId } = entry;
            return archiveThread(threadRef, {
              confirmed: true,
              ...(expectedArchiveCommandId === undefined ? {} : { expectedArchiveCommandId }),
              familyChoice: {
                childDisposition: choice,
                expectedChildThreadIds: family.childThreadIds,
              },
              familyOwner: owner,
              familySnapshot: family,
              onArchived,
            });
          },
        });
        const completedParticipantKeys = new Set<string>();
        for (const threadKey of attempt.archivedThreadKeys) {
          const entry = entriesByKey.get(threadKey);
          if (!entry) continue;
          for (const threadId of [entry.owner.id, ...entry.family.childThreadIds]) {
            completedParticipantKeys.add(
              scopedThreadKey(scopeThreadRef(entry.threadRef.environmentId, threadId)),
            );
          }
        }
        outcome = {
          ...attempt,
          // Retry owners identify commands; selection still identifies the original rows.
          archivedThreadKeys: selected
            .filter(({ threadRef }) => completedParticipantKeys.has(scopedThreadKey(threadRef)))
            .map(({ threadKey }) => threadKey),
        };
        if (!outcome.mutationFailure) return null;
        const error = squashAtomCommandFailure(outcome.mutationFailure);
        return error instanceof Error ? error.message : "The archive did not complete.";
      };
      if (entries.some(({ family }) => family.requiresConfirmation)) {
        const choice = await requestThreadArchiveDialog({
          title: `Archive ${entries.length} threads?`,
          family: {
            threads: [
              ...new Map(
                entries.flatMap(({ family }) =>
                  family.threads.map(
                    (thread) => [`${thread.environmentId}:${thread.id}`, thread] as const,
                  ),
                ),
              ).values(),
            ],
            children,
            activeThreadIds: entries.flatMap(({ family }) => family.activeThreadIds),
            unreadThreadIds: entries.flatMap(({ family }) => family.unreadThreadIds),
            protectedChildThreadIds: entries.flatMap(
              ({ family }) => family.protectedChildThreadIds,
            ),
            canStopAndArchive: entries.every(({ family }) => family.canStopAndArchive),
          },
          submit: perform,
        });
        // Completed participants still leave selection even if the remaining operation was cancelled.
        if (choice === null) return outcome ?? null;
      } else {
        if (
          confirmThreadArchive &&
          !(await readLocalApi()?.dialogs.confirm(`Archive ${entries.length} threads?`))
        )
          return null;
        await perform("archive_if_idle");
      }
      return outcome ?? null;
    },
    [archiveThread, confirmThreadArchive, loadArchiveFamily],
  );

  const setThreadPersistence = useCallback(
    (target: ScopedThreadRef, persistent: boolean) =>
      setThreadPersistenceMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId, persistent },
      }),
    [setThreadPersistenceMutation],
  );

  const deleteThread = useCallback(
    async (target: ScopedThreadRef, opts: DeleteThreadOptions = {}) => {
      const permissionFailure = threadOperationFailure(target);
      if (permissionFailure) return permissionFailure;
      const resolved = resolveThreadTargetWithArchivedFallback(
        target,
        resolveThreadTarget(target)?.thread ?? null,
        opts.archivedThreads,
      );
      if (!resolved) {
        // Thread not in main store (e.g. archived thread) — dispatch delete directly.
        const result = await deleteThreadMutation({
          environmentId: target.environmentId,
          input: { threadId: target.threadId },
        });
        if (result._tag === "Success") {
          purgeThreadHandoffs(target);
          refreshArchivedThreadsForEnvironment(target.environmentId);
        }
        return result;
      }
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
      const survivingThreads =
        deletedIds && deletedIds.size > 0
          ? threads.filter((entry) => entry.id === threadRef.threadId || !deletedIds.has(entry.id))
          : threads;
      const orphanedWorktreePath = getOrphanedWorktreePathForThread(
        survivingThreads,
        threadRef.threadId,
      );
      const displayWorktreePath = orphanedWorktreePath
        ? formatWorktreePathForDisplay(orphanedWorktreePath)
        : null;
      const supportsDurableWorktreeCleanup = readEnvironmentSupportsWorktreeCleanup(
        threadRef.environmentId,
      );
      const environmentConfig = appAtomRegistry
        .get(environmentServerConfigsAtom)
        .get(threadRef.environmentId);
      const localApi = readLocalApi();
      let canDeleteWorktree = false;
      if (
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
              "This thread is the only one linked to this worktree:",
              displayWorktreePath ?? orphanedWorktreePath,
              "",
              "Delete the worktree too?",
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

      const deletedThreadIds = deletedIds ?? new Set<ThreadId>();
      const currentRouteThreadRef = getCurrentRouteThreadRef();
      const shouldNavigateToFallback =
        currentRouteThreadRef?.threadId === threadRef.threadId &&
        currentRouteThreadRef.environmentId === threadRef.environmentId;
      const fallbackThreadId = getFallbackThreadIdAfterDelete({
        threads,
        deletedThreadId: threadRef.threadId,
        deletedThreadIds,
        sortOrder: sidebarThreadSortOrder,
      });
      const deleteResult = await deleteThreadMutation({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          ...(shouldDeleteWorktree && supportsDurableWorktreeCleanup
            ? { deleteWorktree: true }
            : {}),
        },
      });
      if (deleteResult._tag === "Failure") {
        return deleteResult;
      }
      purgeThreadHandoffs(threadRef);
      refreshArchivedThreadsForEnvironment(threadRef.environmentId);
      releaseComposerDraftUploads(threadRef);
      clearComposerDraftForThread(threadRef);
      clearProjectDraftThreadById(
        scopeProjectRef(threadRef.environmentId, thread.projectId),
        threadRef,
      );
      clearTerminalUiState(threadRef);

      if (shouldNavigateToFallback) {
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

      const removeResult = readEnvironmentScope(
        threadRef.environmentId,
        AuthSourceControlWriteScope,
      )
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
                message: "This connection can no longer remove worktrees.",
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
        const message = error instanceof Error ? error.message : "An error occurred.";
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
              ? "Failed to delete worktree"
              : "Worktree deleted, but Git status refresh failed",
            description: removalFailed
              ? `Could not remove ${displayWorktreePath ?? orphanedWorktreePath}. ${message}`
              : message,
          }),
        );
        // The thread was deleted. Cleanup has its own toast; returning its
        // failure would make callers incorrectly report a thread deletion error.
      }

      return deleteResult;
    },
    [
      clearComposerDraftForThread,
      clearProjectDraftThreadById,
      clearTerminalUiState,
      deleteThreadMutation,
      getCurrentRouteThreadRef,
      loadSessionState,
      refreshVcsStatus,
      removeWorktree,
      router,
      resolveThreadTarget,
      sidebarThreadSortOrder,
      stopThreadSession,
    ],
  );

  const unsettleThread = useCallback(
    async (target: ScopedThreadRef) => {
      if (!readEnvironmentSupportsSettlement(target.environmentId)) {
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
      // reason "user" pins the thread active: auto-settle (PR merged /
      // inactivity) stays suppressed until real activity clears the pin.
      return unsettleThreadMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId, reason: "user" },
      });
    },
    [unsettleThreadMutation],
  );

  /** Turns automatic settlement (inactivity, merged PR) on or off for one thread. */
  const setThreadAutoSettle = useCallback(
    async (target: ScopedThreadRef, enabled: boolean) => {
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
    },
    [setThreadAutoSettleMutation],
  );

  const pinThread = useCallback(
    async (target: ScopedThreadRef, opts: { orderKey?: string } = {}) => {
      // Version skew: never send the command to a server that predates it.
      if (!readEnvironmentSupportsPinning(target.environmentId)) {
        return AsyncResult.failure(
          Cause.fail(
            new ThreadPinningUnsupportedError({
              environmentId: target.environmentId,
              threadId: target.threadId,
            }),
          ),
        );
      }
      // Every pin path places the thread at the top of the arranged run:
      // callers with a better anchor (the sidebar, which knows the displayed
      // order) pass their own key; everyone else (chat header, context menus)
      // gets the default so the same action never places differently.
      // orderKey rides only to servers that decode it; pre-reorder servers
      // get the bare pin they understand and the thread stays keyless.
      const orderKey = readEnvironmentSupportsPinReorder(target.environmentId)
        ? (opts.orderKey ?? topOfPinnedRunOrderKey())
        : undefined;
      ThreadUndo.invalidate("pin", scopedThreadKey(target));
      return pinThreadMutation({
        environmentId: target.environmentId,
        input: {
          threadId: target.threadId,
          ...(orderKey !== undefined ? { orderKey } : {}),
        },
      });
    },
    [pinThreadMutation],
  );

  const unpinThread = useCallback(
    async (target: ScopedThreadRef) => {
      if (!readEnvironmentSupportsPinning(target.environmentId)) {
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
      const orderKey = thread?.pinOrderKey ?? undefined;
      const action = ThreadUndo.begin("pin", scopedThreadKey(target));
      const result = await unpinThreadMutation({
        environmentId: target.environmentId,
        input: { threadId: target.threadId },
      });
      if (result._tag === "Success" && action.isCurrent()) {
        showThreadUndoNotice({
          action: "Unpinned",
          claim: action,
          undo: () => pinThread(target, orderKey === undefined ? {} : { orderKey }),
          failureTitle: "Failed to undo unpin",
        });
      } else {
        action.finish();
      }
      return result;
    },
    [pinThread, unpinThreadMutation],
  );

  const settleThread = useCallback(
    async (target: ScopedThreadRef) => {
      // Version skew: never send the command to a server that predates it —
      // the raw protocol rejection would read as a random failure.
      if (!readEnvironmentSupportsSettlement(target.environmentId)) {
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
      const wokeAt = resolved
        ? threadWokeAt(resolved.thread, { now: new Date().toISOString() })
        : null;
      // Settling also drops the pin and the snooze server-side, so Undo
      // has to put those back as well.
      const pinOrderKey = resolved?.thread.pinnedAt != null ? resolved.thread.pinOrderKey : null;
      const wasPinned = resolved?.thread.pinnedAt != null;
      const snoozedUntil = resolved?.thread.snoozedUntil ?? null;
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
        undo: async () => {
          const unsettled = await unsettleThread(target);
          if (unsettled._tag !== "Success") return unsettled;
          if (wasPinned) {
            const pinned = await pinThread(
              target,
              pinOrderKey == null ? {} : { orderKey: pinOrderKey },
            );
            if (pinned._tag !== "Success") return pinned;
          }
          if (snoozedUntil !== null) {
            return snoozeThreadMutation({
              environmentId: target.environmentId,
              input: { threadId: target.threadId, snoozedUntil },
            });
          }
          return unsettled;
        },
        failureTitle: "Failed to undo settle",
      });
      return result;
    },
    [
      markThreadVisited,
      pinThread,
      resolveThreadTarget,
      settleThreadMutation,
      snoozeThreadMutation,
      unsettleThread,
    ],
  );

  const confirmAndUnpinThread = useCallback(
    async (target: ScopedThreadRef) => {
      const permissionFailure = threadOperationFailure(target);
      if (permissionFailure) return permissionFailure;
      const localApi = readLocalApi();
      const resolved = resolveThreadTarget(target);
      const confirmationResult = await requestThreadUnpinConfirmation({
        enabled: confirmThreadUnpin,
        title: resolved?.thread.title ?? "this thread",
        confirm: localApi ? (message) => localApi.dialogs.confirm(message) : null,
      });
      if (confirmationResult._tag === "Failure") {
        return confirmationResult;
      }
      if (!confirmationResult.value) {
        return AsyncResult.success(undefined);
      }
      return unpinThread(target);
    },
    [confirmThreadUnpin, resolveThreadTarget, unpinThread],
  );

  const reorderPinnedThread = useCallback(
    async (target: ScopedThreadRef, orderKey: string) => {
      // Callers (the sidebar drag handler) only enable dragging on
      // reorder-capable environments; this guard covers races around
      // capability changes mid-drag.
      if (!readEnvironmentSupportsPinReorder(target.environmentId)) {
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
    },
    [reorderPinnedThreadMutation],
  );

  const reorderActiveThread = useCallback(
    async (target: ScopedThreadRef, orderKey: string) => {
      if (!readEnvironmentSupportsActiveReorder(target.environmentId)) {
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
    },
    [reorderActiveThreadMutation],
  );

  const unsnoozeThread = useCallback(
    async (target: ScopedThreadRef) => {
      if (!readEnvironmentSupportsSnooze(target.environmentId)) {
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
    },
    [unsnoozeThreadMutation],
  );

  const snoozeThread = useCallback(
    async (target: ScopedThreadRef, snoozedUntil: string) => {
      // Version skew: never send the command to a server that predates it.
      if (!readEnvironmentSupportsSnooze(target.environmentId)) {
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
      // Blocked-on-you work and queued turns can't be snoozed away —
      // client-side twin of the server invariants so the UI rejects before
      // a round trip.
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
        undo: () => unsnoozeThread(target),
        failureTitle: "Failed to wake thread",
      });
      return result;
    },
    [resolveThreadTarget, snoozeThreadMutation, unsnoozeThread],
  );

  const confirmAndDeleteThread = useCallback(
    async (target: ScopedThreadRef, opts: Pick<DeleteThreadOptions, "archivedThreads"> = {}) => {
      const permissionFailure = threadOperationFailure(target);
      if (permissionFailure) return permissionFailure;
      const localApi = readLocalApi();
      const resolved = resolveThreadTargetWithArchivedFallback(
        target,
        resolveThreadTarget(target)?.thread ?? null,
        opts.archivedThreads,
      );

      if (confirmThreadDelete && localApi) {
        const title = resolved?.thread.title ?? "this thread";
        const confirmationResult = await settlePromise(() =>
          localApi.dialogs.confirm(
            [
              `Delete thread "${title}"?`,
              "This also deletes any of its subagents, including archived ones; other forks and independent threads are kept. This cannot be undone.",
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
    },
    [confirmThreadDelete, deleteThread, resolveThreadTarget],
  );

  return useMemo(
    () => ({
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
      setThreadAutoSettle,
    }),
    [
      archiveThread,
      archiveThreads,
      confirmAndDeleteThread,
      confirmAndUnpinThread,
      deleteThread,
      markThreadUnread,
      pinThread,
      reorderPinnedThread,
      reorderActiveThread,
      setThreadAutoSettle,
      settleThread,
      snoozeThread,
      unarchiveThread,
      setThreadPersistence,
      unpinThread,
      unsettleThread,
      unsnoozeThread,
    ],
  );
}
