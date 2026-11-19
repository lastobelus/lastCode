// @effect-diagnostics nodeBuiltinImport:off -- Compare hashes of the persisted JSON bytes.
import * as NodeCrypto from "node:crypto";
import {
  EnvironmentId,
  EventId,
  HistoricalThreadCreatorEvidenceDigest,
  ThreadCreatorOrigin,
  getInteractiveThreadParentThreadId,
  type OrchestrationV2AppThread,
  OrchestrationV2AppThreadJson,
  ThreadId,
} from "@t3tools/contracts";
import { threadAnnotationsOf } from "@t3tools/shared/threadAnnotation";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

import * as EventSink from "./EventSink.ts";

const RepairResult = Schema.Struct({ threadId: ThreadId, status: Schema.String });

class HistoricalThreadCreatorRepairError extends Schema.TaggedError<HistoricalThreadCreatorRepairError>()(
  "HistoricalThreadCreatorRepairError",
  {
    cause: Schema.Defect(),
    failedThreadId: Schema.optional(ThreadId),
    completed: Schema.optional(Schema.Array(RepairResult)),
  },
) {
  override get message(): string {
    return typeof this.cause === "string"
      ? this.cause
      : "Failed to repair historical thread creators.";
  }
}
export const isHistoricalThreadCreatorRepairError = Schema.is(HistoricalThreadCreatorRepairError);

const decodeThread = Schema.decodeEffect(Schema.fromJsonString(OrchestrationV2AppThreadJson));
const decodeThreadId = Schema.decodeUnknownEffect(ThreadId);
const decodeOrigin = Schema.decodeEffect(Schema.fromJsonString(ThreadCreatorOrigin));

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
      origin: ThreadCreatorOrigin,
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
    thread.creatorOrigin === undefined &&
    thread.delegatedFrom == null &&
    thread.forkedFrom === null &&
    thread.lineage.parentThreadId === null &&
    thread.lineage.relationshipToParent === null &&
    thread.lineage.rootThreadId === thread.id
  );
}

function sameCreatorOrigin(a: ThreadCreatorOrigin, b: ThreadCreatorOrigin) {
  return (
    a.environmentId === b.environmentId &&
    a.threadId === b.threadId &&
    (a.kind === "thread_launch"
      ? b.kind === "thread_launch"
      : b.kind === "scheduled_task" && a.scheduledTaskId === b.scheduledTaskId)
  );
}

const repairEventIdPrefix = "historical-thread-creator-v1:";
const repairEventId = (threadId: ThreadId) => EventId.make(`${repairEventIdPrefix}${threadId}`);

