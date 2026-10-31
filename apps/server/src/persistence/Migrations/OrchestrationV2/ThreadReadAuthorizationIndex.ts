import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX orchestration_v2_runs_read_authorization_idx
    ON orchestration_v2_projection_runs(thread_id, json_extract(payload_json, '$.userMessageId'))`;
  yield* sql`CREATE INDEX orchestration_v2_requests_read_authorization_idx
    ON orchestration_v2_projection_runtime_requests(thread_id, json_extract(payload_json, '$.threadReadContext.authorizationId'))`;
  yield* sql`CREATE INDEX orchestration_v2_messages_read_authorization_idx
    ON orchestration_v2_projection_messages(thread_id, json_extract(payload_json, '$.threadReadContext.authorizationId'))
    WHERE role = 'user'`;
});
