import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("043_ProjectionThreadAnnotation", (it) => {
  it.effect("adds annotation and latest user marker fields to thread projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 42 });

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
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          '2026-02-24T00:00:00.000Z',
          '2026-02-24T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES
          (
            'message-user-1',
            'thread-1',
            'user',
            'First',
            0,
            '2026-02-24T00:01:00.000Z',
            '2026-02-24T00:01:00.000Z'
          ),
          (
            'message-user-2',
            'thread-1',
            'user',
            'Second',
            0,
            '2026-02-24T00:01:00.000Z',
            '2026-02-24T00:01:00.000Z'
          )
      `;
      yield* runMigrations({ toMigrationInclusive: 43 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_threads)
      `;
      const annotationJson = columns.find((column) => column.name === "annotation_json");
      const latestUserMessageId = columns.find(
        (column) => column.name === "latest_user_message_id",
      );

      assert.equal(annotationJson?.name, "annotation_json");
      assert.equal(annotationJson?.notnull, 0);
      assert.equal(latestUserMessageId?.name, "latest_user_message_id");
      assert.equal(latestUserMessageId?.notnull, 0);

      const rows = yield* sql<{ readonly latestUserMessageId: string | null }>`
        SELECT latest_user_message_id AS "latestUserMessageId"
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;
      assert.equal(rows[0]?.latestUserMessageId, "message-user-2");
    }),
  );
});
