import * as Schema from "effect/Schema";

import {
  CommandId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const UpdateDrainRequestId = TrimmedNonEmptyString.pipe(
  Schema.brand("UpdateDrainRequestId"),
);
export type UpdateDrainRequestId = typeof UpdateDrainRequestId.Type;

export const UpdateDrainTargetVersion = TrimmedNonEmptyString.pipe(
  Schema.brand("UpdateDrainTargetVersion"),
);
export type UpdateDrainTargetVersion = typeof UpdateDrainTargetVersion.Type;

export const UpdateDrainIntentStatus = Schema.Literals(["draining", "cancelled"]);
export type UpdateDrainIntentStatus = typeof UpdateDrainIntentStatus.Type;

export const UpdateDrainIntent = Schema.Struct({
  requestId: UpdateDrainRequestId,
  targetVersion: UpdateDrainTargetVersion,
  status: UpdateDrainIntentStatus,
});
export type UpdateDrainIntent = typeof UpdateDrainIntent.Type;

export const UpdateDrainState = Schema.Struct({
  sequence: NonNegativeInt,
  intent: Schema.NullOr(UpdateDrainIntent),
});
export type UpdateDrainState = typeof UpdateDrainState.Type;

const UpdateDrainCommandBase = {
  commandId: CommandId,
  requestId: UpdateDrainRequestId,
  createdAt: IsoDateTime,
} as const;

export const UpdateDrainStartCommand = Schema.Struct({
  ...UpdateDrainCommandBase,
  type: Schema.Literal("update-drain.start"),
  targetVersion: UpdateDrainTargetVersion,
});
export type UpdateDrainStartCommand = typeof UpdateDrainStartCommand.Type;

export const UpdateDrainCancelCommand = Schema.Struct({
  ...UpdateDrainCommandBase,
  type: Schema.Literal("update-drain.cancel"),
});
export type UpdateDrainCancelCommand = typeof UpdateDrainCancelCommand.Type;

export const UpdateDrainCommand = Schema.Union([UpdateDrainStartCommand, UpdateDrainCancelCommand]);
export type UpdateDrainCommand = typeof UpdateDrainCommand.Type;

const UpdateDrainEventBase = {
  sequence: NonNegativeInt,
  eventId: EventId,
  commandId: CommandId,
  occurredAt: IsoDateTime,
  requestId: UpdateDrainRequestId,
  targetVersion: UpdateDrainTargetVersion,
} as const;

export const UpdateDrainStartedEvent = Schema.Struct({
  ...UpdateDrainEventBase,
  type: Schema.Literal("update-drain.started"),
  status: Schema.Literal("draining"),
});
export type UpdateDrainStartedEvent = typeof UpdateDrainStartedEvent.Type;

export const UpdateDrainCancelledEvent = Schema.Struct({
  ...UpdateDrainEventBase,
  type: Schema.Literal("update-drain.cancelled"),
  status: Schema.Literal("cancelled"),
});
export type UpdateDrainCancelledEvent = typeof UpdateDrainCancelledEvent.Type;

export const UpdateDrainEvent = Schema.Union([UpdateDrainStartedEvent, UpdateDrainCancelledEvent]);
export type UpdateDrainEvent = typeof UpdateDrainEvent.Type;

export const UpdateDrainFailureReason = Schema.Literals([
  "already_draining",
  "command_id_conflict",
  "internal_error",
  "no_active_drain",
  "request_already_cancelled",
  "request_mismatch",
]);
export type UpdateDrainFailureReason = typeof UpdateDrainFailureReason.Type;

export const UpdateDrainCommandReceipt = Schema.Struct({
  commandId: CommandId,
  requestId: UpdateDrainRequestId,
  commandType: Schema.Literals(["update-drain.start", "update-drain.cancel"]),
  targetVersion: Schema.NullOr(UpdateDrainTargetVersion),
  acceptedAt: IsoDateTime,
  resultSequence: NonNegativeInt,
  status: Schema.Literals(["accepted", "rejected"]),
  errorReason: Schema.NullOr(UpdateDrainFailureReason),
  error: Schema.NullOr(Schema.String),
});
export type UpdateDrainCommandReceipt = typeof UpdateDrainCommandReceipt.Type;

export const UpdateDrainStartInput = Schema.Struct({
  commandId: CommandId,
  requestId: UpdateDrainRequestId,
  targetVersion: UpdateDrainTargetVersion,
});
export type UpdateDrainStartInput = typeof UpdateDrainStartInput.Type;

export const UpdateDrainCancelInput = Schema.Struct({
  commandId: CommandId,
  requestId: UpdateDrainRequestId,
});
export type UpdateDrainCancelInput = typeof UpdateDrainCancelInput.Type;

export class UpdateDrainError extends Schema.TaggedErrorClass<UpdateDrainError>()(
  "UpdateDrainError",
  {
    reason: UpdateDrainFailureReason,
    message: Schema.String,
  },
) {}
