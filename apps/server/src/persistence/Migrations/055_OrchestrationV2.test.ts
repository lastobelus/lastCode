import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import { runDatabaseMigrations } from "../DatabaseMigrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("creator evidence migration", (it) => {
  it.effect("upgrades released schema 53 with the creator evidence index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 53 });
      yield* runDatabaseMigrations();
      assert.deepStrictEqual(
        yield* sql`SELECT migration_id, name FROM lastcode_sql_migrations WHERE migration_id = 12`,
        [{ migration_id: 12, name: "ThreadCreatorEvidenceIndex" }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master
          WHERE type = 'index' AND name = 'orchestration_events_v2_thread_created_target_idx'`,
        [{ name: "orchestration_events_v2_thread_created_target_idx" }],
      );
      assert.deepStrictEqual(yield* runDatabaseMigrations(), []);
    }),
  );
});
