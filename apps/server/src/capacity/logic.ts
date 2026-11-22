import type {
  CapacityMeasurements,
  CapacityReason,
  CapacitySnapshot,
  CapacityVerdict,
} from "@t3tools/contracts";

export const SAMPLE_INTERVAL_MS = 5_000;
const SMOOTHING_WINDOW_MS = 60_000;
export const STALE_AFTER_MS = 30_000;
const RECOVERY_MS = 60_000;
export const GB = 1_000_000_000;

interface Recovery {
  readonly held: boolean;
  readonly healthySince: number | null;
}

export interface CapacityState {
  readonly samples: ReadonlyArray<CapacityMeasurements>;
  /** Survives a reset of the smoothing window, so a gap across it is still seen. */
  readonly lastSampledAt: number | null;
  readonly ownerIdleSeconds: number | null;
  readonly agent: Recovery;
  readonly background: Recovery;
}

export const initialCapacityState = (): CapacityState => ({
  samples: [],
  lastSampledAt: null,
  ownerIdleSeconds: null,
  agent: { held: false, healthySince: null },
  background: { held: false, healthySince: null },
});

const valid = (value: number | null): value is number =>
  value !== null && Number.isFinite(value) && value >= 0;

const restartedRecovery = (state: CapacityState) => ({
  agent: { ...state.agent, healthySince: null },
  background: { ...state.background, healthySince: null },
});
// Nothing was observed during a gap, so both classes must earn open again.
const gapRecovery = {
  agent: { held: true, healthySince: null },
  background: { held: true, healthySince: null },
};

export function recordCapacitySample(
  state: CapacityState,
  sample: CapacityMeasurements,
  ownerIdleSeconds: number | null,
): CapacityState {
  const follows = (earlier: number) =>
    sample.sampledAt - earlier <= STALE_AFTER_MS && sample.sampledAt > earlier;
  const previous = state.samples.at(-1);
  // A gap cannot count toward either a smoothing window or healthy recovery.
  const continuous = previous !== undefined && follows(previous.sampledAt);
  const gap = state.lastSampledAt !== null && !follows(state.lastSampledAt);
  return {
    ...state,
    samples: [
      ...(continuous
        ? state.samples.filter((item) => item.sampledAt >= sample.sampledAt - SMOOTHING_WINDOW_MS)
        : []),
      sample,
    ],
    lastSampledAt: sample.sampledAt,
    ownerIdleSeconds: valid(ownerIdleSeconds) ? ownerIdleSeconds : null,
    ...(gap ? gapRecovery : continuous ? {} : restartedRecovery(state)),
  };
}

function smoothedMeasurements(
  samples: ReadonlyArray<CapacityMeasurements>,
): CapacitySnapshot["smoothed"] {
  const latest = samples.at(-1);
  const first = samples[0];
  const meanLoad = (key: "load1" | "load5") => {
    // Never fill a current failed reading from older good samples.
    if (!latest || !valid(latest[key]) || !valid(latest.physicalCores) || latest.physicalCores < 1)
      return null;
    const values = samples.flatMap((sample) =>
      valid(sample[key]) && valid(sample.physicalCores) && sample.physicalCores >= 1
        ? [sample[key] / sample.physicalCores]
        : [],
    );
    return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };
  const elapsed = latest && first ? latest.sampledAt - first.sampledAt : 0;
  // A failed disk read breaks that signal's window; don't let an old null poison
  // the whole following minute or bridge the missing measurement with a rate.
  const diskSamples = samples.slice(
    samples.findLastIndex((sample) => !valid(sample.worktreesFreeBytes)) + 1,
  );
  const firstDisk = diskSamples[0];
  const diskElapsed = latest && firstDisk ? latest.sampledAt - firstDisk.sampledAt : 0;
  const rate =
    latest &&
    firstDisk &&
    valid(latest.worktreesFreeBytes) &&
    valid(firstDisk.worktreesFreeBytes) &&
    diskElapsed > 0
      ? ((latest.worktreesFreeBytes - firstDisk.worktreesFreeBytes) * 60_000) / diskElapsed
      : null;
  return {
    windowMs: elapsed,
    sampleCount: samples.length,
    load1PerCore: meanLoad("load1"),
    load5PerCore: meanLoad("load5"),
    freeBytesChangePerMinute: rate,
  };
}

function applyRecovery(
  previous: Recovery,
  reasons: ReadonlyArray<CapacityReason>,
  now: number,
): { readonly recovery: Recovery; readonly verdict: CapacityVerdict } {
  if (reasons.length > 0) {
    return {
      recovery: { held: true, healthySince: null },
      verdict: {
        // A fresh measured breach is a hold even when another signal is unreadable;
        // a stale sample's old breach is not current, so staleness is unknown.
        state:
          reasons.some((reason) => reason.comparison === "stale") ||
          reasons.every((reason) => reason.comparison === "unreadable")
            ? "unknown"
            : "hold",
        reasons,
      },
    };
  }
  if (!previous.held) return { recovery: previous, verdict: { state: "open", reasons: [] } };
  const healthySince = previous.healthySince ?? now;
  const elapsed = Math.max(0, now - healthySince);
  return elapsed >= RECOVERY_MS
    ? { recovery: { held: false, healthySince: null }, verdict: { state: "open", reasons: [] } }
    : {
        recovery: { held: true, healthySince },
        verdict: {
          state: "hold",
          reasons: [
            { signal: "recovery", comparison: "recovering", value: elapsed, limit: RECOVERY_MS },
          ],
        },
      };
}

