import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration0044 from "./044_ProjectionThreadAnnotation.ts";
import Migration0045 from "./045_UpdateDrain.ts";
import Migration0046 from "./046_UpdateDrainClaim.ts";
import Migration0047 from "./047_ProjectionTurnRequestCorrelations.ts";
import Migration0048 from "./048_ProjectionThreadWorktreeCleanup.ts";
import Migration0049 from "./049_ProjectionThreadLinkedPullRequest.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("050_ProjectionThreadsUnsettledAt", (it) => {
  it.effect("bridges databases whose old ledger would skip the new upstream migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 41 });
      yield* Migration0044;
      yield* Migration0045;
      yield* Migration0046;
      yield* Migration0047;
      yield* Migration0048;
      yield* Migration0049;
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

      const executed = yield* runMigrations({ toMigrationInclusive: 50 });
      assert.deepStrictEqual(executed, [
        [49, "ProjectionThreadLinkedPullRequest"],
        [50, "ProjectionThreadsUnsettledAt"],
      ]);

      const after = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.equal(after.filter((column) => column.name === "linked_pull_request_json").length, 1);
      assert.equal(after.filter((column) => column.name === "unsettled_at").length, 1);
    }),
  );
});
