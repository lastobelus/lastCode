import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  UpdateDrainCommandReceipt,
  UpdateDrainEvent,
  UpdateDrainIntentStatus,
  UpdateDrainRequestId,
  UpdateDrainTargetVersion,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type UpdateDrainRepositoryError,
} from "../Errors.ts";
import {
  UpdateDrainRepository,
  type UpdateDrainRepositoryShape,
} from "../Services/UpdateDrainRepository.ts";

const UpdateDrainEventRow = Schema.Struct({
  sequence: NonNegativeInt,
  eventId: Schema.String,
  type: Schema.String,
  commandId: CommandId,
  occurredAt: IsoDateTime,
  requestId: UpdateDrainRequestId,
  targetVersion: UpdateDrainTargetVersion,
  status: UpdateDrainIntentStatus,
});

const AppendEventRequest = Schema.Struct({
  eventId: Schema.String,
  type: Schema.String,
  commandId: CommandId,
  occurredAt: IsoDateTime,
  requestId: UpdateDrainRequestId,
  targetVersion: UpdateDrainTargetVersion,
  status: UpdateDrainIntentStatus,
});

const CommandIdInput = Schema.Struct({ commandId: CommandId });
const decodeEvent = Schema.decodeUnknownEffect(UpdateDrainEvent);

function repositoryError(operation: string) {
  return (cause: unknown): UpdateDrainRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(`${operation}:decode`)(cause)
      : toPersistenceSqlError(`${operation}:query`)(cause);
}

const makeUpdateDrainRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const readEventRows = SqlSchema.findAll({
    Request: Schema.Struct({}),
    Result: UpdateDrainEventRow,
    execute: () => sql`
      SELECT
        sequence,
        event_id AS "eventId",
        event_type AS "type",
        command_id AS "commandId",
        occurred_at AS "occurredAt",
        request_id AS "requestId",
        target_version AS "targetVersion",
        status
      FROM update_drain_events
      ORDER BY sequence ASC
    `,
  });

  const findReceipt = SqlSchema.findOneOption({
    Request: CommandIdInput,
    Result: UpdateDrainCommandReceipt,
    execute: ({ commandId }) => sql`
      SELECT
        command_id AS "commandId",
        request_id AS "requestId",
        command_type AS "commandType",
        target_version AS "targetVersion",
        accepted_at AS "acceptedAt",
        result_sequence AS "resultSequence",
        status,
        error_reason AS "errorReason",
        error
      FROM update_drain_command_receipts
      WHERE command_id = ${commandId}
    `,
  });

  const appendEvent = SqlSchema.findOne({
    Request: AppendEventRequest,
    Result: UpdateDrainEventRow,
    execute: (event) => sql`
      INSERT INTO update_drain_events (
        event_id,
        event_type,
        command_id,
        occurred_at,
        request_id,
        target_version,
        status
      )
      VALUES (
        ${event.eventId},
        ${event.type},
        ${event.commandId},
        ${event.occurredAt},
        ${event.requestId},
        ${event.targetVersion},
        ${event.status}
      )
      RETURNING
        sequence,
        event_id AS "eventId",
        event_type AS "type",
        command_id AS "commandId",
        occurred_at AS "occurredAt",
        request_id AS "requestId",
        target_version AS "targetVersion",
        status
    `,
  });

  const insertReceipt = SqlSchema.void({
    Request: UpdateDrainCommandReceipt,
    execute: (receipt) => sql`
      INSERT INTO update_drain_command_receipts (
        command_id,
        command_type,
        request_id,
        target_version,
        accepted_at,
        result_sequence,
        status,
        error_reason,
        error
      )
      VALUES (
        ${receipt.commandId},
        ${receipt.commandType},
        ${receipt.requestId},
        ${receipt.targetVersion},
        ${receipt.acceptedAt},
        ${receipt.resultSequence},
        ${receipt.status},
        ${receipt.errorReason},
        ${receipt.error}
      )
    `,
  });

  const readAllEvents: UpdateDrainRepositoryShape["readAllEvents"] = () =>
    readEventRows({}).pipe(
      Effect.mapError(repositoryError("UpdateDrainRepository.readAllEvents")),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodeEvent(row).pipe(
            Effect.mapError(toPersistenceDecodeError("UpdateDrainRepository.readAllEvents:event")),
          ),
        ),
      ),
    );

  const getReceipt: UpdateDrainRepositoryShape["getReceipt"] = (commandId) =>
    findReceipt({ commandId }).pipe(
      Effect.mapError(repositoryError("UpdateDrainRepository.getReceipt")),
    );

  const commitAccepted: UpdateDrainRepositoryShape["commitAccepted"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const eventRow = yield* appendEvent(input.event);
          const event = yield* decodeEvent(eventRow);
          const receipt = {
            ...input.receipt,
            resultSequence: event.sequence,
          };
          yield* insertReceipt(receipt);
          return { event, receipt };
        }),
      )
      .pipe(Effect.mapError(repositoryError("UpdateDrainRepository.commitAccepted")));

  const saveRejected: UpdateDrainRepositoryShape["saveRejected"] = (receipt) =>
    insertReceipt(receipt).pipe(
      Effect.mapError(repositoryError("UpdateDrainRepository.saveRejected")),
    );

  return {
    readAllEvents,
    getReceipt,
    commitAccepted,
    saveRejected,
  } satisfies UpdateDrainRepositoryShape;
});

export const UpdateDrainRepositoryLive = Layer.effect(
  UpdateDrainRepository,
  makeUpdateDrainRepository,
);
