import { MessageId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Schema from "effect/Schema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ProjectionTurnRequestCorrelation,
  ProjectionTurnRequestCorrelationRepository,
  type ProjectionTurnRequestCorrelationRepositoryShape,
} from "../Services/ProjectionTurnRequestCorrelations.ts";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const getRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: ThreadId, messageId: MessageId }),
    Result: ProjectionTurnRequestCorrelation,
    execute: ({ threadId, messageId }) => sql`
      SELECT thread_id AS "threadId", message_id AS "messageId", turn_id AS "turnId",
        state, requested_at AS "requestedAt", resolved_at AS "resolvedAt"
      FROM projection_turn_request_correlations
      WHERE thread_id = ${threadId} AND message_id = ${messageId}
      LIMIT 1
    `,
  });

  const insertPending: ProjectionTurnRequestCorrelationRepositoryShape["insertPending"] = (row) =>
    sql`
      INSERT INTO projection_turn_request_correlations
        (thread_id, message_id, turn_id, state, requested_at, resolved_at)
      VALUES (${row.threadId}, ${row.messageId}, NULL, 'pending', ${row.requestedAt}, NULL)
      ON CONFLICT (thread_id, message_id) DO NOTHING
    `.pipe(Effect.asVoid, Effect.mapError(toPersistenceSqlError("turnCorrelation.insertPending")));

  const resolve: ProjectionTurnRequestCorrelationRepositoryShape["resolve"] = (row) =>
    sql`
      UPDATE projection_turn_request_correlations
      SET turn_id = ${row.turnId}, state = ${row.state}, resolved_at = ${row.resolvedAt}
      WHERE thread_id = ${row.threadId} AND message_id = ${row.messageId} AND state = 'pending'
    `.pipe(Effect.asVoid, Effect.mapError(toPersistenceSqlError("turnCorrelation.resolve")));

  const get: ProjectionTurnRequestCorrelationRepositoryShape["get"] = (input) =>
    getRow(input).pipe(Effect.mapError(toPersistenceSqlError("turnCorrelation.get")));

  const deleteByThreadId: ProjectionTurnRequestCorrelationRepositoryShape["deleteByThreadId"] = ({
    threadId,
  }) =>
    sql`DELETE FROM projection_turn_request_correlations WHERE thread_id = ${threadId}`.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("turnCorrelation.deleteByThreadId")),
    );

  return { insertPending, resolve, get, deleteByThreadId };
});

export const ProjectionTurnRequestCorrelationRepositoryLive = Layer.effect(
  ProjectionTurnRequestCorrelationRepository,
  make,
);
