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
  unreadableCapacitySnapshot,
} from "./logic.ts";
import { nativeSource, type CapacitySource } from "./source.ts";

export type { CapacitySource } from "./source.ts";

const unwired = Clock.currentTimeMillis.pipe(Effect.map(unreadableCapacitySnapshot));
/** Reports `unknown` without sampling: the default, and the fallback when capacity can't start. */
const unwiredCapacity = { read: unwired, readWithActivity: unwired };

export class Capacity extends Context.Reference<{
  /** The current verdicts, without activity, so a launch never waits on a thread scan. */
  readonly read: Effect.Effect<CapacitySnapshot>;
  /** The same reading with turn activity counted, for environment reads. */
  readonly readWithActivity: Effect.Effect<CapacitySnapshot>;
}>("t3/capacity/Capacity", {
  defaultValue: () => unwiredCapacity,
}) {}

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
  // Keep one native source per directory so it can reuse what never changes, such as cores.
  const native = yield* Ref.make<{
    readonly directory: string;
    readonly source: CapacitySource;
  } | null>(null);
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
    if (inputs.source) return yield* inputs.source.read;
    const cached = yield* Ref.get(native);
    if (cached?.directory === directory) return yield* cached.source.read;
    const source = yield* nativeSource(directory);
    yield* Ref.set(native, { directory, source });
    return yield* source.read;
  });
  const paused = yield* Ref.make(false);
  // Set by a defective sample and cleared by the next good one; reads report unknown meanwhile.
  const sampleFailed = yield* Ref.make(false);
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
            // Off was chosen, not a stall: resuming starts like server start.
            lastSampledAt: null,
            agent: { ...current.agent, healthySince: null },
            background: { ...current.background, healthySince: null },
          }
        : current;
      const next = evaluateCapacity(recordCapacitySample(base, measurements, idle), now, mode);
      return [next.snapshot, next.state] as const;
    });
    yield* Ref.set(sampleFailed, false);
    const { agent, background } = snapshot.verdicts;
    // Log a held verdict once per change of state or reasons, not on every sample.
    const verdicts = [agent, background]
      .map(
        ({ state, reasons }) =>
          `${state}(${reasons
            .map(
              ({ signal, comparison, value }) =>
                `${signal}:${comparison}${typeof value === "string" ? `=${value}` : ""}`,
            )
            .join(",")})`,
      )
      .join(" ");
    const previous = yield* Ref.getAndSet(loggedVerdicts, verdicts);
    if (verdicts !== previous && (agent.state !== "open" || background.state !== "open")) {
      yield* Effect.logInfo("capacity.would-hold", { capacity: snapshot });
    }
  });
  yield* sample().pipe(
    // One defective sample must not end sampling and leave every later read stale.
    Effect.catchDefect((defect) =>
      // Report the failure now, not only once the last good sample goes stale.
      Ref.set(sampleFailed, true).pipe(
        Effect.andThen(Effect.logWarning("capacity.sample-failed", { defect })),
      ),
    ),
    Effect.repeat(Schedule.fixed(SAMPLE_INTERVAL_MS)),
    Effect.forkScoped,
  );

  const readWith = Effect.fn("capacity.read")(function* (
    activityOf: Effect.Effect<CapacityActivity | null>,
  ) {
    const mode = yield* inputs.mode;
    if (mode === "off") {
      // A read can see Off between sampler ticks; the next sample must still start afresh.
      yield* Ref.set(paused, true);
      yield* Ref.set(loggedVerdicts, "");
      return offCapacitySnapshot(yield* Clock.currentTimeMillis);
    }
    const activity = yield* activityOf;
    const now = yield* Clock.currentTimeMillis;
    if (yield* Ref.get(sampleFailed)) return { ...unreadableCapacitySnapshot(now), mode, activity };
    // Until the first sample after Off, earlier readings and recovery no longer apply.
    const snapshot = (yield* Ref.get(paused))
      ? unknownCapacitySnapshot(now, mode)
      : evaluateCapacity(yield* Ref.get(state), now, mode).snapshot;
    return { ...snapshot, activity } satisfies CapacitySnapshot;
  });
  // Results carry capacity as advice: a defect here reports unknown, never fails the result.
  const guarded = (read: Effect.Effect<CapacitySnapshot>) =>
    read.pipe(
      Effect.catchDefect((defect) =>
        Effect.logWarning("capacity.read-failed", { defect }).pipe(Effect.andThen(unwired)),
      ),
    );
  return Capacity.of({
    read: guarded(readWith(Effect.succeed(null))),
    // Activity is informational: no rule reads it, so a failed read never gates a verdict.
    readWithActivity: guarded(
      readWith(
        inputs.activity.pipe(
          // Shorter than a peer's 2 s forwarded read, so a slow scan drops only activity.
          Effect.timeout("1 second"),
          Effect.orElseSucceed(() => null),
        ),
      ),
    ),
  });
});

export const layer = (inputs: CapacityInputs) => Layer.effect(Capacity, make(inputs));

/** Capacity is advisory: if it can't start, the server still starts and reports unknown. */
export const orUnwired = <A, E, R>(capacity: Layer.Layer<A, E, R>) =>
  capacity.pipe(
    Layer.catchCause((cause) =>
      Layer.effect(
        Capacity,
        Effect.logWarning("capacity.unavailable", { cause }).pipe(Effect.as(unwiredCapacity)),
      ),
    ),
  );
