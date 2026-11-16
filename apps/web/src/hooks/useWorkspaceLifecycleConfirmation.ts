import { formatEnvironmentQueryError } from "../state/query";
import { CommandId } from "@t3tools/contracts";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { RegistryContext } from "@effect/atom-react";
import { useContext } from "react";
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
  const confirm = async (
    targets: readonly Target[],
    options: Omit<
      Parameters<typeof requestWorkspaceLifecycleDialog>[0],
      "snapshots" | "retainedSnapshots" | "canDiscard"
    >,
  ) => {
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
            title: "Saved workspace review could not load",
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
    const snapshots = unique("snapshots");
    const retainedSnapshots = unique("retainedSnapshots");
    if (snapshots.length + retainedSnapshots.length > 100) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Review a smaller selection",
          description:
            "This selection contains more than 100 saved copies. Review a smaller selection.",
        }),
      );
      return null;
    }
    const choice = await requestWorkspaceLifecycleDialog({
      ...options,
      snapshots,
      retainedSnapshots,
      canDiscard: targets.every((target, index) => {
        const reviewed = previews[index];
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
    const dispositions = previews.map((value): SavedWorkspaceDisposition =>
      choice.discard && value !== null
        ? { mode: "discard", previewToken: value.token }
        : { mode: "retain" },
    );
    return {
      childDisposition: choice.childDisposition,
      dispositions,
      batches: targets.map((target, index) => ({
        ...target,
        savedWorkspace: dispositions[index]!,
      })),
    };
  };
  return { supported, confirm };
}
