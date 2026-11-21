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
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

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
      // A launch's read never waits on the activity scan.
      const launchRead = yield* service.read;
      expect(launchRead.activity).toBeNull();
      expect(yield* Ref.get(activityReads)).toBe(0);
      const firstRead = yield* service.readWithActivity;
      expect(firstRead.verdicts.agent.state).toBe("open");
      expect(firstRead.verdicts.background.state).toBe("open");
      expect(firstRead.activity).toEqual(yield* activity);

      // Activity is informational, so a failed read reports null without gating verdicts.
      yield* Ref.set(activityFailure, true);
      const failedRead = yield* service.readWithActivity;
      expect(failedRead.activity).toBeNull();
      expect(failedRead.verdicts.agent).toEqual({ state: "open", reasons: [] });
      expect(failedRead.verdicts.background).toEqual({ state: "open", reasons: [] });
      yield* Ref.set(activityFailure, false);
      expect((yield* service.read).verdicts.agent.state).toBe("open");
      yield* Ref.set(mode, "off");
      const readsBeforeOff = yield* Ref.get(activityReads);
      yield* service.readWithActivity;
      expect(yield* Ref.get(activityReads)).toBe(readsBeforeOff);
      // A read that saw Off makes earlier readings and recovery stale until a fresh sample.
      yield* Ref.set(mode, "observe");
      const resumed = yield* service.read;
      expect(resumed).toMatchObject({ mode: "observe", sampledAt: null, measurements: null });
      expect(resumed.verdicts.agent.state).toBe("unknown");
      yield* TestClock.adjust("5 seconds");
      expect((yield* service.read).smoothed.sampleCount).toBe(1);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  });

  it.effect(
    "samples every five seconds, logs held verdicts when they change, and skips sampling while off",
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

        // The same held verdict and reasons are not logged again.
        yield* TestClock.adjust("5 seconds");
        expect(yield* Ref.get(reads)).toBe(3);
        expect(logs).toHaveLength(2);

        yield* Ref.set(mode, "off");
        yield* TestClock.adjust("60 seconds");
        expect(yield* Ref.get(reads)).toBe(3);
        expect(logs).toHaveLength(2);
        // Off samples and holds nothing, so it reports no measurements and open verdicts.
        const off = yield* service.read;
        expect(off).toMatchObject({ mode: "off", sampledAt: null, measurements: null });
        expect(off.verdicts.agent).toEqual({ state: "open", reasons: [] });
        expect(off.verdicts.background).toEqual({ state: "open", reasons: [] });

        yield* Ref.set(mode, "enforce");
        yield* TestClock.adjust("5 seconds");
        expect(yield* Ref.get(reads)).toBe(4);
        expect(logs).toHaveLength(3);
        expect(logs[2]).toMatchObject(["capacity.would-hold", { capacity: { mode: "enforce" } }]);
        const resumed = yield* service.read;
        expect(resumed.mode).toBe("enforce");
        expect(resumed.sampledAt).toBe(75_000);
        expect(resumed.smoothed.sampleCount).toBe(1);
        expect(resumed.ownerIdleSeconds).toBeNull();

        // Even a brief Off interval breaks continuous observation and recovery.
        yield* Ref.set(mode, "off");
        yield* TestClock.adjust("5 seconds");
        yield* Ref.set(mode, "observe");
        yield* TestClock.adjust("5 seconds");
        expect(yield* Ref.get(reads)).toBe(5);
        expect((yield* service.read).smoothed.sampleCount).toBe(1);
        expect(logs).toHaveLength(4);

        yield* Ref.set(directory, "/different-volume/worktrees");
        yield* TestClock.adjust("5 seconds");
        const retargeted = yield* service.read;
        expect(retargeted.smoothed.sampleCount).toBe(1);
        expect(retargeted.smoothed.freeBytesChangePerMinute).toBeNull();
        // The missing rate is unreadable, but this source's measured breach still holds.
        expect(retargeted.verdicts.agent.state).toBe("hold");
        expect(retargeted.verdicts.agent.reasons).toContainEqual(
          expect.objectContaining({ signal: "freeBytesChangePerMinute", comparison: "unreadable" }),
        );

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
        expect(off.verdicts.agent.state).toBe("open");
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
  it.effect("keeps one native source across samples and logs each change of held reasons", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "capacity-native-" });
      const calls: Array<string> = [];
      // Each sample reports a different pressure level, so each held verdict is logged.
      const pressures = ["1", "2", "4"];
      const logged = yield* Queue.unbounded<unknown>();
      const logger = Logger.make(({ message }) => {
        if (Array.isArray(message) && message[0] === "capacity.would-hold")
          Queue.offerUnsafe(logged, message[1]);
      });
      const spawner = ChildProcessSpawner.make((command) => {
        const args = command._tag === "StandardCommand" ? command.args.map(String) : [];
        calls.push(args.join(" "));
        const live = args.includes("vm.swapusage");
        const pressure = live ? (pressures.shift() ?? "4") : "";
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.encodeText(
              Stream.make(
                live ? `${pressure}\ntotal = 4.00M  used = 1.00M  free = 3.00M\n` : "8\n",
              ),
            ),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        );
      });
      const service = yield* Capacity.make({
        mode: Effect.succeed("observe"),
        worktreesDir: Effect.succeed(directory),
        activity,
        ownerPower: Effect.succeed(power),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Layer.succeed(HostProcess.Platform, "darwin"),
            Logger.layer([logger], { mergeWithExisting: false }),
          ),
        ),
      );
      yield* Queue.take(logged);
      yield* TestClock.adjust("5 seconds");
      expect(yield* Queue.take(logged)).toMatchObject({
        capacity: { measurements: { memoryPressure: "warning" } },
      });
      yield* TestClock.adjust("5 seconds");
      expect(yield* Queue.take(logged)).toMatchObject({
        capacity: { measurements: { memoryPressure: "critical" } },
      });
      expect(calls.filter((call) => call.includes("hw.physicalcpu"))).toHaveLength(1);
      expect(calls.filter((call) => call.includes("vm.swapusage"))).toHaveLength(3);
      expect((yield* service.read).measurements).toMatchObject({
        physicalCores: 8,
        swapUsedBytes: 1024 ** 2,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("starts unwired when the capacity layer fails to build", () =>
    Effect.gen(function* () {
      const capacity = yield* Effect.flatMap(Capacity.Capacity, (service) => service.read).pipe(
        Effect.provide(Capacity.orUnwired(Layer.effect(Capacity.Capacity, Effect.die("broken")))),
      );
      expect(capacity).toMatchObject({ mode: "unknown", measurements: null });
    }),
  );

  it.effect("reports unknown instead of failing when a read defects", () =>
    Effect.gen(function* () {
      const broken = yield* Ref.make(false);
      const service = yield* Capacity.make({
        mode: Ref.get(broken).pipe(
          Effect.flatMap((isBroken) =>
            isBroken ? Effect.die("settings defect") : Effect.succeed("observe" as const),
          ),
        ),
        worktreesDir: Effect.succeed(null),
        activity,
        ownerPower: Effect.succeed(power),
      });
      yield* Ref.set(broken, true);
      expect((yield* service.read).mode).toBe("unknown");
      expect((yield* service.readWithActivity).verdicts.agent.state).toBe("unknown");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps sampling after a defective sample", () =>
    Effect.gen(function* () {
      const modeReads = yield* Ref.make(0);
      const service = yield* Capacity.make({
        mode: Ref.getAndUpdate(modeReads, (count) => count + 1).pipe(
          Effect.flatMap((count) =>
            count === 0 ? Effect.die("settings defect") : Effect.succeed("observe" as const),
          ),
        ),
        worktreesDir: Effect.succeed("/unused"),
        activity,
        ownerPower: Effect.succeed(power),
        source: {
          read: Clock.currentTimeMillis.pipe(
            Effect.map((sampledAt) => ({
              sampledAt,
              physicalCores: 8,
              load1: 1,
              load5: 1,
              memoryPressure: "normal" as const,
              swapUsedBytes: 0,
              worktreesFreeBytes: 100 * GB,
              worktreeFoldersByProject: null,
            })),
          ),
        },
      });
      yield* TestClock.adjust("5 seconds");
      expect((yield* service.read).sampledAt).toBe(5_000);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
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
      expect((yield* service.readWithActivity).sampledAt).toBeNull();
      expect(yield* Ref.get(activityReads)).toBe(1);
      yield* TestClock.adjust("15 seconds");
      expect(yield* Ref.get(activityReads)).toBe(1);
      expect((yield* service.readWithActivity).activity).toEqual(yield* activity);
      expect(yield* Ref.get(activityReads)).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
