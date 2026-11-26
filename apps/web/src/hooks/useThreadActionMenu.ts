import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { mergeWorktreeSuspensionMenuItems } from "../components/worktreeSuspensionMenu";
import { withThreadReadPermissions } from "./threadReadActions";
import {
  linkedArchiveStatusMenuItem,
  LINKED_ARCHIVE_STATUS_ACTION,
  useLastCodeLinkedArchiveRecovery,
} from "./useLastCodeLinkedArchiveRecovery";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { requestCustomSnooze } from "../components/CustomSnoozeDialog";
import { openGuestShareDialog } from "../components/chat/guestShareDialogState";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { canSnooze, effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import {
  AuthOrchestrationOperateScope,
  type ScopedThreadRef,
  type ThreadId,
  type ContextMenuSource,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { msg } from "gt-react";

import { pickSnoozePreset, resolveSnoozePresets } from "../components/Sidebar.snooze";
import {
  buildThreadActionMenuItems,
  isThreadTriageAction,
  threadActionRequiresOperate,
  type ThreadActionMenuId,
} from "../components/threadActionMenu.logic";
import { titleRegenerationToast } from "../components/threadTitleRegenerationToast";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { copyThreadReference } from "../lib/copyThreadReference";
import { m } from "../i18n/messages";
import { threadChipCopyTarget } from "@t3tools/client-runtime/thread-reference";
import { threadEnvironment } from "../state/threads";
import { threadTriagePermitted, useOrchestrationCommand } from "../state/use-orchestration-command";
import { readEnvironmentScope } from "../state/session";
import { terminalEnvironment } from "../state/terminal";
import { useThreadRunningTerminalIds } from "../state/terminalSessions";
import {
  usePreviewProcessControlsSupported,
  useStopThreadProcesses,
  useThreadPreviewLeases,
} from "../state/previewHosting";
import { useAtomCommand } from "../state/use-atom-command";
import {
  readEnvironmentServerConfigLoaded,
  readEnvironmentSupportsAutoSettleOptOut,
  readEnvironmentSupportsPersistence,
  readThreadShell,
  useProjects,
} from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { readLocalApi } from "../localApi";
import { configuredHostedAppUrl } from "../hostedPairing";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { buildPhysicalToLogicalProjectKeyMap } from "../sidebarProjectGrouping";
import {
  threadRuntimeBlocksMarkUnread,
  threadRuntimeIsActive,
} from "@t3tools/client-runtime/state/models";
import { useCopyToClipboard } from "./useCopyToClipboard";
import { useNewThreadHandler } from "./useHandleNewThread";
import { useClientSettings } from "./useSettings";
import { canTurnThreadIntoProject, useThreadActions } from "./useThreadActions";
import { describeHandoff } from "../handoffs/handoffMenu";
import { useThreadHandoffs } from "../handoffs/handoffsStore";
import { useOpenHandoff } from "../handoffs/useOpenHandoff";
import { useRightPanelStore } from "../rightPanelStore";
import { useWorktreeSuspensionActions } from "./useWorktreeSuspensionActions";

function failureToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: thrownErrorMessage(error, m) ?? m(msg("An error occurred.")),
    }),
  );
}

