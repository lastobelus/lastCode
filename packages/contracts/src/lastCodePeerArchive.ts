import * as Schema from "effect/Schema";
import { EnvironmentId, ThreadId } from "./baseSchemas.ts";
import { ThreadArchivePreview, ThreadArchivePreviewThread } from "./threadArchive.ts";

export const PEER_ARCHIVE_ROUTE = "/api/lastcode/peer-archive/v1";

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
});
export type PeerArchiveInventory = typeof PeerArchiveInventory.Type;

export const PeerArchiveUnavailable = Schema.Struct({
  status: Schema.Literals(["pending", "blocked"]),
  reason: Schema.Literals(["offline", "denied", "unsupported", "unlinked", "changed"]),
});
export type PeerArchiveUnavailable = typeof PeerArchiveUnavailable.Type;

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
