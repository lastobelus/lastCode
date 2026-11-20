import { EnvironmentId, ForwardCompatibleArray } from "./baseSchemas.ts";
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

export const CapacitySnapshot = Schema.Struct({
  // The stored setting, reported verbatim: a newer version's mode is kept, not coerced.
  mode: Schema.String,
  sampledAt: Schema.NullOr(Schema.Number),
  readAt: Schema.Number,
  stale: Schema.Boolean,
  measurements: Schema.NullOr(CapacityMeasurements),
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
    owner: CapacityVerdict,
    agent: CapacityVerdict,
    background: CapacityVerdict,
  }),
});
export type CapacitySnapshot = typeof CapacitySnapshot.Type;

// Results read from another server or CLI can carry values introduced by a newer version.
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
export const ReportedCapacitySnapshot = CapacitySnapshot.mapFields((fields) => ({
  ...fields,
  measurements: Schema.NullOr(
    CapacityMeasurements.mapFields((measurements) => ({
      ...measurements,
      memoryPressure: Schema.String,
    })),
  ),
  verdicts: Schema.Struct({
    owner: ReportedCapacityVerdict,
    agent: ReportedCapacityVerdict,
    background: ReportedCapacityVerdict,
  }),
}));
export type ReportedCapacitySnapshot = typeof ReportedCapacitySnapshot.Type;

function optionalObservation<S extends Schema.Constraint>(schema: S) {
  const optional = Schema.optionalKey(schema);
  return Schema.catchDecoding<typeof optional>(() => Effect.succeedNone)(optional);
}

export const OptionalCapacitySnapshot = optionalObservation(ReportedCapacitySnapshot);

const LinkedCapacity = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  capacity: ReportedCapacitySnapshot,
});

export const EnvironmentCapacitySnapshot = Schema.Struct({
  ...ReportedCapacitySnapshot.fields,
  linkedObservation: Schema.String,
  // One malformed linked entry or reading drops only itself, not the peer's whole block.
  linked: ForwardCompatibleArray(LinkedCapacity),
});
export type EnvironmentCapacitySnapshot = typeof EnvironmentCapacitySnapshot.Type;

export const OptionalEnvironmentCapacitySnapshot = optionalObservation(EnvironmentCapacitySnapshot);
export const ReportedCapacityMode = optionalObservation(Schema.String);
export const CapacityModeSetting = Schema.String.pipe(
  Schema.withDecodingDefault(Effect.succeed("observe")),
);
