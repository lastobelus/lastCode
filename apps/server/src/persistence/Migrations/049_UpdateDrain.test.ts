import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

<<<<<<<< HEAD:apps/server/src/persistence/Migrations/049_UpdateDrain.test.ts
layer("049_UpdateDrain", (it) => {
|||||||| parent of 8104aad471 (fix(lastcode): keep checkpoint migrations replayable (#95)):apps/server/src/persistence/Migrations/043_UpdateDrain.test.ts
layer("043_UpdateDrain", (it) => {
========
layer("044_UpdateDrain", (it) => {
>>>>>>>> 8104aad471 (fix(lastcode): keep checkpoint migrations replayable (#95)):apps/server/src/persistence/Migrations/044_UpdateDrain.test.ts
  it.effect("creates a narrow event stream and durable command receipts", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

<<<<<<<< HEAD:apps/server/src/persistence/Migrations/049_UpdateDrain.test.ts
      yield* runMigrations({ toMigrationInclusive: 48 });
      yield* runMigrations({ toMigrationInclusive: 49 });
|||||||| parent of 8104aad471 (fix(lastcode): keep checkpoint migrations replayable (#95)):apps/server/src/persistence/Migrations/043_UpdateDrain.test.ts
      yield* runMigrations({ toMigrationInclusive: 42 });
      yield* runMigrations({ toMigrationInclusive: 43 });
========
      yield* runMigrations({ toMigrationInclusive: 43 });
      yield* runMigrations({ toMigrationInclusive: 44 });
>>>>>>>> 8104aad471 (fix(lastcode): keep checkpoint migrations replayable (#95)):apps/server/src/persistence/Migrations/044_UpdateDrain.test.ts

      const eventColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(update_drain_events)
      `;
      const receiptColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(update_drain_command_receipts)
      `;

      assert.deepStrictEqual(
        eventColumns.map((column) => column.name),
        [
          "sequence",
          "event_id",
          "event_type",
          "command_id",
          "occurred_at",
          "request_id",
          "target_version",
          "status",
        ],
      );
      assert.ok(receiptColumns.some((column) => column.name === "command_id"));
      assert.ok(!eventColumns.some((column) => column.name.includes("blocker")));
      assert.ok(!eventColumns.some((column) => column.name.includes("quiet")));
    }),
  );
});
