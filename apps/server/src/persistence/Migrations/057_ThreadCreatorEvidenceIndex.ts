import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Historical creator repair must not scan every transcript event on each startup
  // when an old thread has no recoverable evidence. The TEXT affinity matches
  // thread IDs so SQLite can seek this expression index for the join equality.
  yield* sql`
    CREATE INDEX orchestration_events_v2_thread_created_target_idx
    ON orchestration_events(CAST(json_extract(payload_json, '$.targetThreadId') AS TEXT), sequence)
    WHERE application_event_version = 2
      AND aggregate_kind = 'thread'
      AND event_type = 'turn-item.updated'
      AND json_extract(payload_json, '$.type') = 'thread_created'
  `;
});