function localCreatorEvidence(
  sql: SqlClient.SqlClient,
  candidateQuery: Statement.Statement<unknown>,
  useEvidenceIndex: boolean,
) {
  // The launch path reused one ID for creation and its initial message. Other sender
  // attribution is not creation evidence. createThreads recorded a typed timeline item.
  // CROSS JOIN keeps candidates outermost; INDEXED BY prevents SQLite from choosing
  // a whole-history scan when statistics are absent or an old thread has no evidence.
  return sql<{
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
      AND message.command_id IN (candidate.command_id, candidate.command_id || ':initial-message')
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
    CROSS JOIN orchestration_events AS record ${sql.literal(
      useEvidenceIndex ? "INDEXED BY orchestration_events_v2_thread_created_target_idx" : "",
    )}
      ON CAST(json_extract(record.payload_json, '$.targetThreadId') AS TEXT) = candidate.thread_id
    WHERE record.application_event_version = 2
      AND record.aggregate_kind = 'thread'
      AND record.event_type = 'turn-item.updated'
      AND record.command_id IS NOT NULL
      AND record.sequence > candidate.sequence
      AND json_extract(record.payload_json, '$.type') = 'thread_created'
      AND json_extract(record.payload_json, '$.threadId') = record.stream_id
    UNION ALL
    SELECT candidate.thread_id, json_extract(message.payload_json, '$.senderThreadId') AS creator_thread_id,
           candidate.payload_json
    FROM candidates AS candidate
    INNER JOIN orchestration_command_receipts AS receipt
      ON receipt.command_id IN (candidate.command_id, candidate.command_id || ':initial-message')
    INNER JOIN orchestration_v2_projection_messages AS message
      ON message.thread_id = candidate.thread_id AND message.message_id = candidate.thread_id
    WHERE candidate.command_id = candidate.thread_id
      AND receipt.aggregate_kind = 'thread' AND receipt.aggregate_id = candidate.thread_id
      AND receipt.status = 'accepted'
      AND (
        (receipt.command_id = candidate.command_id AND receipt.command_type = 'thread.create')
        OR (receipt.command_id = candidate.command_id || ':initial-message'
          AND receipt.command_type = 'message.dispatch')
      )
      AND receipt.result_sequence > candidate.sequence
      AND json_extract(message.payload_json, '$.id') = candidate.thread_id
      AND json_extract(message.payload_json, '$.threadId') = candidate.thread_id
      AND json_extract(message.payload_json, '$.role') = 'user'
      AND json_extract(message.payload_json, '$.createdBy') = 'agent'
      AND json_extract(message.payload_json, '$.creationSource') = 'mcp'
      AND json_type(message.payload_json, '$.senderThreadId') = 'text'
    UNION ALL
    -- create_threads shares its namespace, request key and index across the create
    -- and record commands. The projected item ID percent-encodes that record command.
    SELECT candidate.thread_id, item.thread_id AS creator_thread_id, candidate.payload_json
    FROM candidates AS candidate
    INNER JOIN orchestration_command_receipts AS receipt
      ON receipt.command_id = replace(candidate.command_id, ':create-thread:', ':record-created-thread:')
    INNER JOIN orchestration_v2_projection_turn_items AS item
      ON item.turn_item_id = 'turn-item:created-thread:' ||
        replace(replace(receipt.command_id, '%', '%25'), ':', '%3A')
    WHERE candidate.command_id LIKE 'command:mcp:%:create-thread:%'
      AND candidate.thread_id = 'thread:mcp:' ||
        replace(substr(candidate.command_id, length('command:mcp:') + 1), ':create-thread:', ':')
      AND receipt.aggregate_kind = 'thread' AND receipt.aggregate_id = item.thread_id
      AND receipt.command_type = 'thread.created.record' AND receipt.status = 'accepted'
      AND receipt.result_sequence > candidate.sequence
      AND item.type = 'thread_created' AND item.status = 'completed'
      AND json_extract(item.payload_json, '$.id') = item.turn_item_id
      AND json_extract(item.payload_json, '$.threadId') = item.thread_id
      AND json_extract(item.payload_json, '$.targetThreadId') = candidate.thread_id
  `;
}

function anotherCreation(
  sql: SqlClient.SqlClient,
  threadId: string | Statement.Fragment,
  sequence: number | Statement.Fragment,
) {
  return sql`SELECT 1 FROM orchestration_events AS duplicate
    WHERE duplicate.aggregate_kind = 'thread' AND duplicate.stream_id = ${threadId}
      AND duplicate.event_type = 'thread.created' AND duplicate.application_event_version = 2
      AND duplicate.sequence <> ${sequence}`;
}

// The enclosing repair spans trace the graph read and its use.
const localCreatorGraph = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  environmentId: EnvironmentId,
) {
  const rows = yield* sql<{ readonly thread_id: string; readonly parent_thread_id: string | null }>`
    SELECT thread_id, COALESCE(
      CASE WHEN json_extract(payload_json, '$.creatorOrigin.environmentId') = ${environmentId}
        THEN json_extract(payload_json, '$.creatorOrigin.threadId')
      END,
      json_extract(payload_json, '$.creatorThreadId'),
      json_extract(payload_json, '$.lineage.parentThreadId')
    ) AS parent_thread_id
    FROM orchestration_v2_projection_threads
  `;
  return new Map(rows.map((row) => [row.thread_id, row.parent_thread_id]));
});

function firstRepeatedCreator(threadId: ThreadId, parents: ReadonlyMap<string, string | null>) {
  const visited = new Set<string>([threadId]);
  let ancestor = parents.get(threadId);
  while (ancestor != null && !visited.has(ancestor)) {
    visited.add(ancestor);
    ancestor = parents.get(ancestor);
  }
  return ancestor;
}

const scheduleFireSuffix =
  /^(?:\d+:(?:scheduled|manual)|webhook:delivery:(?:relay:)?[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

/** Runs before command admission: recover only provenance recorded by the old MCP launch paths. */
export const repairHistoricalThreadCreators = Effect.fn("repairHistoricalThreadCreators")(
  function* (environmentId: EnvironmentId) {
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
        AND json_extract(created.payload_json, '$.delegatedFrom') IS NULL
        AND json_type(created.payload_json, '$.creatorOrigin') IS NULL
        AND COALESCE(created.command_id, '') NOT LIKE 'scheduled-task:%'
        AND json_extract(created.payload_json, '$.createdAt') = json_extract(current.payload_json, '$.createdAt')
        AND NOT EXISTS (${anotherCreation(sql, sql.literal("created.stream_id"), sql.literal("created.sequence"))})
        AND json_type(current.payload_json, '$.creatorThreadId') IS NULL
        AND json_type(current.payload_json, '$.creatorOrigin') IS NULL
        AND json_extract(current.payload_json, '$.delegatedFrom') IS NULL
        AND current.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM orchestration_events AS repaired
          WHERE repaired.event_id = ${repairEventIdPrefix} || current.thread_id
        )
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

    const rows = yield* localCreatorEvidence(sql, candidateQuery, true);
    if (rows.length === 0) return 0;

    const evidence = new Map<string, Set<string>>();
    for (const row of rows) {
      const creators = evidence.get(row.thread_id) ?? new Set<string>();
      creators.add(row.creator_thread_id);
      evidence.set(row.thread_id, creators);
    }
    const skipped = {
      conflictingEvidence: 0,
      invalidTarget: 0,
      invalidCreator: 0,
      wouldMove: 0,
      wouldHideAnnotation: 0,
      missingCreator: 0,
      cycle: 0,
      stale: 0,
    };
    const candidates = new Map<
      ThreadId,
      { readonly before: string; readonly creatorThreadId: ThreadId }
    >();
    const checked = new Set<string>();
    for (const row of rows) {
      if (checked.has(row.thread_id)) continue;
      checked.add(row.thread_id);
      if (evidence.get(row.thread_id)?.size !== 1) {
        skipped.conflictingEvidence += 1;
        continue;
      }
      const decoded = yield* decodeThread(row.payload_json).pipe(Effect.option);
      if (decoded._tag === "None" || !eligibleForRepair(decoded.value)) {
        skipped.invalidTarget += 1;
        continue;
      }
      const thread = decoded.value;
      const creator = yield* decodeThreadId(row.creator_thread_id).pipe(Effect.option);
      if (creator._tag === "None") {
        skipped.invalidCreator += 1;
        continue;
      }
      const creatorThreadId = creator.value;
      const repaired = { ...thread, creatorThreadId };
      if (
        getInteractiveThreadParentThreadId(thread) !== getInteractiveThreadParentThreadId(repaired)
      ) {
        skipped.wouldMove += 1;
        continue;
      }
      if (threadAnnotationsOf(thread).length !== threadAnnotationsOf(repaired).length) {
        skipped.wouldHideAnnotation += 1;
        continue;
      }
      const exists = yield* sql`SELECT 1 FROM orchestration_v2_projection_threads
        WHERE thread_id = ${creatorThreadId}`;
      if (exists.length === 0) {
        skipped.missingCreator += 1;
        continue;
      }
      candidates.set(thread.id, { before: row.payload_json, creatorThreadId });
    }
    const logSkips = () =>
      Object.values(skipped).some((count) => count > 0)
        ? Effect.logInfo("Skipped historical thread creator evidence", skipped)
        : Effect.void;
    if (candidates.size === 0) {
      yield* logSkips();
      return 0;
    }

    const parents = yield* localCreatorGraph(sql, environmentId);
    for (const [threadId, candidate] of candidates)
      parents.set(threadId, candidate.creatorThreadId);
    const now = yield* DateTime.now;
    let repaired = 0;
    for (const [threadId, candidate] of candidates) {
      // Check the whole proposed graph before writing, so cyclic candidates cannot partly apply.
      if (firstRepeatedCreator(threadId, parents) != null) {
        skipped.cycle += 1;
        continue;
      }
      const committed = yield* sink.write({
        onlyIf: sql`SELECT 1 FROM orchestration_v2_projection_threads
        WHERE thread_id = ${threadId} AND payload_json = ${candidate.before}`.pipe(
          Effect.map((rows) => rows.length === 1),
        ),
        events: [
          {
            id: repairEventId(threadId),
            type: "thread.creator-repaired",
            threadId,
            occurredAt: now,
            payload: {
              kind: "local",
              creatorThreadId: candidate.creatorThreadId,
              origin: { kind: "thread_launch", environmentId, threadId: candidate.creatorThreadId },
            },
          },
        ],
      });
      repaired += committed.length;
      if (committed.length === 0) skipped.stale += 1;
    }
    yield* logSkips();
    return repaired;
  },
  Effect.mapError((cause) => new HistoricalThreadCreatorRepairError({ cause })),
);

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
    const hasEvidenceIndex =
      (yield* sql`SELECT 1 FROM sqlite_schema
      WHERE type = 'index' AND name = 'orchestration_events_v2_thread_created_target_idx'`).length >
      0;
    const scheduledEntries = input.entries.filter(
      ({ origin }) => origin.kind === "scheduled_task" && origin.environmentId === environmentId,
    );
    const parents =
      scheduledEntries.length > 0
        ? yield* localCreatorGraph(sql, environmentId)
        : new Map<string, string | null>();
    // The enclosing repair and event-write spans already trace entry checks.
    const assessEntry = Effect.fnUntraced(function* (
      entry: HistoricalThreadCreatorRepairManifest["entries"][number],
    ) {
      const { threadId, origin } = entry;
      const [row] = yield* sql<{ readonly payload_json: string }>`
          SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
        `;
      if (!row) return "missing-target";
      const thread = yield* decodeThread(row.payload_json).pipe(Effect.option);
      if (thread._tag === "None") return "invalid-target-payload";
      const target = thread.value;
      const current = target.creatorOrigin;
      const id = repairEventId(threadId);
      const [previous] = yield* sql<{
        readonly kind: string | null;
        readonly creation_id: string | null;
        readonly creation_hash: string | null;
        readonly evidence_hash: string | null;
        readonly expected_hash: string | null;
        readonly origin_json: string | null;
      }>`
          SELECT json_extract(payload_json, '$.kind') AS kind,
            json_extract(payload_json, '$.creationEventId') AS creation_id,
            json_extract(payload_json, '$.creationPayloadSha256') AS creation_hash,
            json_extract(payload_json, '$.evidenceSha256') AS evidence_hash,
            json_extract(payload_json, '$.expectedPayloadSha256') AS expected_hash,
            json_extract(payload_json, '$.origin') AS origin_json
          FROM orchestration_events
          WHERE event_id = ${id} AND stream_id = ${threadId} AND event_type = 'thread.creator-repaired'
        `;
      if (current !== undefined) {
        if (!sameCreatorOrigin(current, origin)) return "conflicting-origin";
        if (
          previous?.kind !== "scoped" ||
          previous.creation_id !== entry.creationEventId ||
          previous.creation_hash !== entry.creationPayloadSha256 ||
          previous.evidence_hash !== entry.evidenceSha256 ||
          previous.expected_hash !== entry.expectedPayloadSha256 ||
          previous.origin_json === null
        )
          return "conflicting-repair-evidence";
        const committedOrigin = yield* decodeOrigin(previous.origin_json).pipe(Effect.option);
        return committedOrigin._tag === "Some" && sameCreatorOrigin(committedOrigin.value, origin)
          ? "already-repaired"
          : "conflicting-repair-evidence";
      }
      if (previous !== undefined) return "repair-projection-missing";
      if (target.creatorThreadId != null || target.delegatedFrom != null) {
        return "conflicting-origin";
      }
      if (!eligibleForRepair(target)) return "ineligible-target";
      if (sha256(row.payload_json) !== entry.expectedPayloadSha256) return "stale-target";
      const [created] = yield* sql<{
        readonly command_id: string | null;
        readonly payload_json: string;
        readonly sequence: number;
      }>`
          SELECT command_id, payload_json, sequence FROM orchestration_events
          WHERE event_id = ${entry.creationEventId} AND stream_id = ${threadId}
            AND aggregate_kind = 'thread' AND event_type = 'thread.created'
            AND application_event_version = 2
        `;
      if (!created || sha256(created.payload_json) !== entry.creationPayloadSha256) {
        return "missing-creation-evidence";
      }
      if ((yield* anotherCreation(sql, threadId, created.sequence)).length !== 0) {
        return "ambiguous-creation";
      }
      const original = yield* decodeThread(created.payload_json).pipe(Effect.option);
      if (
        original._tag === "None" ||
        original.value.id !== threadId ||
        DateTime.toEpochMillis(original.value.createdAt) !==
          DateTime.toEpochMillis(target.createdAt) ||
        !eligibleForRepair(original.value)
      )
        return "conflicting-creation-evidence";
      const localEvidence = yield* localCreatorEvidence(
        sql,
        sql`
          SELECT ${threadId} AS thread_id, ${created.command_id} AS command_id,
            ${created.sequence} AS sequence, ${row.payload_json} AS payload_json
        `,
        hasEvidenceIndex,
      );
      if (localEvidence.length > 0) return "conflicting-local-evidence";
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
          !scheduleFireSuffix.test(created.command_id.slice(scheduledPrefix.length))
        ) {
          return "invalid-schedule-evidence";
        }
        const messageId = `scheduled-task-message:${created.command_id.slice("scheduled-task:".length)}`;
        const mismatched = yield* sql`SELECT 1
          FROM orchestration_v2_projection_messages AS message
          LEFT JOIN orchestration_v2_projection_runs AS run ON run.run_id = message.run_id
            AND run.thread_id = message.thread_id
          WHERE message.message_id = ${messageId} AND message.thread_id = ${threadId}
            AND message.role = 'user'
            AND (
              json_extract(message.payload_json, '$.scheduledTaskId') <> ${origin.scheduledTaskId}
              OR json_extract(run.payload_json, '$.scheduledTaskId') <> ${origin.scheduledTaskId}
            )`;
        if (mismatched.length > 0) return "conflicting-scheduled-task";
        if (!parents.has(origin.threadId)) return "missing-schedule-creator";
      }
      return "eligible";
    });
    const results: Array<typeof RepairResult.Type> = [];
    const annotateFailure = (threadId: ThreadId) => (cause: unknown) =>
      new HistoricalThreadCreatorRepairError({
        cause,
        failedThreadId: threadId,
        completed: [...results],
      });
    const scheduledPlan = new Map<ThreadId, string>();
    for (const entry of scheduledEntries) {
      const status = yield* assessEntry(entry).pipe(
        Effect.mapError(annotateFailure(entry.threadId)),
      );
      scheduledPlan.set(entry.threadId, status);
      if (status === "eligible") parents.set(entry.threadId, entry.origin.threadId);
    }
    const cyclicEntries = scheduledEntries.filter(
      ({ threadId }) =>
        scheduledPlan.get(threadId) === "eligible" &&
        firstRepeatedCreator(threadId, parents) === threadId,
    );
    // Remove only the proposed cycle members before checking paths that lead to them.
    for (const { threadId } of cyclicEntries) {
      scheduledPlan.set(threadId, "creator-cycle");
      parents.set(threadId, null);
    }
    for (const entry of input.entries) {
      const { threadId, origin } = entry;
      const scheduledStatus = scheduledPlan.get(threadId);
      if (scheduledStatus !== undefined && scheduledStatus !== "eligible") {
        results.push({ threadId, status: scheduledStatus });
        continue;
      }
      if (scheduledStatus === "eligible" && firstRepeatedCreator(threadId, parents) != null) {
        results.push({ threadId, status: "creator-cycle" });
        continue;
      }
      const assess = assessEntry(entry);
      if (!apply) {
        const status =
          scheduledStatus ?? (yield* assess.pipe(Effect.mapError(annotateFailure(threadId))));
        results.push({ threadId, status });
        continue;
      }
      const decision = { status: "not-checked" };
      const committed = yield* sink
        .write({
          onlyIf: assess.pipe(
            Effect.map((status) => {
              decision.status = status;
              return status === "eligible";
            }),
          ),
          events: [
            {
              id: repairEventId(threadId),
              type: "thread.creator-repaired",
              threadId,
              occurredAt: now,
              payload: {
                kind: "scoped",
                origin,
                creationEventId: entry.creationEventId,
                creationPayloadSha256: entry.creationPayloadSha256,
                expectedPayloadSha256: entry.expectedPayloadSha256,
                evidenceSha256: entry.evidenceSha256,
              },
            },
          ],
        })
        .pipe(Effect.mapError(annotateFailure(threadId)));
      results.push({
        threadId,
        status: committed.length > 0 ? "repaired" : decision.status,
      });
    }
    return results;
  },
  Effect.mapError((cause) =>
    isHistoricalThreadCreatorRepairError(cause)
      ? cause
      : new HistoricalThreadCreatorRepairError({ cause }),
  ),
);
