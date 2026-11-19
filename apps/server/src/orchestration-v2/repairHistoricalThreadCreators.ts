// @effect-diagnostics nodeBuiltinImport:off -- Compare hashes of the persisted JSON bytes.
import * as NodeCrypto from "node:crypto";
import {
  EnvironmentId,
  EventId,
  HistoricalThreadCreatorEvidenceDigest,
  HistoricalThreadCreatorOrigin,
  getInteractiveThreadParentThreadId,
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

export const HistoricalThreadCreatorRepairManifest = Schema.Struct({
  version: Schema.Literal(1),
  environmentId: EnvironmentId,
  entries: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      creationEventId: EventId,
      creationPayloadSha256: HistoricalThreadCreatorEvidenceDigest,
      expectedPayloadSha256: HistoricalThreadCreatorEvidenceDigest,
      evidenceSha256: HistoricalThreadCreatorEvidenceDigest,
      origin: HistoricalThreadCreatorOrigin,
    }),
  ),
});
type HistoricalThreadCreatorRepairManifest = typeof HistoricalThreadCreatorRepairManifest.Type;

const sha256 = (payload: string) => NodeCrypto.createHash("sha256").update(payload).digest("hex");

function eligibleForRepair(thread: OrchestrationV2AppThread) {
  return (
    thread.deletedAt === null &&
    thread.createdBy === "agent" &&
    thread.creationSource === "mcp" &&
    thread.creatorThreadId == null &&
    thread.historicalCreatorOrigin === undefined &&
    thread.delegatedFrom == null &&
    thread.forkedFrom === null &&
    thread.lineage.parentThreadId === null &&
    thread.lineage.relationshipToParent === null &&
    thread.lineage.rootThreadId === thread.id
  );
}

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
        AND json_type(current.payload_json, '$.historicalCreatorOrigin') IS NULL
        AND json_extract(current.payload_json, '$.delegatedFrom') IS NULL
        AND current.deleted_at IS NULL
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
  const candidates = new Map<
    ThreadId,
    { readonly before: string; readonly creatorThreadId: ThreadId }
  >();
  for (const row of rows) {
    if (evidence.get(row.thread_id)?.size !== 1 || !parents.has(row.creator_thread_id)) continue;
    const thread = yield* decodeThread(row.payload_json);
    if (!eligibleForRepair(thread)) continue;
    const creatorThreadId = yield* decodeThreadId(row.creator_thread_id);
    if (
      getInteractiveThreadParentThreadId(thread) !==
      getInteractiveThreadParentThreadId({ ...thread, creatorThreadId })
    )
      continue;
    candidates.set(thread.id, {
      before: row.payload_json,
      creatorThreadId,
    });
    parents.set(thread.id, creatorThreadId);
  }

  const now = yield* DateTime.now;
  let repaired = 0;
  for (const [threadId, candidate] of candidates) {
    const visited = new Set<string>([threadId]);
    let ancestor = parents.get(threadId);
    while (ancestor != null && !visited.has(ancestor)) {
      visited.add(ancestor);
      ancestor = parents.get(ancestor);
    }
    // Check the whole proposed graph before writing, so cyclic candidates cannot partly apply.
    if (ancestor != null) continue;
    const committed = yield* sink.write({
      onlyIf: sql`SELECT 1 FROM orchestration_v2_projection_threads
        WHERE thread_id = ${threadId} AND payload_json = ${candidate.before}`.pipe(
        Effect.map((rows) => rows.length === 1),
      ),
      events: [
        {
          id: EventId.make(`historical-thread-creator-v1:${threadId}`),
          type: "thread.creator-repaired",
          threadId,
          occurredAt: now,
          payload: { kind: "local", creatorThreadId: candidate.creatorThreadId },
        },
      ],
    });
    repaired += committed.length;
  }
  return repaired;
}).pipe(Effect.mapError((cause) => new HistoricalThreadCreatorRepairError({ cause })));

