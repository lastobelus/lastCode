import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("045_UpdateDrainComplete", (it) => {
  it.effect("preserves claimed history and accepts the completed transition", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 44 });
      yield* sql`
        INSERT INTO update_drain_events (
          event_id, event_type, command_id, occurred_at, request_id, target_version, status
        ) VALUES (
          'event-claim', 'update-drain.claimed', 'command-claim',
          '2026-08-21T00:01:00.000Z', 'request-1', '1.2.3', 'claimed'
        )
      `;
      yield* runMigrations({ toMigrationInclusive: 45 });
      yield* sql`
        INSERT INTO update_drain_events (
          event_id, event_type, command_id, occurred_at, request_id, target_version, status
        ) VALUES (
          'event-complete', 'update-drain.completed', 'command-complete',
          '2026-08-21T00:02:00.000Z', 'request-1', '1.2.3', 'completed'
        )
      `;
      yield* sql`
        INSERT INTO update_drain_command_receipts (
          command_id, command_type, request_id, target_version, accepted_at,
          result_sequence, status, error_reason, error
        ) VALUES (
          'command-complete', 'update-drain.complete', 'request-1', NULL,
          '2026-08-21T00:02:00.000Z', 2, 'accepted', NULL, NULL
        )
      `;

      const events = yield* sql<{ readonly eventType: string; readonly status: string }>`
        SELECT event_type AS "eventType", status FROM update_drain_events ORDER BY sequence ASC
      `;
      assert.deepStrictEqual(events, [
        { eventType: "update-drain.claimed", status: "claimed" },
        { eventType: "update-drain.completed", status: "completed" },
      ]);
    }),
  );
});
