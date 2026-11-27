import type { NodeId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";

export interface DelegatedTaskCancellationEdge {
  readonly parentThreadId: ThreadId;
  readonly taskId: NodeId;
  readonly childThreadId: ThreadId;
}

/** Ownership edges that every stop in a delegated cancellation must still own. */
export const DelegatedTaskCancellation = Context.Reference<
  ReadonlyArray<DelegatedTaskCancellationEdge>
>("t3/orchestration-v2/DelegatedTaskCancellation", { defaultValue: () => [] });
