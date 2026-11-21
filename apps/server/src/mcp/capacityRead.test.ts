import { expect, it } from "@effect/vitest";
import { EnvironmentId, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Capacity from "../capacity/Capacity.ts";
import { unknownCapacitySnapshot } from "../capacity/logic.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { capacityForTarget, linkedCapacity } from "./capacityRead.ts";

const localId = EnvironmentId.make("local-example");
const targetId = EnvironmentId.make("remote-example");
const scope: McpInvocationScope = {
  environmentId: localId,
  requestNamespace: "capacity-test",
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
  thread: undefined,
  client: { sessionId: "test", label: "Test", access: "full-access" },
};

it.effect(
  "returns the target's reading and fails closed without affecting an accepted launch",
  () =>
    Effect.gen(function* () {
      const local = { ...unknownCapacitySnapshot(1), mode: "off" as const };
      const remote = unknownCapacitySnapshot(2);
      const provide = (response: "available" | "unavailable" | "older") =>
        Layer.mergeAll(
          Layer.succeed(Capacity.Capacity, {
            read: Effect.succeed(local),
            readWithActivity: Effect.die("a launch reads capacity without activity"),
          }),
          Layer.mock(PeerForwarding.PeerForwarding)({
            call: (_scope, tool, target, params) => {
              expect(tool.name).toBe("t3_environment_read");
              expect(params).toEqual({ includeLinked: false });
              expect(target).toBe(targetId);
              return response === "unavailable"
                ? Effect.fail(
                    new OrchestratorMcpFailure({
                      code: "environment_unavailable",
                      message: "Unavailable",
                    }),
                  )
                : (Effect.succeed(response === "older" ? {} : { capacity: remote }) as never);
            },
          }),
        );
      expect(
        yield* capacityForTarget(scope, undefined).pipe(Effect.provide(provide("available"))),
      ).toEqual(local);
      expect(
        yield* capacityForTarget(scope, localId).pipe(Effect.provide(provide("available"))),
      ).toEqual(local);
      expect(
        yield* capacityForTarget(scope, targetId).pipe(Effect.provide(provide("available"))),
      ).toEqual(remote);
      for (const response of ["unavailable", "older"] as const) {
        const missing = yield* capacityForTarget(scope, targetId).pipe(
          Effect.provide(provide(response)),
        );
        expect(missing.mode).toBe("unknown");
        expect(missing.verdicts.owner.state).toBe("open");
        expect(missing.verdicts.agent.state).toBe("unknown");
        expect(missing.verdicts.background.state).toBe("unknown");
        expect(missing.measurements).toBeNull();
        expect(missing).not.toEqual(local);
      }
    }),
);

it.effect("keeps missing local and peer services unknown", () =>
  Effect.gen(function* () {
    for (const target of [undefined, localId, targetId]) {
      const result = yield* capacityForTarget(scope, target);
      expect(result.verdicts.owner.state).toBe("open");
      expect(result.verdicts.agent.state).toBe("unknown");
      expect(result.verdicts.background.state).toBe("unknown");
    }
    expect(yield* linkedCapacity(scope)).toEqual({ linkedObservation: "unknown", linked: [] });
  }),
);

it.effect("one read includes linked capacity and keeps unreachable machines unknown", () =>
  Effect.gen(function* () {
    const remote = unknownCapacitySnapshot(2);
    const offline = EnvironmentId.make("offline-example");
    const result = yield* linkedCapacity(scope).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(Capacity.Capacity, {
            read: Effect.die("must not substitute local capacity"),
            readWithActivity: Effect.die("must not substitute local capacity"),
          }),
          Layer.mock(PeerForwarding.PeerForwarding)({
            links: () =>
              Effect.succeed({
                environmentId: localId,
                notListed: "",
                links: [
                  {
                    environmentId: targetId,
                    label: "Remote",
                    status: "reachable",
                    access: "full-access",
                    expiresAt: "2030-01-01T00:00:00.000Z",
                    lastError: null,
                  },
                  {
                    environmentId: offline,
                    label: "Offline",
                    status: "unreachable",
                    access: "full-access",
                    expiresAt: "2030-01-01T00:00:00.000Z",
                    lastError: "Unavailable",
                  },
                ],
              }),
            call: (_scope, _tool, target, params) => {
              expect(target).toBe(targetId);
              expect(params).toEqual({ includeLinked: false });
              return Effect.succeed({ capacity: remote }) as never;
            },
          }),
        ),
      ),
    );
    expect(result.linkedObservation).toBe("known");
    expect(result.linked[0]).toEqual({
      environmentId: targetId,
      label: "Remote",
      capacity: remote,
    });
    expect(result.linked[1]?.capacity.verdicts.agent.state).toBe("unknown");
    expect(result.linked[1]?.capacity.verdicts.owner.state).toBe("open");
  }),
);
