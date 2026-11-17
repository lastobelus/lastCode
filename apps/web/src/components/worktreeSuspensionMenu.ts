import type { ContextMenuItem, WorktreeSuspensionSummary } from "@t3tools/contracts";

export type WorktreeSuspensionActionId =
  | "workspace-status"
  | "workspace-suspend"
  | "workspace-restore"
  | "workspace-keep"
  | "workspace-release"
  | "workspace-create-fresh";

export function isWorktreeSuspensionAction(
  action: string | null,
): action is WorktreeSuspensionActionId {
  return (
    action !== null &&
    [
      "workspace-status",
      "workspace-suspend",
      "workspace-restore",
      "workspace-keep",
      "workspace-release",
      "workspace-create-fresh",
    ].includes(action)
  );
}

export function workspaceStatusLabel(summary: WorktreeSuspensionSummary): string {
  switch (summary.state) {
    case "capturing":
      return "Saving workspace…";
    case "suspended":
      return "Workspace suspended";
    case "restoring":
      return "Restoring workspace…";
    case "discarding":
      return "Discarding saved workspace…";
    case "discarded":
      return "Saved workspace discarded";
    case "blocked":
      return "Workspace recovery needs attention";
    case "active":
      return summary.keepWorkspace ? "Keep workspace is on" : "Workspace active";
  }
}

export function buildWorktreeSuspensionMenuItems(input: {
  readonly supported: boolean;
  readonly hasWorktree: boolean;
  readonly summary: WorktreeSuspensionSummary | null | undefined;
  readonly canSuspend: boolean;
  readonly canRestore: boolean;
  readonly canKeep: boolean;
  readonly canCreateFresh: boolean;
}): readonly ContextMenuItem<WorktreeSuspensionActionId>[] {
  if (!input.supported || (!input.hasWorktree && input.summary == null)) return [];
  const summary = input.summary;
  const busy =
    summary != null && ["capturing", "restoring", "discarding", "blocked"].includes(summary.state);
  const items: ContextMenuItem<WorktreeSuspensionActionId>[] = [];
  if (summary)
    items.push({
      id: "workspace-status",
      label: workspaceStatusLabel(summary),
      disabled: true,
      separatorBefore: true,
    });
  if (summary?.state === "suspended") {
    items.push({
      id: "workspace-restore",
      label: "Restore worktree",
      disabled: !input.canRestore || summary.snapshotId === null,
    });
  } else if (summary?.state === "discarded") {
    items.push({
      id: "workspace-create-fresh",
      label: "Create fresh worktree",
      disabled: !input.canCreateFresh,
    });
  } else if (input.hasWorktree) {
    items.push({
      id: "workspace-suspend",
      label: "Suspend worktree…",
      disabled: busy || summary?.keepWorkspace === true || !input.canSuspend,
      separatorBefore: summary == null,
    });
  }
  if (summary?.state !== "discarded") {
    items.push({
      id: summary?.keepWorkspace ? "workspace-release" : "workspace-keep",
      label: summary?.keepWorkspace ? "Release Keep workspace…" : "Keep workspace",
      disabled: busy || summary?.state === "suspended" || !input.canKeep,
    });
  }
  return items;
}

export function mergeWorktreeSuspensionMenuItems<T extends string>(
  base: readonly ContextMenuItem<T>[],
  workspace: readonly ContextMenuItem<WorktreeSuspensionActionId | "archive-discard">[],
): ContextMenuItem<T | WorktreeSuspensionActionId | "archive-discard">[] {
  const discard = workspace.filter((item) => item.id === "archive-discard");
  const others = workspace.filter((item) => item.id !== "archive-discard");
  const archive = base.findIndex((item) => item.id === "archive");
  const deletion = base.findIndex((item) => item.id === "delete");
  const index = archive >= 0 ? archive + 1 : deletion >= 0 ? deletion : base.length;
  return [...base.slice(0, index), ...discard, ...base.slice(index), ...others];
}
