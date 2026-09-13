import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import Migration0048 from "./048_ProjectionThreadAnnotation.ts";
import Migration0049 from "./049_UpdateDrain.ts";
import Migration0050 from "./050_UpdateDrainClaim.ts";
import Migration0051 from "./051_ProjectionTurnRequestCorrelations.ts";
import Migration0052 from "./052_ProjectionThreadWorktreeCleanup.ts";
import Migration0053 from "./053_ProjectionThreadLinkedPullRequest.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("054_ProjectionThreadsUnsettledAt", (it) => {
  it.effect("bridges databases whose old ledger would skip the new upstream migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 41 });
      yield* Migration0048;
      yield* Migration0049;
      yield* Migration0050;
      yield* Migration0051;
      yield* Migration0052;
      yield* Migration0053;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (42, 'ProjectionThreadAnnotation'),
          (43, 'ProjectionThreadAnnotation'),
          (44, 'UpdateDrain'),
          (45, 'UpdateDrainClaim'),
          (46, 'ProjectionTurnRequestCorrelations'),
          (47, 'ProjectionThreadWorktreeCleanup'),
          (48, 'ProjectionThreadLinkedPullRequest')
      `;

      const before = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.isFalse(before.some((column) => column.name === "unsettled_at"));

      const executed = yield* runMigrations({ toMigrationInclusive: 54 });
      assert.deepStrictEqual(executed, [
        [49, "UpdateDrain"],
        [50, "UpdateDrainClaim"],
        [51, "ProjectionTurnRequestCorrelations"],
        [52, "ProjectionThreadWorktreeCleanup"],
        [53, "ProjectionThreadLinkedPullRequest"],
        [54, "ProjectionThreadsUnsettledAt"],
      ]);

      const after = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.equal(after.filter((column) => column.name === "linked_pull_request_json").length, 1);
      assert.equal(after.filter((column) => column.name === "unsettled_at").length, 1);
    }),
  );
});
