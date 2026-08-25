import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration0048 from "./048_ProjectionThreadAnnotation.ts";
import Migration0049 from "./049_UpdateDrain.ts";
import Migration0050 from "./050_UpdateDrainClaim.ts";
import Migration0051 from "./051_ProjectionTurnRequestCorrelations.ts";
import Migration0052 from "./052_ProjectionThreadWorktreeCleanup.ts";
import Migration0053 from "./053_ProjectionThreadLinkedPullRequest.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("053_ProjectionThreadLinkedPullRequest", (it) => {
  it.effect("bridges databases that recorded the previous LastCode migration numbers", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 41 });
      yield* Migration0048;
      yield* Migration0049;
      yield* Migration0050;
      yield* Migration0051;
      yield* Migration0052;
      yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES
            (42, 'ProjectionThreadAnnotation'),
            (43, 'UpdateDrain'),
            (44, 'UpdateDrainClaim'),
            (45, 'ProjectionTurnRequestCorrelations'),
            (46, 'ProjectionThreadWorktreeCleanup')
        `;

      const before = yield* sql<{ readonly name: string }>`
          PRAGMA table_info(projection_threads)
        `;
      assert.isFalse(before.some((column) => column.name === "linked_pull_request_json"));

      const executed = yield* runMigrations({ toMigrationInclusive: 53 });
      assert.deepStrictEqual(executed, [
        [47, "ProjectionProjectIcon"],
        [48, "ProjectionThreadAnnotation"],
        [49, "UpdateDrain"],
        [50, "UpdateDrainClaim"],
        [51, "ProjectionTurnRequestCorrelations"],
        [52, "ProjectionThreadWorktreeCleanup"],
        [53, "ProjectionThreadLinkedPullRequest"],
      ]);

      yield* Migration0053;
      const after = yield* sql<{ readonly name: string }>`
          PRAGMA table_info(projection_threads)
        `;
      assert.equal(after.filter((column) => column.name === "linked_pull_request_json").length, 1);
    }),
  );
});

const partialUpgradeLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

partialUpgradeLayer("053_ProjectionThreadLinkedPullRequest partial upgrades", (it) => {
  it.effect("preserves update drain data when upgrading from the previous migration 44", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 41 });
      yield* Migration0048;
      yield* Migration0049;
      yield* Migration0050;
      yield* sql`
        INSERT INTO update_drain_events (
          event_id, event_type, command_id, occurred_at, request_id, target_version, status
        ) VALUES (
          'event-claimed', 'update-drain.claimed', 'command-event',
          '2026-08-25T00:00:00.000Z', 'request-1', '1.2.3', 'claimed'
        )
      `;
      yield* sql`
        INSERT INTO update_drain_command_receipts (
          command_id, command_type, request_id, target_version, accepted_at,
          result_sequence, status, error_reason, error
        ) VALUES (
          'command-receipt', 'update-drain.claim', 'request-1', '1.2.3',
          '2026-08-25T00:00:01.000Z', 1, 'accepted', NULL, NULL
        )
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (42, 'ProjectionThreadAnnotation'),
          (43, 'UpdateDrain'),
          (44, 'UpdateDrainClaim')
      `;

      const executed = yield* runMigrations({ toMigrationInclusive: 53 });
      assert.deepStrictEqual(executed, [
        [45, "ProjectionProjectsAutoPull"],
        [46, "RepairAutomaticSettlementTimestamps"],
        [47, "ProjectionProjectIcon"],
        [48, "ProjectionThreadAnnotation"],
        [49, "UpdateDrain"],
        [50, "UpdateDrainClaim"],
        [51, "ProjectionTurnRequestCorrelations"],
        [52, "ProjectionThreadWorktreeCleanup"],
        [53, "ProjectionThreadLinkedPullRequest"],
      ]);

      const events = yield* sql<{
        readonly eventType: string;
        readonly status: string;
      }>`
        SELECT event_type AS "eventType", status
        FROM update_drain_events
        WHERE event_id = 'event-claimed'
      `;
      assert.deepStrictEqual(events, [{ eventType: "update-drain.claimed", status: "claimed" }]);

      const receipts = yield* sql<{
        readonly commandType: string;
        readonly status: string;
      }>`
        SELECT command_type AS "commandType", status
        FROM update_drain_command_receipts
        WHERE command_id = 'command-receipt'
      `;
      assert.deepStrictEqual(receipts, [{ commandType: "update-drain.claim", status: "accepted" }]);
    }),
  );
});
