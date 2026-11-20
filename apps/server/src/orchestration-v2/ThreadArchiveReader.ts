import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { interactiveThreadParentSql } from "./InteractiveThreadParentSql.ts";

// Candidate discovery only. The planner qualifies recorded owners with getThreadOwner.
export const readArchiveFamilyThreadIds = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  sql<{ readonly thread_id: string }>`
        WITH RECURSIVE recorded_owner_candidates(thread_id, parent_id) AS MATERIALIZED (
          SELECT thread_id, CAST(json_extract(payload_json, '$.creatorOrigin.threadId') AS TEXT)
          FROM orchestration_v2_projection_threads
          WHERE json_extract(payload_json, '$.creatorOrigin.owned') = 1
          UNION ALL
          SELECT thread_id, CAST(json_extract(payload_json, '$.delegatedFrom.threadId') AS TEXT)
          FROM orchestration_v2_projection_threads
          WHERE json_extract(payload_json, '$.delegatedFrom.threadId') IS NOT NULL
        ), family(thread_id) AS (
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
          UNION
          SELECT child.thread_id FROM recorded_owner_candidates AS child
          JOIN family ON child.parent_id = family.thread_id
        ), groups(thread_id) AS (
          SELECT DISTINCT parent.thread_id
          FROM family
          JOIN orchestration_v2_projection_threads AS child ON child.thread_id = family.thread_id
          JOIN orchestration_v2_projection_threads AS parent
            ON parent.thread_id = ${interactiveThreadParentSql(sql, "child")}
          WHERE child.project_id = parent.project_id
            AND parent.archived_at IS NULL AND parent.deleted_at IS NULL
            AND json_extract(parent.payload_json, '$.groupThread') = 1
        )
        SELECT thread_id FROM family
        UNION
        SELECT thread_id FROM groups
        UNION
        SELECT child.thread_id FROM groups
        JOIN orchestration_v2_projection_threads AS child
          ON ${interactiveThreadParentSql(sql, "child")} = groups.thread_id
        WHERE child.archived_at IS NULL AND child.deleted_at IS NULL
        UNION
        SELECT child.thread_id FROM recorded_owner_candidates AS child
        JOIN groups ON child.parent_id = groups.thread_id
        UNION
        SELECT child.thread_id FROM orchestration_v2_projection_threads AS child
        JOIN groups ON CAST(json_extract(child.payload_json, '$.lineage.parentThreadId') AS TEXT) = groups.thread_id
        WHERE json_extract(child.payload_json, '$.lineage.relationshipToParent') = 'subagent'
          AND child.archived_at IS NULL AND child.deleted_at IS NULL
        UNION
        SELECT child.thread_id FROM orchestration_v2_projection_threads AS child
        JOIN orchestration_v2_projection_threads AS root ON root.thread_id = ${threadId}
        WHERE json_extract(child.payload_json, '$.archivedWith.threadId') =
              json_extract(root.payload_json, '$.archivedWith.threadId')
          AND json_extract(child.payload_json, '$.archivedWith.commandId') =
              json_extract(root.payload_json, '$.archivedWith.commandId')
      `.pipe(Effect.map((rows) => rows.map((row) => ThreadId.make(row.thread_id))));
