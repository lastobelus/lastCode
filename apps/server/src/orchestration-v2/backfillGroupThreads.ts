import { EventId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "./EventSink.ts";
import { interactiveThreadParentSql } from "./InteractiveThreadParentSql.ts";

/** Startup can recognize historical containers by their children, not by an empty title or timeline alone. */
export const backfillGroupThreads = Effect.fn("backfillGroupThreads")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sink = yield* EventSink.EventSinkV2;
  const candidates = yield* sql<{ thread_id: string }>`
    SELECT parent.thread_id
    FROM orchestration_v2_projection_threads AS parent
    WHERE parent.deleted_at IS NULL
      AND parent.active_provider_thread_id IS NULL
      AND json_extract(parent.payload_json, '$.createdBy') = 'agent'
      AND json_extract(parent.payload_json, '$.creationSource') = 'mcp'
      AND json_type(parent.payload_json, '$.groupThread') IS NULL
      AND json_extract(parent.payload_json, '$.historyOrigin') IS NULL
      AND json_extract(parent.payload_json, '$.delegatedFrom') IS NULL
      AND json_extract(parent.payload_json, '$.remoteDelegations') IS NULL
      AND json_extract(parent.payload_json, '$.lineage.parentThreadId') IS NULL
      AND json_extract(parent.payload_json, '$.lineage.relationshipToParent') IS NULL
      AND json_extract(parent.payload_json, '$.lineage.independent') IS NOT 1
      AND json_extract(parent.payload_json, '$.forkedFrom') IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_runs AS run WHERE run.thread_id = parent.thread_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_messages AS message WHERE message.thread_id = parent.thread_id
      )
      AND EXISTS (
        SELECT 1 FROM orchestration_v2_projection_threads AS child
        WHERE ${interactiveThreadParentSql(sql, "child")} = parent.thread_id
          AND child.project_id = parent.project_id
          AND child.thread_id <> parent.thread_id
      )
  `;
  if (candidates.length === 0) return 0;

  const now = yield* DateTime.now;
  const events = candidates.map(({ thread_id }) => ({
    id: EventId.make(`historical-group-thread:${thread_id}`),
    type: "thread.group-marked" as const,
    threadId: ThreadId.make(thread_id),
    occurredAt: now,
    payload: {},
  }));
  const stored = yield* sink.write({ events });
  return stored.length;
});
