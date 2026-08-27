import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
<<<<<<<< HEAD:apps/server/src/persistence/Migrations/053_ProjectionThreadLinkedPullRequest.test.ts
import Migration0048 from "./048_ProjectionThreadAnnotation.ts";
import Migration0049 from "./049_UpdateDrain.ts";
import Migration0050 from "./050_UpdateDrainClaim.ts";
import Migration0051 from "./051_ProjectionTurnRequestCorrelations.ts";
import Migration0052 from "./052_ProjectionThreadWorktreeCleanup.ts";
import Migration0053 from "./053_ProjectionThreadLinkedPullRequest.ts";
|||||||| parent of 6f3273be76 (fix(lastcode): make checkpoint failures self-reporting (#101)):apps/server/src/persistence/Migrations/048_ProjectionThreadLinkedPullRequest.test.ts
import Migration0043 from "./043_ProjectionThreadAnnotation.ts";
import Migration0044 from "./044_UpdateDrain.ts";
import Migration0045 from "./045_UpdateDrainClaim.ts";
import Migration0046 from "./046_ProjectionTurnRequestCorrelations.ts";
import Migration0047 from "./047_ProjectionThreadWorktreeCleanup.ts";
import Migration0048 from "./048_ProjectionThreadLinkedPullRequest.ts";
========
import Migration0044 from "./044_ProjectionThreadAnnotation.ts";
import Migration0045 from "./045_UpdateDrain.ts";
import Migration0046 from "./046_UpdateDrainClaim.ts";
import Migration0047 from "./047_ProjectionTurnRequestCorrelations.ts";
import Migration0048 from "./048_ProjectionThreadWorktreeCleanup.ts";
import Migration0049 from "./049_ProjectionThreadLinkedPullRequest.ts";
>>>>>>>> 6f3273be76 (fix(lastcode): make checkpoint failures self-reporting (#101)):apps/server/src/persistence/Migrations/049_ProjectionThreadLinkedPullRequest.test.ts

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

<<<<<<<< HEAD:apps/server/src/persistence/Migrations/053_ProjectionThreadLinkedPullRequest.test.ts
layer("053_ProjectionThreadLinkedPullRequest", (it) => {
|||||||| parent of 6f3273be76 (fix(lastcode): make checkpoint failures self-reporting (#101)):apps/server/src/persistence/Migrations/048_ProjectionThreadLinkedPullRequest.test.ts
layer("048_ProjectionThreadLinkedPullRequest", (it) => {
========
layer("049_ProjectionThreadLinkedPullRequest", (it) => {
>>>>>>>> 6f3273be76 (fix(lastcode): make checkpoint failures self-reporting (#101)):apps/server/src/persistence/Migrations/049_ProjectionThreadLinkedPullRequest.test.ts
  it.effect("bridges databases that recorded the previous LastCode migration numbers", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 41 });
<<<<<<<< HEAD:apps/server/src/persistence/Migrations/053_ProjectionThreadLinkedPullRequest.test.ts
      yield* Migration0048;
      yield* Migration0049;
      yield* Migration0050;
      yield* Migration0051;
      yield* Migration0052;
|||||||| parent of 6f3273be76 (fix(lastcode): make checkpoint failures self-reporting (#101)):apps/server/src/persistence/Migrations/048_ProjectionThreadLinkedPullRequest.test.ts
      yield* Migration0043;
      yield* Migration0044;
      yield* Migration0045;
      yield* Migration0046;
      yield* Migration0047;
========
      yield* Migration0044;
      yield* Migration0045;
      yield* Migration0046;
      yield* Migration0047;
      yield* Migration0048;
>>>>>>>> 6f3273be76 (fix(lastcode): make checkpoint failures self-reporting (#101)):apps/server/src/persistence/Migrations/049_ProjectionThreadLinkedPullRequest.test.ts
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (42, 'ProjectionThreadAnnotation'),
          (43, 'UpdateDrain'),
          (44, 'UpdateDrainClaim'),
          (45, 'ProjectionTurnRequestCorrelations'),
          (46, 'ProjectionThreadWorktreeCleanup')
      `;

      const before = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.isFalse(before.some((column) => column.name === "linked_pull_request_json"));

<<<<<<<< HEAD:apps/server/src/persistence/Migrations/053_ProjectionThreadLinkedPullRequest.test.ts
      const executed = yield* runMigrations({ toMigrationInclusive: 53 });
|||||||| parent of 6f3273be76 (fix(lastcode): make checkpoint failures self-reporting (#101)):apps/server/src/persistence/Migrations/048_ProjectionThreadLinkedPullRequest.test.ts
      const executed = yield* runMigrations({ toMigrationInclusive: 48 });
========
      const executed = yield* runMigrations({ toMigrationInclusive: 49 });
>>>>>>>> 6f3273be76 (fix(lastcode): make checkpoint failures self-reporting (#101)):apps/server/src/persistence/Migrations/049_ProjectionThreadLinkedPullRequest.test.ts
      assert.deepStrictEqual(executed, [
<<<<<<<< HEAD:apps/server/src/persistence/Migrations/053_ProjectionThreadLinkedPullRequest.test.ts
        [47, "ProjectionProjectIcon"],
        [48, "ProjectionThreadAnnotation"],
        [49, "UpdateDrain"],
        [50, "UpdateDrainClaim"],
        [51, "ProjectionTurnRequestCorrelations"],
        [52, "ProjectionThreadWorktreeCleanup"],
        [53, "ProjectionThreadLinkedPullRequest"],
|||||||| parent of 6f3273be76 (fix(lastcode): make checkpoint failures self-reporting (#101)):apps/server/src/persistence/Migrations/048_ProjectionThreadLinkedPullRequest.test.ts
        [47, "ProjectionThreadWorktreeCleanup"],
        [48, "ProjectionThreadLinkedPullRequest"],
========
        [47, "ProjectionTurnRequestCorrelations"],
        [48, "ProjectionThreadWorktreeCleanup"],
        [49, "ProjectionThreadLinkedPullRequest"],
>>>>>>>> 6f3273be76 (fix(lastcode): make checkpoint failures self-reporting (#101)):apps/server/src/persistence/Migrations/049_ProjectionThreadLinkedPullRequest.test.ts
      ]);

<<<<<<<< HEAD:apps/server/src/persistence/Migrations/053_ProjectionThreadLinkedPullRequest.test.ts
      yield* Migration0053;
|||||||| parent of 6f3273be76 (fix(lastcode): make checkpoint failures self-reporting (#101)):apps/server/src/persistence/Migrations/048_ProjectionThreadLinkedPullRequest.test.ts
      yield* Migration0048;
========
      yield* Migration0049;
>>>>>>>> 6f3273be76 (fix(lastcode): make checkpoint failures self-reporting (#101)):apps/server/src/persistence/Migrations/049_ProjectionThreadLinkedPullRequest.test.ts
      const after = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.equal(after.filter((column) => column.name === "linked_pull_request_json").length, 1);
    }),
  );
});

const partialUpgradeLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

<<<<<<<< HEAD:apps/server/src/persistence/Migrations/053_ProjectionThreadLinkedPullRequest.test.ts
partialUpgradeLayer("053_ProjectionThreadLinkedPullRequest partial upgrades", (it) => {
  it.effect("preserves update drain data when upgrading from the previous migration 44", () =>
|||||||| parent of 6f3273be76 (fix(lastcode): make checkpoint failures self-reporting (#101)):apps/server/src/persistence/Migrations/048_ProjectionThreadLinkedPullRequest.test.ts
partialUpgradeLayer("048_ProjectionThreadLinkedPullRequest partial upgrades", (it) => {
  it.effect("preserves update drain data when upgrading from the previous migration 44", () =>
========
partialUpgradeLayer("049_ProjectionThreadLinkedPullRequest partial upgrades", (it) => {
  it.effect("preserves update drain data recorded with the previous migration numbers", () =>
>>>>>>>> 6f3273be76 (fix(lastcode): make checkpoint failures self-reporting (#101)):apps/server/src/persistence/Migrations/049_ProjectionThreadLinkedPullRequest.test.ts
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 41 });
<<<<<<<< HEAD:apps/server/src/persistence/Migrations/053_ProjectionThreadLinkedPullRequest.test.ts
      yield* Migration0048;
      yield* Migration0049;
      yield* Migration0050;
|||||||| parent of 6f3273be76 (fix(lastcode): make checkpoint failures self-reporting (#101)):apps/server/src/persistence/Migrations/048_ProjectionThreadLinkedPullRequest.test.ts
      yield* Migration0043;
      yield* Migration0044;
      yield* Migration0045;
========
      yield* Migration0044;
      yield* Migration0045;
      yield* Migration0046;
>>>>>>>> 6f3273be76 (fix(lastcode): make checkpoint failures self-reporting (#101)):apps/server/src/persistence/Migrations/049_ProjectionThreadLinkedPullRequest.test.ts
      yield* sql`
        INSERT INTO update_drain_events (
          event_id, event_type, command_id, occurred_at, request_id, target_version, status
        ) VALUES (
          'event-claimed', 'update-drain.claimed', 'command-event',
          '2026-08-25T00:00:00.000Z', 'request-1', '1.2.3', 'claimed'
        )
      `;
      yield* sql`
        INSERT INTO update_drain_command_receipts (
          command_id, command_type, request_id, target_version, accepted_at,
          result_sequence, status, error_reason, error
        ) VALUES (
          'command-receipt', 'update-drain.claim', 'request-1', '1.2.3',
          '2026-08-25T00:00:01.000Z', 1, 'accepted', NULL, NULL
        )
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (42, 'ProjectionThreadAnnotation'),
          (43, 'UpdateDrain'),
          (44, 'UpdateDrainClaim')
      `;

<<<<<<<< HEAD:apps/server/src/persistence/Migrations/053_ProjectionThreadLinkedPullRequest.test.ts
      const executed = yield* runMigrations({ toMigrationInclusive: 53 });
|||||||| parent of 6f3273be76 (fix(lastcode): make checkpoint failures self-reporting (#101)):apps/server/src/persistence/Migrations/048_ProjectionThreadLinkedPullRequest.test.ts
      const executed = yield* runMigrations({ toMigrationInclusive: 48 });
========
      const executed = yield* runMigrations({ toMigrationInclusive: 49 });
>>>>>>>> 6f3273be76 (fix(lastcode): make checkpoint failures self-reporting (#101)):apps/server/src/persistence/Migrations/049_ProjectionThreadLinkedPullRequest.test.ts
      assert.deepStrictEqual(executed, [
<<<<<<<< HEAD:apps/server/src/persistence/Migrations/053_ProjectionThreadLinkedPullRequest.test.ts
        [45, "ProjectionProjectsAutoPull"],
        [46, "RepairAutomaticSettlementTimestamps"],
        [47, "ProjectionProjectIcon"],
        [48, "ProjectionThreadAnnotation"],
        [49, "UpdateDrain"],
        [50, "UpdateDrainClaim"],
        [51, "ProjectionTurnRequestCorrelations"],
        [52, "ProjectionThreadWorktreeCleanup"],
        [53, "ProjectionThreadLinkedPullRequest"],
|||||||| parent of 6f3273be76 (fix(lastcode): make checkpoint failures self-reporting (#101)):apps/server/src/persistence/Migrations/048_ProjectionThreadLinkedPullRequest.test.ts
        [45, "UpdateDrainClaim"],
        [46, "ProjectionTurnRequestCorrelations"],
        [47, "ProjectionThreadWorktreeCleanup"],
        [48, "ProjectionThreadLinkedPullRequest"],
========
        [45, "UpdateDrain"],
        [46, "UpdateDrainClaim"],
        [47, "ProjectionTurnRequestCorrelations"],
        [48, "ProjectionThreadWorktreeCleanup"],
        [49, "ProjectionThreadLinkedPullRequest"],
>>>>>>>> 6f3273be76 (fix(lastcode): make checkpoint failures self-reporting (#101)):apps/server/src/persistence/Migrations/049_ProjectionThreadLinkedPullRequest.test.ts
      ]);

      const events = yield* sql<{
        readonly eventType: string;
        readonly status: string;
      }>`
        SELECT event_type AS "eventType", status
        FROM update_drain_events
        WHERE event_id = 'event-claimed'
      `;
      assert.deepStrictEqual(events, [{ eventType: "update-drain.claimed", status: "claimed" }]);

      const receipts = yield* sql<{
        readonly commandType: string;
        readonly status: string;
      }>`
        SELECT command_type AS "commandType", status
        FROM update_drain_command_receipts
        WHERE command_id = 'command-receipt'
      `;
      assert.deepStrictEqual(receipts, [{ commandType: "update-drain.claim", status: "accepted" }]);
    }),
  );
});
