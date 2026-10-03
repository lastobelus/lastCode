import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import { runLastCodeMigrations } from "../LastCodeMigrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("051_ProjectionTurnRequestCorrelations", (it) => {
  it.effect("creates thread-scoped correlation and finalization keys with constrained states", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* runLastCodeMigrations({ toMigrationInclusive: 4 });
      yield* sql`
        INSERT INTO projection_turn_request_correlations
          (thread_id, message_id, state, requested_at)
        VALUES
          ('thread-1', 'message-1', 'pending', '2026-08-22T00:00:00.000Z'),
          ('thread-2', 'message-1', 'pending', '2026-08-22T00:00:01.000Z')
      `;
      assert.deepStrictEqual(
        yield* sql<{ readonly turnId: string | null; readonly resolvedAt: string | null }>`
          SELECT turn_id AS "turnId", resolved_at AS "resolvedAt"
          FROM projection_turn_request_correlations WHERE thread_id = 'thread-1'
        `,
        [{ turnId: null, resolvedAt: null }],
      );
      assert.equal(
        (yield* Effect.exit(sql`
          INSERT INTO projection_turn_request_correlations
            (thread_id, message_id, state, requested_at)
          VALUES ('thread-1', 'message-1', 'pending', '2026-08-22T00:00:02.000Z')
        `))._tag,
        "Failure",
      );
      for (const state of ["started", "error", "interrupted"] as const) {
        yield* sql`
          UPDATE projection_turn_request_correlations
          SET turn_id = 'turn-1', state = ${state}, resolved_at = '2026-08-22T00:00:03.000Z'
          WHERE thread_id = 'thread-1' AND message_id = 'message-1'
        `;
        assert.deepStrictEqual(
          yield* sql<{
            readonly state: "pending" | "started" | "error" | "interrupted";
            readonly turnId: string | null;
            readonly requestedAt: string;
            readonly resolvedAt: string | null;
          }>`
            SELECT state, turn_id AS "turnId", requested_at AS "requestedAt", resolved_at AS "resolvedAt"
            FROM projection_turn_request_correlations WHERE thread_id = 'thread-1'
          `,
          [
            {
              state,
              turnId: "turn-1",
              requestedAt: "2026-08-22T00:00:00.000Z",
              resolvedAt: "2026-08-22T00:00:03.000Z",
            },
          ],
        );
      }
      assert.equal(
        (yield* Effect.exit(sql`
          UPDATE projection_turn_request_correlations SET state = 'completed'
          WHERE thread_id = 'thread-1' AND message_id = 'message-1'
        `))._tag,
        "Failure",
      );
      yield* sql`
        INSERT INTO projection_turn_assistant_finalizations (thread_id, turn_id, finalized_at)
        VALUES
          ('thread-1', 'turn-1', '2026-08-22T00:00:04.000Z'),
          ('thread-2', 'turn-1', '2026-08-22T00:00:05.000Z')
      `;
      assert.equal(
        (yield* Effect.exit(sql`
          INSERT INTO projection_turn_assistant_finalizations (thread_id, turn_id, finalized_at)
          VALUES ('thread-1', 'turn-1', '2026-08-22T00:00:06.000Z')
        `))._tag,
        "Failure",
      );
      yield* runLastCodeMigrations({ toMigrationInclusive: 4 });
      assert.deepStrictEqual(
        yield* sql<{ readonly finalizedAt: string }>`
          SELECT finalized_at AS "finalizedAt"
          FROM projection_turn_assistant_finalizations
          WHERE thread_id = 'thread-1' AND turn_id = 'turn-1'
        `,
        [{ finalizedAt: "2026-08-22T00:00:04.000Z" }],
      );
      yield* sql`DELETE FROM projection_turn_request_correlations WHERE thread_id = 'thread-1'`;
      yield* sql`DELETE FROM projection_turn_assistant_finalizations WHERE thread_id = 'thread-1'`;
      assert.deepStrictEqual(
        yield* sql<{ readonly threadId: string }>`
          SELECT thread_id AS "threadId" FROM projection_turn_request_correlations
        `,
        [{ threadId: "thread-2" }],
      );
      assert.deepStrictEqual(
        yield* sql<{ readonly threadId: string; readonly finalizedAt: string }>`
          SELECT thread_id AS "threadId", finalized_at AS "finalizedAt"
          FROM projection_turn_assistant_finalizations
        `,
        [{ threadId: "thread-2", finalizedAt: "2026-08-22T00:00:05.000Z" }],
      );
    }),
  );
});
