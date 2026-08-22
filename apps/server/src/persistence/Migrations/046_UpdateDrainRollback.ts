import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE update_drain_events RENAME TO update_drain_events_legacy_045`;
  yield* sql`
    CREATE TABLE update_drain_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL CHECK (event_type IN ('update-drain.started', 'update-drain.cancelled', 'update-drain.claimed', 'update-drain.completed', 'update-drain.rolled-back')),
      command_id TEXT NOT NULL UNIQUE,
      occurred_at TEXT NOT NULL,
      request_id TEXT NOT NULL,
      target_version TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draining', 'cancelled', 'claimed', 'completed', 'rolled-back'))
    )
  `;
  yield* sql`
    INSERT INTO update_drain_events (
      sequence, event_id, event_type, command_id, occurred_at, request_id, target_version, status
    )
    SELECT
      sequence, event_id, event_type, command_id, occurred_at, request_id, target_version, status
    FROM update_drain_events_legacy_045
  `;
  yield* sql`DROP TABLE update_drain_events_legacy_045`;

  yield* sql`ALTER TABLE update_drain_command_receipts RENAME TO update_drain_command_receipts_legacy_045`;
  yield* sql`
    CREATE TABLE update_drain_command_receipts (
      command_id TEXT PRIMARY KEY,
      command_type TEXT NOT NULL CHECK (command_type IN ('update-drain.start', 'update-drain.cancel', 'update-drain.claim', 'update-drain.complete', 'update-drain.rollback')),
      request_id TEXT NOT NULL,
      target_version TEXT,
      accepted_at TEXT NOT NULL,
      result_sequence INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected')),
      error_reason TEXT,
      error TEXT
    )
  `;
  yield* sql`
    INSERT INTO update_drain_command_receipts (
      command_id, command_type, request_id, target_version, accepted_at,
      result_sequence, status, error_reason, error
    )
    SELECT
      command_id, command_type, request_id, target_version, accepted_at,
      result_sequence, status, error_reason, error
    FROM update_drain_command_receipts_legacy_045
  `;
  yield* sql`DROP TABLE update_drain_command_receipts_legacy_045`;
});
