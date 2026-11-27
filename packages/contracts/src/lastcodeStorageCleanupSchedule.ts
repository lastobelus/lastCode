import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const CleanupIntervalMinutes = Schema.Int.check(Schema.isGreaterThan(0));

export const StorageCleanupSchedule = Schema.Struct({
  intervalMinutes: CleanupIntervalMinutes.pipe(Schema.withDecodingDefault(Effect.succeed(60))),
  alternateGroups: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  deferDuringTimeMachine: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});

export const StorageCleanupSchedulePatch = Schema.Struct({
  intervalMinutes: Schema.optionalKey(CleanupIntervalMinutes),
  alternateGroups: Schema.optionalKey(Schema.Boolean),
  deferDuringTimeMachine: Schema.optionalKey(Schema.Boolean),
});
