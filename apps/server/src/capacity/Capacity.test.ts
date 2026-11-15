import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { CapacityMode, HostPowerSnapshot } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as Capacity from "./Capacity.ts";
import { GB } from "./logic.ts";

class CapacityTestReadError extends Schema.TaggedError<CapacityTestReadError>()(
  "CapacityTestReadError",
  {
    message: Schema.String,
  },
) {}

const activity = Effect.succeed({ runningTurns: 1, startingTurns: 2, heldTurns: 3 });
const power: HostPowerSnapshot = {
  source: "electron-main",
  idle: "true",
  idleSeconds: 300,
  locked: "false",
  suspended: false,
  onBattery: "false",
  lowPowerMode: "false",
  thermalState: "nominal",
  stale: false,
  updatedAt: DateTime.makeUnsafe(0),
};

describe("Capacity service", () => {
  it.effect(
    "samples every five seconds, logs full verdicts each held sample, and skips sampling while off",
    () => {
      const logs: Array<unknown> = [];
      const logger = Logger.make(({ message }) => {
        logs.push(message);
      });
      return Effect.gen(function* () {
        const mode = yield* Ref.make<CapacityMode>("observe");
        const reads = yield* Ref.make(0);
        const service = yield* Capacity.make({
          mode: Ref.get(mode),
          activity,
          worktreesDir: "/unused",
          ownerPower: Effect.succeed(power),
          source: {
            read: Effect.gen(function* () {
              yield* Ref.update(reads, (count) => count + 1);
              return {
                sampledAt: yield* Clock.currentTimeMillis,
                physicalCores: 8,
                load1: 16,
                load5: 16,
                memoryPressure: "warning" as const,
                swapUsedBytes: 1024,
                worktreesFreeBytes: 100 * GB,
                worktreeFoldersByProject: { example: 4 },
              };
            }),
          },
        });
        expect(yield* Ref.get(reads)).toBe(1);
        expect((yield* service.read).ownerIdleSeconds).toBe(300);
        yield* TestClock.adjust("5 seconds");
        expect(yield* Ref.get(reads)).toBe(2);
        expect(logs).toHaveLength(2);
        expect(logs[1]).toMatchObject([
          "capacity.would-hold",
          {
            capacity: {
              sampledAt: 5_000,
              verdicts: { background: { state: "hold" } },
              activity: { runningTurns: 1 },
            },
          },
        ]);

        yield* Ref.set(mode, "off");
        yield* TestClock.adjust("60 seconds");
        expect(yield* Ref.get(reads)).toBe(2);
        expect(logs).toHaveLength(2);
        const cached = yield* service.read;
        expect(cached.mode).toBe("off");
        expect(cached.sampledAt).toBe(5_000);
        expect(cached.stale).toBe(true);
        expect(cached.verdicts.agent.state).toBe("unknown");
        expect(cached.verdicts.owner.state).toBe("open");

        yield* Ref.set(mode, "observe");
        yield* TestClock.adjust("5 seconds");
        expect(yield* Ref.get(reads)).toBe(3);
        expect(logs).toHaveLength(3);
        const resumed = yield* service.read;
        expect(resumed.sampledAt).toBe(70_000);
        expect(resumed.smoothed.sampleCount).toBe(1);
        expect(resumed.ownerIdleSeconds).toBeNull();

        // Even a brief Off interval breaks continuous observation and recovery.
        yield* Ref.set(mode, "off");
        yield* TestClock.adjust("5 seconds");
        yield* Ref.set(mode, "observe");
        yield* TestClock.adjust("5 seconds");
        expect(yield* Ref.get(reads)).toBe(4);
        expect((yield* service.read).smoothed.sampleCount).toBe(1);
        expect(logs).toHaveLength(4);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(NodeServices.layer, Logger.layer([logger], { mergeWithExisting: false })),
        ),
      );
    },
  );

  it.effect(
    "starts off without touching sources and converts unreadable measurements into unknown",
    () =>
      Effect.gen(function* () {
        const mode = yield* Ref.make<CapacityMode>("off");
        const reads = yield* Ref.make(0);
        const service = yield* Capacity.make({
          mode: Ref.get(mode),
          worktreesDir: "/unused",
          activity,
          ownerPower: Effect.fail(new CapacityTestReadError({ message: "no desktop telemetry" })),
          source: {
            read: Ref.update(reads, (count) => count + 1).pipe(
              Effect.andThen(
                Effect.fail(new CapacityTestReadError({ message: "unreadable host" })),
              ),
            ),
          },
        });
        const off = yield* service.read;
        expect(off.sampledAt).toBeNull();
        expect(off.verdicts.agent.state).toBe("unknown");
        expect(yield* Ref.get(reads)).toBe(0);
        yield* Ref.set(mode, "observe");
        yield* TestClock.adjust("5 seconds");
        const failed = yield* service.read;
        expect(yield* Ref.get(reads)).toBe(1);
        expect(failed.sampledAt).toBe(5_000);
        expect(failed.verdicts.agent.state).toBe("unknown");
        expect(failed.verdicts.background.state).toBe("unknown");
        expect(failed.verdicts.owner.state).toBe("open");
        expect(failed.ownerIdleSeconds).toBeNull();
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
