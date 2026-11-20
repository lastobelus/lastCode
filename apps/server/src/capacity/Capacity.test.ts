import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { CapacityMode, HostPowerSnapshot } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
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
  it.effect("reports an unknown mode when no sampler is wired", () =>
    Effect.gen(function* () {
      const capacity = yield* Capacity.Capacity;
      expect((yield* capacity.read).mode).toBe("unknown");
    }),
  );

  it.effect("samples healthy measurements without reads or activity-induced recovery", () => {
    const logs: Array<unknown> = [];
    const logger = Logger.make(({ message }) => logs.push(message));
    return Effect.gen(function* () {
      const mode = yield* Ref.make<CapacityMode>("observe");
      const activityFailure = yield* Ref.make(false);
      const activityReads = yield* Ref.make(0);
      const service = yield* Capacity.make({
        mode: Ref.get(mode),
        worktreesDir: Effect.succeed("/unused"),
        ownerPower: Effect.succeed(power),
        activity: Ref.update(activityReads, (count) => count + 1).pipe(
          Effect.andThen(Ref.get(activityFailure)),
          Effect.flatMap((fail) =>
            fail
              ? Effect.fail(new CapacityTestReadError({ message: "activity unavailable" }))
              : activity,
          ),
        ),
        source: {
          read: Effect.gen(function* () {
            return {
              sampledAt: yield* Clock.currentTimeMillis,
              physicalCores: 8,
              load1: 4,
              load5: 4,
              memoryPressure: "normal" as const,
              swapUsedBytes: 0,
              worktreesFreeBytes: 100 * GB,
              worktreeFoldersByProject: { example: 1 },
            };
          }),
        },
      });
      // The first disk-rate sample still needs its existing warm-up and recovery.
      yield* TestClock.adjust("65 seconds");
      logs.length = 0;
      yield* TestClock.adjust("10 seconds");
      expect(logs).toHaveLength(0);
      expect(yield* Ref.get(activityReads)).toBe(0);
      const firstRead = yield* service.read;
      expect(firstRead.verdicts.agent.state).toBe("open");
      expect(firstRead.verdicts.background.state).toBe("open");
      expect(firstRead.activity).toEqual(yield* activity);

      yield* Ref.set(activityFailure, true);
      const failedRead = yield* service.read;
      expect(failedRead.verdicts.agent.state).toBe("unknown");
      expect(failedRead.verdicts.background.state).toBe("unknown");
      expect(failedRead.verdicts.owner.state).toBe("open");
      expect(failedRead.verdicts.agent.reasons).toContainEqual({
        signal: "activity",
        comparison: "unreadable",
        value: null,
        limit: null,
      });
      yield* Ref.set(activityFailure, false);
      expect((yield* service.read).verdicts.agent.state).toBe("open");
      yield* Ref.set(mode, "off");
      const readsBeforeOff = yield* Ref.get(activityReads);
      yield* service.read;
      expect(yield* Ref.get(activityReads)).toBe(readsBeforeOff);
      yield* Ref.set(mode, "observe");
      const resumed = yield* service.read;
      expect(resumed.verdicts.agent.state).toBe("open");
      expect(resumed.verdicts.background.state).toBe("open");
      yield* TestClock.adjust("5 seconds");
      expect(logs).toHaveLength(0);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  });

  it.effect(
    "samples every five seconds, logs full verdicts each held sample, and skips sampling while off",
    () => {
      const logs: Array<unknown> = [];
      let firstSample: Deferred.Deferred<void>;
      const logger = Logger.make(({ message }) => {
        logs.push(message);
        Deferred.doneUnsafe(firstSample, Effect.void);
      });
      return Effect.gen(function* () {
        firstSample = yield* Deferred.make<void>();
        const mode = yield* Ref.make<string>("observe");
        const reads = yield* Ref.make(0);
        const directory = yield* Ref.make<string | null>("/unused");
        const service = yield* Capacity.make({
          mode: Ref.get(mode),
          activity,
          worktreesDir: Ref.get(directory),
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
        yield* Deferred.await(firstSample);
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
              activity: null,
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

        yield* Ref.set(mode, "enforce");
        yield* TestClock.adjust("5 seconds");
        expect(yield* Ref.get(reads)).toBe(3);
        expect(logs).toHaveLength(3);
        expect(logs[2]).toMatchObject(["capacity.would-hold", { capacity: { mode: "enforce" } }]);
        const resumed = yield* service.read;
        expect(resumed.mode).toBe("enforce");
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

        yield* Ref.set(directory, "/different-volume/worktrees");
        yield* TestClock.adjust("5 seconds");
        const retargeted = yield* service.read;
        expect(retargeted.smoothed.sampleCount).toBe(1);
        expect(retargeted.smoothed.freeBytesChangePerMinute).toBeNull();
        expect(retargeted.verdicts.agent.state).toBe("unknown");

        yield* Ref.set(directory, null);
        yield* TestClock.adjust("5 seconds");
        const unreadableDirectory = yield* service.read;
        expect(unreadableDirectory.measurements?.worktreesFreeBytes).toBeNull();
        expect(unreadableDirectory.verdicts.agent.state).toBe("unknown");
        expect(unreadableDirectory.verdicts.owner.state).toBe("open");
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
          worktreesDir: Effect.succeed("/unused"),
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
        yield* TestClock.adjust("0 seconds");
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
  it.effect("samples the selected directory and resets disk history when it changes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "capacity-directory-" });
      const first = path.join(root, "first");
      const second = path.join(root, "second");
      yield* fs.makeDirectory(path.join(first, "project-a", "worktree-one"), { recursive: true });
      yield* fs.makeDirectory(path.join(second, "project-b", "worktree-two"), { recursive: true });
      const directory = yield* Ref.make<string | null>(first);
      let sampled = yield* Deferred.make<void>();
      const logger = Logger.make(({ message }) => {
        if (Array.isArray(message) && message[0] === "capacity.would-hold")
          Deferred.doneUnsafe(sampled, Effect.void);
      });
      const service = yield* Capacity.make({
        mode: Effect.succeed("observe"),
        worktreesDir: Ref.get(directory),
        activity,
        ownerPower: Effect.succeed(power),
      }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
      yield* Deferred.await(sampled);
      expect((yield* service.read).measurements?.worktreeFoldersByProject).toEqual({
        "project-a": 1,
      });
      sampled = yield* Deferred.make<void>();
      yield* TestClock.adjust("5 seconds");
      yield* Deferred.await(sampled);
      expect((yield* service.read).smoothed.sampleCount).toBe(2);
      yield* Ref.set(directory, second);
      sampled = yield* Deferred.make<void>();
      yield* TestClock.adjust("5 seconds");
      yield* Deferred.await(sampled);
      const retargeted = yield* service.read;
      expect(retargeted.measurements?.worktreeFoldersByProject).toEqual({ "project-b": 1 });
      expect(retargeted.smoothed.sampleCount).toBe(1);
      expect(retargeted.smoothed.freeBytesChangePerMinute).toBeNull();
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, Layer.succeed(HostProcess.Platform, "linux")),
      ),
    ),
  );
  it.effect("does not wait for the first sample or read activity in the sampler", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const activityReads = yield* Ref.make(0);
      const service = yield* Capacity.make({
        mode: Effect.succeed("observe"),
        worktreesDir: Effect.succeed("/unused"),
        activity: Ref.update(activityReads, (count) => count + 1).pipe(Effect.andThen(activity)),
        ownerPower: Effect.succeed(power),
        source: { read: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)) },
      });
      yield* Deferred.await(entered);
      expect(yield* Ref.get(activityReads)).toBe(0);
      expect((yield* service.read).sampledAt).toBeNull();
      expect(yield* Ref.get(activityReads)).toBe(1);
      yield* TestClock.adjust("15 seconds");
      expect(yield* Ref.get(activityReads)).toBe(1);
      expect((yield* service.read).activity).toEqual(yield* activity);
      expect(yield* Ref.get(activityReads)).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
