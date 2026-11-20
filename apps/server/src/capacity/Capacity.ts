import type {
  CapacityActivity,
  CapacityMeasurements,
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
  offCapacitySnapshot,
  recordCapacitySample,
  SAMPLE_INTERVAL_MS,
  STALE_AFTER_MS,
  unknownCapacitySnapshot,
} from "./logic.ts";
import { nativeSource, type CapacitySource } from "./source.ts";

export type { CapacitySource } from "./source.ts";

export class Capacity extends Context.Reference<{ readonly read: Effect.Effect<CapacitySnapshot> }>(
  "t3/capacity/Capacity",
  {
    defaultValue: () => ({
      read: Clock.currentTimeMillis.pipe(Effect.map((now) => unknownCapacitySnapshot(now))),
    }),
  },
) {}

export interface CapacityInputs {
  readonly mode: Effect.Effect<CapacitySnapshot["mode"]>;
  readonly activity: Effect.Effect<CapacityActivity, Error>;
  readonly worktreesDir: Effect.Effect<string | null, Error>;
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
  const state = yield* Ref.make(initialCapacityState());
  const sourceDirectory = yield* Ref.make<string | null>(null);
  const readMeasurements = Effect.gen(function* () {
    const directory = yield* inputs.worktreesDir;
    const previous = yield* Ref.getAndSet(sourceDirectory, directory);
    if (directory !== previous) {
      yield* Ref.update(state, (current) => ({
        ...current,
        samples: [],
        agent: { ...current.agent, healthySince: null },
        background: { ...current.background, healthySince: null },
      }));
    }
    if (directory === null) return failedMeasurements(yield* Clock.currentTimeMillis);
    const source = inputs.source ?? (yield* nativeSource(directory));
    return yield* source.read;
  });
  const paused = yield* Ref.make(false);
  const loggedVerdicts = yield* Ref.make("");
  const sample = Effect.fn("capacity.sample")(function* () {
    const mode = yield* inputs.mode;
    if (mode === "off") {
      yield* Ref.set(paused, true);
      yield* Ref.set(loggedVerdicts, "");
      return;
    }
    const resumed = yield* Ref.getAndSet(paused, false);
    const startedAt = yield* Clock.currentTimeMillis;
    const [measurements, ownerPower] = yield* Effect.all(
      [
        readMeasurements.pipe(
          Effect.timeout("3 seconds"),
          Effect.orElseSucceed(() => failedMeasurements(startedAt)),
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
      const next = evaluateCapacity(recordCapacitySample(base, measurements, idle), now, mode);
      return [next.snapshot, next.state] as const;
    });
    const { agent, background } = snapshot.verdicts;
    // Log a held verdict once per change of state or reasons, not on every sample.
    const verdicts = [agent, background]
      .map(
        ({ state, reasons }) =>
          `${state}(${reasons.map(({ signal, comparison }) => `${signal}:${comparison}`).join(",")})`,
      )
      .join(" ");
    const previous = yield* Ref.getAndSet(loggedVerdicts, verdicts);
    if (verdicts !== previous && (agent.state !== "open" || background.state !== "open")) {
      yield* Effect.logInfo("capacity.would-hold", { capacity: snapshot });
    }
  });
  yield* sample().pipe(Effect.repeat(Schedule.fixed(SAMPLE_INTERVAL_MS)), Effect.forkScoped);

  const read = Effect.gen(function* () {
    const mode = yield* inputs.mode;
    if (mode === "off") return offCapacitySnapshot(yield* Clock.currentTimeMillis);
    // Activity is informational: no rule reads it, so a failed read never gates a verdict.
    const activity = yield* inputs.activity.pipe(
      Effect.timeout("3 seconds"),
      Effect.orElseSucceed(() => null),
    );
    const now = yield* Clock.currentTimeMillis;
    return {
      ...evaluateCapacity(yield* Ref.get(state), now, mode).snapshot,
      activity,
    } satisfies CapacitySnapshot;
  });
  return Capacity.of({ read });
});

export const layer = (inputs: CapacityInputs) => Layer.effect(Capacity, make(inputs));
