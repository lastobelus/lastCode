import * as Schema from "effect/Schema";
import { CommandId, EnvironmentId, IsoDateTime, NonNegativeInt, ThreadId } from "./baseSchemas.ts";
import {
  ThreadArchivedWith,
  ThreadArchiveChildDisposition,
  ThreadArchivePeerGuard,
  ThreadArchivePreview,
  ThreadArchivePreviewThread,
} from "./threadArchive.ts";

export const PEER_ARCHIVE_ROUTE = "/api/lastcode/peer-archive/v1";
export const PEER_ARCHIVE_APPLY_ROUTE = "/api/lastcode/peer-archive/v1/apply";
export const PEER_ARCHIVE_RESTORE_ROUTE = "/api/lastcode/peer-archive/v1/restore";

export const PeerArchiveCohort = Schema.Struct({
  anchorThreadId: ThreadId,
  selectedThreadIds: Schema.Array(ThreadId).check(Schema.isMinLength(1)),
  typedIn: ThreadArchivePeerGuard.fields.typedIn,
  childDisposition: ThreadArchiveChildDisposition,
});
export type PeerArchiveCohort = typeof PeerArchiveCohort.Type;

export const PeerArchiveInventoryInput = Schema.Struct({
  ownerEnvironmentId: EnvironmentId,
  ownerThreadIds: Schema.Array(ThreadId).check(Schema.isMinLength(1)),
  keptOwnerThreadIds: Schema.Array(ThreadId),
});
export type PeerArchiveInventoryInput = typeof PeerArchiveInventoryInput.Type;

export const PeerArchiveInventory = Schema.Struct({
  ...ThreadArchivePreview.fields,
  threads: Schema.Array(
    Schema.Struct({
      ...ThreadArchivePreviewThread.fields,
      projectTitle: Schema.optional(Schema.String),
    }),
  ),
  activeThreadIds: Schema.Array(ThreadId),
  unreadThreadIds: Schema.Array(ThreadId),
  protectedThreadIds: Schema.Array(ThreadId),
  keptThreadIds: Schema.Array(ThreadId),
  archiveChoices: Schema.optional(
    Schema.Struct({
      defaultCohorts: Schema.Array(PeerArchiveCohort),
      includingTypedInCohorts: Schema.Array(PeerArchiveCohort),
    }),
  ),
});
export type PeerArchiveInventory = typeof PeerArchiveInventory.Type;

export const PeerArchiveUnavailable = Schema.Struct({
  status: Schema.Literals(["pending", "blocked"]),
  reason: Schema.Literals([
    "offline",
    "denied",
    "unsupported",
    "unlinked",
    "changed",
    "selection_changed",
  ]),
});
export type PeerArchiveUnavailable = typeof PeerArchiveUnavailable.Type;

export const PeerArchiveGeneration = Schema.Struct({
  ownerEnvironmentId: EnvironmentId,
  ownerThreadId: ThreadId,
  sourceArchiveCommandId: CommandId,
});
export type PeerArchiveGeneration = typeof PeerArchiveGeneration.Type;

export const PeerArchiveApplyInput = Schema.Struct({
  ...PeerArchiveGeneration.fields,
  ownerThreadIds: PeerArchiveInventoryInput.fields.ownerThreadIds,
  selectionRevision: Schema.optional(NonNegativeInt),
  cohorts: Schema.Array(PeerArchiveCohort),
}).check(
  Schema.makeFilter(
    ({ selectionRevision, cohorts }) => (selectionRevision ?? 0) > 0 || cohorts.length > 0,
  ),
);
export type PeerArchiveApplyInput = typeof PeerArchiveApplyInput.Type;

export const PeerArchiveReceipt = Schema.Struct({
  anchorThreadId: ThreadId,
  threads: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      archivedAt: IsoDateTime,
      archivedWith: ThreadArchivedWith,
    }),
  ),
});
export type PeerArchiveReceipt = typeof PeerArchiveReceipt.Type;

export const PeerArchiveApplyResult = Schema.Struct({
  receipts: Schema.Array(PeerArchiveReceipt),
  remaining: Schema.optional(PeerArchiveUnavailable),
});
export type PeerArchiveApplyResult = typeof PeerArchiveApplyResult.Type;

export const PeerArchiveRestoreResult = Schema.Struct({
  restoredThreadIds: Schema.Array(ThreadId),
  remaining: Schema.optional(PeerArchiveUnavailable),
});
export type PeerArchiveRestoreResult = typeof PeerArchiveRestoreResult.Type;

const LinkedArchiveMachine = {
  environmentId: EnvironmentId,
  label: Schema.String,
};
export const LinkedArchiveSelection = Schema.Union([
  Schema.Struct({
    ...LinkedArchiveMachine,
    status: Schema.Literal("ready"),
    cohorts: Schema.Array(PeerArchiveCohort),
  }),
  Schema.Struct({ ...LinkedArchiveMachine, ...PeerArchiveUnavailable.fields }),
]);
export type LinkedArchiveSelection = typeof LinkedArchiveSelection.Type;

export const LinkedArchiveOperation = Schema.Struct({
  sourceArchiveCommandId: CommandId,
  archivedAt: IsoDateTime,
  operation: Schema.Literals(["archive", "restore"]),
  machines: Schema.Array(
    Schema.Struct({
      ...LinkedArchiveMachine,
      status: Schema.Literals(["pending", "blocked", "review", "committed", "restored"]),
      reason: Schema.optional(PeerArchiveUnavailable.fields.reason),
      requiresReview: Schema.optional(Schema.Boolean),
    }),
  ),
});
export type LinkedArchiveOperation = typeof LinkedArchiveOperation.Type;

export const LinkedArchivePreview = Schema.Union([
  Schema.Struct({
    environmentId: EnvironmentId,
    label: Schema.String,
    status: Schema.Literal("ready"),
    inventory: PeerArchiveInventory,
  }),
  Schema.Struct({
    ...PeerArchiveUnavailable.fields,
    environmentId: EnvironmentId,
    label: Schema.String,
  }),
]);
export type LinkedArchivePreview = typeof LinkedArchivePreview.Type;
