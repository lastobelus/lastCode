import type {
  CapacityActivity,
  CapacityMeasurements,
  CapacityMode,
  CapacitySnapshot,
  HostPowerSnapshot,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";

import {
  evaluateCapacity,
  initialCapacityState,
  recordCapacitySample,
  SAMPLE_INTERVAL_MS,
  STALE_AFTER_MS,
} from "./logic.ts";
import { nativeSource, type CapacitySource } from "./source.ts";

export type { CapacitySource } from "./source.ts";

export class Capacity extends Context.Service<
  Capacity,
  {
    readonly read: Effect.Effect<CapacitySnapshot>;
  }
>()("t3/capacity/Capacity") {}

export interface CapacityInputs {
  readonly mode: Effect.Effect<CapacityMode>;
  readonly activity: Effect.Effect<CapacityActivity, Error>;
  readonly worktreesDir: string;
  readonly ownerPower: Effect.Effect<HostPowerSnapshot, Error>;
  readonly source?: CapacitySource;
}

const failedMeasurements = (sampledAt: number): CapacityMeasurements => ({
  sampledAt,
  physicalCores: null,
  load1: null,
  load5: null,
  memoryPressure: "unknown",
  swapUsedBytes: null,
  worktreesFreeBytes: null,
  worktreeFoldersByProject: null,
});

export const make = Effect.fn("capacity.make")(function* (inputs: CapacityInputs) {
  const source = inputs.source ?? (yield* nativeSource(inputs.worktreesDir));
  const state = yield* Ref.make(initialCapacityState());
  const paused = yield* Ref.make(false);
  const sample = Effect.fn("capacity.sample")(function* () {
    const mode = yield* inputs.mode;
    if (mode === "off") {
      yield* Ref.set(paused, true);
      return;
    }
    const resumed = yield* Ref.getAndSet(paused, false);
    const startedAt = yield* Clock.currentTimeMillis;
    const [measurements, activity, ownerPower] = yield* Effect.all(
      [
        source.read.pipe(
          Effect.timeout("3 seconds"),
          Effect.orElseSucceed(() => failedMeasurements(startedAt)),
        ),
        inputs.activity.pipe(
          Effect.timeout("3 seconds"),
          Effect.orElseSucceed(() => null),
        ),
        inputs.ownerPower.pipe(
          Effect.timeout("3 seconds"),
          Effect.orElseSucceed(() => null),
        ),
      ],
      { concurrency: "unbounded" },
    );
    const now = yield* Clock.currentTimeMillis;
    const powerAge = ownerPower ? now - DateTime.toEpochMillis(ownerPower.updatedAt) : null;
    const idle =
      ownerPower &&
      !ownerPower.stale &&
      powerAge !== null &&
      powerAge >= 0 &&
      powerAge <= STALE_AFTER_MS
        ? ownerPower.idleSeconds
        : null;
    const snapshot = yield* Ref.modify(state, (current) => {
      const base = resumed
        ? {
            ...current,
            samples: [],
            agent: { ...current.agent, healthySince: null },
            background: { ...current.background, healthySince: null },
          }
        : current;
      const next = evaluateCapacity(
        recordCapacitySample(base, measurements, activity, idle),
        now,
        mode,
      );
      return [next.snapshot, next.state] as const;
    });
    if (
      mode === "observe" &&
      (snapshot.verdicts.agent.state !== "open" || snapshot.verdicts.background.state !== "open")
    ) {
      yield* Effect.logInfo("capacity.would-hold", { capacity: snapshot });
    }
  });
  yield* sample();
  yield* sample().pipe(
    Effect.repeat(Schedule.fixed(SAMPLE_INTERVAL_MS)),
    Effect.delay(SAMPLE_INTERVAL_MS),
    Effect.forkScoped,
  );

  const read = Effect.gen(function* () {
    const [now, mode] = yield* Effect.all([Clock.currentTimeMillis, inputs.mode]);
    return yield* Ref.modify(state, (current) => {
      const next = evaluateCapacity(current, now, mode);
      return [next.snapshot, next.state] as const;
    });
  });
  return Capacity.of({ read });
});

export const layer = (inputs: CapacityInputs) => Layer.effect(Capacity, make(inputs));
