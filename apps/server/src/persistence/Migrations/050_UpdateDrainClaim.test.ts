import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

<<<<<<<< HEAD:apps/server/src/persistence/Migrations/050_UpdateDrainClaim.test.ts
layer("050_UpdateDrainClaim", (it) => {
|||||||| parent of 8104aad471 (fix(lastcode): keep checkpoint migrations replayable (#95)):apps/server/src/persistence/Migrations/044_UpdateDrainClaim.test.ts
layer("044_UpdateDrainClaim", (it) => {
========
layer("045_UpdateDrainClaim", (it) => {
>>>>>>>> 8104aad471 (fix(lastcode): keep checkpoint migrations replayable (#95)):apps/server/src/persistence/Migrations/045_UpdateDrainClaim.test.ts
  it.effect("preserves drain history and accepts one claimed transition", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
<<<<<<<< HEAD:apps/server/src/persistence/Migrations/050_UpdateDrainClaim.test.ts
      yield* runMigrations({ toMigrationInclusive: 49 });
|||||||| parent of 8104aad471 (fix(lastcode): keep checkpoint migrations replayable (#95)):apps/server/src/persistence/Migrations/044_UpdateDrainClaim.test.ts
      yield* runMigrations({ toMigrationInclusive: 43 });
========
      yield* runMigrations({ toMigrationInclusive: 44 });
>>>>>>>> 8104aad471 (fix(lastcode): keep checkpoint migrations replayable (#95)):apps/server/src/persistence/Migrations/045_UpdateDrainClaim.test.ts
      yield* sql`
        INSERT INTO update_drain_events (
          event_id, event_type, command_id, occurred_at, request_id, target_version, status
        ) VALUES (
          'event-start', 'update-drain.started', 'command-start',
          '2026-08-21T00:00:00.000Z', 'request-1', '1.2.3', 'draining'
        )
      `;
<<<<<<<< HEAD:apps/server/src/persistence/Migrations/050_UpdateDrainClaim.test.ts
      yield* runMigrations({ toMigrationInclusive: 50 });
|||||||| parent of 8104aad471 (fix(lastcode): keep checkpoint migrations replayable (#95)):apps/server/src/persistence/Migrations/044_UpdateDrainClaim.test.ts
      yield* runMigrations({ toMigrationInclusive: 44 });
========
      yield* runMigrations({ toMigrationInclusive: 45 });
>>>>>>>> 8104aad471 (fix(lastcode): keep checkpoint migrations replayable (#95)):apps/server/src/persistence/Migrations/045_UpdateDrainClaim.test.ts
      yield* sql`
        INSERT INTO update_drain_events (
          event_id, event_type, command_id, occurred_at, request_id, target_version, status
        ) VALUES (
          'event-claim', 'update-drain.claimed', 'command-claim',
          '2026-08-21T00:01:00.000Z', 'request-1', '1.2.3', 'claimed'
        )
      `;

      const events = yield* sql<{ readonly eventType: string; readonly status: string }>`
        SELECT event_type AS "eventType", status
        FROM update_drain_events
        ORDER BY sequence ASC
      `;
      assert.deepStrictEqual(events, [
        { eventType: "update-drain.started", status: "draining" },
        { eventType: "update-drain.claimed", status: "claimed" },
      ]);
    }),
  );
});