export function evaluateCapacity(
  state: CapacityState,
  now: number,
  mode: CapacitySnapshot["mode"],
): {
  readonly state: CapacityState;
  readonly snapshot: CapacitySnapshot;
} {
  const latest = state.samples.at(-1) ?? null;
  const smooth = smoothedMeasurements(state.samples);
  const age = latest ? now - latest.sampledAt : null;
  const stale = age === null || age > STALE_AFTER_MS || age < 0;
  const common: CapacityReason[] = [];
  const unreadable = (signal: CapacityReason["signal"]) =>
    common.push({
      signal,
      comparison: "unreadable",
      value: null,
      limit: null,
    });
  if (stale)
    common.push({
      signal: "measurement",
      comparison: latest ? "stale" : "unreadable",
      value: age,
      limit: STALE_AFTER_MS,
    });
  if (latest) {
    if (
      !valid(latest.physicalCores) ||
      latest.physicalCores < 1 ||
      !valid(latest.load1) ||
      !valid(latest.load5)
    )
      unreadable("measurement");
    if (latest.memoryPressure === "unknown") unreadable("memoryPressure");
    else if (latest.memoryPressure !== "normal")
      common.push({
        signal: "memoryPressure",
        comparison: "gte",
        value: latest.memoryPressure,
        limit: "warning",
      });
    // Swap and worktree folder counts are informational: no rule reads them.
    if (!valid(latest.worktreesFreeBytes)) unreadable("worktreesFreeBytes");
  }
  const agentReasons = [...common];
  const backgroundReasons = [...common];
  if (smooth.load1PerCore !== null && smooth.load1PerCore >= 1.5)
    agentReasons.push({
      signal: "load1PerCore",
      comparison: "gte",
      value: smooth.load1PerCore,
      limit: 1.5,
    });
  if (smooth.load5PerCore !== null && smooth.load5PerCore >= 1)
    backgroundReasons.push({
      signal: "load5PerCore",
      comparison: "gte",
      value: smooth.load5PerCore,
      limit: 1,
    });
  if (latest && valid(latest.worktreesFreeBytes)) {
    if (latest.worktreesFreeBytes < 60 * GB)
      agentReasons.push({
        signal: "worktreesFreeBytes",
        comparison: "lt",
        value: latest.worktreesFreeBytes,
        limit: 60 * GB,
      });
    if (latest.worktreesFreeBytes < 80 * GB)
      backgroundReasons.push({
        signal: "worktreesFreeBytes",
        comparison: "lt",
        value: latest.worktreesFreeBytes,
        limit: 80 * GB,
      });
  }
  if (smooth.freeBytesChangePerMinute === null)
    agentReasons.push({
      signal: "freeBytesChangePerMinute",
      comparison: "unreadable",
      value: null,
      limit: null,
    });
  else if (smooth.freeBytesChangePerMinute < -2 * GB)
    agentReasons.push({
      signal: "freeBytesChangePerMinute",
      comparison: "lt",
      value: smooth.freeBytesChangePerMinute,
      limit: -2 * GB,
    });
  // Recovery advances only with new samples: a later read is no more evidence of health.
  const observedAt = latest?.sampledAt ?? now;
  const agent = applyRecovery(state.agent, agentReasons, observedAt);
  const background = applyRecovery(state.background, backgroundReasons, observedAt);
  return {
    state: { ...state, agent: agent.recovery, background: background.recovery },
    snapshot: {
      mode,
      sampledAt: latest?.sampledAt ?? null,
      readAt: now,
      stale,
      measurements: latest,
      smoothed: smooth,
      activity: null,
      ownerIdleSeconds: state.ownerIdleSeconds,
      verdicts: {
        owner: { state: "open", reasons: [] },
        agent: agent.verdict,
        background: background.verdict,
      },
    },
  };
}

export function unknownCapacitySnapshot(
  now: number,
  mode: CapacitySnapshot["mode"] = "unknown",
): CapacitySnapshot {
  return evaluateCapacity(initialCapacityState(), now, mode).snapshot;
}

// Off samples nothing and holds nothing, so both verdicts are open.
export function offCapacitySnapshot(now: number): CapacitySnapshot {
  return {
    ...unknownCapacitySnapshot(now, "off"),
    verdicts: {
      owner: { state: "open", reasons: [] },
      agent: { state: "open", reasons: [] },
      background: { state: "open", reasons: [] },
    },
  };
}
