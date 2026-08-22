import * as Schema from "effect/Schema";

import {
  CommandId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TurnId,
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

export const UpdateActivationTargetDigest = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/),
).pipe(Schema.brand("UpdateActivationTargetDigest"));
export type UpdateActivationTargetDigest = typeof UpdateActivationTargetDigest.Type;

export const UpdateDrainIntentStatus = Schema.Literals(["draining", "cancelled", "claimed"]);
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

export const UpdateDrainBlocker = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("thread-turn"),
    threadId: ThreadId,
    turnId: Schema.NullOr(TurnId),
    status: Schema.Literals(["starting", "running"]),
  }),
  Schema.Struct({
    type: Schema.Literal("thread-background"),
    threadId: ThreadId,
    status: Schema.Literals(["working", "monitoring"]),
  }),
  Schema.Struct({
    type: Schema.Literal("terminal-process"),
    threadId: ThreadId,
    terminalId: TrimmedNonEmptyString,
    label: Schema.String,
    status: Schema.Literals(["starting", "running"]),
  }),
]);
export type UpdateDrainBlocker = typeof UpdateDrainBlocker.Type;

export const UpdateDrainStatus = Schema.Struct({
  sequence: NonNegativeInt,
  intent: Schema.NullOr(UpdateDrainIntent),
  admission: Schema.Literals(["open", "closed"]),
  blockers: Schema.Array(UpdateDrainBlocker),
});
export type UpdateDrainStatus = typeof UpdateDrainStatus.Type;

export class UpdateDrainAdmissionError extends Schema.TaggedErrorClass<UpdateDrainAdmissionError>()(
  "UpdateDrainAdmissionError",
  {
    reason: Schema.Literal("update_draining"),
    requestId: UpdateDrainRequestId,
    targetVersion: UpdateDrainTargetVersion,
    message: Schema.String,
  },
) {}

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

export const UpdateDrainClaimCommand = Schema.Struct({
  ...UpdateDrainCommandBase,
  type: Schema.Literal("update-drain.claim"),
});
export type UpdateDrainClaimCommand = typeof UpdateDrainClaimCommand.Type;

export const UpdateDrainCommand = Schema.Union([
  UpdateDrainStartCommand,
  UpdateDrainCancelCommand,
  UpdateDrainClaimCommand,
]);
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

export const UpdateDrainClaimedEvent = Schema.Struct({
  ...UpdateDrainEventBase,
  type: Schema.Literal("update-drain.claimed"),
  status: Schema.Literal("claimed"),
});
export type UpdateDrainClaimedEvent = typeof UpdateDrainClaimedEvent.Type;

export const UpdateDrainEvent = Schema.Union([
  UpdateDrainStartedEvent,
  UpdateDrainCancelledEvent,
  UpdateDrainClaimedEvent,
]);
export type UpdateDrainEvent = typeof UpdateDrainEvent.Type;

export const UpdateDrainFailureReason = Schema.Literals([
  "already_draining",
  "activation_claimed",
  "command_id_conflict",
  "internal_error",
  "not_quiescent",
  "no_active_drain",
  "request_already_cancelled",
  "request_mismatch",
]);
export type UpdateDrainFailureReason = typeof UpdateDrainFailureReason.Type;

export const UpdateDrainCommandReceipt = Schema.Struct({
  commandId: CommandId,
  requestId: UpdateDrainRequestId,
  commandType: Schema.Literals(["update-drain.start", "update-drain.cancel", "update-drain.claim"]),
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

export const UpdateDrainClaimInput = Schema.Struct({
  requestId: UpdateDrainRequestId,
});
export type UpdateDrainClaimInput = typeof UpdateDrainClaimInput.Type;

export const UpdateActivationCommitInput = Schema.Struct({
  requestId: UpdateDrainRequestId,
  targetDigest: UpdateActivationTargetDigest,
});
export type UpdateActivationCommitInput = typeof UpdateActivationCommitInput.Type;

export const UpdateActivationCommitResult = Schema.Struct({
  requestId: UpdateDrainRequestId,
  schemaVersion: Schema.Literal(1),
  status: Schema.Literal("committed"),
  targetDigest: UpdateActivationTargetDigest,
});
export type UpdateActivationCommitResult = typeof UpdateActivationCommitResult.Type;

export const UpdateActivationCommitFailureReason = Schema.Literals([
  "not_trial",
  "request_mismatch",
  "digest_mismatch",
  "drain_not_claimed",
  "write_failed",
]);
export type UpdateActivationCommitFailureReason = typeof UpdateActivationCommitFailureReason.Type;

export class UpdateActivationCommitError extends Schema.TaggedErrorClass<UpdateActivationCommitError>()(
  "UpdateActivationCommitError",
  {
    reason: UpdateActivationCommitFailureReason,
    message: Schema.String,
  },
) {}

export class UpdateDrainError extends Schema.TaggedErrorClass<UpdateDrainError>()(
  "UpdateDrainError",
  {
    reason: UpdateDrainFailureReason,
    message: Schema.String,
  },
) {}
