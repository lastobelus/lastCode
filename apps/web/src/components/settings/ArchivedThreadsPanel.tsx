import { settingsScopeEnvironmentLabels } from "./settingsScopeAxis";
import { Spinner } from "~/components/ui/spinner";
import { ArchiveIcon, ArchiveX, Trash2Icon } from "lucide-react";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useSettingsScope } from "./SettingsScopeContext";
import { useThreadActions } from "../../hooks/useThreadActions";
import { readLocalApi } from "../../localApi";
import { derivePhysicalProjectKey } from "@t3tools/client-runtime/state/project-grouping";
import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import {
  createArchivedThreadRestoreTarget,
  groupArchivedThreadFamilies,
} from "./archiveFamilyOrder";
import { RelativeTime } from "../RelativeTime";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { ProjectFavicon } from "../ProjectFavicon";

import { useRef, useState } from "react";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";

const ARCHIVE_ACTIONS = [
  { action: "unarchive", label: "Unarchive", Icon: ArchiveX },
  { action: "delete", label: "Delete", Icon: Trash2Icon },
] as const;
type ArchiveAction = (typeof ARCHIVE_ACTIONS)[number]["action"];

export function ArchivedThreadsPanel() {
  const { scope, groups: projectGroups, environments, isReady: isScopeReady } = useSettingsScope();
  // Archive reads need a connection, not the server config required by settings writes.
  const environmentIds = environments
    .filter((environment) => environment.connection.phase === "connected")
    .map((environment) => environment.environmentId);
  const { unarchiveThread, confirmAndDeleteThread } = useThreadActions();
  const pendingActionsRef = useRef(new Set<string>());
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const {
    snapshots: archivedSnapshots,
    error: archiveError,
    isLoading: isLoadingSnapshots,
    refresh: refreshArchivedThreads,
  } = useArchivedThreadSnapshots(environmentIds);
  const isLoadingArchive = !isScopeReady || isLoadingSnapshots;
  const restoreThreadId = createArchivedThreadRestoreTarget(archivedSnapshots);

  const { groups: archivedGroups, hasMultipleEnvironments } = (() => {
    const selectedProjectKeys =
      scope.kind === "project" || scope.kind === "checkout"
        ? new Set(scope.members.map((member) => member.physicalProjectKey))
        : null;
    const projectsByEnvironmentAndId = new Map(
      archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
        snapshot.projects
          .filter(
            (project) =>
              selectedProjectKeys === null ||
              selectedProjectKeys.has(derivePhysicalProjectKey({ ...project, environmentId })),
          )
          .map(
            (project) => [`${environmentId}:${project.id}`, { ...project, environmentId }] as const,
          ),
      ),
    );
    const environmentLabels = new Map(
      environments.map((environment) => {
        const { primary, secondary } = settingsScopeEnvironmentLabels(environment, environments);
        return [environment.environmentId, secondary ? `${primary} (${secondary})` : primary];
      }),
    );
    const threads = archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
      snapshot.threads.map((thread) => ({
        ...presentThreadShell(environmentId, thread),
        environmentLabel: environmentLabels.get(environmentId) ?? environmentId,
      })),
    );
    const hasMultipleEnvironments =
      new Set(
        threads
          .filter((thread) =>
            projectsByEnvironmentAndId.has(`${thread.environmentId}:${thread.projectId}`),
          )
          .map((thread) => thread.environmentId),
      ).size > 1;
    const logicalGroupsByProjectKey = new Map(
      projectGroups.flatMap((group) =>
        group.memberProjectRefs.map(
          (member) => [`${member.environmentId}:${member.projectId}`, group] as const,
        ),
      ),
    );

    const threadsByProject = new Map<string, Array<(typeof threads)[number]>>();
    for (const thread of threads) {
      const key = `${thread.environmentId}:${thread.projectId}`;
      const projectThreads = threadsByProject.get(key);
      if (projectThreads) projectThreads.push(thread);
      else threadsByProject.set(key, [thread]);
    }

    const archivedProjects = Array.from(projectsByEnvironmentAndId.values());
    const groups = new Map<
      string,
      {
        readonly project: (typeof archivedProjects)[number];
        readonly title: string;
        readonly threads: Array<(typeof threads)[number]>;
      }
    >();
    for (const project of archivedProjects) {
      const projectThreads = threadsByProject.get(`${project.environmentId}:${project.id}`);
      if (projectThreads && projectThreads.length > 0) {
        const physicalProjectKey = `${project.environmentId}:${project.id}` as const;
        const logicalGroup = hasMultipleEnvironments
          ? logicalGroupsByProjectKey.get(physicalProjectKey)
          : undefined;
        const groupKey = logicalGroup?.projectKey ?? physicalProjectKey;
        const group = groups.get(groupKey);
        if (group) {
          group.threads.push(...projectThreads);
        } else {
          groups.set(groupKey, {
            project,
            title: logicalGroup?.displayName ?? project.title,
            threads: projectThreads,
          });
        }
      }
    }
    const sortedGroups = Array.from(groups, ([key, group]) => ({
      ...group,
      key,
      threads: groupArchivedThreadFamilies(
        group.threads.toSorted((left, right) => {
          const leftKey = left.archivedAt ?? left.createdAt;
          const rightKey = right.archivedAt ?? right.createdAt;
          return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
        }),
      ),
    }));
    return { groups: sortedGroups, hasMultipleEnvironments };
  })();

  type ArchivedThread = (typeof archivedGroups)[number]["threads"][number];

  const reportFailure = (result: AtomCommandResult<unknown, unknown> | null, title: string) => {
    if (result?._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  };

  const handleThreadAction = async (action: ArchiveAction, thread: ArchivedThread) => {
    const target = scopeThreadRef(
      thread.environmentId,
      action === "unarchive" ? restoreThreadId(thread) : thread.id,
    );
    const key = scopedThreadKey(target);
    // Context menus can outlive their render, so checks and cleanup use the live set.
    const pending = pendingActionsRef.current;
    if (
      pending.has(key) ||
      pending.has(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))) ||
      pending.has(scopedThreadKey(scopeThreadRef(thread.environmentId, restoreThreadId(thread))))
    )
      return;
    pending.add(key);
    setPendingKeys(new Set(pending));
    const result = await settlePromise(async () => {
      const result = await (action === "unarchive"
        ? unarchiveThread(target)
        : confirmAndDeleteThread(target, {
            archivedThreads: archivedSnapshots
              .filter((entry) => entry.environmentId === thread.environmentId)
              .flatMap(({ environmentId, snapshot }) =>
                snapshot.threads.map((archivedThread) =>
                  presentThreadShell(environmentId, archivedThread),
                ),
              ),
          }));
      if (result._tag === "Success") refreshArchivedThreads();
      return result;
    }).finally(() => {
      pending.delete(key);
      setPendingKeys(new Set(pending));
    });
    reportFailure(result._tag === "Failure" ? result : result.value, `Failed to ${action} thread`);
  };

  const handleContextMenu = async (thread: ArchivedThread, position: { x: number; y: number }) => {
    const pending = pendingActionsRef.current;
    if (
      pending.has(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))) ||
      pending.has(scopedThreadKey(scopeThreadRef(thread.environmentId, restoreThreadId(thread))))
    )
      return;
    const result = await settlePromise(async () => {
      const clicked = await readLocalApi()?.contextMenu.show(
        ARCHIVE_ACTIONS.map(({ action, label }) => ({
          id: action,
          label:
            action === "unarchive" && restoreThreadId(thread) !== thread.id
              ? "Restore family"
              : label,
          destructive: action === "delete",
        })),
        position,
      );
      if (clicked === "unarchive" || clicked === "delete")
        await handleThreadAction(clicked, thread);
    });
    reportFailure(result, "Archived thread action failed");
  };

  return (
    <SettingsPageContainer>
      {archivedGroups.length === 0 ? (
        <SettingsSection
          id={isLoadingArchive ? undefined : searchableSetting("archive").id}
          title={searchableSetting("archive").title}
        >
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-2">
                {isLoadingArchive ? (
                  <Spinner size="sm" tone="muted" />
                ) : (
                  <ArchiveIcon className="size-3.5 text-muted-foreground" />
                )}
                {isLoadingArchive
                  ? "Loading archived threads"
                  : archiveError
                    ? "Could not load archived threads"
                    : environmentIds.length === 0
                      ? "No connected environments"
                      : "No archived threads"}
              </span>
            }
            description={
              isLoadingArchive
                ? "Checking connected environments."
                : (archiveError ??
                  (environmentIds.length === 0
                    ? "Connect an environment in this scope to view archived threads."
                    : "Archived threads will appear here."))
            }
          />
        </SettingsSection>
      ) : (
        archivedGroups.map(({ key, project, title, threads: projectThreads }, index) => (
          <SettingsSection
            key={key}
            id={index === 0 ? searchableSetting("archive").id : undefined}
            title={title}
            icon={<ProjectFavicon project={project} />}
          >
            {projectThreads.map((thread) => {
              const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
              const restoreKey = scopedThreadKey(
                scopeThreadRef(thread.environmentId, restoreThreadId(thread)),
              );
              return (
                <div
                  key={`${thread.environmentId}:${thread.id}`}
                  className={restoreThreadId(thread) !== thread.id ? "pl-4" : undefined}
                >
                  <SettingsRow
                    onContextMenu={(event) => {
                      event.preventDefault();
                      void handleContextMenu(thread, { x: event.clientX, y: event.clientY });
                    }}
                    title={thread.title}
                    description={
                      <span className={hasMultipleEnvironments ? "block truncate" : undefined}>
                        {hasMultipleEnvironments ? `${thread.environmentLabel} · ` : null}
                        Archived <RelativeTime timestamp={thread.archivedAt ?? thread.createdAt} />
                        {" \u00b7 Created "}
                        <RelativeTime timestamp={thread.createdAt} />
                        {restoreThreadId(thread) !== thread.id ? " · Archived with family" : null}
                      </span>
                    }
                    control={
                      <div className="flex shrink-0 items-center gap-2">
                        {ARCHIVE_ACTIONS.map(({ action, label, Icon }) => (
                          <Tooltip key={action}>
                            <TooltipTrigger
                              render={
                                <Button
                                  type="button"
                                  variant={action === "delete" ? "destructive-outline" : "outline"}
                                  size="icon-sm"
                                  aria-label={`${label} ${thread.title}`}
                                  disabled={
                                    pendingKeys.has(threadKey) || pendingKeys.has(restoreKey)
                                  }
                                  onClick={() => void handleThreadAction(action, thread)}
                                />
                              }
                            >
                              <Icon className="size-3.5" />
                            </TooltipTrigger>
                            <TooltipPopup>{label}</TooltipPopup>
                          </Tooltip>
                        ))}
                      </div>
                    }
                  />
                </div>
              );
            })}
          </SettingsSection>
        ))
      )}
    </SettingsPageContainer>
  );
}
