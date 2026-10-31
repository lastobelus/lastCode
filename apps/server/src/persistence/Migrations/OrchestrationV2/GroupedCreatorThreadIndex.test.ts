import { interactiveThreadParentSql } from "../../../orchestration-v2/InteractiveThreadParentSql.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runDatabaseMigrations } from "../../DatabaseMigrations.ts";
import { runLastCodeMigrations } from "../../LastCodeMigrations.ts";
import { runMigrations } from "../../Migrations.ts";

it.effect(
  "indexes current parent lookup and startup repair after upgrading an existing database",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* runLastCodeMigrations({ toMigrationInclusive: 13 });
      assert.deepEqual(yield* runDatabaseMigrations(), [
        [14, "OrchestrationV2GroupedCreatorThreadIndex"],
        [15, "OrchestrationV2ArchiveReadIndex"],
        [16, "OrchestrationV2CommandHistoryIndex"],
        [17, "OrchestrationV2InteractiveThreadParentIndex"],
      ]);
      assert.deepEqual(yield* runDatabaseMigrations(), []);
      for (const recovery of [false, true]) {
        const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT child.thread_id FROM orchestration_v2_projection_threads AS child
        LEFT JOIN orchestration_v2_projection_threads AS creator
          ON creator.thread_id = ${interactiveThreadParentSql(sql, "child")}
        WHERE child.deleted_at IS NULL
          AND ${interactiveThreadParentSql(sql, "child")} IS NOT NULL
          AND ${
            recovery
              ? sql`(creator.thread_id IS NULL OR creator.deleted_at IS NOT NULL)`
              : sql`${interactiveThreadParentSql(sql, "child")} IN ('creator:origin')`
          }
      `;
        assert.isTrue(
          plan.some((step) =>
            step.detail.includes(
              `${recovery ? "" : "SEARCH child "}USING INDEX orchestration_v2_projection_threads_interactive_parent_idx`,
            ),
          ),
          JSON.stringify(plan),
        );
        assert.isFalse(plan.some((step) => step.detail === "SCAN child"));
      }
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
