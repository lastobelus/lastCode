import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("047_ProjectionThreadWorktreeCleanup", (it) => {
  it.effect("adds nullable cleanup state without changing existing rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 46 });
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

      yield* runMigrations({ toMigrationInclusive: 47 });

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
