import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "annotation_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN annotation_json TEXT
    `;
  }

  if (!columns.some((column) => column.name === "latest_user_message_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN latest_user_message_id TEXT
    `;
  }

  yield* sql`
    UPDATE projection_threads
    SET latest_user_message_id = (
      SELECT messages.message_id
      FROM projection_thread_messages AS messages
      WHERE messages.thread_id = projection_threads.thread_id
        AND messages.role = 'user'
      ORDER BY messages.created_at DESC, messages.message_id DESC
      LIMIT 1
    )
  `;
});
