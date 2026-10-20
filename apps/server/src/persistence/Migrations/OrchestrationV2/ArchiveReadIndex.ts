import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_messages_latest_assistant_idx
    ON orchestration_v2_projection_messages(thread_id, updated_at DESC)
    WHERE role = 'assistant'
  `;
});
