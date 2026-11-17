import { describe, expect, it } from "@effect/vitest";
import type { CapacityMeasurements } from "@t3tools/contracts";

import {
  evaluateCapacity,
  GB,
  initialCapacityState,
  recordCapacitySample,
  unknownCapacitySnapshot,
} from "./logic.ts";

const activity = { runningTurns: 3, startingTurns: 2, heldTurns: 1 };
const measurement = (
  sampledAt: number,
  patch: Partial<CapacityMeasurements> = {},
): CapacityMeasurements => ({
  sampledAt,
  physicalCores: 8,
  load1: 4,
  load5: 4,
  memoryPressure: "normal",
  swapUsedBytes: 0,
  worktreesFreeBytes: 100 * GB,
  worktreeFoldersByProject: { example: 2 },
  ...patch,
});

function pair(patch: Partial<CapacityMeasurements> = {}) {
  const first = recordCapacitySample(initialCapacityState(), measurement(0, patch), activity, null);
  return recordCapacitySample(first, measurement(5_000, patch), activity, null);
}

describe("capacity verdicts", () => {
  it.each([
    [{ load1: 12 }, "agent", "load1PerCore", 1.5],
    [{ load5: 8 }, "background", "load5PerCore", 1],
    [{ memoryPressure: "warning" }, "agent", "memoryPressure", "warning"],
    [{ memoryPressure: "critical" }, "background", "memoryPressure", "critical"],
    [{ worktreesFreeBytes: 60 * GB - 1 }, "agent", "worktreesFreeBytes", 60 * GB - 1],
    [{ worktreesFreeBytes: 80 * GB - 1 }, "background", "worktreesFreeBytes", 80 * GB - 1],
  ] as const)("holds on threshold %j for %s", (patch, workClass, signal, value) => {
    const verdict = evaluateCapacity(pair(patch), 5_000, "observe").snapshot.verdicts[workClass];
    expect(verdict.state).toBe("hold");
    expect(verdict.reasons).toContainEqual(expect.objectContaining({ signal, value }));
  });

  it("keeps exact disk floors open and the load thresholds inclusive", () => {
    const agent = evaluateCapacity(
      pair({ worktreesFreeBytes: 60 * GB, load1: 11.999 }),
      5_000,
      "observe",
    );
    expect(agent.snapshot.verdicts.agent.state).toBe("open");
    const background = evaluateCapacity(
      pair({ worktreesFreeBytes: 80 * GB, load5: 7.999 }),
      5_000,
      "observe",
    );
    expect(background.snapshot.verdicts.background.state).toBe("open");
    expect(agent.snapshot.verdicts.background.state).toBe("hold");
  });

  it("uses 1-minute load for agents and 5-minute load for background, independently", () => {
    const high1 = evaluateCapacity(pair({ load1: 12 }), 5_000, "observe").snapshot;
    expect(high1.verdicts.agent.state).toBe("hold");
    expect(high1.verdicts.background.state).toBe("open");
    const high5 = evaluateCapacity(pair({ load5: 8 }), 5_000, "observe").snapshot;
    expect(high5.verdicts.agent.state).toBe("open");
    expect(high5.verdicts.background.state).toBe("hold");
  });

  it("smooths normalized load for 60 seconds and reports signed free-byte change per minute", () => {
    let state = initialCapacityState();
    for (let tick = 0; tick <= 13; tick++) {
      state = recordCapacitySample(
        state,
        measurement(tick * 5_000, {
          load1: tick === 0 ? 800 : 8,
          load5: 4,
          worktreesFreeBytes: (100 - tick / 6) * GB,
        }),
        activity,
        100,
      );
    }
    const snapshot = evaluateCapacity(state, 65_000, "observe").snapshot;
    expect(snapshot.smoothed).toEqual({
      windowMs: 60_000,
      sampleCount: 13,
      load1PerCore: 1,
      load5PerCore: 0.5,
      freeBytesChangePerMinute: -2 * GB,
    });
    expect(snapshot.verdicts.agent.state).toBe("open");
    expect(snapshot.ownerIdleSeconds).toBe(100);
    expect(snapshot.activity).toEqual(activity);
    expect(snapshot.measurements?.worktreeFoldersByProject).toEqual({ example: 2 });
  });

  it("holds only agents when disk falls faster than 2 GB per minute, and permits gains", () => {
    const first = recordCapacitySample(initialCapacityState(), measurement(0), activity, null);
    const drop = recordCapacitySample(
      first,
      measurement(5_000, { worktreesFreeBytes: 100 * GB - GB / 6 - 1 }),
      activity,
      null,
    );
    const snapshot = evaluateCapacity(drop, 5_000, "observe").snapshot;
    expect(snapshot.verdicts.agent.reasons).toContainEqual(
      expect.objectContaining({ signal: "freeBytesChangePerMinute", limit: -2 * GB }),
    );
    expect(snapshot.verdicts.background.state).toBe("open");
    const gain = recordCapacitySample(
      first,
      measurement(5_000, { worktreesFreeBytes: 101 * GB }),
      activity,
      null,
    );
    expect(evaluateCapacity(gain, 5_000, "observe").snapshot.verdicts.agent.state).toBe("open");
  });

  it.each([
    { physicalCores: null },
    { physicalCores: 0 },
    { load1: null },
    { load5: Number.NaN },
    { memoryPressure: "unknown" },
    { swapUsedBytes: null },
    { worktreesFreeBytes: null },
    { worktreeFoldersByProject: null },
  ] satisfies ReadonlyArray<Partial<CapacityMeasurements>>)(
    "never fills an unreadable current measurement from history: %j",
    (patch) => {
      const state = recordCapacitySample(pair(), measurement(10_000, patch), activity, null);
      const snapshot = evaluateCapacity(state, 10_000, "observe").snapshot;
      expect(snapshot.verdicts.agent.state).toBe("unknown");
      expect(snapshot.verdicts.background.state).toBe("unknown");
      expect(snapshot.verdicts.owner).toEqual({ state: "open", reasons: [] });
    },
  );

  it("keeps activity and owner presence out of measurement verdicts", () => {
    expect(evaluateCapacity(pair(), 5_000, "observe").snapshot.verdicts.agent.state).toBe("open");
    const state = recordCapacitySample(pair(), measurement(10_000), null, null);
    const snapshot = evaluateCapacity(state, 10_000, "observe").snapshot;
    expect(snapshot.verdicts.agent.state).toBe("open");
    expect(snapshot.verdicts.background.state).toBe("open");
    expect(snapshot.activity).toBeNull();
  });

  it("treats age greater than 30 seconds, future samples, and an absent remote sample as unknown", () => {
    expect(evaluateCapacity(pair(), 35_000, "observe").snapshot.stale).toBe(false);
    const stale = evaluateCapacity(pair(), 35_001, "observe").snapshot;
    expect(stale.stale).toBe(true);
    expect(stale.verdicts.agent.reasons).toContainEqual({
      signal: "measurement",
      comparison: "stale",
      value: 30_001,
      limit: 30_000,
    });
    expect(evaluateCapacity(pair(), 4_999, "observe").snapshot.verdicts.background.state).toBe(
      "unknown",
    );
    const remote = unknownCapacitySnapshot(123, "off");
    expect(remote).toMatchObject({
      mode: "off",
      sampledAt: null,
      readAt: 123,
      measurements: null,
      stale: true,
    });
    expect(remote.verdicts.agent.state).toBe("unknown");
    expect(remote.verdicts.background.state).toBe("unknown");
    expect(remote.verdicts.owner.state).toBe("open");
  });

  it("requires 60 continuous healthy seconds after a hold and restarts recovery on a failure", () => {
    let state = evaluateCapacity(pair({ memoryPressure: "warning" }), 5_000, "observe").state;
    for (let now = 10_000; now <= 70_000; now += 5_000) {
      const next = evaluateCapacity(
        recordCapacitySample(state, measurement(now), activity, null),
        now,
        "observe",
      );
      expect(next.snapshot.verdicts.agent.state).toBe(now === 70_000 ? "open" : "hold");
      expect(next.snapshot.verdicts.background.state).toBe(now === 70_000 ? "open" : "hold");
      state = next.state;
    }
    state = evaluateCapacity(
      recordCapacitySample(
        state,
        measurement(75_000, { memoryPressure: "unknown" }),
        activity,
        null,
      ),
      75_000,
      "observe",
    ).state;
    for (let now = 80_000; now <= 130_000; now += 5_000) {
      state = evaluateCapacity(
        recordCapacitySample(state, measurement(now), activity, null),
        now,
        "observe",
      ).state;
    }
    const failed = evaluateCapacity(
      recordCapacitySample(
        state,
        measurement(135_000, { memoryPressure: "warning" }),
        activity,
        null,
      ),
      135_000,
      "observe",
    );
    const resumed = evaluateCapacity(
      recordCapacitySample(failed.state, measurement(140_000), activity, null),
      140_000,
      "observe",
    );
    expect(resumed.snapshot.verdicts.agent.reasons).toEqual([
      { signal: "recovery", comparison: "recovering", value: 0, limit: 60_000 },
    ]);
  });

  it("does not count an unobserved gap as healthy recovery", () => {
    const held = evaluateCapacity(pair({ memoryPressure: "warning" }), 5_000, "observe").state;
    const healthy = evaluateCapacity(
      recordCapacitySample(held, measurement(10_000), activity, null),
      10_000,
      "observe",
    ).state;
    const afterGap = evaluateCapacity(
      recordCapacitySample(healthy, measurement(75_000), activity, null),
      75_000,
      "observe",
    );
    expect(afterGap.snapshot.smoothed.sampleCount).toBe(1);
    expect(afterGap.snapshot.verdicts.agent.state).toBe("unknown");
    expect(afterGap.snapshot.verdicts.background.reasons).toEqual([
      { signal: "recovery", comparison: "recovering", value: 0, limit: 60_000 },
    ]);
  });

  it("restarts the disk-rate window after a failed read without delaying recovery another minute", () => {
    let state = evaluateCapacity(pair(), 5_000, "observe").state;
    state = evaluateCapacity(
      recordCapacitySample(
        state,
        measurement(10_000, {
          worktreesFreeBytes: null,
        }),
        activity,
        null,
      ),
      10_000,
      "observe",
    ).state;
    for (let now = 15_000; now <= 80_000; now += 5_000) {
      const next = evaluateCapacity(
        recordCapacitySample(state, measurement(now), activity, null),
        now,
        "observe",
      );
      expect(next.snapshot.verdicts.agent.state).toBe(
        now === 15_000 ? "unknown" : now === 80_000 ? "open" : "hold",
      );
      state = next.state;
    }
  });
});
