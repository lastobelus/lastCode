import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import {
  CheckIcon,
  FolderPlusIcon,
  MessageSquareDashedIcon,
  ScaleIcon,
  SquarePenIcon,
} from "lucide-react";
import { useMemo } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { useScratchProject } from "~/hooks/useScratchProject";
import { useClientSettings } from "~/hooks/useSettings";
import { shortcutLabelForCommand } from "~/keybindings";
import { resolveThreadActionProjectRef } from "~/lib/chatThreadActions";
import { projectIconColorClassName } from "~/projectIconColors";
import {
  buildSidebarProjectPickerEntries,
  NO_PROJECT_GROUP_KEY,
  projectGroupsSpanEnvironments,
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "~/sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { ProjectEnvironmentBadge } from "../ProjectEnvironmentBadge";
import { ProjectFavicon } from "../ProjectFavicon";
import { Kbd } from "../ui/kbd";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { useSidebar } from "../ui/sidebar";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";

export function LegacySidebarThreadPicker({
  projectGroups,
}: {
  readonly projectGroups: readonly SidebarProjectSnapshot[];
}) {
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();
  const { scratchEnvironmentId, startScratchThread } = useScratchProject();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const loadBalancingEnabled = useClientSettings((settings) => settings.loadBalancingEnabled);
  const { isMobile, setOpenMobile } = useSidebar();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const contextualProjectRef = useMemo(
    () =>
      resolveThreadActionProjectRef({
        activeDraftThread,
        activeThread: activeThread ?? undefined,
        defaultProjectRef,
        handleNewThread,
      }),
    [activeDraftThread, activeThread, defaultProjectRef, handleNewThread],
  );
  const projectPickerEntries = useMemo(
    () =>
      buildSidebarProjectPickerEntries({
        groups: projectGroups,
        preferredProjectRef: contextualProjectRef,
      }),
    [contextualProjectRef, projectGroups],
  );
  const menuEntries = projectPickerEntries.filter(
    ({ group }) => group.projectKey !== NO_PROJECT_GROUP_KEY,
  );
  const scratchTargetEnvironmentId = scratchEnvironmentId(
    activeThread?.environmentId ?? activeDraftThread?.environmentId ?? primaryEnvironmentId,
  );
  const withoutProjectShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "chat.newWithoutProject",
  );
  const showProjectEnvironments = projectGroupsSpanEnvironments(projectGroups);
  const environmentMachineById = useMemo(
    () =>
      new Map(
        environments.map(
          (environment) =>
            [
              environment.environmentId,
              resolveEnvironmentMachineKind(environment.serverConfig),
            ] as const,
        ),
      ),
    [environments],
  );

  const createThread = async (
    project: SidebarProjectGroupMember,
    environmentSelection: "auto" | "manual" = "manual",
  ) => {
    if (isMobile) setOpenMobile(false);
    const result = await settlePromise(() =>
      handleNewThread(scopeProjectRef(project.environmentId, project.id), { environmentSelection }),
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
  };

  return (
    <Menu>
      <MenuTrigger
        render={
          <SidebarHeaderIconButton label="New thread" data-testid="legacy-new-thread-trigger" />
        }
      >
        <SquarePenIcon />
      </MenuTrigger>
      <MenuPopup align="end" className="max-h-80 w-64 overflow-y-auto" aria-label="New thread in">
        <MenuGroup>
          <MenuGroupLabel>New thread in…</MenuGroupLabel>
          {scratchTargetEnvironmentId === null ? null : (
            <MenuItem
              onClick={() => {
                if (isMobile) setOpenMobile(false);
                void startScratchThread(scratchTargetEnvironmentId);
              }}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span
                  aria-hidden="true"
                  className={`inline-flex size-4 shrink-0 ${projectIconColorClassName("gray")}`}
                >
                  <MessageSquareDashedIcon className="size-full" />
                </span>
                No project
              </span>
              {withoutProjectShortcutLabel ? <Kbd>{withoutProjectShortcutLabel}</Kbd> : null}
            </MenuItem>
          )}
          {scratchTargetEnvironmentId !== null && menuEntries.length > 0 ? <MenuSeparator /> : null}
          {menuEntries.map(({ group, targetProject, isPreferred }) => {
            const projectLabel = (
              <>
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <ProjectFavicon project={group} className="size-4 shrink-0" />
                  <Tooltip>
                    <TooltipTrigger render={<span className="block min-w-0 truncate" />}>
                      {group.displayName}
                    </TooltipTrigger>
                    <TooltipPopup side="top">{group.displayName}</TooltipPopup>
                  </Tooltip>
                  {showProjectEnvironments ? (
                    <ProjectEnvironmentBadge
                      group={group}
                      primaryEnvironmentId={primaryEnvironmentId}
                      machineByEnvironmentId={environmentMachineById}
                    />
                  ) : null}
                </span>
                {isPreferred ? <CheckIcon className="size-3.5" /> : null}
              </>
            );
            if (group.memberProjects.length === 1) {
              return (
                <MenuItem key={group.projectKey} onClick={() => void createThread(targetProject)}>
                  {projectLabel}
                </MenuItem>
              );
            }
            return (
              <MenuSub key={group.projectKey}>
                <MenuSubTrigger>{projectLabel}</MenuSubTrigger>
                <MenuSubPopup aria-label={`Run ${group.displayName} on`}>
                  {loadBalancingEnabled &&
                  new Set(group.memberProjects.map((member) => member.environmentId)).size > 1 ? (
                    <>
                      <MenuItem onClick={() => void createThread(targetProject, "auto")}>
                        <ScaleIcon />
                        Auto balance
                      </MenuItem>
                      <MenuSeparator />
                    </>
                  ) : null}
                  {group.memberProjects.map((member) => (
                    <MenuItem
                      key={member.physicalProjectKey}
                      onClick={() => void createThread(member)}
                    >
                      {member.environmentLabel ?? "Remote"} — {member.workspaceRoot}
                    </MenuItem>
                  ))}
                </MenuSubPopup>
              </MenuSub>
            );
          })}
        </MenuGroup>
        {scratchTargetEnvironmentId !== null || menuEntries.length > 0 ? <MenuSeparator /> : null}
        <MenuItem onClick={() => openCommandPalette({ open: "add-project" })}>
          <FolderPlusIcon />
          Add project
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
