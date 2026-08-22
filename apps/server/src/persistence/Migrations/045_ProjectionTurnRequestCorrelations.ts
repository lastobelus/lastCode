import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_turn_request_correlations (
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      turn_id TEXT,
      state TEXT NOT NULL CHECK (state IN ('pending', 'started', 'error', 'interrupted')),
      requested_at TEXT NOT NULL,
      resolved_at TEXT,
      PRIMARY KEY (thread_id, message_id)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_turn_assistant_finalizations (
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      finalized_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, turn_id)
    )
  `;
});
