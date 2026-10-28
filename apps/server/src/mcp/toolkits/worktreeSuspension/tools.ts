import {
  DiscardWorktreeSnapshotsInput,
  ListSavedWorkspacesInput,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  PreviewWorktreeDiscardInput,
  PreviewWorktreeSuspensionInput,
  RestoreWorktreeInput,
  SavedWorkspacesPage,
  SetKeepWorkspaceInput,
  SuspendWorktreeInput,
  WorkspaceOperation,
  WorktreeDiscardPreview,
  WorktreeSuspensionPreview,
  WorktreeSuspensionRequestError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { WorktreeSuspension } from "../../../workspace/WorktreeSuspension.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";

const failure = Schema.Union([
  WorktreeSuspensionRequestError,
  OrchestratorMcpFailure,
  McpCapabilityUnavailableError,
]);
const dependencies = [McpInvocationContext, WorktreeSuspension, ThreadManagementService];

export const WorktreeSuspensionToolkit = Toolkit.make(
  Tool.make("t3_worktree_saved_list", {
    description:
      "List saved workspace copies on this environment. Read-only; it does not restore a checkout. Orphan recovery items require a live full-access/default caller or full-access client. Use nextCursor to page through results.",
    parameters: ListSavedWorkspacesInput,
    success: SavedWorkspacesPage,
    failure,
    dependencies,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_worktree_suspend_preview", {
    description:
      "Preview suspension of one exact thread-owned checkout, including sharing owners. Requires a live full-access caller. Preview does not remove files; use the returned token only for the confirmed checkout.",
    parameters: PreviewWorktreeSuspensionInput,
    success: WorktreeSuspensionPreview,
    failure,
    dependencies,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_worktree_suspend", {
    description:
      "Save local work and remove the confirmed checkout after all owners and consumers are rechecked. Requires its exact preview token and a live full-access caller. Returns a queued operation; inspect saved workspaces for completion. Never suspend an active caller's own checkout.",
    parameters: SuspendWorktreeInput,
    success: WorkspaceOperation,
    failure,
    dependencies,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, true),
  Tool.make("t3_worktree_restore", {
    description:
      "Restore the current saved checkout and enable Keep workspace. Historical/orphan recovery requires an explicit project and unused managed destination. Does not install dependencies or run setup. Requires a live full-access caller.",
    parameters: RestoreWorktreeInput,
    success: WorkspaceOperation,
    failure,
    dependencies,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_worktree_discard_preview", {
    description:
      "Preview irreversible loss of exact saved workspace copies, including saved notes and uncommitted work. Does not restore or discard anything. Requires a live full-access caller. Show the summary before using the returned token for an authorized discard.",
    parameters: PreviewWorktreeDiscardInput,
    success: WorktreeDiscardPreview,
    failure,
    dependencies,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_worktree_discard_saved", {
    description:
      "Irreversibly discard only the exact saved copies in a confirmed preview. The user must authorize loss of the saved uncommitted work and notes. No restore is required. Live source, ordinary Git branches and checkpoints are not deleted. Requires a live full-access caller.",
    parameters: DiscardWorktreeSnapshotsInput,
    success: WorkspaceOperation,
    failure,
    dependencies,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, true),
  Tool.make("t3_worktree_keep", {
    description:
      "Hold or release a thread's workspace. A checkoutId can only release a retained orphan's hold after its last owner was deleted. Keep workspace blocks automatic suspension, dependencies, builds and whole-checkout cleanup; release does not restart elapsed cleanup delays. Requires a live full-access caller.",
    // MCP requires an object root; the nested contract keeps the two targets exclusive.
    parameters: Schema.Struct({ workspace: SetKeepWorkspaceInput }),
    success: WorkspaceOperation,
    failure,
    dependencies,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_worktree_create_fresh", {
    description:
      "Explicitly create a fresh checkout after a current saved copy was discarded. Discarded uncommitted work cannot be recovered. Uses surviving Git history and never silently substitutes a historical saved copy. Requires a live full-access caller.",
    parameters: PreviewWorktreeSuspensionInput,
    success: WorkspaceOperation,
    failure,
    dependencies,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false),
);
