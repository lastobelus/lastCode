import { msg } from "gt-react";
import { formatEnvironmentQueryError } from "../state/query";
import { CommandId } from "@t3tools/contracts";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { RegistryContext } from "@effect/atom-react";
import { useContext } from "react";
import { m } from "../i18n/messages";
import { archivePreviewSelection } from "@t3tools/client-runtime/state/thread-archive";
import type {
  EnvironmentId,
  SavedWorkspaceDisposition,
  WorkspaceLifecyclePreviewInput,
  WorkspaceLifecyclePreview,
} from "@t3tools/contracts";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { requestWorkspaceLifecycleDialog } from "../components/WorkspaceLifecycleDialog";

type Target = {
  readonly environmentId: EnvironmentId;
  readonly input: WorkspaceLifecyclePreviewInput;
};
export function groupThreadDeletionTargets(threads: readonly ScopedThreadRef[]): Target[] {
  const grouped = new Map<EnvironmentId, Set<ScopedThreadRef["threadId"]>>();
  for (const thread of threads) {
    const ids = grouped.get(thread.environmentId) ?? new Set();
    ids.add(thread.threadId);
    grouped.set(thread.environmentId, ids);
  }
  return [...grouped].map(([environmentId, ids]) => ({
    environmentId,
    input: { operation: "delete", target: { kind: "threads", threadIds: [...ids].sort() } },
  }));
}

export function useWorkspaceLifecycleConfirmation() {
  const registry = useContext(RegistryContext);
  const preview = useAtomCommand(serverEnvironment.previewWorkspaceLifecycle, {
    reportFailure: false,
  });
  const supported = (environmentId: EnvironmentId) =>
    registry.get(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities
      .worktreeSuspension === true;
  const loadSelection = async (targets: readonly Target[]) => {
    const previews: (WorkspaceLifecyclePreview | null)[] = [];
    for (const target of targets) {
      if (!supported(target.environmentId)) {
        previews.push(null);
        continue;
      }
      const result = await preview(target);
      if (result._tag !== "Success") {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: m(msg("Saved workspace review could not load")),
            description: formatEnvironmentQueryError(result.cause),
          }),
        );
        return null;
      }
      previews.push(result.value);
    }
    const unique = (field: "snapshots" | "retainedSnapshots") => [
      ...new Map(
        previews.flatMap((value, index) =>
          value
            ? value[field].map(
                (snapshot) =>
                  [
                    `${targets[index]?.environmentId}:${snapshot.checkoutId}:${snapshot.snapshotId}`,
                    snapshot,
                  ] as const,
              )
            : [],
        ),
      ).values(),
    ];
    const copies = {
      snapshots: unique("snapshots"),
      retainedSnapshots: unique("retainedSnapshots"),
    };
    if (copies.snapshots.length + copies.retainedSnapshots.length > 100) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: m(msg("Review a smaller selection")),
          description: m(
            msg("This selection contains more than 100 saved copies. Review a smaller selection."),
          ),
        }),
      );
      return null;
    }
    return { targets, previews, copies };
  };
  const confirm = async (
    targets: readonly Target[],
    options: Omit<
      Parameters<typeof requestWorkspaceLifecycleDialog>[0],
      "snapshots" | "retainedSnapshots" | "copiesIncludingTypedIn" | "canDiscard"
    >,
  ) => {
    const targetsFor = (includeTypedIn: boolean) => {
      const archiveThreadIds =
        options.archiveFamily === undefined
          ? undefined
          : archivePreviewSelection(options.archiveFamily, includeTypedIn).expectedArchiveThreadIds;
      return archiveThreadIds === undefined
        ? targets
        : targets.map((target) =>
            target.input.operation === "archive" && target.input.target.kind === "threads"
              ? {
                  ...target,
                  input: { ...target.input, target: { ...target.input.target, archiveThreadIds } },
                }
              : target,
          );
    };
    const defaultSelection = await loadSelection(targetsFor(false));
    if (defaultSelection === null) return null;
    let includingTypedIn: typeof defaultSelection | undefined;
    if ((options.archiveFamily?.archivePreview?.typedInThreadIds.length ?? 0) > 0) {
      const selection = await loadSelection(targetsFor(true));
      if (selection === null) return null;
      includingTypedIn = selection;
    }
    const choice = await requestWorkspaceLifecycleDialog({
      ...options,
      ...defaultSelection.copies,
      ...(includingTypedIn === undefined
        ? {}
        : { copiesIncludingTypedIn: includingTypedIn.copies }),
      canDiscard: targets.every((target, index) => {
        const reviewed = defaultSelection.previews[index];
        if (reviewed === null || reviewed === undefined) return true;
        return registry.get(
          target.input.operation === "delete" && target.input.target.kind === "threads"
            ? serverEnvironment.deleteThreads.permissionAtom(target.environmentId, {
                commandId: CommandId.make("delete-permission-check"),
                threads: target.input.target.threadIds.map((threadId) => ({ threadId })),
                savedWorkspace: { mode: "discard", previewToken: reviewed.token },
              })
            : serverEnvironment.discardWorktreeSnapshots.permissionAtom(target.environmentId),
        );
      }),
    });
    if (choice === null) return null;
    const selected =
      choice.includeTypedIn && includingTypedIn !== undefined ? includingTypedIn : defaultSelection;
    const dispositions = selected.previews.map((value): SavedWorkspaceDisposition =>
      choice.discard && value !== null
        ? { mode: "discard", previewToken: value.token }
        : { mode: "retain" },
    );
    return {
      childDisposition: choice.childDisposition,
      includeTypedIn: choice.includeTypedIn,
      dispositions,
      batches: selected.targets.map((target, index) => ({
        ...target,
        savedWorkspace: dispositions[index]!,
      })),
    };
  };
  return { supported, confirm };
}