export function useThreadActionMenu(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly projectCwd: string | null;
  /** Omitted where no inline title editor is rendered; the rename item is then disabled. */
  readonly onStartRename?: (() => void) | undefined;
  readonly onFind?: ((threadRef: ScopedThreadRef) => void) | undefined;
  readonly canShareWithGuest: boolean;
}) {
  const { threadRef, projectCwd, onStartRename, onFind, canShareWithGuest } = input;
  const router = useRouter();
  const showLinkedArchiveStatus = useLastCodeLinkedArchiveRecovery();
  const workspaceActions = useWorktreeSuspensionActions();
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const logicalProjectKeyByPhysicalKey = buildPhysicalToLogicalProjectKeyMap({
    projects,
    settings: projectGroupingSettings,
    primaryEnvironmentId,
  });
  const {
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    confirmAndUnpinThread,
    setThreadAutoSettle,
    setThreadPersistence,
    archiveThread,
    unarchiveThread,
    confirmAndDeleteThread,
    markThreadUnread,
    turnThreadIntoProject,
    markThreadRead,
  } = useThreadActions();
  const regenerateThreadTitle = useOrchestrationCommand(threadEnvironment.regenerateTitle, {
    reportFailure: false,
  });
  const closeTerminal = useAtomCommand(terminalEnvironment.close, "cancel Project Action");
  const stopThreadProcesses = useStopThreadProcesses();
  const previews = useThreadPreviewLeases(threadRef);
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: threadRef?.environmentId ?? null,
    threadId: threadRef?.threadId ?? null,
  });
  const supportsProcessControls = usePreviewProcessControlsSupported(
    threadRef?.environmentId ?? null,
  );
  const hasStoppableProcesses =
    supportsProcessControls && (runningTerminalIds.length > 0 || previews.length > 0);
  const handleNewThread = useNewThreadHandler();
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const handoffsMenuLimit = useClientSettings((s) => s.handoffsMenuLimit);
  const handoffs = useThreadHandoffs(threadRef);
  const openHandoff = useOpenHandoff();
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onError: (error) => failureToast(m(msg("Failed to copy path")), error),
  });
  const { copyToClipboard: copyBranchToClipboard } = useCopyToClipboard<{ branch: string }>({
    target: {
      target: "branch name",
      unavailableMessage: msg("Clipboard API is unavailable while copying branch name."),
      failureMessage: msg("Failed to copy branch name to the clipboard."),
    },
    onError: (error) => failureToast(m(msg("Failed to copy branch")), error),
  });
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{ threadId: ThreadId }>({
    onError: (error) => failureToast(m(msg("Failed to copy thread ID")), error),
  });

  /** The thread's menu as of now, and a runner for its actions. Null until the thread loads. */
  const readMenu = () => {
    if (threadRef === null) return null;
    const thread = readThreadShell(threadRef);
    if (!thread) return null;
    const now = new Date();
    const configLoaded = readEnvironmentServerConfigLoaded(threadRef.environmentId);
    const supports = {
      settlement: configLoaded,
      autoSettleOptOut: readEnvironmentSupportsAutoSettleOptOut(threadRef.environmentId),
      snooze: configLoaded,
      pinning: configLoaded,
      titleRegeneration: configLoaded,
      persistence: readEnvironmentSupportsPersistence(threadRef.environmentId),
    };
    const isRegeneratingTitle = thread.titleRegeneration != null;
    const snoozePresets = resolveSnoozePresets(now, timestampFormat, threadRef.environmentId);
    const handoffDescriptors = handoffs.slice(0, handoffsMenuLimit).map(describeHandoff);
    const items = mergeWorktreeSuspensionMenuItems(
      buildThreadActionMenuItems({
        canOperate: readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope),
        canTriage: threadTriagePermitted(threadRef.environmentId),
        canRename: onStartRename !== undefined,
        canFind: onFind !== undefined,
        branch: thread.branch ?? null,
        projectFilter: null,
        isPinned: thread.pinnedAt != null,
        isPersistent: thread.persistent === true,
        archiveFailed: thread.archivePending?.status === "failed",
        isSettled: supports.settlement && thread.settledOverride === "settled",
        autoSettleEnabled: thread.autoSettleDisabledAt == null,
        isSnoozed: supports.snooze && effectiveSnoozed(thread, { now: now.toISOString() }),
        canSnoozeNow: canSnooze(thread, { now: now.toISOString() }),
        isRegeneratingTitle,
        isRunning: threadRuntimeIsActive(thread.runtime),
        hasCompletedRun: thread.latestRun?.completedAt != null,
        blocksMarkUnread: threadRuntimeBlocksMarkUnread(thread.runtime),
        hasRunningAction: thread.actionResume?.outcome === "running",
        hasStoppableProcesses,
        supports,
        snoozePresets,
        canShareWithGuest,
        canTurnIntoProject: canTurnThreadIntoProject(threadRef),
        handoffs: handoffDescriptors,
        handoffsOverflow: handoffs.length > handoffDescriptors.length,
      }),
      workspaceActions.menuItems(thread),
    );
    const run = async (action: ThreadActionMenuId) => {
      if (!readLocalApi()) return;
      if (action === LINKED_ARCHIVE_STATUS_ACTION) {
        await showLinkedArchiveStatus(threadRef);
        return;
      }
      if (await workspaceActions.run(action, threadRef)) return;
      if (action === "handoff-show-all") {
        useRightPanelStore.getState().open(threadRef, "handoffs");
        return;
      }
      if (action.startsWith("handoff:")) {
        const entry = handoffs.find((candidate) => `handoff:${candidate.id}` === action);
        if (entry) await openHandoff(threadRef, entry);
        return;
      }
      if (
        threadActionRequiresOperate(action) &&
        !(isThreadTriageAction(action)
          ? threadTriagePermitted(threadRef.environmentId)
          : readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope))
      ) {
        failureToast(
          m(msg("Thread action unavailable")),
          new Error(m(msg("This connection cannot change threads."))),
        );
        return;
      }
      if (action.startsWith("snooze:")) {
        const preset =
          action === "snooze:custom"
            ? await requestCustomSnooze()
            : pickSnoozePreset(
                snoozePresets,
                action.slice("snooze:".length),
                timestampFormat,
                threadRef.environmentId,
              );
        if (!preset) return;
        const result = await snoozeThread(threadRef, preset.snoozedUntil);
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          failureToast(m(msg("Failed to snooze thread")), squashAtomCommandFailure(result));
        }
        return;
      }
      const reportFailure = async (
        title: string,
        run: () => Promise<AtomCommandResult<unknown, unknown>>,
      ) => {
        const result = await run();
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          failureToast(title, squashAtomCommandFailure(result));
        }
      };
      switch (action) {
        case "find":
          onFind?.(threadRef);
          return;
        case "project-settings": {
          const project = projects.find(
            (candidate) =>
              candidate.environmentId === thread.environmentId && candidate.id === thread.projectId,
          );
          if (!project) return;
          const projectKey =
            logicalProjectKeyByPhysicalKey.get(derivePhysicalProjectKey(project)) ??
            deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings);
          void router.navigate({
            to: "/projects/$projectKey",
            params: { projectKey },
          });
          return;
        }
        case "new-thread-on-branch": {
          const result = await settlePromise(() =>
            handleNewThread(scopeProjectRef(threadRef.environmentId, thread.projectId), {
              branch: thread.branch,
              worktreePath: thread.worktreePath,
              envMode: thread.worktreePath ? "worktree" : "local",
              startFromOrigin: false,
            }),
          );
          if (result._tag === "Failure") {
            failureToast(m(msg("Could not create thread")), squashAtomCommandFailure(result));
          }
          return;
        }
        case "settle":
          await reportFailure(m(msg("Failed to settle thread")), () => settleThread(threadRef));
          return;
        case "unsettle":
          await reportFailure(m(msg("Failed to un-settle thread")), () =>
            unsettleThread(threadRef),
          );
          return;
        case "unsnooze":
          await reportFailure(m(msg("Failed to wake thread")), () => unsnoozeThread(threadRef));
          return;
        case "pin":
          await reportFailure(m(msg("Failed to pin thread")), () => pinThread(threadRef));
          return;
        case "unpin": {
          await reportFailure(m(msg("Failed to unpin thread")), () =>
            confirmAndUnpinThread(threadRef),
          );
          return;
        }
        case "auto-settle:enabled":
        case "auto-settle:disabled":
          await reportFailure(m(msg("Failed to update auto-settle")), () =>
            setThreadAutoSettle(threadRef, action === "auto-settle:enabled"),
          );
          return;
        case "mark-persistent":
          await reportFailure(m(msg("Failed to mark persistent thread")), () =>
            setThreadPersistence(threadRef, true),
          );
          return;
        case "disable-persistence":
          await reportFailure(m(msg("Failed to disable persistent thread")), () =>
            setThreadPersistence(threadRef, false),
          );
          return;
        case "rename":
          onStartRename?.();
          return;
        case "regenerate-title": {
          if (isRegeneratingTitle) return;
          const toast = titleRegenerationToast([
            await regenerateThreadTitle({
              environmentId: threadRef.environmentId,
              input: { threadId: threadRef.threadId },
            }),
          ]);
          if (toast) toastManager.add(toast);
          return;
        }
        case "cancel-action": {
          const actionState = thread.actionResume;
          if (actionState?.outcome !== "running") return;
          await reportFailure(m(msg("Failed to cancel Project Action")), () =>
            closeTerminal({
              environmentId: threadRef.environmentId,
              input: { threadId: threadRef.threadId, terminalId: actionState.terminalId },
            }),
          );
          return;
        }
        case "mark-unread":
          markThreadUnread(threadRef);
          return;
        case "share-guest":
          openGuestShareDialog(threadRef);
          return;
        case "turn-into-project": {
          const result = await turnThreadIntoProject(threadRef);
          if (result._tag === "Success") {
            toastManager.add({
              type: "success",
              title: m(msg("Project created")),
              description: thread.title,
            });
          } else if (!isAtomCommandInterrupted(result)) {
            failureToast(
              m(msg("Could not turn thread into a project")),
              squashAtomCommandFailure(result),
            );
          }
          return;
        }
        case "mark-read":
          markThreadRead(threadRef);
          return;
        case "stop-thread-processes":
          await stopThreadProcesses(threadRef);
          return;
        case "copy-path": {
          const workspacePath = thread.worktreePath ?? projectCwd;
          if (!workspacePath) {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: m(msg("Path unavailable")),
                description: m(msg("This thread does not have a workspace path to copy.")),
              }),
            );
            return;
          }
          copyPathToClipboard(workspacePath, { path: workspacePath });
          return;
        }
        case "copy-branch":
          if (thread.branch) {
            copyBranchToClipboard(thread.branch, { branch: thread.branch });
          }
          return;
        case "copy-thread":
          void copyThreadReference(
            threadChipCopyTarget(threadRef, thread.title, configuredHostedAppUrl(), m),
          );
          return;
        case "copy-thread-id":
          copyThreadIdToClipboard(thread.id, { threadId: thread.id });
          return;
        case "dismiss-archive-failure": {
          const pending = thread.archivePending;
          if (pending?.status !== "failed") return;
          await reportFailure(m(msg("Couldn't dismiss archive failure")), () =>
            unarchiveThread(scopeThreadRef(thread.environmentId, pending.threadId), {
              expectedArchiveCommandId: pending.commandId,
            }),
          );
          return;
        }
        case "archive":
        case "archive-discard": {
          let didArchive = false;
          const result = await archiveThread(threadRef, {
            discardSavedWorkspace: action === "archive-discard",
            ...(thread.archivePending?.status === "failed"
              ? { expectedArchiveCommandId: thread.archivePending.commandId }
              : {}),
            onArchived: () => {
              didArchive = true;
            },
          });
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            failureToast(
              didArchive
                ? m(msg("Thread archived, but navigation failed"))
                : m(msg("Failed to archive thread")),
              squashAtomCommandFailure(result),
            );
          }
          return;
        }
        case "delete": {
          const deleted = await confirmAndDeleteThread(threadRef);
          if (
            deleted._tag === "Failure" &&
            !isAtomCommandInterrupted(deleted) &&
            // A missing thread means cleanup failed after deletion; deleteThread already toasted that failure.
            readThreadShell(threadRef) !== null
          ) {
            failureToast(m(msg("Failed to delete thread")), squashAtomCommandFailure(deleted));
          }
          return;
        }
        default:
          return;
      }
    };
    return {
      items: withThreadReadPermissions(
        [...items, ...linkedArchiveStatusMenuItem(threadRef.environmentId)],
        [threadRef],
      ),
      run,
    };
  };

  const openMenu = (position: { x: number; y: number }, source?: ContextMenuSource) => {
    void (async () => {
      const api = readLocalApi();
      if (!api || threadRef === null) return;
      const menu = readMenu();
      if (!menu) {
        failureToast(
          m(msg("Thread actions unavailable")),
          new Error(m(msg("This thread has not loaded yet."))),
        );
        return;
      }
      const clicked = await settlePromise(() => api.contextMenu.show(menu.items, position, source));
      if (clicked._tag === "Failure" || clicked.value === null) return;
      await menu.run(clicked.value);
    })();
  };

  const closeMenu = () => {
    void readLocalApi()?.contextMenu.close();
  };

  return { openMenu, closeMenu, readMenu };
}
