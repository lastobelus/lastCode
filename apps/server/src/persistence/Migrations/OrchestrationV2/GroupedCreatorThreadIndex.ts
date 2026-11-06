import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_threads_grouped_creator_idx
    ON orchestration_v2_projection_threads(CAST(json_extract(payload_json, '$.creatorThreadId') AS TEXT))
    WHERE deleted_at IS NULL
      AND json_extract(payload_json, '$.createdBy') = 'agent'
      AND json_extract(payload_json, '$.creatorThreadId') IS NOT NULL
      AND json_extract(payload_json, '$.creatorGrouping') = 'grouped'
      AND json_extract(payload_json, '$.lineage.parentThreadId') IS NULL
      AND json_extract(payload_json, '$.lineage.relationshipToParent') IS NULL
      AND json_extract(payload_json, '$.forkedFrom') IS NULL
  `;
});
