import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The blob key cannot be a MessageId. It reserves IDs in corrupt histories without decoding them.
  yield* sql`CREATE INDEX orchestration_v2_runs_read_authorization_idx
    ON orchestration_v2_projection_runs(thread_id, CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.userMessageId') ELSE X'' END)`;
  yield* sql`CREATE INDEX orchestration_v2_requests_read_authorization_idx
    ON orchestration_v2_projection_runtime_requests(thread_id, CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.threadReadContext.authorizationId') ELSE X'' END)`;
  yield* sql`CREATE INDEX orchestration_v2_messages_read_authorization_idx
    ON orchestration_v2_projection_messages(thread_id, CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.threadReadContext.authorizationId') ELSE X'' END)
    WHERE role = 'user'`;
});
