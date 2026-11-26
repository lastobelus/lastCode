import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // TEXT affinity lets SQLite seek the expression index against thread IDs.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_threads_owned_parent_idx
    ON orchestration_v2_projection_threads(CAST(json_extract(payload_json, '$.lineage.parentThreadId') AS TEXT))
    WHERE json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent'
  `;
});
