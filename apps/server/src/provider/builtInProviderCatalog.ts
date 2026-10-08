import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  OrchestrationV2ThreadCapabilities,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type { ProviderAdapterV2Error } from "../orchestration-v2/ProviderAdapter.ts";
import type * as Stream from "effect/Stream";
import type { ServerProviderShape } from "./ServerProvider.ts";

export type ProviderSnapshotSource = {
  /**
   * Routing key — uniquely identifies this instance in the aggregated
   * snapshot list. Two different snapshot sources may share the same
   * driver kind (multiple instances of the same driver).
   */
  readonly instanceId: ProviderInstanceId;
  /** Driver implementation kind. */
  readonly driverKind: ProviderDriverKind;
  readonly threadCapabilities: Effect.Effect<
    OrchestrationV2ThreadCapabilities,
    ProviderAdapterV2Error
  >;
  readonly getSnapshot: ServerProviderShape["getSnapshot"];
  readonly refresh: ServerProviderShape["refresh"];
  readonly streamChanges: Stream.Stream<ServerProvider>;
};
