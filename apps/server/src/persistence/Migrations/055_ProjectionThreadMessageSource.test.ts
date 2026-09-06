import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("055_ProjectionThreadMessageSource", (it) => {
  it.effect("adds nullable source thread provenance to projected messages", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 54 });
      const before = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_messages)
      `;
      assert.isFalse(before.some((column) => column.name === "source_thread_id"));

      const executed = yield* runMigrations({ toMigrationInclusive: 55 });
      assert.deepStrictEqual(executed, [[55, "ProjectionThreadMessageSource"]]);

      const after = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_messages)
      `;
      assert.equal(after.filter((column) => column.name === "source_thread_id").length, 1);
    }),
  );
});
