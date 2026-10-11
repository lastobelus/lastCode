import { useCallback, useMemo } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { SidebarThreadSummary } from "../../types";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useClientSettings } from "~/hooks/useSettings";
import { selectProjectGroupingSettings } from "../../logicalProject";
import { useRouter } from "@tanstack/react-router";
import { useOpenHandoff } from "../../handoffs/useOpenHandoff";
import { useRightPanelStore } from "../../rightPanelStore";
import { useSidebar } from "../ui/sidebar";
import { readLocalApi } from "../../localApi";
import { readThreadShell } from "../../state/entities";
import { useStopThreadProcesses } from "../../state/previewHosting";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { threadEnvironment } from "../../state/threads";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useLastCodeThreadActions } from "./LastCodeThreadActions";
import { useLastCodeThreadClipboard } from "./useLastCodeThreadClipboard";
import { deleteLastCodeThread } from "./lastcodeThreadDeletion";
import { reportThreadOperationFailure } from "./lastcodeThreadOperationResult";
import { checkTaskPermission } from "./lastcodeSidebarPermission";
import { readLastCodeThreadMenuTarget } from "./lastcodeThreadMenuTarget";
import {
  isLastCodeThreadActionId,
  lastcodeThreadActionRequiresOperate,
  parseLastCodeHandoffAction,
  type LastCodeThreadActionId,
} from "./lastcodeThreadMenu";

export function useLastCodeThreadMenu(
  project: SidebarProjectSnapshot,
  getThread: (ref: ScopedThreadRef) => SidebarThreadSummary | null,
  startRename: (key: string, title: string) => void,
  editAnnotation: (thread: SidebarThreadSummary) => void,
  navigateToThread: (ref: ScopedThreadRef) => Promise<void>,
  handleNewThread: ReturnType<typeof useNewThreadHandler>,
) {
  const { unarchiveThread, deleteThread, setThreadPersistence, markThreadUnread } =
    useLastCodeThreadActions();
  const updateMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const stopProcesses = useStopThreadProcesses();
  const { copyPath, copyId } = useLastCodeThreadClipboard();
  const handoffsLimit = useClientSettings((s) => s.handoffsMenuLimit);
  const confirmDeletion = useClientSettings((s) => s.confirmThreadDelete);
  const settings = useClientSettings(selectProjectGroupingSettings);
  const openHandoff = useOpenHandoff();
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const members = useMemo(
    () =>
      new Map(
        project.memberProjects.map((member) => [
          scopedProjectKey(scopeProjectRef(member.environmentId, member.id)),
          member,
        ]),
      ),
    [project.memberProjects],
  );
  return useCallback(
    async (
      ref: ScopedThreadRef,
      position: { x: number; y: number },
      hasStoppableProcesses: boolean,
    ) => {
      const api = readLocalApi();
      if (!api) return;
      const thread = getThread(ref);
      if (!thread) return;
      const target = readLastCodeThreadMenuTarget(
        project,
        ref,
        thread,
        members,
        settings,
        handoffsLimit,
        hasStoppableProcesses,
      );
      const clicked = await api.contextMenu.show(target.items, position);
      const handoff = parseLastCodeHandoffAction(clicked);
      if (handoff) {
        if (isMobile) setOpenMobile(false);
        await router.navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: thread.environmentId, threadId: thread.id },
        });
        if (handoff.kind === "all") useRightPanelStore.getState().open(ref, "handoffs");
        else {
          const entry = target.handoffs.find((candidate) => candidate.id === handoff.id);
          if (entry) await openHandoff(ref, entry);
        }
        return;
      }
      if (lastcodeThreadActionRequiresOperate(clicked) && !checkTaskPermission(ref.environmentId))
        return;
      const setCreatorGrouping = async (mode: "grouped" | "independent") => {
        if (!target.creator.groupingEligible) return;
        const result = await updateMetadata({
          environmentId: ref.environmentId,
          input: { threadId: ref.threadId, creatorGrouping: mode },
        });
        reportThreadOperationFailure(result, "Failed to update creator grouping");
      };
      const setPersistence = async (persistent: boolean) => {
        reportThreadOperationFailure(
          await setThreadPersistence(ref, persistent),
          "Failed to update persistent thread",
        );
      };
      const handlers: Record<LastCodeThreadActionId, () => Promise<void> | void> = {
        "dismiss-archive-failure": async () => {
          const pending = thread.archivePending;
          if (pending?.status !== "failed") return;
          const result = await unarchiveThread(
            scopeThreadRef(thread.environmentId, pending.threadId),
            { expectedArchiveCommandId: pending.commandId },
          );
          reportThreadOperationFailure(result, "Couldn't dismiss archive failure");
        },
        "creator-independent": () => setCreatorGrouping("independent"),
        "creator-grouped": () => setCreatorGrouping("grouped"),
        "open-creator": async () => {
          if (target.creator.ref && target.creator.canOpen)
            await navigateToThread(target.creator.ref);
        },
        "open-dashboard": () => {
          if (isMobile) setOpenMobile(false);
          void router.navigate({
            to: "/dashboard",
            search: { environmentId: thread.environmentId, projectId: thread.projectId },
          });
        },
        "project-settings": () => {
          if (target.projectSettingsKey === null) return;
          if (isMobile) setOpenMobile(false);
          void router.navigate({
            to: "/projects/$projectKey",
            params: { projectKey: target.projectSettingsKey },
          });
        },
        "new-thread-on-branch": async () => {
          // Explicit branch carry-over keeps the existing worktree when present.
          const result = await settlePromise(() =>
            handleNewThread(scopeProjectRef(thread.environmentId, thread.projectId), {
              branch: thread.branch,
              worktreePath: thread.worktreePath,
              envMode: thread.worktreePath ? "worktree" : "local",
              startFromOrigin: false,
            }),
          );
          if (result._tag === "Failure") {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Could not create thread",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
        },
        rename: () => startRename(scopedThreadKey(ref), thread.title),
        annotate: () => editAnnotation(thread),
        "mark-unread": () => markThreadUnread(ref),
        "stop-thread-processes": async () => {
          await stopProcesses(ref);
        },
        "mark-persistent": () => setPersistence(true),
        "disable-persistence": () => setPersistence(false),
        "copy-path": () => {
          if (!target.workspacePath) {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Path unavailable",
                description: "This thread does not have a workspace path to copy.",
              }),
            );
            return;
          }
          copyPath(target.workspacePath, { path: target.workspacePath });
        },
        "copy-thread-id": () => copyId(thread.id, { threadId: thread.id }),
        delete: () =>
          deleteLastCodeThread(ref, thread, {
            canOperate: checkTaskPermission,
            confirm: (message, options) => api.dialogs.confirm(message, options),
            confirmDeletion,
            readThread: readThreadShell,
            deleteThread: deleteThread,
          }),
        "handoffs-heading": () => {},
        "handoffs-empty": () => {},
        "handoff-show-all": () => {},
      };
      if (isLastCodeThreadActionId(clicked)) await handlers[clicked]();
    },
    [
      deleteThread,
      markThreadUnread,
      setThreadPersistence,
      unarchiveThread,
      copyId,
      copyPath,
      confirmDeletion,
      editAnnotation,
      getThread,
      handleNewThread,
      handoffsLimit,
      isMobile,
      members,
      navigateToThread,
      openHandoff,
      project,
      router,
      setOpenMobile,
      settings,
      startRename,
      stopProcesses,
      updateMetadata,
    ],
  );
}
