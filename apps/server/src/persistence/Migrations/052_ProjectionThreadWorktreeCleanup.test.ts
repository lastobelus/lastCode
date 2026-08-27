import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

<<<<<<<< HEAD:apps/server/src/persistence/Migrations/052_ProjectionThreadWorktreeCleanup.test.ts
<<<<<<<< HEAD:apps/server/src/persistence/Migrations/052_ProjectionThreadWorktreeCleanup.test.ts
layer("052_ProjectionThreadWorktreeCleanup", (it) => {
|||||||| parent of 8104aad471 (fix(lastcode): keep checkpoint migrations replayable (#95)):apps/server/src/persistence/Migrations/046_ProjectionThreadWorktreeCleanup.test.ts
layer("046_ProjectionThreadWorktreeCleanup", (it) => {
========
layer("047_ProjectionThreadWorktreeCleanup", (it) => {
>>>>>>>> 8104aad471 (fix(lastcode): keep checkpoint migrations replayable (#95)):apps/server/src/persistence/Migrations/047_ProjectionThreadWorktreeCleanup.test.ts
|||||||| parent of 6f3273be76 (fix(lastcode): make checkpoint failures self-reporting (#101)):apps/server/src/persistence/Migrations/047_ProjectionThreadWorktreeCleanup.test.ts
layer("047_ProjectionThreadWorktreeCleanup", (it) => {
========
layer("048_ProjectionThreadWorktreeCleanup", (it) => {
>>>>>>>> 6f3273be76 (fix(lastcode): make checkpoint failures self-reporting (#101)):apps/server/src/persistence/Migrations/048_ProjectionThreadWorktreeCleanup.test.ts
  it.effect("adds nullable cleanup state without changing existing rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
<<<<<<<< HEAD:apps/server/src/persistence/Migrations/052_ProjectionThreadWorktreeCleanup.test.ts
<<<<<<<< HEAD:apps/server/src/persistence/Migrations/052_ProjectionThreadWorktreeCleanup.test.ts
      yield* runMigrations({ toMigrationInclusive: 51 });
|||||||| parent of 8104aad471 (fix(lastcode): keep checkpoint migrations replayable (#95)):apps/server/src/persistence/Migrations/046_ProjectionThreadWorktreeCleanup.test.ts
      yield* runMigrations({ toMigrationInclusive: 44 });
========
      yield* runMigrations({ toMigrationInclusive: 46 });
>>>>>>>> 8104aad471 (fix(lastcode): keep checkpoint migrations replayable (#95)):apps/server/src/persistence/Migrations/047_ProjectionThreadWorktreeCleanup.test.ts
|||||||| parent of 6f3273be76 (fix(lastcode): make checkpoint failures self-reporting (#101)):apps/server/src/persistence/Migrations/047_ProjectionThreadWorktreeCleanup.test.ts
      yield* runMigrations({ toMigrationInclusive: 46 });
========
      yield* runMigrations({ toMigrationInclusive: 47 });
>>>>>>>> 6f3273be76 (fix(lastcode): make checkpoint failures self-reporting (#101)):apps/server/src/persistence/Migrations/048_ProjectionThreadWorktreeCleanup.test.ts
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          created_at,
          updated_at
        )
        VALUES (
          'thread-before-cleanup',
          'project-1',
          'Existing thread',
          '{"instanceId":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          '2026-08-23T00:00:00.000Z',
          '2026-08-23T00:00:00.000Z'
        )
      `;

<<<<<<<< HEAD:apps/server/src/persistence/Migrations/052_ProjectionThreadWorktreeCleanup.test.ts
<<<<<<<< HEAD:apps/server/src/persistence/Migrations/052_ProjectionThreadWorktreeCleanup.test.ts
      yield* runMigrations({ toMigrationInclusive: 52 });
|||||||| parent of 8104aad471 (fix(lastcode): keep checkpoint migrations replayable (#95)):apps/server/src/persistence/Migrations/046_ProjectionThreadWorktreeCleanup.test.ts
      yield* runMigrations({ toMigrationInclusive: 46 });
========
      yield* runMigrations({ toMigrationInclusive: 47 });
>>>>>>>> 8104aad471 (fix(lastcode): keep checkpoint migrations replayable (#95)):apps/server/src/persistence/Migrations/047_ProjectionThreadWorktreeCleanup.test.ts
|||||||| parent of 6f3273be76 (fix(lastcode): make checkpoint failures self-reporting (#101)):apps/server/src/persistence/Migrations/047_ProjectionThreadWorktreeCleanup.test.ts
      yield* runMigrations({ toMigrationInclusive: 47 });
========
      yield* runMigrations({ toMigrationInclusive: 48 });
>>>>>>>> 6f3273be76 (fix(lastcode): make checkpoint failures self-reporting (#101)):apps/server/src/persistence/Migrations/048_ProjectionThreadWorktreeCleanup.test.ts

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_threads)
      `;
      const cleanupJson = columns.find((column) => column.name === "worktree_cleanup_json");
      assert.equal(cleanupJson?.notnull, 0);

      const rows = yield* sql<{ readonly cleanup: string | null }>`
        SELECT worktree_cleanup_json AS cleanup
        FROM projection_threads
        WHERE thread_id = 'thread-before-cleanup'
      `;
      assert.equal(rows[0]?.cleanup, null);
    }),
  );
});
