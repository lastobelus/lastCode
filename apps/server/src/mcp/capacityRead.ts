import type { EnvironmentId, ReportedCapacitySnapshot } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Capacity from "../capacity/Capacity.ts";
import { unreadableCapacitySnapshot } from "../capacity/logic.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import { McpInvocationContext, type McpInvocationScope } from "./McpInvocationContext.ts";
import { EnvironmentToolkit } from "./toolkits/environment/tools.ts";

const unavailableCapacity: Effect.Effect<ReportedCapacitySnapshot> = Clock.currentTimeMillis.pipe(
  Effect.map(unreadableCapacitySnapshot),
);
// Capacity is advice: a defect while reading a peer reports unknown, never fails the result.
const unavailableOnDefect = <A>(fallback: Effect.Effect<A>) =>
  Effect.catchDefect((defect) =>
    Effect.logWarning("capacity.peer-read-failed", { defect }).pipe(Effect.andThen(fallback)),
  );

export const capacityForTarget = Effect.fn("mcp.capacityForTarget")(function* (
  scope: McpInvocationScope,
  target: EnvironmentId | undefined,
): Effect.fn.Return<ReportedCapacitySnapshot> {
  const remote = PeerForwarding.remoteTarget(scope, target);
  if (remote === undefined) return yield* (yield* Capacity.Capacity).read;
  const forwarding = yield* Effect.serviceOption(PeerForwarding.PeerForwarding);
  if (Option.isNone(forwarding)) return yield* unavailableCapacity;
  // Publication must never turn an accepted launch into a failure, or use this host's
  // reading for a different machine. An unavailable target stays explicitly unknown.
  // Suspended so a call that throws while building its effect is caught below too.
  return yield* Effect.suspend(() =>
    forwarding.value.call(scope, EnvironmentToolkit.tools.t3_environment_read, remote, {
      includeLinked: false,
    }),
  ).pipe(
    Effect.flatMap(({ capacity }) =>
      capacity === undefined ? unavailableCapacity : Effect.succeed(capacity),
    ),
    Effect.timeout("2 seconds"),
    Effect.catch(() => unavailableCapacity),
    unavailableOnDefect(unavailableCapacity),
  );
});

export const linkedCapacity = Effect.fn("mcp.linkedCapacity")(function* (
  scope: McpInvocationScope,
) {
  const forwarding = yield* Effect.serviceOption(PeerForwarding.PeerForwarding);
  if (Option.isNone(forwarding)) return { linkedObservation: "unknown" as const, linked: [] };
  const listing = yield* forwarding.value
    .links(scope)
    .pipe(Effect.timeout("4 seconds"), Effect.result);
  if (listing._tag === "Failure") return { linkedObservation: "unknown" as const, linked: [] };
  const linked = yield* Effect.forEach(
    listing.success.links,
    (link) =>
      Effect.gen(function* () {
        const capacity =
          link.status === "reachable"
            ? yield* capacityForTarget(scope, link.environmentId)
            : yield* unavailableCapacity;
        return { environmentId: link.environmentId, label: link.label, capacity };
      }),
    { concurrency: 3 },
  );
  return { linkedObservation: "known" as const, linked };
});

export const readEnvironmentCapacity = Effect.fn("mcp.readEnvironmentCapacity")(function* (
  includeLinked: boolean | undefined,
) {
  const scope = yield* McpInvocationContext;
  return {
    ...(yield* (yield* Capacity.Capacity).readWithActivity),
    // Each linked read can cost up to 2 s, so only an explicit request fans out.
    ...(includeLinked !== true
      ? { linkedObservation: "not-requested" as const, linked: [] }
      : yield* linkedCapacity(scope).pipe(
          unavailableOnDefect(
            Effect.succeed({ linkedObservation: "unknown" as const, linked: [] }),
          ),
        )),
  };
});
