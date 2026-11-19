import { EnvironmentId } from "./baseSchemas.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const CapacityMode = Schema.Literals(["off", "observe"]).annotate({
  description:
    "Capacity checks. `off`: none. `observe`: sample and report verdicts without holding work.",
});
export type CapacityMode = typeof CapacityMode.Type;

export const CapacityMemoryPressure = Schema.Literals(["normal", "warning", "critical", "unknown"]);
export type CapacityMemoryPressure = typeof CapacityMemoryPressure.Type;

export const CapacityActivity = Schema.Struct({
  runningTurns: Schema.Number,
  startingTurns: Schema.Number,
  heldTurns: Schema.Number,
});
export type CapacityActivity = typeof CapacityActivity.Type;

export const CapacityMeasurements = Schema.Struct({
  sampledAt: Schema.Number,
  physicalCores: Schema.NullOr(Schema.Number),
  load1: Schema.NullOr(Schema.Number),
  load5: Schema.NullOr(Schema.Number),
  memoryPressure: CapacityMemoryPressure,
  swapUsedBytes: Schema.NullOr(Schema.Number),
  worktreesFreeBytes: Schema.NullOr(Schema.Number),
  worktreeFoldersByProject: Schema.NullOr(Schema.Record(Schema.String, Schema.Number)),
});
export type CapacityMeasurements = typeof CapacityMeasurements.Type;

export const CapacityReason = Schema.Struct({
  signal: Schema.Literals([
    "measurement",
    "load1PerCore",
    "load5PerCore",
    "memoryPressure",
    "swapUsedBytes",
    "worktreesFreeBytes",
    "freeBytesChangePerMinute",
    "activity",
    "worktreeFoldersByProject",
    "recovery",
  ]),
  comparison: Schema.Literals(["gte", "lt", "unreadable", "stale", "recovering"]),
  value: Schema.NullOr(Schema.Union([Schema.Number, Schema.String])),
  limit: Schema.NullOr(Schema.Union([Schema.Number, Schema.String])),
});
export type CapacityReason = typeof CapacityReason.Type;

export const CapacityVerdict = Schema.Struct({
  state: Schema.Literals(["open", "hold", "unknown"]),
  reasons: Schema.Array(CapacityReason),
});
export type CapacityVerdict = typeof CapacityVerdict.Type;

// Observation results can carry values introduced by a newer server.
const ReportedCapacityMeasurements = CapacityMeasurements.mapFields((fields) => ({
  ...fields,
  memoryPressure: Schema.String,
}));
const ReportedCapacityReason = CapacityReason.mapFields((fields) => ({
  ...fields,
  signal: Schema.String,
  comparison: Schema.String,
}));
const ReportedCapacityVerdict = CapacityVerdict.mapFields((fields) => ({
  ...fields,
  state: Schema.String,
  reasons: Schema.Array(ReportedCapacityReason),
}));

export const CapacitySnapshot = Schema.Struct({
  mode: Schema.String,
  sampledAt: Schema.NullOr(Schema.Number),
  readAt: Schema.Number,
  stale: Schema.Boolean,
  measurements: Schema.NullOr(ReportedCapacityMeasurements),
  smoothed: Schema.Struct({
    windowMs: Schema.Number,
    sampleCount: Schema.Number,
    load1PerCore: Schema.NullOr(Schema.Number),
    load5PerCore: Schema.NullOr(Schema.Number),
    freeBytesChangePerMinute: Schema.NullOr(Schema.Number),
  }),
  activity: Schema.NullOr(CapacityActivity),
  ownerIdleSeconds: Schema.NullOr(Schema.Number),
  verdicts: Schema.Struct({
    owner: ReportedCapacityVerdict,
    agent: ReportedCapacityVerdict,
    background: ReportedCapacityVerdict,
  }),
});
export type CapacitySnapshot = typeof CapacitySnapshot.Type;

export const EnvironmentCapacitySnapshot = Schema.Struct({
  ...CapacitySnapshot.fields,
  linkedObservation: Schema.Literals(["known", "unknown", "not-requested"]),
  linked: Schema.Array(
    Schema.Struct({
      environmentId: EnvironmentId,
      label: Schema.String,
      capacity: CapacitySnapshot,
    }),
  ),
});
export type EnvironmentCapacitySnapshot = typeof EnvironmentCapacitySnapshot.Type;

function optionalObservation<S extends Schema.Constraint>(schema: S) {
  const optional = Schema.optionalKey(schema);
  return Schema.catchDecoding<typeof optional>(() => Effect.succeedNone)(optional);
}

export const OptionalCapacitySnapshot = optionalObservation(CapacitySnapshot);
export const OptionalEnvironmentCapacitySnapshot = optionalObservation(EnvironmentCapacitySnapshot);
export const ReportedCapacityMode = optionalObservation(CapacitySnapshot.fields.mode);
