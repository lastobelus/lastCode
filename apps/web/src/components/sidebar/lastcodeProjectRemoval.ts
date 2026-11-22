import { msg } from "gt-react";
import { m } from "~/i18n/messages";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { releaseProjectDraftUploads } from "../../lib/composerDraftUploads";
import { useComposerDraftStore } from "../../composerDraftStore";
import type {
  EnvironmentId,
  ProjectId,
  LocalApi,
  SavedWorkspaceDisposition,
} from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import type { SidebarThreadSummary } from "../../types";
import { readUnloadedThreadCount } from "../../state/olderSettledShelf";
import { projectsContainPersistentThread } from "../projectPersistence.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";

export type RemovalDependencies = {
  canOperate: (environmentId: EnvironmentId) => boolean;
  getApi: () => { dialogs: Pick<LocalApi["dialogs"], "confirm"> } | undefined;
  getThreads: () => readonly SidebarThreadSummary[];
  threadCount: number;
  removeProject: (
    member: SidebarProjectGroupMember,
    savedWorkspace?: SavedWorkspaceDisposition,
  ) => Promise<AtomCommandResult<unknown, unknown>>;
  waitForWarning: () => Promise<void>;
  confirmSavedData?: (
    member: SidebarProjectGroupMember,
    message: string,
  ) => Promise<SavedWorkspaceDisposition | null>;
};
type ConfirmRemoval = LocalApi["dialogs"]["confirm"];
function projectRemovalMessage(member: SidebarProjectGroupMember, threadCount: number) {
  const title = member.title;
  const heading =
    threadCount > 0
      ? m(
          msg(
            'Remove project "{title}" and delete its {count, plural, one {{count} thread} other {{count} threads}}?',
            { title, count: threadCount },
          ),
        )
      : m(msg('Remove project "{title}"?', { title }));
  return [
    heading,
    m(msg("Path: {path}", { path: member.workspaceRoot })),
    ...(member.environmentLabel
      ? [m(msg("Environment: {environment}", { environment: member.environmentLabel }))]
      : []),
    m(
      msg(
        "This deletes all threads in this project, including archived threads, forks, independent threads, and subagents. This cannot be undone.",
      ),
    ),
    m(msg("This removes only this project entry.")),
  ].join("\n");
}
function reportProjectRemovalError(member: SidebarProjectGroupMember, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: m(msg('Failed to remove "{title}"', { title: member.title })),
      description:
        error instanceof Error ? error.message : m(msg("Unknown error removing project.")),
    }),
  );
}
function logProjectRemovalError(member: SidebarProjectGroupMember, error: unknown) {
  console.error("Failed to remove project", {
    projectId: member.id,
    environmentId: member.environmentId,
    ...safeErrorLogAttributes(error),
  });
}
async function confirmNonemptyProjectRemoval(
  member: SidebarProjectGroupMember,
  confirm: ConfirmRemoval,
  dependencies: RemovalDependencies,
  warningToastId: ReturnType<typeof toastManager.add>,
) {
  toastManager.close(warningToastId);
  await dependencies.waitForWarning();
  if (!dependencies.canOperate(member.environmentId)) return;
  const latestThreads = dependencies
    .getThreads()
    .filter(
      (thread) => thread.environmentId === member.environmentId && thread.projectId === member.id,
    );
  const threadCount = latestThreads.length + readUnloadedThreadCount([member], latestThreads);
  const savedWorkspace = dependencies.confirmSavedData
    ? await dependencies.confirmSavedData(member, projectRemovalMessage(member, threadCount))
    : undefined;
  if (savedWorkspace === null) return;
  if (
    savedWorkspace === undefined &&
    !(await confirm(projectRemovalMessage(member, threadCount), {
      variant: "destructive",
    }))
  )
    return;
  const result = await (savedWorkspace === undefined
    ? dependencies.removeProject(member)
    : dependencies.removeProject(member, savedWorkspace));
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    reportProjectRemovalError(member, squashAtomCommandFailure(result));
  }
}
function warnNonemptyProject(
  member: SidebarProjectGroupMember,
  confirm: ConfirmRemoval,
  dependencies: RemovalDependencies,
) {
  const warningToastId = toastManager.add(
    stackedThreadToast({
      type: "warning",
      title: m(msg("Project is not empty")),
      description: m(msg("Delete all threads in this project before removing it.")),
      actionVariant: "destructive",
      actionProps: {
        children: m(msg("Delete anyway")),
        onClick: () => {
          void confirmNonemptyProjectRemoval(member, confirm, dependencies, warningToastId).catch(
            (error) => {
              logProjectRemovalError(member, error);
              reportProjectRemovalError(member, error);
            },
          );
        },
      },
    }),
  );
}
export async function requestLastCodeProjectRemoval(
  member: SidebarProjectGroupMember,
  dependencies: RemovalDependencies,
) {
  if (!dependencies.canOperate(member.environmentId)) return;
  const api = dependencies.getApi();
  if (!api) return;
  if (projectsContainPersistentThread({ members: [member], threads: dependencies.getThreads() })) {
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: m(msg("Persistent thread protected")),
        description: m(
          msg("Disable persistence or move it to another thread before removing this project."),
        ),
      }),
    );
    return;
  }
  if (dependencies.threadCount > 0) {
    warnNonemptyProject(
      member,
      (message, options) => api.dialogs.confirm(message, options),
      dependencies,
    );
    return;
  }
  const savedWorkspace = dependencies.confirmSavedData
    ? await dependencies.confirmSavedData(member, projectRemovalMessage(member, 0))
    : undefined;
  if (savedWorkspace === null) return;
  if (
    savedWorkspace === undefined &&
    !(await api.dialogs.confirm(projectRemovalMessage(member, 0), { variant: "destructive" }))
  )
    return;
  const result = await (savedWorkspace === undefined
    ? dependencies.removeProject(member)
    : dependencies.removeProject(member, savedWorkspace));
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    logProjectRemovalError(member, error);
    reportProjectRemovalError(member, error);
  }
}

export type DeleteProjectCommand = (value: {
  environmentId: EnvironmentId;
  input: { projectId: ProjectId; force: boolean; savedWorkspace?: SavedWorkspaceDisposition };
}) => Promise<AtomCommandResult<unknown, unknown>>;
export async function deleteLastCodeSidebarProject(
  member: SidebarProjectGroupMember,
  deleteProject: DeleteProjectCommand,
  sidebarThreads: readonly SidebarThreadSummary[],
  savedWorkspace?: SavedWorkspaceDisposition,
) {
  const memberProjectRef = scopeProjectRef(member.environmentId, member.id);
  const result = await deleteProject({
    environmentId: member.environmentId,
    input: {
      projectId: member.id,
      force: true,
      ...(savedWorkspace === undefined ? {} : { savedWorkspace }),
    },
  });
  if (result._tag === "Failure") {
    return result;
  }
  const draftStore = useComposerDraftStore.getState();
  releaseProjectDraftUploads(
    memberProjectRef,
    sidebarThreads
      .filter(
        (thread) => thread.environmentId === member.environmentId && thread.projectId === member.id,
      )
      .map((thread) => scopeThreadRef(thread.environmentId, thread.id)),
  );
  const projectDraftThread = draftStore.getDraftThreadByProjectRef(memberProjectRef);
  if (projectDraftThread) {
    draftStore.clearDraftThread(projectDraftThread.draftId);
  }
  draftStore.clearProjectDraftThreadId(memberProjectRef);
  return result;
}
