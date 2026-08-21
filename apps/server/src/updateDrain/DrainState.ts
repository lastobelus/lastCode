import {
  EventId,
  type UpdateDrainCommand,
  UpdateDrainError,
  type UpdateDrainEvent,
  type UpdateDrainState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

export type UpdateDrainEventDraft = UpdateDrainEvent extends infer Event
  ? Event extends UpdateDrainEvent
    ? Omit<Event, "sequence">
    : never
  : never;

export const emptyUpdateDrainState: UpdateDrainState = {
  sequence: 0,
  intent: null,
};

export function projectUpdateDrainEvent(
  _state: UpdateDrainState,
  event: UpdateDrainEvent,
): UpdateDrainState {
  return {
    sequence: event.sequence,
    intent: {
      requestId: event.requestId,
      targetVersion: event.targetVersion,
      status: event.status,
    },
  };
}

function eventIdFor(command: UpdateDrainCommand) {
  return EventId.make(`update-drain:${command.commandId}`);
}

export function decideUpdateDrainCommand(
  state: UpdateDrainState,
  command: UpdateDrainCommand,
): Effect.Effect<UpdateDrainEventDraft, UpdateDrainError> {
  if (command.type === "update-drain.start") {
    if (state.intent?.status === "draining") {
      return Effect.fail(
        new UpdateDrainError({
          reason: "already_draining",
          message: `Update drain '${state.intent.requestId}' is already targeting ${state.intent.targetVersion}.`,
        }),
      );
    }
    if (state.intent?.requestId === command.requestId) {
      return Effect.fail(
        new UpdateDrainError({
          reason: "request_already_cancelled",
          message: `Update drain request '${command.requestId}' was already cancelled; use a new request id.`,
        }),
      );
    }
    return Effect.succeed({
      type: "update-drain.started",
      eventId: eventIdFor(command),
      commandId: command.commandId,
      occurredAt: command.createdAt,
      requestId: command.requestId,
      targetVersion: command.targetVersion,
      status: "draining",
    });
  }

  if (state.intent === null) {
    return Effect.fail(
      new UpdateDrainError({
        reason: "no_active_drain",
        message: "There is no active update drain to cancel.",
      }),
    );
  }
  if (state.intent.requestId !== command.requestId) {
    return Effect.fail(
      new UpdateDrainError({
        reason: "request_mismatch",
        message: `Update drain '${command.requestId}' does not match active request '${state.intent.requestId}'.`,
      }),
    );
  }
  if (state.intent.status === "cancelled") {
    return Effect.fail(
      new UpdateDrainError({
        reason: "request_already_cancelled",
        message: `Update drain request '${command.requestId}' is already cancelled.`,
      }),
    );
  }

  return Effect.succeed({
    type: "update-drain.cancelled",
    eventId: eventIdFor(command),
    commandId: command.commandId,
    occurredAt: command.createdAt,
    requestId: command.requestId,
    targetVersion: state.intent.targetVersion,
    status: "cancelled",
  });
}
