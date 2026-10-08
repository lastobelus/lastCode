import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runDatabaseMigrations } from "../../DatabaseMigrations.ts";
import { runLastCodeMigrations } from "../../LastCodeMigrations.ts";
import { runMigrations } from "../../Migrations.ts";

it.effect(
  "indexes grouped creator lookup and startup repair after upgrading an existing database",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* runLastCodeMigrations({ toMigrationInclusive: 13 });
      assert.deepEqual(yield* runDatabaseMigrations(), [
        [14, "OrchestrationV2GroupedCreatorThreadIndex"],
      ]);
      assert.deepEqual(yield* runDatabaseMigrations(), []);
      for (const recovery of [false, true]) {
        const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT child.thread_id FROM orchestration_v2_projection_threads AS child
        LEFT JOIN orchestration_v2_projection_threads AS creator
          ON creator.thread_id = CAST(json_extract(child.payload_json, '$.creatorThreadId') AS TEXT)
        WHERE child.deleted_at IS NULL
          AND json_extract(child.payload_json, '$.createdBy') = 'agent'
          AND json_extract(child.payload_json, '$.creatorThreadId') IS NOT NULL
          AND json_extract(child.payload_json, '$.creatorGrouping') = 'grouped'
          AND json_extract(child.payload_json, '$.lineage.parentThreadId') IS NULL
          AND json_extract(child.payload_json, '$.lineage.relationshipToParent') IS NULL
          AND json_extract(child.payload_json, '$.forkedFrom') IS NULL
          AND ${
            recovery
              ? sql`(creator.thread_id IS NULL OR creator.archived_at IS NOT NULL OR creator.deleted_at IS NOT NULL)`
              : sql`CAST(json_extract(child.payload_json, '$.creatorThreadId') AS TEXT) IN ('creator:origin')`
          }
      `;
        assert.isTrue(
          plan.some((step) =>
            step.detail.includes(
              `${recovery ? "SCAN" : "SEARCH"} child USING INDEX orchestration_v2_projection_threads_grouped_creator_idx`,
            ),
          ),
        );
        assert.isFalse(plan.some((step) => step.detail === "SCAN child"));
      }
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
