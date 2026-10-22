import { type MouseEvent } from "react";
import { SquarePenIcon } from "lucide-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useClientSetting } from "../../hooks/useSettings";
import type { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { readLocalApi } from "../../localApi";
import {
  NO_PROJECT_GROUP_KEY,
  type SidebarProjectSnapshot,
  type SidebarProjectGroupMember,
} from "../../sidebarProjectGrouping";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { formatProjectMemberActionLabel } from "./lastcodeProjectMenu";
const SIDEBAR_ICON_ACTION_BUTTON_CLASS =
  "inline-flex h-6 min-w-6 cursor-pointer items-center justify-center rounded-md px-0.75 text-icon-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";
function reportNewThreadFailure(result: AtomCommandResult<unknown, unknown>, title: string) {
  if (result._tag !== "Failure") return;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}
async function chooseProjectThreadMember(
  project: SidebarProjectSnapshot,
  canAutoBalance: boolean,
  position: { x: number; y: number },
) {
  const api = readLocalApi();
  if (!api) return null;
  const result = await settlePromise(() =>
    api.contextMenu.show(
      [
        ...(canAutoBalance ? [{ id: "auto", label: "Auto balance" }] : []),
        ...project.memberProjects.map((member) => ({
          id: member.physicalProjectKey,
          label: formatProjectMemberActionLabel(member, project.groupedProjectCount),
        })),
      ],
      position,
    ),
  );
  if (result._tag === "Failure") {
    reportNewThreadFailure(result, "Could not choose environment");
    return null;
  }
  const clicked = result.value;
  if (!clicked) return null;
  if (clicked === "auto")
    return { member: project.memberProjects[0]!, environmentSelection: "auto" as const };
  const member = project.memberProjects.find((member) => member.physicalProjectKey === clicked);
  return member ? { member, environmentSelection: "manual" as const } : null;
}
export function LastCodeProjectNewThread({
  project,
  handleNewThread,
  shortcutLabel: newThreadShortcutLabel,
}: {
  project: SidebarProjectSnapshot;
  handleNewThread: ReturnType<typeof useNewThreadHandler>;
  shortcutLabel: string | null;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  const isNoProjectGroup = project.projectKey === NO_PROJECT_GROUP_KEY;
  const loadBalancingEnabled = useClientSetting("loadBalancingEnabled");
  const canAutoBalance =
    loadBalancingEnabled &&
    !isNoProjectGroup &&
    new Set(project.memberProjects.map((member) => member.environmentId)).size > 1;
  const createThreadForProjectMember = (
    member: SidebarProjectGroupMember,
    environmentSelection: "auto" | "manual" = "manual",
  ) => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void (async () => {
      const result = await settlePromise(() =>
        handleNewThread(scopeProjectRef(member.environmentId, member.id), {
          environmentSelection,
        }),
      );
      reportNewThreadFailure(result, "Could not create thread");
    })();
  };

  const handleCreateThreadClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();

    if (project.memberProjects.length === 1) {
      createThreadForProjectMember(project.memberProjects[0]!);
      return;
    }

    void (async () => {
      const choice = await chooseProjectThreadMember(project, canAutoBalance, {
        x: event.clientX,
        y: event.clientY,
      });
      if (choice) createThreadForProjectMember(choice.member, choice.environmentSelection);
    })();
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div className="pointer-events-none absolute top-[calc(50%+1px)] right-0.5 -translate-y-1/2 opacity-0 transition-opacity duration-150 max-sm:pointer-events-auto max-sm:opacity-100 group-hover/project-header:pointer-events-auto group-hover/project-header:opacity-100 group-focus-within/project-header:pointer-events-auto group-focus-within/project-header:opacity-100">
            <button
              type="button"
              aria-label={`Create new thread in ${project.displayName}`}
              data-testid="new-thread-button"
              className={SIDEBAR_ICON_ACTION_BUTTON_CLASS}
              onClick={handleCreateThreadClick}
            >
              <SquarePenIcon className="size-3.5" />
            </button>
          </div>
        }
      />
      <TooltipPopup side="top">
        {newThreadShortcutLabel ? `New thread (${newThreadShortcutLabel})` : "New thread"}
      </TooltipPopup>
    </Tooltip>
  );
}
