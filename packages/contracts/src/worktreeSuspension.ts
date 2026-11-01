import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const WorktreeSuspensionState = Schema.Literals([
  "capturing",
  "suspended",
  "restoring",
  "active",
  "discarding",
  "discarded",
  "blocked",
]);
export type WorktreeSuspensionState = typeof WorktreeSuspensionState.Type;

export const WorktreeSuspensionSummary = Schema.Struct({
  checkoutId: TrimmedNonEmptyString,
  generation: NonNegativeInt,
  state: WorktreeSuspensionState,
  snapshotId: Schema.NullOr(TrimmedNonEmptyString),
  lastRestoredAt: Schema.NullOr(IsoDateTime),
  keepWorkspace: Schema.Boolean,
});
export type WorktreeSuspensionSummary = typeof WorktreeSuspensionSummary.Type;

export const WorktreeSuspensionOwner = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  worktreePath: TrimmedNonEmptyString,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  generation: Schema.NullOr(NonNegativeInt),
});
export type WorktreeSuspensionOwner = typeof WorktreeSuspensionOwner.Type;

/** Only the owning server supplies the exact aliases established by its filesystem checks. */
export const WorktreeSuspensionTransitionInput = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
  checkoutId: TrimmedNonEmptyString,
  aliases: Schema.Array(TrimmedNonEmptyString),
  expectedOwners: Schema.Array(WorktreeSuspensionOwner),
  expected: Schema.NullOr(WorktreeSuspensionSummary),
  next: WorktreeSuspensionSummary,
  workspace: Schema.optional(
    Schema.Struct({
      worktreePath: TrimmedNonEmptyString,
      branch: Schema.NullOr(TrimmedNonEmptyString),
    }),
  ),
});
export type WorktreeSuspensionTransitionInput = typeof WorktreeSuspensionTransitionInput.Type;
