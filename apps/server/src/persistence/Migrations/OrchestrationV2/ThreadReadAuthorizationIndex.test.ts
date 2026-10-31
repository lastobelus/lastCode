import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runDatabaseMigrations } from "../../DatabaseMigrations.ts";
import { runLastCodeMigrations } from "../../LastCodeMigrations.ts";
import { runMigrations } from "../../Migrations.ts";

it.effect("upgrades existing databases with indexed thread read authorization lookups", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* runLastCodeMigrations({ toMigrationInclusive: 16 });
    assert.deepEqual(yield* runDatabaseMigrations(), [
      [17, "OrchestrationV2ThreadReadAuthorizationIndex"],
    ]);
    const plans = [
      yield* sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN SELECT 1 FROM orchestration_v2_projection_runs
        WHERE thread_id = 'thread' AND json_extract(payload_json, '$.userMessageId') = 'authorization'`,
      yield* sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN SELECT 1 FROM orchestration_v2_projection_runtime_requests
        WHERE thread_id = 'thread' AND json_extract(payload_json, '$.threadReadContext.authorizationId') = 'authorization'`,
      yield* sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN SELECT 1 FROM orchestration_v2_projection_messages
        WHERE thread_id = 'thread' AND role = 'user' AND json_extract(payload_json, '$.threadReadContext.authorizationId') = 'authorization'`,
    ];
    for (const [index, plan] of plans.entries()) {
      const name = ["runs", "requests", "messages"][index];
      assert.isTrue(
        plan.some((row) =>
          row.detail.includes(
            `orchestration_v2_${name}_read_authorization_idx (thread_id=? AND <expr>=?)`,
          ),
        ),
        JSON.stringify(plan),
      );
    }
    assert.deepEqual(yield* runDatabaseMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