/** The operator verifies and freezes source evidence on both environments before making a manifest. */
export const repairScopedHistoricalThreadCreators = Effect.fn(
  "repairScopedHistoricalThreadCreators",
)(
  function* (
    input: HistoricalThreadCreatorRepairManifest,
    environmentId: EnvironmentId,
    apply: boolean,
  ) {
    if (
      input.environmentId !== environmentId ||
      new Set(input.entries.map(({ threadId }) => threadId)).size !== input.entries.length
    ) {
      return yield* new HistoricalThreadCreatorRepairError({
        cause: "Expected a manifest for this environment with unique target thread IDs.",
      });
    }
    const sql = yield* SqlClient.SqlClient;
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const results = [];
    for (const entry of input.entries) {
      const { threadId, origin } = entry;
      const assess = Effect.gen(function* () {
        const [row] = yield* sql<{ readonly payload_json: string }>`
          SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
        `;
        if (!row) return "missing-target";
        const thread = yield* decodeThread(row.payload_json).pipe(Effect.option);
        if (thread._tag === "None") return "invalid-target-payload";
        const target = thread.value;
        const current = target.historicalCreatorOrigin;
        if (current !== undefined) {
          return current.environmentId === origin.environmentId &&
            current.threadId === origin.threadId &&
            (current.kind === "thread_launch"
              ? origin.kind === "thread_launch"
              : origin.kind === "scheduled_task" &&
                current.scheduledTaskId === origin.scheduledTaskId)
            ? "already-repaired"
            : "conflicting-origin";
        }
        if (target.creatorThreadId != null || target.delegatedFrom != null) {
          return "conflicting-origin";
        }
        if (!eligibleForRepair(target)) return "ineligible-target";
        if (sha256(row.payload_json) !== entry.expectedPayloadSha256) return "stale-target";
        const [created] = yield* sql<{
          readonly command_id: string | null;
          readonly payload_json: string;
        }>`
          SELECT command_id, payload_json FROM orchestration_events
          WHERE event_id = ${entry.creationEventId} AND stream_id = ${threadId}
            AND aggregate_kind = 'thread' AND event_type = 'thread.created'
            AND application_event_version = 2
        `;
        if (!created || sha256(created.payload_json) !== entry.creationPayloadSha256) {
          return "missing-creation-evidence";
        }
        if (origin.kind === "thread_launch") {
          if (origin.environmentId === environmentId || created.command_id !== threadId) {
            return "invalid-launch-evidence";
          }
        } else {
          const scheduledPrefix = `scheduled-task:${origin.scheduledTaskId}:`;
          if (
            origin.environmentId !== environmentId ||
            origin.threadId === threadId ||
            !created.command_id?.startsWith(scheduledPrefix) ||
            !/^\d+:scheduled$/.test(created.command_id.slice(scheduledPrefix.length))
          ) {
            return "invalid-schedule-evidence";
          }
          const creator = yield* sql`SELECT 1 FROM orchestration_v2_projection_threads
            WHERE thread_id = ${origin.threadId} AND deleted_at IS NULL`;
          if (creator.length !== 1) return "missing-schedule-creator";
        }
        return "eligible";
      });
      if (!apply) {
        results.push({ threadId, status: yield* assess });
        continue;
      }
      const decision = { status: "not-checked" };
      const committed = yield* sink.write({
        onlyIf: assess.pipe(
          Effect.map((status) => {
            decision.status = status;
            return status === "eligible";
          }),
        ),
        events: [
          {
            id: EventId.make(`historical-thread-creator-v1:${threadId}`),
            type: "thread.creator-repaired",
            threadId,
            occurredAt: now,
            payload: { kind: "scoped", origin, evidenceSha256: entry.evidenceSha256 },
          },
        ],
      });
      results.push({
        threadId,
        status: committed.length > 0 ? "repaired" : decision.status,
      });
    }
    return results;
  },
  Effect.mapError((cause) => new HistoricalThreadCreatorRepairError({ cause })),
);
