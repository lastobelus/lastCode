import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import Migration0057 from "./057_ProjectionThreadAttention.ts";

const projectionColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projectColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  return { projectColumns, threadColumns };
});

interface ProjectionColumns {
  readonly projectColumns: ReadonlyArray<{ readonly name: string }>;
  readonly threadColumns: ReadonlyArray<{ readonly name: string }>;
}

const assertRepaired = (columns: ProjectionColumns) => {
  assert.equal(
    columns.projectColumns.filter((column) => column.name === "project_icon_json").length,
    1,
  );
  assert.equal(
    columns.threadColumns.filter((column) => column.name === "attention_json").length,
    1,
  );
};

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "058_RepairMigration57ProjectionColumns project icon history",
  (it) => {
    it.effect("repairs databases that recorded migration 57 as project icon", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 56 });
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (57, 'ProjectionProjectIcon')
        `;

        const before = yield* projectionColumns;
        assert.equal(
          before.projectColumns.some((column) => column.name === "project_icon_json"),
          true,
        );
        assert.equal(
          before.threadColumns.some((column) => column.name === "attention_json"),
          false,
        );

        const executed = yield* runMigrations({ toMigrationInclusive: 58 });
        assert.deepStrictEqual(executed, [[58, "RepairMigration57ProjectionColumns"]]);
        assertRepaired(yield* projectionColumns);
      }),
    );
  },
);

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "058_RepairMigration57ProjectionColumns thread attention history",
  (it) => {
    it.effect("repairs databases that recorded migration 57 as thread attention", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 56 });
        yield* sql`ALTER TABLE projection_projects DROP COLUMN project_icon_json`;
        yield* Migration0057;
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (57, 'ProjectionThreadAttention')
        `;

        const before = yield* projectionColumns;
        assert.equal(
          before.projectColumns.some((column) => column.name === "project_icon_json"),
          false,
        );
        assert.equal(
          before.threadColumns.some((column) => column.name === "attention_json"),
          true,
        );

        const executed = yield* runMigrations({ toMigrationInclusive: 58 });
        assert.deepStrictEqual(executed, [[58, "RepairMigration57ProjectionColumns"]]);
        assertRepaired(yield* projectionColumns);
      }),
    );
  },
);
