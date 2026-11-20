import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { releaseProjectDraftUploads } from "../../lib/composerDraftUploads";
import { useComposerDraftStore } from "../../composerDraftStore";
import type { EnvironmentId, ProjectId, LocalApi } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import type { SidebarThreadSummary } from "../../types";
import { projectsContainPersistentThread } from "../projectPersistence.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";

export type RemovalDependencies = {
  canOperate: (environmentId: EnvironmentId) => boolean;
  getApi: () => { dialogs: Pick<LocalApi["dialogs"], "confirm"> } | undefined;
  getThreads: () => readonly SidebarThreadSummary[];
  threadCount: number;
  removeProject: (
    member: SidebarProjectGroupMember,
  ) => Promise<AtomCommandResult<unknown, unknown>>;
  waitForWarning: () => Promise<void>;
};
type ConfirmRemoval = LocalApi["dialogs"]["confirm"];
function projectRemovalMessage(member: SidebarProjectGroupMember, threadCount: number) {
  const heading =
    threadCount > 0
      ? `Remove project "${member.title}" and delete its ${threadCount} thread${threadCount === 1 ? "" : "s"}?`
      : `Remove project "${member.title}"?`;
  return [
    heading,
    `Path: ${member.workspaceRoot}`,
    ...(member.environmentLabel ? [`Environment: ${member.environmentLabel}`] : []),
    "This deletes all threads in this project, including archived threads, forks, independent threads, and subagents. This cannot be undone.",
    "This removes only this project entry.",
  ].join("\n");
}
function reportProjectRemovalError(member: SidebarProjectGroupMember, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: `Failed to remove "${member.title}"`,
      description: error instanceof Error ? error.message : "Unknown error removing project.",
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
  if (
    !(await confirm(projectRemovalMessage(member, latestThreads.length), {
      variant: "destructive",
    }))
  )
    return;
  const result = await dependencies.removeProject(member);
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
      title: "Project is not empty",
      description: "Delete all threads in this project before removing it.",
      actionVariant: "destructive",
      actionProps: {
        children: "Delete anyway",
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
        title: "Persistent thread protected",
        description:
          "Disable persistence or move it to another thread before removing this project.",
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
  if (!(await api.dialogs.confirm(projectRemovalMessage(member, 0), { variant: "destructive" })))
    return;
  const result = await dependencies.removeProject(member);
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    logProjectRemovalError(member, error);
    reportProjectRemovalError(member, error);
  }
}

export type DeleteProjectCommand = (value: {
  environmentId: EnvironmentId;
  input: { projectId: ProjectId; force: boolean };
}) => Promise<AtomCommandResult<unknown, unknown>>;
export async function deleteLastCodeSidebarProject(
  member: SidebarProjectGroupMember,
  deleteProject: DeleteProjectCommand,
  sidebarThreads: readonly SidebarThreadSummary[],
) {
  const memberProjectRef = scopeProjectRef(member.environmentId, member.id);
  const result = await deleteProject({
    environmentId: member.environmentId,
    input: {
      projectId: member.id,
      force: true,
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
