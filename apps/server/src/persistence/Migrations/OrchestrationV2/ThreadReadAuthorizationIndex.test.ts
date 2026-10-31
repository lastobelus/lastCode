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
    yield* sql`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES ('corrupt-run', 'corrupt-thread', 1, 'codex', 'completed', 'now', '{broken')`;
    yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests
      (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
      VALUES ('corrupt-request', 'corrupt-thread', 'node', 'user_input', 'resolved', 'now', '{broken')`;
    // Search parses message JSON; isolate this corruption fixture from its insert trigger.
    yield* sql`DROP TRIGGER IF EXISTS orchestration_v2_message_search_insert`;
    yield* sql`INSERT INTO orchestration_v2_projection_messages
      (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('corrupt-message', 'corrupt-thread', 'user', 1, 'now', 'now', '{broken')`;
    assert.deepEqual(yield* runDatabaseMigrations(), [
      [17, "OrchestrationV2ThreadReadAuthorizationIndex"],
    ]);
    const plans = [
      yield* sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN SELECT 1 FROM orchestration_v2_projection_runs
        WHERE thread_id = 'thread' AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.userMessageId') ELSE X'' END IN ('authorization', X'')`,
      yield* sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN SELECT 1 FROM orchestration_v2_projection_runtime_requests
        WHERE thread_id = 'thread' AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.threadReadContext.authorizationId') ELSE X'' END IN ('authorization', X'')`,
      yield* sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN SELECT 1 FROM orchestration_v2_projection_messages
        WHERE thread_id = 'thread' AND role = 'user' AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.threadReadContext.authorizationId') ELSE X'' END IN ('authorization', X'')`,
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
