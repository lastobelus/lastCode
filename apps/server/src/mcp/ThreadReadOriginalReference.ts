import type { MessageId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Projection timestamps cannot prove which nonce was on an input before a same-tick edit. */
export const makeOriginalReferenceCheck = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (threadId: ThreadId, runId: RunId, nonce: MessageId) =>
    sql`WITH accepted_run AS (
      SELECT command_id, json_extract(payload_json, '$.userMessageId') AS message_id
      FROM orchestration_events
      WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
        AND application_event_version = 2 AND event_type = 'run.created'
        AND json_extract(payload_json, '$.id') = ${runId}
      ORDER BY sequence LIMIT 1
    )
    SELECT 1 FROM orchestration_events AS input
    JOIN accepted_run ON input.command_id = accepted_run.command_id
    WHERE input.aggregate_kind = 'thread' AND input.stream_id = ${threadId}
      AND input.application_event_version = 2 AND input.event_type = 'message.updated'
      AND json_extract(input.payload_json, '$.id') = accepted_run.message_id
      AND json_extract(input.payload_json, '$.threadReadContext.authorizationId') = ${nonce}
    LIMIT 1`.pipe(Effect.map((rows) => rows.length === 1));
});
