import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Keep these expressions and predicates aligned with ThreadArchiveReader's indexed lookups.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_threads_archive_creator_owner_idx
    ON orchestration_v2_projection_threads(
      CAST(CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.creatorOrigin.threadId') END AS TEXT)
    )
    WHERE CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.creatorOrigin.owned') END = 1
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_threads_archive_delegated_owner_idx
    ON orchestration_v2_projection_threads(
      CAST(CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.delegatedFrom.threadId') END AS TEXT)
    )
    WHERE CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.delegatedFrom.threadId') END IS NOT NULL
  `;
});
