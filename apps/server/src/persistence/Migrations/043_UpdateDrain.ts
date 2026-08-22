import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS update_drain_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL CHECK (event_type IN ('update-drain.started', 'update-drain.cancelled')),
      command_id TEXT NOT NULL UNIQUE,
      occurred_at TEXT NOT NULL,
      request_id TEXT NOT NULL,
      target_version TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draining', 'cancelled'))
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS update_drain_command_receipts (
      command_id TEXT PRIMARY KEY,
      command_type TEXT NOT NULL CHECK (command_type IN ('update-drain.start', 'update-drain.cancel')),
      request_id TEXT NOT NULL,
      target_version TEXT,
      accepted_at TEXT NOT NULL,
      result_sequence INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected')),
      error_reason TEXT,
      error TEXT
    )
  `;
});
