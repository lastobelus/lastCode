import {
  EventId,
  type OrchestrationV2AppThread,
  OrchestrationV2AppThreadJson,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "./EventSink.ts";

class HistoricalThreadCreatorRepairError extends Schema.TaggedError<HistoricalThreadCreatorRepairError>()(
  "HistoricalThreadCreatorRepairError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to repair historical thread creators.";
  }
}

const decodeThread = Schema.decodeEffect(Schema.fromJsonString(OrchestrationV2AppThreadJson));
const decodeThreadId = Schema.decodeUnknownEffect(ThreadId);

/** Runs before command admission: recover only provenance recorded by the old MCP launch paths. */
export const repairHistoricalThreadCreators = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sink = yield* EventSink.EventSinkV2;
  const candidateQuery = sql`
      SELECT created.stream_id AS thread_id, created.command_id, created.sequence,
             current.payload_json
      FROM orchestration_events AS created INDEXED BY orchestration_events_v2_created_threads_idx
      INNER JOIN orchestration_v2_projection_threads AS current
        ON current.thread_id = created.stream_id
      WHERE created.application_event_version = 2
        AND created.aggregate_kind = 'thread'
        AND created.event_type = 'thread.created'
        AND json_extract(created.payload_json, '$.createdBy') = 'agent'
        AND json_extract(created.payload_json, '$.creationSource') = 'mcp'
        AND json_type(created.payload_json, '$.creatorThreadId') IS NULL
        AND json_type(current.payload_json, '$.creatorThreadId') IS NULL
        AND json_extract(current.payload_json, '$.createdBy') = 'agent'
        AND json_extract(current.payload_json, '$.creationSource') = 'mcp'
        AND json_extract(current.payload_json, '$.forkedFrom') IS NULL
        AND json_extract(current.payload_json, '$.lineage.parentThreadId') IS NULL
        AND json_extract(current.payload_json, '$.lineage.relationshipToParent') IS NULL
        AND json_extract(current.payload_json, '$.lineage.rootThreadId') = current.thread_id
  `;
  // Most restarts have no eligible old threads; avoid reading message/turn-item history then.
  const pending = yield* sql`SELECT 1 FROM (${candidateQuery}) LIMIT 1`;
  if (pending.length === 0) return 0;

  // The launch path reused one ID for creation and its initial message. Other sender
  // attribution is not creation evidence. createThreads recorded a typed timeline item.
  // CROSS JOIN keeps candidates outermost; INDEXED BY prevents SQLite from choosing
  // a whole-history scan when statistics are absent or an old thread has no evidence.
  const rows = yield* sql<{
    readonly thread_id: string;
    readonly creator_thread_id: string;
    readonly payload_json: string;
  }>`
    WITH candidates AS (${candidateQuery})
    SELECT candidate.thread_id, json_extract(message.payload_json, '$.senderThreadId') AS creator_thread_id,
           candidate.payload_json
    FROM candidates AS candidate
    CROSS JOIN orchestration_events AS message INDEXED BY idx_orch_events_command_id
      ON message.stream_id = candidate.thread_id
      AND message.command_id = candidate.command_id || ':initial-message'
    WHERE candidate.command_id = candidate.thread_id
      AND message.application_event_version = 2
      AND message.aggregate_kind = 'thread'
      AND message.event_type = 'message.updated'
      AND message.sequence > candidate.sequence
      AND json_extract(message.payload_json, '$.id') = candidate.thread_id
      AND json_extract(message.payload_json, '$.threadId') = candidate.thread_id
      AND json_extract(message.payload_json, '$.role') = 'user'
      AND json_extract(message.payload_json, '$.createdBy') = 'agent'
      AND json_extract(message.payload_json, '$.creationSource') = 'mcp'
      AND json_type(message.payload_json, '$.senderThreadId') = 'text'
    UNION ALL
    SELECT candidate.thread_id, record.stream_id AS creator_thread_id, candidate.payload_json
    FROM candidates AS candidate
    CROSS JOIN orchestration_events AS record INDEXED BY orchestration_events_v2_thread_created_target_idx
      ON CAST(json_extract(record.payload_json, '$.targetThreadId') AS TEXT) = candidate.thread_id
    WHERE record.application_event_version = 2
      AND record.aggregate_kind = 'thread'
      AND record.event_type = 'turn-item.updated'
      AND record.command_id IS NOT NULL
      AND record.sequence > candidate.sequence
      AND json_extract(record.payload_json, '$.type') = 'thread_created'
      AND json_extract(record.payload_json, '$.threadId') = record.stream_id
  `;
  if (rows.length === 0) return 0;

  const evidence = new Map<string, Set<string>>();
  for (const row of rows) {
    const creators = evidence.get(row.thread_id) ?? new Set<string>();
    creators.add(row.creator_thread_id);
    evidence.set(row.thread_id, creators);
  }
  const graphRows = yield* sql<{
    readonly thread_id: string;
    readonly parent_thread_id: string | null;
  }>`
    SELECT thread_id, COALESCE(json_extract(payload_json, '$.creatorThreadId'),
      json_extract(payload_json, '$.lineage.parentThreadId')) AS parent_thread_id
    FROM orchestration_v2_projection_threads
  `;
  const parents = new Map(graphRows.map((row) => [row.thread_id, row.parent_thread_id]));
  const candidates = new Map<ThreadId, OrchestrationV2AppThread>();
  for (const row of rows) {
    if (evidence.get(row.thread_id)?.size !== 1 || !parents.has(row.creator_thread_id)) continue;
    const thread = yield* decodeThread(row.payload_json);
    if (
      thread.creatorThreadId !== undefined ||
      thread.createdBy !== "agent" ||
      thread.creationSource !== "mcp" ||
      thread.forkedFrom !== null ||
      thread.lineage.parentThreadId !== null ||
      thread.lineage.relationshipToParent !== null ||
      thread.lineage.rootThreadId !== thread.id
    )
      continue;
    const creatorThreadId = yield* decodeThreadId(row.creator_thread_id);
    candidates.set(thread.id, {
      ...thread,
      creatorThreadId,
      creatorGrouping: thread.creatorGrouping ?? "grouped",
    });
    parents.set(thread.id, creatorThreadId);
  }

  const now = yield* DateTime.now;
  let repaired = 0;
  for (const thread of candidates.values()) {
    const visited = new Set<string>([thread.id]);
    let ancestor = parents.get(thread.id);
    while (ancestor != null && !visited.has(ancestor)) {
      visited.add(ancestor);
      ancestor = parents.get(ancestor);
    }
    // Check the whole proposed graph before writing, so cyclic candidates cannot partly apply.
    if (ancestor != null) continue;
    yield* sink.write({
      events: [
        {
          id: EventId.make(`historical-thread-creator:${thread.id}`),
          type: "thread.metadata-updated",
          threadId: thread.id,
          providerInstanceId: thread.providerInstanceId,
          occurredAt: now,
          payload: thread,
        },
      ],
    });
    repaired += 1;
  }
  return repaired;
}).pipe(Effect.mapError((cause) => new HistoricalThreadCreatorRepairError({ cause })));
