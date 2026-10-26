import { formatEnvironmentQueryError } from "../state/query";
import { RegistryContext } from "@effect/atom-react";
import type { ScopedThreadRef, WorkspaceOperation } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useContext } from "react";
import {
  buildWorktreeSuspensionMenuItems,
  isWorktreeSuspensionAction,
} from "../components/worktreeSuspensionMenu";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { readLocalApi } from "../localApi";
import { readThreadShell } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import type { SidebarThreadSummary } from "../types";

function reportOperation(result: AtomCommandResult<WorkspaceOperation, unknown>) {
  if (result._tag === "Success") {
    toastManager.add(
      stackedThreadToast({
        type: "info",
        title:
          result.value.state === "queued"
            ? "Workspace request queued"
            : "Workspace request completed",
        description: `${result.value.message} Request: ${result.value.operationId}.`,
      }),
    );
  } else if (!isAtomCommandInterrupted(result)) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Workspace action could not run",
        description: formatEnvironmentQueryError(result.cause),
      }),
    );
  }
}

export function useWorktreeSuspensionActions() {
  const registry = useContext(RegistryContext);
  const previewSuspend = useAtomCommand(serverEnvironment.previewWorktreeSuspension, {
    reportFailure: false,
  });
  const suspend = useAtomCommand(serverEnvironment.suspendWorktree, { reportFailure: false });
  const restore = useAtomCommand(serverEnvironment.restoreWorktree, { reportFailure: false });
  const keep = useAtomCommand(serverEnvironment.setKeepWorkspace, { reportFailure: false });
  const createFresh = useAtomCommand(serverEnvironment.createFreshWorktree, {
    reportFailure: false,
  });
  const menuItems = (thread: SidebarThreadSummary) => [
    ...buildWorktreeSuspensionMenuItems({
      supported:
        registry.get(serverEnvironment.configValueAtom(thread.environmentId))?.environment
          .capabilities.worktreeSuspension === true,
      hasWorktree: thread.worktreePath !== null,
      summary: thread.source.worktreeSuspension,
      canSuspend: registry.get(
        serverEnvironment.suspendWorktree.permissionAtom(thread.environmentId),
      ),
      canRestore: registry.get(
        serverEnvironment.restoreWorktree.permissionAtom(thread.environmentId),
      ),
      canKeep: registry.get(
        serverEnvironment.setKeepWorkspace.permissionAtom(thread.environmentId),
      ),
      canCreateFresh: registry.get(
        serverEnvironment.createFreshWorktree.permissionAtom(thread.environmentId),
      ),
    }),
    ...(registry.get(serverEnvironment.configValueAtom(thread.environmentId))?.environment
      .capabilities.worktreeSuspension === true
      ? [
          {
            id: "archive-discard" as const,
            label: "Archive and discard saved workspace…",
            destructive: true,
            disabled:
              thread.persistent ||
              !registry.get(
                serverEnvironment.discardWorktreeSnapshots.permissionAtom(thread.environmentId),
              ),
          },
        ]
      : []),
  ];
  const run = async (action: string | null, ref: ScopedThreadRef): Promise<boolean> => {
    if (!isWorktreeSuspensionAction(action)) return false;
    if (action === "workspace-status") return true;
    const thread = readThreadShell(ref);
    const api = readLocalApi();
    if (!thread || !api || !menuItems(thread).some((item) => item.id === action && !item.disabled))
      return true;
    if (action === "workspace-suspend") {
      const preview = await previewSuspend({
        environmentId: ref.environmentId,
        input: { threadId: ref.threadId },
      });
      if (preview._tag !== "Success") {
        if (!isAtomCommandInterrupted(preview))
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Worktree cannot be suspended",
              description: formatEnvironmentQueryError(preview.cause),
            }),
          );
        return true;
      }
      if (
        await api.dialogs.confirm(
          [
            `Suspend the worktree for “${thread.title}”?`,
            preview.value.path,
            `${preview.value.ownerThreadIds.length} thread owners share this checkout.`,
            preview.value.message,
            "The conversation stays available. Continuing work restores the saved checkout.",
          ].join("\n\n"),
        )
      ) {
        reportOperation(
          await suspend({
            environmentId: ref.environmentId,
            input: { threadId: ref.threadId, previewToken: preview.value.token },
          }),
        );
      }
    } else if (action === "workspace-restore") {
      const summary = thread.source.worktreeSuspension;
      if (summary?.state === "suspended" && summary.snapshotId !== null)
        reportOperation(
          await restore({
            environmentId: ref.environmentId,
            input: { checkoutId: summary.checkoutId, snapshotId: summary.snapshotId },
          }),
        );
    } else if (action === "workspace-create-fresh") {
      if (
        await api.dialogs.confirm(
          "The saved workspace was deliberately discarded. Create a fresh checkout from the current branch? Discarded local files and notes cannot be recovered by this action.",
        )
      ) {
        reportOperation(
          await createFresh({
            environmentId: ref.environmentId,
            input: { threadId: ref.threadId },
          }),
        );
      }
    } else if (
      action === "workspace-keep" ||
      (await api.dialogs.confirm(
        "Release Keep workspace? Already-old resources may become eligible for automatic suspension or cleanup at the next pass.",
      ))
    ) {
      reportOperation(
        await keep({
          environmentId: ref.environmentId,
          input: { threadId: ref.threadId, keep: action === "workspace-keep" },
        }),
      );
    }
    return true;
  };
  return { menuItems, run };
}
