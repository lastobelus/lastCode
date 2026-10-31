import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runDatabaseMigrations } from "../../DatabaseMigrations.ts";
import { runLastCodeMigrations } from "../../LastCodeMigrations.ts";
import { runMigrations } from "../../Migrations.ts";
import { interactiveThreadParentSql } from "../../../orchestration-v2/InteractiveThreadParentSql.ts";

it.effect("upgrades existing v2 databases and indexes every step of owned-thread traversal", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* runLastCodeMigrations({ toMigrationInclusive: 12 });
    assert.deepEqual(yield* runDatabaseMigrations(), [
      [13, "OrchestrationV2OwnedThreadIndex"],
      [14, "OrchestrationV2GroupedCreatorThreadIndex"],
      [15, "OrchestrationV2ArchiveReadIndex"],
      [16, "OrchestrationV2CommandHistoryIndex"],
      [17, "OrchestrationV2InteractiveThreadParentIndex"],
    ]);
    assert.deepEqual(yield* runDatabaseMigrations(), []);
    const plan = yield* sql<{ readonly detail: string }>`
      EXPLAIN QUERY PLAN
      WITH RECURSIVE family(thread_id) AS (
        SELECT 'root'
        UNION
        SELECT child.thread_id FROM orchestration_v2_projection_threads AS child
        JOIN family ON CAST(json_extract(child.payload_json, '$.lineage.parentThreadId') AS TEXT) = family.thread_id
        WHERE json_extract(child.payload_json, '$.lineage.relationshipToParent') = 'subagent'
      )
      SELECT thread_id FROM family
    `;
    assert.isTrue(
      plan.some((step) =>
        step.detail.includes(
          "SEARCH child USING INDEX orchestration_v2_projection_threads_owned_parent_idx",
        ),
      ),
    );
    assert.isFalse(plan.some((step) => /^SCAN child\b/.test(step.detail)));
    const archivePlan = yield* sql<{ readonly detail: string }>`
      EXPLAIN QUERY PLAN
      WITH RECURSIVE family(thread_id) AS (
        SELECT 'example-root'
        UNION
        SELECT child.thread_id FROM orchestration_v2_projection_threads AS child
        JOIN family ON CAST(json_extract(child.payload_json, '$.lineage.parentThreadId') AS TEXT) = family.thread_id
        WHERE json_extract(child.payload_json, '$.lineage.relationshipToParent') = 'subagent'
          AND json_extract(child.payload_json, '$.lineage.independent') IS NOT 1
        UNION
        SELECT child.thread_id FROM orchestration_v2_projection_threads AS child
        JOIN family ON ${interactiveThreadParentSql(sql, "child")} = family.thread_id
        JOIN orchestration_v2_projection_threads AS parent ON parent.thread_id = family.thread_id
        WHERE child.deleted_at IS NULL AND child.project_id = parent.project_id
      )
      SELECT thread_id FROM family
    `;
    for (const index of ["owned_parent", "interactive_parent"])
      assert.isTrue(
        archivePlan.some((step) =>
          step.detail.includes(
            `SEARCH child USING INDEX orchestration_v2_projection_threads_${index}_idx`,
          ),
        ),
        JSON.stringify(archivePlan),
      );
    assert.isFalse(archivePlan.some((step) => /^SCAN child\b/.test(step.detail)));
    const groupedPlan = yield* sql<{ readonly detail: string }>`
      EXPLAIN QUERY PLAN
      SELECT child.thread_id FROM orchestration_v2_projection_threads AS child
      WHERE ${interactiveThreadParentSql(sql, "child")} IN ('example-root')
        AND child.deleted_at IS NULL
      ORDER BY child.thread_id
    `;
    assert.isTrue(
      groupedPlan.some((step) =>
        step.detail.includes(
          "SEARCH child USING INDEX orchestration_v2_projection_threads_interactive_parent_idx",
        ),
      ),
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
