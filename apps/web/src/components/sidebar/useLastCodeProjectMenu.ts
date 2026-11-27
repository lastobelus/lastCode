import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import {
  NO_PROJECT_GROUP_KEY,
  resolveSidebarProjectSettingsKey,
} from "../../sidebarProjectGrouping";
import type { SidebarThreadSummary } from "../../types";
import { useClientSettings } from "~/hooks/useSettings";
import { selectProjectGroupingSettings } from "../../logicalProject";
import { useRouter } from "@tanstack/react-router";
import { readLocalApi } from "../../localApi";
import { readEnvironmentScope } from "../../state/session";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { projectEnvironment } from "../../state/projects";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useSidebar } from "../ui/sidebar";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { projectsContainPersistentThread } from "../projectPersistence.logic";
import { buildLastCodeProjectMenu } from "./lastcodeProjectMenu";
import { checkTaskPermission } from "./lastcodeSidebarPermission";
import {
  deleteLastCodeSidebarProject,
  requestLastCodeProjectRemoval,
} from "./lastcodeProjectRemoval";

type OpenMember = (member: SidebarProjectGroupMember) => void;
export function useLastCodeProjectMenu(
  project: SidebarProjectSnapshot,
  openProjectRenameDialog: OpenMember,
  openProjectGroupingDialog: OpenMember,
  getThreads: () => readonly SidebarThreadSummary[],
) {
  const { isMobile, setOpenMobile } = useSidebar();
  const router = useRouter();
  const settings = useClientSettings(selectProjectGroupingSettings);
  const projectSettingsKey = resolveSidebarProjectSettingsKey({
    sidebarProjectKey: project.projectKey,
    targetProject: project,
    settings,
  });
  const isNoProjectGroup = project.projectKey === NO_PROJECT_GROUP_KEY;
  const deleteProject = useOrchestrationCommand(projectEnvironment.delete, {
    reportFailure: false,
  });
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{
    path: string;
  }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Path copied",
        description: ctx.path,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  return async (position: { x: number; y: number }) => {
    const threads = getThreads();
    const handleRemoveProject = (member: SidebarProjectGroupMember) =>
      requestLastCodeProjectRemoval(member, {
        canOperate: checkTaskPermission,
        getApi: readLocalApi,
        getThreads,
        threadCount: threads.filter(
          (thread) =>
            thread.environmentId === member.environmentId && thread.projectId === member.id,
        ).length,
        removeProject: (member) => deleteLastCodeSidebarProject(member, deleteProject, threads),
        waitForWarning: () => new Promise<void>((resolve) => window.setTimeout(resolve, 180)),
      });
    const api = readLocalApi();
    if (!api) return;

    const { items, actions } = buildLastCodeProjectMenu({
      members: project.memberProjects.map((member) => ({
        member,
        canOperate: readEnvironmentScope(member.environmentId, AuthOrchestrationOperateScope),
        removalBlocked: projectsContainPersistentThread({
          members: [member],
          threads: threads,
        }),
      })),
      groupedProjectCount: project.groupedProjectCount,
      isNoProjectGroup,
    });
    const clicked = await api.contextMenu.show(items, position);
    const actionHandlers = new Map<string, () => Promise<void> | void>([
      [
        "open-dashboard",
        () => {
          if (isMobile) setOpenMobile(false);
          void router.navigate({
            to: "/dashboard",
            search: { environmentId: project.environmentId, projectId: project.id },
          });
        },
      ],
      [
        "project-settings",
        () => {
          if (isMobile) setOpenMobile(false);
          void router.navigate({
            to: "/projects/$projectKey",
            params: { projectKey: projectSettingsKey },
          });
        },
      ],
    ]);
    const memberHandlers = {
      rename: openProjectRenameDialog,
      grouping: openProjectGroupingDialog,
      "copy-path": (member: SidebarProjectGroupMember) => {
        copyPathToClipboard(member.workspaceRoot, { path: member.workspaceRoot });
      },
      delete: handleRemoveProject,
    };
    for (const [id, target] of actions) {
      actionHandlers.set(id, () => memberHandlers[target.action](target.member));
    }
    await actionHandlers.get(clicked ?? "")?.();
  };
}
