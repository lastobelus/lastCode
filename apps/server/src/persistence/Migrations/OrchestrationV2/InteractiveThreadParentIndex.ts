import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Keep this historical expression frozen. The traversal query-plan test uses
  // the runtime expression to catch changes that would stop matching this index.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_threads_interactive_parent_idx
    ON orchestration_v2_projection_threads(
      CAST(CASE
        WHEN json_extract(payload_json, '$.deletedAt') IS NOT NULL THEN NULL
        WHEN json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent'
          AND (json_extract(payload_json, '$.lineage.independent') IS NOT 1
            OR json_extract(payload_json, '$.creationSource') = 'provider') THEN NULL
        WHEN json_type(payload_json, '$.groupedUnderThreadId') IS NOT NULL
          THEN CAST(json_extract(payload_json, '$.groupedUnderThreadId') AS TEXT)
        WHEN json_extract(payload_json, '$.createdBy') = 'agent'
          AND json_extract(payload_json, '$.creatorGrouping') = 'grouped'
          AND json_extract(payload_json, '$.lineage.parentThreadId') IS NULL
          AND json_extract(payload_json, '$.lineage.relationshipToParent') IS NULL
          AND json_extract(payload_json, '$.lineage.independent') IS NOT 1
          AND json_extract(payload_json, '$.forkedFrom') IS NULL
          THEN CAST(json_extract(payload_json, '$.creatorThreadId') AS TEXT)
        ELSE NULL END AS TEXT)
    )
    WHERE deleted_at IS NULL
  `;
});
