import type { EnvironmentId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Capacity from "../capacity/Capacity.ts";
import { unknownCapacitySnapshot } from "../capacity/logic.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { EnvironmentToolkit } from "./toolkits/environment/tools.ts";

export const capacityForTarget = Effect.fn("mcp.capacityForTarget")(function* (
  scope: McpInvocationScope,
  target: EnvironmentId | undefined,
) {
  const remote = PeerForwarding.remoteTarget(scope, target);
  if (remote === undefined) return yield* (yield* Capacity.Capacity).read;
  const forwarding = yield* PeerForwarding.PeerForwarding;
  // Publication must never turn an accepted launch into a failure, or use this host's
  // reading for a different machine. An unavailable target stays explicitly unknown.
  return yield* forwarding
    .call(scope, EnvironmentToolkit.tools.t3_environment_read, remote, { includeLinked: false })
    .pipe(
      Effect.map((result) => result.capacity),
      Effect.timeout("2 seconds"),
      Effect.catch(() =>
        Clock.currentTimeMillis.pipe(Effect.map((now) => unknownCapacitySnapshot(now))),
      ),
    );
});

export const linkedCapacity = Effect.fn("mcp.linkedCapacity")(function* (
  scope: McpInvocationScope,
) {
  const forwarding = yield* PeerForwarding.PeerForwarding;
  const listing = yield* forwarding.links(scope).pipe(Effect.timeout("4 seconds"), Effect.result);
  if (listing._tag === "Failure") return { linkedObservation: "unknown" as const, linked: [] };
  const linked = yield* Effect.forEach(
    listing.success.links,
    (link) =>
      Effect.gen(function* () {
        const capacity =
          link.status === "reachable"
            ? yield* capacityForTarget(scope, link.environmentId)
            : unknownCapacitySnapshot(yield* Clock.currentTimeMillis);
        return { environmentId: link.environmentId, label: link.label, capacity };
      }),
    { concurrency: 3 },
  );
  return { linkedObservation: "known" as const, linked };
});
