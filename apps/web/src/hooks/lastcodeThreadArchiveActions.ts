import { randomUUID } from "../lib/utils";
import { consultThreadArchiveAgent } from "@t3tools/client-runtime/state/thread-archive";
import type { useRouter } from "@tanstack/react-router";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  scopeThreadRef,
  scopeProjectRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import {
  archiveRetryThreadId,
  buildThreadArchiveConfirmation,
  THREAD_ARCHIVE_UPDATE_REQUIRED_MESSAGE,
} from "@t3tools/client-runtime/state/thread-archive";
import {
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommand,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import * as ThreadUndo from "@t3tools/client-runtime/state/thread-undo";
import type {
  CommandId,
  EnvironmentAuthorizationError,
  SavedWorkspaceDisposition,
  ScopedThreadRef,
  ThreadArchiveChildDisposition,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { archiveSelectedThreadEntries } from "../components/Sidebar.logic";
import { requestThreadArchiveDialog } from "../components/ThreadArchiveDialog";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { purgeThreadHandoffs } from "../handoffs/handoffsStore";
import { refreshArchivedThreadsForEnvironment } from "../lib/archivedThreadsState";
import { readLocalApi } from "../localApi";
import { readEnvironmentSupportsArchiveFamilies, readThreadShell } from "../state/entities";
import type { threadEnvironment } from "../state/threads";
import { buildThreadRouteParams } from "../threadRoutes";
import { showThreadUndoNotice } from "./showThreadUndoNotice";
import type { useWorkspaceLifecycleConfirmation } from "./useWorkspaceLifecycleConfirmation";
import type { useNewThreadHandler } from "./useHandleNewThread";

type CommandRunner<C> =
  C extends AtomCommand<infer W, infer A, infer E>
    ? (input: W) => Promise<AtomCommandResult<A, E | EnvironmentAuthorizationError>>
    : never;
type ArchiveFamily = Extract<
  Awaited<ReturnType<CommandRunner<typeof threadEnvironment.loadArchiveFamily>>>,
  { _tag: "Success" }
>["value"];
const LIST_PLACEMENT_UNDO_KINDS = ["settle", "snooze", "pin"];

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

export function createLastCodeThreadArchiveActions(ports: {
  workspaceLifecycle: ReturnType<typeof useWorkspaceLifecycleConfirmation>;
  archiveThreadMutation: CommandRunner<typeof threadEnvironment.archive>;
  unarchiveThreadMutation: CommandRunner<typeof threadEnvironment.unarchive>;
  loadArchiveFamily: CommandRunner<typeof threadEnvironment.loadArchiveFamily>;
  sendArchiveQuestion: CommandRunner<typeof threadEnvironment.startTurn>;
  confirmThreadArchive: boolean;
  markThreadVisited: (threadKey: string, visitedAt: string) => void;
  router: ReturnType<typeof useRouter>;
  handleNewThread: ReturnType<typeof useNewThreadHandler>;
  getCurrentRouteThreadRef: () => ScopedThreadRef | null;
  threadOperationFailure: (
    target: ScopedThreadRef,
  ) => AtomCommandResult<unknown, EnvironmentAuthorizationError> | null;
  expireThreadUndos: (target: ScopedThreadRef, kinds: readonly string[]) => void;
}) {
  const {
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
  } = ports;
  const resolveThreadTarget = (target: ScopedThreadRef) => {
    const thread = readThreadShell(target);
    return thread ? { thread, threadRef: target } : null;
  };
  const review = (ref: ScopedThreadRef) =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(ref),
    });

  const unarchiveThread = async (
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
  };

  const archiveThread = async (
    target: ScopedThreadRef,
    opts: {
      onArchived?: () => void;
      discardSavedWorkspace?: boolean;
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
    if (!resolved && opts.expectedArchiveCommandId === undefined)
      return AsyncResult.success(undefined);
    const expectedArchiveCommandId =
      opts.expectedArchiveCommandId ??
      (resolved?.thread.archivePending?.status === "failed"
        ? resolved.thread.archivePending.commandId
        : undefined);
    const retry = expectedArchiveCommandId !== undefined;
    const threadRef = scopeThreadRef(
      target.environmentId,
      resolved ? archiveRetryThreadId(resolved.thread) : target.threadId,
    );
    let thread = resolved?.thread;
    const familyChoice = retry && !opts.familyOwner ? undefined : opts.familyChoice;

    const requestingRouteHref = router.state.location.href;
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
      thread = familyResult.value.threads.find(
        (candidate) =>
          candidate.id === threadRef.threadId &&
          candidate.environmentId === threadRef.environmentId,
      );
    }
    if (!thread)
      return AsyncResult.failure(
        Cause.fail(
          new Error(
            "The archive owner is no longer available. Refresh the thread list before retrying.",
          ),
        ),
      );
    const family = familyResult === null ? (opts.familySnapshot ?? null) : familyResult.value;
    const preflightError = archiveThreadPreflightError(thread);
    if (preflightError) return AsyncResult.failure(Cause.fail(preflightError));

    let savedWorkspace: SavedWorkspaceDisposition | undefined;
    let lifecycleChildDisposition: ThreadArchiveChildDisposition | undefined;
    if (opts.discardSavedWorkspace) {
      const confirmation = await settlePromise(() =>
        workspaceLifecycle.confirm(
          [
            {
              environmentId: threadRef.environmentId,
              input: {
                operation: "archive",
                target: { kind: "threads", threadIds: [threadRef.threadId] },
              },
            },
          ],
          {
            title: `Archive "${thread.title}" and discard saved workspace?`,
            description:
              "The conversation stays in Archived threads. Saved data can be permanently discarded without restoring it.",
            ...(family?.requiresConfirmation
              ? { archiveFamily: buildThreadArchiveConfirmation(family) }
              : {}),
          },
        ),
      );
      if (confirmation._tag === "Failure") return confirmation;
      if (confirmation.value === null) return AsyncResult.failure(Cause.interrupt());
      savedWorkspace = confirmation.value.dispositions[0];
      lifecycleChildDisposition = confirmation.value.childDisposition;
    }
    const expectedChildThreadIds = family?.childThreadIds ?? [];
    const mutate = (childDisposition?: ThreadArchiveChildDisposition) => {
      action?.finish();
      action = ThreadUndo.begin("archive", scopedThreadKey(threadRef));
      return archiveThreadMutation({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          ...(savedWorkspace === undefined ? {} : { savedWorkspace }),
          ...(expectedArchiveCommandId === undefined ? {} : { expectedArchiveCommandId }),
          ...(familyChoice ??
            (family !== null
              ? {
                  childDisposition:
                    childDisposition ?? lifecycleChildDisposition ?? "archive_if_idle",
                  expectedChildThreadIds,
                }
              : {})),
        },
      });
    };
    let archiveResult: Awaited<ReturnType<typeof mutate>> | undefined;
    let consulted = false;
    if (!opts.discardSavedWorkspace && !familyChoice && family?.requiresConfirmation) {
      const choice = await requestThreadArchiveDialog({
        title: `Archive "${thread.title}"?`,
        family,
        review,
        ...(family.consultationTargets?.length
          ? {
              consultation: {
                targets: family.consultationTargets,
                environmentId: threadRef.environmentId,
                ask: async (ownerThreadId: ThreadId) => {
                  const reason = await consultThreadArchiveAgent({
                    familyRef: threadRef,
                    ownerThreadId,
                    inspect: async () => {
                      const result = await loadArchiveFamily({
                        environmentId: threadRef.environmentId,
                        input: { threadId: threadRef.threadId },
                      });
                      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                      return result.value;
                    },
                    readOwner: readThreadShell,
                    randomId: randomUUID,
                    send: async (input) => {
                      const result = await sendArchiveQuestion(input);
                      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
                    },
                  });
                  if (reason !== null) return reason;
                  consulted = true;
                  await review(scopeThreadRef(threadRef.environmentId, ownerThreadId));
                  return null;
                },
              },
            }
          : {}),
        submit: async (selected) => {
          archiveResult = await mutate(selected);
          if (archiveResult._tag === "Success") return null;
          const error = squashAtomCommandFailure(archiveResult);
          const message = error instanceof Error ? error.message : "The archive did not complete.";
          return message;
        },
      });
      if (choice === null) {
        if (consulted) return AsyncResult.success(undefined);
        action?.finish();
        if (archiveResult?._tag === "Failure") return archiveResult;
        return AsyncResult.failure(Cause.interrupt());
      }
    } else {
      if (!opts.discardSavedWorkspace && !opts.confirmed && !familyChoice && confirmThreadArchive) {
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
    for (const threadId of [threadRef.threadId, ...(family?.childThreadIds ?? [])]) {
      expireThreadUndos(
        scopeThreadRef(threadRef.environmentId, threadId),
        LIST_PLACEMENT_UNDO_KINDS,
      );
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
    if (savedWorkspace?.mode === "discard") {
      action.finish();
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: "Thread archived",
          description:
            "Discarding the reviewed saved copies was authorized. This cannot be undone. Refresh Saved workspaces in Storage to inspect any pending disposal.",
        }),
      );
    } else {
      showThreadUndoNotice({
        action: "Archived",
        claim: action,
        // Undo also brings the reader back when archiving moved them to a draft.
        undo: () => unarchiveThread(threadRef, { navigate: shouldNavigateToDraft }),
        failureTitle: "Failed to undo archive",
      });
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: "Saved workspace data kept",
          description: "Archiving keeps any saved copies available in Storage.",
        }),
      );
    }

    if (shouldNavigateToDraft && router.state.location.href === requestingRouteHref) {
      const navigationResult = await settlePromise(() =>
        handleNewThread(scopeProjectRef(thread.environmentId, thread.projectId)),
      );
      if (navigationResult._tag === "Failure") {
        return navigationResult;
      }
      return archiveResult;
    }

    return archiveResult;
  };

  const archiveThreads = async (
    selected: ReadonlyArray<{ threadKey: string; threadRef: ScopedThreadRef }>,
  ) => {
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
        review,
        reviewFamilies: entries.map(({ threadRef, owner }) => ({
          ref: threadRef,
          title: owner.title,
        })),
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
          protectedChildThreadIds: entries.flatMap(({ family }) => family.protectedChildThreadIds),
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
  };

  return { archiveThread, archiveThreads, unarchiveThread };
}
