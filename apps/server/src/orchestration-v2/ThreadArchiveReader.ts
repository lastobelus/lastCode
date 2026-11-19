import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { interactiveThreadParentSql } from "./InteractiveThreadParentSql.ts";

export const readArchiveFamilyThreadIds = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  sql<{ readonly thread_id: string }>`
        WITH RECURSIVE family(thread_id) AS (
          SELECT ${threadId}
          UNION
          SELECT child.thread_id FROM orchestration_v2_projection_threads AS child
          JOIN family ON CAST(json_extract(child.payload_json, '$.lineage.parentThreadId') AS TEXT) = family.thread_id
          WHERE json_extract(child.payload_json, '$.lineage.relationshipToParent') = 'subagent'
            AND json_extract(child.payload_json, '$.lineage.independent') IS NOT 1
          UNION
          SELECT child.thread_id FROM orchestration_v2_projection_threads AS child
          JOIN family ON ${interactiveThreadParentSql(sql, "child")} = family.thread_id
          JOIN orchestration_v2_projection_threads AS parent ON parent.thread_id = family.thread_id
          WHERE child.deleted_at IS NULL AND child.project_id = parent.project_id
        )
        SELECT thread_id FROM family
      `.pipe(Effect.map((rows) => rows.map((row) => ThreadId.make(row.thread_id))));
