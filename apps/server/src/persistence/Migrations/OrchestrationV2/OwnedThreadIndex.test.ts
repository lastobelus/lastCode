import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runDatabaseMigrations } from "../../DatabaseMigrations.ts";
import { runLastCodeMigrations } from "../../LastCodeMigrations.ts";
import { runMigrations } from "../../Migrations.ts";

it.effect("upgrades existing v2 databases and indexes every step of owned-thread traversal", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* runLastCodeMigrations({ toMigrationInclusive: 12 });
    assert.deepEqual(yield* runDatabaseMigrations(), [[13, "OrchestrationV2OwnedThreadIndex"]]);
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
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
