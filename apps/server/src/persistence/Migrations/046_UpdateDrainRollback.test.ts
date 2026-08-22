import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("046_UpdateDrainRollback", (it) => {
  it.effect("preserves completed history and accepts the rolled-back transition", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 45 });
      yield* sql`
        INSERT INTO update_drain_events (
          event_id, event_type, command_id, occurred_at, request_id, target_version, status
        ) VALUES (
          'event-complete', 'update-drain.completed', 'command-complete',
          '2026-08-21T00:01:00.000Z', 'request-1', '1.2.3', 'completed'
        )
      `;
      yield* runMigrations({ toMigrationInclusive: 46 });
      yield* sql`
        INSERT INTO update_drain_events (
          event_id, event_type, command_id, occurred_at, request_id, target_version, status
        ) VALUES (
          'event-rollback', 'update-drain.rolled-back', 'command-rollback',
          '2026-08-21T00:02:00.000Z', 'request-2', '1.2.4', 'rolled-back'
        )
      `;
      yield* sql`
        INSERT INTO update_drain_command_receipts (
          command_id, command_type, request_id, target_version, accepted_at,
          result_sequence, status, error_reason, error
        ) VALUES (
          'command-rollback', 'update-drain.rollback', 'request-2', NULL,
          '2026-08-21T00:02:00.000Z', 2, 'accepted', NULL, NULL
        )
      `;
      const events = yield* sql<{ readonly eventType: string; readonly status: string }>`
        SELECT event_type AS "eventType", status FROM update_drain_events ORDER BY sequence ASC
      `;
      assert.deepStrictEqual(events, [
        { eventType: "update-drain.completed", status: "completed" },
        { eventType: "update-drain.rolled-back", status: "rolled-back" },
      ]);
    }),
  );
});
