import { msg } from "gt-react";
import { m } from "~/i18n/messages";
import { mergeWorktreeSuspensionMenuItems } from "../worktreeSuspensionMenu";
import { withThreadReadPermissions } from "../../hooks/threadReadActions";
import type { ScopedThreadRef, ThreadOwnershipAction } from "@t3tools/contracts";
import { getRecordedThreadOwner } from "@t3tools/shared/threadOwnership";
import { threadOwnershipChangeFailed } from "./lastcodeThreadPromotionCopy";
import { threadAnnotationId } from "@t3tools/shared/threadAnnotation";
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
import { selectProjectGroupingSettings } from "@t3tools/client-runtime/state/project-grouping";
import { useRouter } from "@tanstack/react-router";
import { useOpenHandoff } from "../../handoffs/useOpenHandoff";
import { useWorktreeSuspensionActions } from "../../hooks/useWorktreeSuspensionActions";
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
import {
  readLastCodeThreadMenuTarget,
  readLastCodeThreadMenuProject,
  type LastCodeThreadMenuTarget,
} from "./lastcodeThreadMenuTarget";
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
  const {
    archiveThread,
    unarchiveThread,
    confirmAndDeleteThread,
    setThreadPersistence,
    markThreadUnread,
    markThreadRead,
  } = useLastCodeThreadActions();
  const updateMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const loadOwnershipAvailability = useOrchestrationCommand(
    threadEnvironment.loadOwnershipAvailability,
    { reportFailure: false },
  );
  const changeOwnership = useOrchestrationCommand(threadEnvironment.changeOwnership, {
    reportFailure: false,
  });
  const resolveAnnotation = useOrchestrationCommand(threadEnvironment.resolveAnnotation, {
    reportFailure: false,
  });
  const stopProcesses = useStopThreadProcesses();
  const { copyPath, copyId } = useLastCodeThreadClipboard();
  const handoffsLimit = useClientSettings((s) => s.handoffsMenuLimit);
  const settings = useClientSettings(selectProjectGroupingSettings);
  const router = useRouter();
  const workspaceActions = useWorktreeSuspensionActions();
  const { isMobile, setOpenMobile } = useSidebar();
  const openHandoff = useThreadMenuHandoff(router, isMobile, setOpenMobile);
  const members = new Map(
    project.memberProjects.map((member) => [
      scopedProjectKey(scopeProjectRef(member.environmentId, member.id)),
      member,
    ]),
  );
  return async (
    ref: ScopedThreadRef,
    position: { x: number; y: number },
    hasStoppableProcesses: boolean,
  ) => {
    const api = readLocalApi();
    if (!api) return;
    const thread = getThread(ref);
    if (!thread) return;
    const owner = getRecordedThreadOwner(thread, ref.environmentId);
    const checked =
      owner === null
        ? null
        : await loadOwnershipAvailability({
            environmentId: ref.environmentId,
            input: { threadId: ref.threadId },
          });
    const ownership =
      checked?._tag === "Success"
        ? checked.value
        : owner === null
          ? null
          : {
              action:
                thread.lineage.independent === true
                  ? ("return_to_owner" as const)
                  : ("promote" as const),
              ownerHere: owner.environmentId === ref.environmentId,
              refusal: "unavailable" as const,
            };
    const target = readLastCodeThreadMenuTarget(
      thread,
      readLastCodeThreadMenuProject(thread, project, members, settings),
      handoffsLimit,
      hasStoppableProcesses,
      ownership,
    );
    const clicked = await api.contextMenu.show(
      withThreadReadPermissions(
        mergeWorktreeSuspensionMenuItems(target.items, workspaceActions.menuItems(thread)),
        [ref],
      ),
      position,
    );
    if (await workspaceActions.run(clicked, ref)) return;
    const handoff = parseLastCodeHandoffAction(clicked);
    if (handoff) {
      await openHandoff(target, handoff);
      return;
    }
    if (lastcodeThreadActionRequiresOperate(clicked) && !checkTaskPermission(ref.environmentId))
      return;
    const setCreatorGrouping = async (mode: "grouped" | "independent") => {
      if (mode === "grouped" && (!target.creator.groupingEligible || !target.creator.groupingRef))
        return;
      if (mode === "independent" && target.parentThreadId === null) return;
      const result = await updateMetadata({
        environmentId: ref.environmentId,
        input: {
          threadId: ref.threadId,
          groupedUnderThreadId: mode === "grouped" ? target.creator.groupingRef!.threadId : null,
        },
      });
      reportThreadOperationFailure(result, msg("Failed to update creator grouping"));
    };
    const setPersistence = async (persistent: boolean) => {
      reportThreadOperationFailure(
        await setThreadPersistence(ref, persistent),
        msg("Failed to update persistent thread"),
      );
    };
    const setOwnership = async (action: ThreadOwnershipAction) => {
      if (ownership?.action !== action || ownership.refusal !== null) return;
      reportThreadOperationFailure(
        await changeOwnership({
          environmentId: ref.environmentId,
          input: { threadId: ref.threadId, action },
        }),
        threadOwnershipChangeFailed,
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
        reportThreadOperationFailure(result, msg("Couldn't dismiss archive failure"));
      },
      "creator-independent": () => setCreatorGrouping("independent"),
      "creator-grouped": () => setCreatorGrouping("grouped"),
      promote: () => setOwnership("promote"),
      "return-to-owner": () => setOwnership("return_to_owner"),
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
              title: m(msg("Could not create thread")),
              description: error instanceof Error ? error.message : m(msg("An error occurred.")),
            }),
          );
        }
      },
      rename: () => startRename(scopedThreadKey(ref), thread.title),
      annotate: () => editAnnotation(thread),
      "resolve-annotation": async () => {
        if (thread.annotation?.resolvedAt !== null) return;
        const result = await resolveAnnotation({
          environmentId: thread.environmentId,
          input: { threadId: thread.id, annotationId: threadAnnotationId(thread.annotation) },
        });
        reportThreadOperationFailure(result, msg("Failed to resolve annotation"));
      },
      "mark-unread": () => {
        markThreadUnread(ref);
      },
      "mark-read": () => {
        void markThreadRead(ref);
      },
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
              title: m(msg("Path unavailable")),
              description: m(msg("This thread does not have a workspace path to copy.")),
            }),
          );
          return;
        }
        copyPath(target.workspacePath, { path: target.workspacePath });
      },
      "copy-thread-id": () => copyId(thread.id, { threadId: thread.id }),
      "archive-discard": async () => {
        reportThreadOperationFailure(
          await archiveThread(ref, { discardSavedWorkspace: true }),
          msg("Failed to archive thread"),
        );
      },
      delete: () =>
        deleteLastCodeThread(ref, thread, {
          canOperate: checkTaskPermission,
          confirm: (message, options) => api.dialogs.confirm(message, options),
          confirmDeletion: false,
          readThread: readThreadShell,
          deleteThread: confirmAndDeleteThread,
        }),
      "handoffs-heading": () => {},
      "handoffs-empty": () => {},
      "handoff-show-all": () => {},
    };
    if (isLastCodeThreadActionId(clicked)) await handlers[clicked]();
  };
}

/** Handoff destinations share thread navigation, but individual and show-all actions open different views. */
function useThreadMenuHandoff(
  router: ReturnType<typeof useRouter>,
  isMobile: boolean,
  setOpenMobile: ReturnType<typeof useSidebar>["setOpenMobile"],
) {
  const openHandoff = useOpenHandoff();
  return async (
    target: LastCodeThreadMenuTarget,
    handoff: NonNullable<ReturnType<typeof parseLastCodeHandoffAction>>,
  ) => {
    const { thread, threadRef } = target;
    if (isMobile) setOpenMobile(false);
    await router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: thread.environmentId, threadId: thread.id },
    });
    if (handoff.kind === "all") useRightPanelStore.getState().open(threadRef, "handoffs");
    else {
      const entry = target.handoffs.find((candidate) => candidate.id === handoff.id);
      if (entry) await openHandoff(threadRef, entry);
    }
  };
}
