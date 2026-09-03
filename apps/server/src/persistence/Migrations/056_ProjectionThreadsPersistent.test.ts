import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("056_ProjectionThreadsPersistent", (it) => {
  it.effect("adds a false-by-default persistent marker", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 55 });
      const executed = yield* runMigrations({ toMigrationInclusive: 56 });
      assert.deepStrictEqual(executed, [[56, "ProjectionThreadsPersistent"]]);
      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
      }>`PRAGMA table_info(projection_threads)`;
      const persistent = columns.find((column) => column.name === "persistent");
      assert.deepInclude(persistent, { notnull: 1, dflt_value: "0" });
    }),
  );
});
