import type {
  CapacityActivity,
  CapacityMeasurements,
  CapacityMode,
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
  readonly activity: CapacityActivity | null;
  readonly ownerIdleSeconds: number | null;
  readonly agent: Recovery;
  readonly background: Recovery;
}

export const initialCapacityState = (): CapacityState => ({
  samples: [],
  activity: null,
  ownerIdleSeconds: null,
  agent: { held: false, healthySince: null },
  background: { held: false, healthySince: null },
});

const valid = (value: number | null): value is number =>
  value !== null && Number.isFinite(value) && value >= 0;

export function recordCapacitySample(
  state: CapacityState,
  sample: CapacityMeasurements,
  activity: CapacityActivity | null,
  ownerIdleSeconds: number | null,
): CapacityState {
  const previous = state.samples.at(-1);
  // A gap cannot count toward either a smoothing window or healthy recovery.
  const continuous =
    previous !== undefined &&
    sample.sampledAt - previous.sampledAt <= STALE_AFTER_MS &&
    sample.sampledAt > previous.sampledAt;
  return {
    ...state,
    samples: [
      ...(continuous
        ? state.samples.filter((item) => item.sampledAt >= sample.sampledAt - SMOOTHING_WINDOW_MS)
        : []),
      sample,
    ],
    activity,
    ownerIdleSeconds: valid(ownerIdleSeconds) ? ownerIdleSeconds : null,
    agent: continuous ? state.agent : { ...state.agent, healthySince: null },
    background: continuous ? state.background : { ...state.background, healthySince: null },
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
        state: reasons.some(
          (reason) => reason.comparison === "unreadable" || reason.comparison === "stale",
        )
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
    if (!valid(latest.swapUsedBytes)) unreadable("swapUsedBytes");
    if (!valid(latest.worktreesFreeBytes)) unreadable("worktreesFreeBytes");
    if (latest.worktreeFoldersByProject === null) unreadable("worktreeFoldersByProject");
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
  const agent = applyRecovery(state.agent, agentReasons, now);
  const background = applyRecovery(state.background, backgroundReasons, now);
  return {
    state: { ...state, agent: agent.recovery, background: background.recovery },
    snapshot: {
      mode,
      sampledAt: latest?.sampledAt ?? null,
      readAt: now,
      stale,
      measurements: latest,
      smoothed: smooth,
      activity: state.activity,
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
  mode: CapacityMode = "observe",
): CapacitySnapshot {
  return evaluateCapacity(initialCapacityState(), now, mode).snapshot;
}
