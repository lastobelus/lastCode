import {
  type UpdateDrainCommand,
  type UpdateDrainCommandReceipt,
  UpdateDrainError,
  type UpdateDrainState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import { UpdateDrainRepository } from "../persistence/Services/UpdateDrainRepository.ts";
import {
  decideUpdateDrainCommand,
  emptyUpdateDrainState,
  projectUpdateDrainEvent,
} from "./DrainState.ts";

export interface UpdateDrainShape {
  readonly dispatch: (
    command: UpdateDrainCommand,
  ) => Effect.Effect<UpdateDrainCommandReceipt, UpdateDrainError>;
  readonly status: Effect.Effect<UpdateDrainState, UpdateDrainError>;
}

export class UpdateDrain extends Context.Service<UpdateDrain, UpdateDrainShape>()(
  "t3/updateDrain/UpdateDrain",
) {}

function internalError(_cause: unknown) {
  return new UpdateDrainError({
    reason: "internal_error",
    message: "Failed to access durable update drain state.",
  });
}

function commandTargetVersion(command: UpdateDrainCommand) {
  return command.type === "update-drain.start" ? command.targetVersion : null;
}

function receiptMatchesCommand(
  receipt: UpdateDrainCommandReceipt,
  command: UpdateDrainCommand,
): boolean {
  return (
    receipt.commandType === command.type &&
    receipt.requestId === command.requestId &&
    receipt.targetVersion === commandTargetVersion(command)
  );
}

export const makeUpdateDrain = Effect.fn("makeUpdateDrain")(function* () {
  const repository = yield* UpdateDrainRepository;
  const mutex = yield* Semaphore.make(1);
  const events = yield* repository.readAllEvents().pipe(Effect.mapError(internalError));
  let currentState = events.reduce(projectUpdateDrainEvent, emptyUpdateDrainState);

  const dispatchUnlocked = Effect.fn("UpdateDrain.dispatchUnlocked")(function* (
    command: UpdateDrainCommand,
  ) {
    const existingReceipt = yield* repository
      .getReceipt(command.commandId)
      .pipe(Effect.mapError(internalError));
    if (Option.isSome(existingReceipt)) {
      if (!receiptMatchesCommand(existingReceipt.value, command)) {
        return yield* new UpdateDrainError({
          reason: "command_id_conflict",
          message: `Update drain command id '${command.commandId}' was already used for different input.`,
        });
      }
      if (existingReceipt.value.status === "accepted") {
        return existingReceipt.value;
      }
      return yield* new UpdateDrainError({
        reason: existingReceipt.value.errorReason ?? "internal_error",
        message: existingReceipt.value.error ?? "Update drain command was previously rejected.",
      });
    }

    const decision = yield* Effect.result(decideUpdateDrainCommand(currentState, command));
    if (decision._tag === "Failure") {
      yield* repository
        .saveRejected({
          commandId: command.commandId,
          requestId: command.requestId,
          commandType: command.type,
          targetVersion: commandTargetVersion(command),
          acceptedAt: command.createdAt,
          resultSequence: currentState.sequence,
          status: "rejected",
          errorReason: decision.failure.reason,
          error: decision.failure.message,
        })
        .pipe(Effect.mapError(internalError));
      return yield* decision.failure;
    }

    const committed = yield* repository
      .commitAccepted({
        event: decision.success,
        receipt: {
          commandId: command.commandId,
          requestId: command.requestId,
          commandType: command.type,
          targetVersion: commandTargetVersion(command),
          acceptedAt: command.createdAt,
          status: "accepted",
          errorReason: null,
          error: null,
        },
      })
      .pipe(Effect.mapError(internalError));
    currentState = projectUpdateDrainEvent(currentState, committed.event);
    return committed.receipt;
  });

  const dispatch: UpdateDrainShape["dispatch"] = (command) =>
    mutex.withPermits(1)(dispatchUnlocked(command));

  return UpdateDrain.of({
    dispatch,
    status: mutex.withPermits(1)(Effect.sync(() => currentState)),
  });
});

export const layer = Layer.effect(UpdateDrain, makeUpdateDrain());
