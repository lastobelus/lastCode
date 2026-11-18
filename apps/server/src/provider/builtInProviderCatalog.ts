import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  OrchestrationV2ThreadCapabilities,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type { ProviderAdapterV2Error } from "@t3tools/provider-core/server/ProviderAdapter";
import type * as Stream from "effect/Stream";
import type { ManagedServerProvider } from "@t3tools/provider-core/server/snapshot";

export type ProviderSnapshotSource = {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly threadCapabilities: Effect.Effect<
    OrchestrationV2ThreadCapabilities,
    ProviderAdapterV2Error
  >;
  readonly getSnapshot: ManagedServerProvider["getSnapshot"];
  readonly refresh: ManagedServerProvider["refresh"];
  readonly streamChanges: Stream.Stream<ServerProvider>;
};
