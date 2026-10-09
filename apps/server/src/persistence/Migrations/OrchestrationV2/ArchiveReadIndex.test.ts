import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runDatabaseMigrations } from "../../DatabaseMigrations.ts";
import { runLastCodeMigrations } from "../../LastCodeMigrations.ts";
import { runMigrations } from "../../Migrations.ts";

it.effect("upgrades existing databases with a bounded latest-assistant-reply lookup", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* runLastCodeMigrations({ toMigrationInclusive: 14 });
    assert.deepEqual(yield* runDatabaseMigrations(), [[15, "OrchestrationV2ArchiveReadIndex"]]);
    assert.deepEqual(yield* runDatabaseMigrations(), []);
    const plan = yield* sql<{ readonly detail: string }>`
      EXPLAIN QUERY PLAN
      SELECT updated_at FROM orchestration_v2_projection_messages
      WHERE thread_id = 'example-thread' AND role = 'assistant'
      ORDER BY updated_at DESC LIMIT 1
    `;
    assert.isTrue(
      plan.some((step) =>
        step.detail.includes(
          "SEARCH orchestration_v2_projection_messages USING COVERING INDEX orchestration_v2_projection_messages_latest_assistant_idx",
        ),
      ),
    );
    assert.isFalse(plan.some((step) => /SCAN|TEMP B-TREE/.test(step.detail)));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
