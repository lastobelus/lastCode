import type {
  EnvironmentId,
  PeerArchiveApplyInput,
  PeerArchiveApplyResult,
  PeerArchiveGeneration,
  PeerArchiveInventory,
  PeerArchiveInventoryInput,
  PeerArchiveRestoreResult,
  PeerArchiveUnavailable,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { ClientModes, McpClientCaller } from "../mcp/McpInvocationContext.ts";

export const PEER_ARCHIVE_PREVIEW_TIMEOUT_MS = 1_000;

export class PeerArchiveHandler extends Context.Service<
  PeerArchiveHandler,
  {
    readonly inventory: (
      client: McpClientCaller,
      input: PeerArchiveInventoryInput,
    ) => Effect.Effect<PeerArchiveInventory, PeerArchiveUnavailable>;
  }
>()("t3/peer/LastCodePeerArchiveTransport/PeerArchiveHandler") {}

export class PeerArchiveMutationHandler extends Context.Service<
  PeerArchiveMutationHandler,
  {
    readonly apply: (
      client: McpClientCaller,
      input: PeerArchiveApplyInput,
    ) => Effect.Effect<PeerArchiveApplyResult, PeerArchiveUnavailable>;
    readonly restore: (
      client: McpClientCaller,
      input: PeerArchiveGeneration,
    ) => Effect.Effect<PeerArchiveRestoreResult, PeerArchiveUnavailable>;
  }
>()("t3/peer/LastCodePeerArchiveTransport/PeerArchiveMutationHandler") {}

export class LastCodePeerArchiveTransport extends Context.Service<
  LastCodePeerArchiveTransport,
  {
    readonly inventory: (
      environmentId: EnvironmentId,
      input: PeerArchiveInventoryInput,
      limits?: ClientModes,
    ) => Effect.Effect<PeerArchiveInventory, PeerArchiveUnavailable>;
  }
>()("t3/peer/LastCodePeerArchiveTransport") {}

export class PeerArchiveWriteTransport extends Context.Service<
  PeerArchiveWriteTransport,
  {
    readonly apply: (
      environmentId: EnvironmentId,
      input: PeerArchiveApplyInput,
      limits?: ClientModes,
    ) => Effect.Effect<PeerArchiveApplyResult, PeerArchiveUnavailable>;
    readonly restore: (
      environmentId: EnvironmentId,
      input: PeerArchiveGeneration,
      limits?: ClientModes,
    ) => Effect.Effect<PeerArchiveRestoreResult, PeerArchiveUnavailable>;
  }
>()("t3/peer/LastCodePeerArchiveTransport/PeerArchiveWriteTransport") {}
