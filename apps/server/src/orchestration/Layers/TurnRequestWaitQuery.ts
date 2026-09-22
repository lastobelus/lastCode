import { MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../../persistence/Errors.ts";
import type { TurnRequestWaitState } from "../Services/OrchestrationEngine.ts";

const WaitRow = Schema.Struct({
  correlationState: Schema.Literals(["pending", "started", "error", "interrupted"]),
  turnId: Schema.NullOr(TurnId),
  turnState: Schema.NullOr(Schema.Literals(["running", "completed", "error", "interrupted"])),
  assistantMessageId: Schema.NullOr(MessageId),
  response: Schema.NullOr(Schema.String),
  responseStreaming: Schema.NullOr(Schema.Number),
  latestFinalizedAssistantResponse: Schema.NullOr(Schema.String),
  assistantFinalizedAt: Schema.NullOr(Schema.String),
  sessionStatus: Schema.NullOr(
    Schema.Literals(["idle", "starting", "running", "ready", "interrupted", "stopped", "error"]),
  ),
  sessionActiveTurnId: Schema.NullOr(TurnId),
});

export const resolveTurnRequestWaitState = (value: typeof WaitRow.Type): TurnRequestWaitState => {
  if (value.correlationState === "error" || value.correlationState === "interrupted") {
    return { kind: "terminal", state: value.correlationState };
  }
  if (value.turnId !== null && value.turnState !== null && value.turnState !== "running") {
    if (
      value.turnState === "interrupted" &&
      value.sessionStatus === "running" &&
      value.sessionActiveTurnId === value.turnId
    ) {
      return { kind: "pending" };
    }
    if (value.turnState === "completed") {
      if (value.assistantFinalizedAt === null) {
        return { kind: "pending" };
      }
      if (value.assistantMessageId === null) {
        return { kind: "terminal", state: "completed", turnId: value.turnId, response: "" };
      }
      if (value.response === null) {
        if (value.assistantMessageId !== MessageId.make(`assistant:${value.turnId}`)) {
          return { kind: "pending" };
        }
        if (value.latestFinalizedAssistantResponse !== null) {
          return {
            kind: "terminal",
            state: "completed",
            turnId: value.turnId,
            response: value.latestFinalizedAssistantResponse,
          };
        }
        return { kind: "terminal", state: "completed", turnId: value.turnId, response: "" };
      }
      if (value.responseStreaming !== 0) {
        return { kind: "pending" };
      }
      return {
        kind: "terminal",
        state: "completed",
        turnId: value.turnId,
        response: value.response,
      };
    }
    return { kind: "terminal", state: value.turnState, turnId: value.turnId };
  }
  return { kind: "pending" };
};

export const makeTurnRequestWaitQuery = (sql: SqlClient.SqlClient) => {
  const getRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: ThreadId, messageId: MessageId }),
    Result: WaitRow,
    execute: ({ threadId, messageId }) => sql`
      SELECT correlations.state AS "correlationState", correlations.turn_id AS "turnId",
        turns.state AS "turnState", turns.assistant_message_id AS "assistantMessageId",
        messages.text AS "response", messages.is_streaming AS "responseStreaming",
        latest_finalized_assistant.text AS "latestFinalizedAssistantResponse",
        finalizations.finalized_at AS "assistantFinalizedAt",
        sessions.status AS "sessionStatus", sessions.active_turn_id AS "sessionActiveTurnId"
      FROM projection_turn_request_correlations AS correlations
      LEFT JOIN projection_turns AS turns
        ON turns.thread_id = correlations.thread_id AND turns.turn_id = correlations.turn_id
      LEFT JOIN projection_thread_messages AS messages
        ON messages.message_id = turns.assistant_message_id
      LEFT JOIN projection_thread_messages AS latest_finalized_assistant
        ON latest_finalized_assistant.message_id = (
          SELECT candidate.message_id
          FROM projection_thread_messages AS candidate
          WHERE candidate.thread_id = correlations.thread_id
            AND candidate.turn_id = correlations.turn_id
            AND candidate.role = 'assistant'
            AND candidate.is_streaming = 0
            AND candidate.message_id != ('assistant:' || correlations.turn_id)
          ORDER BY candidate.updated_at DESC, candidate.created_at DESC, candidate.message_id DESC
          LIMIT 1
        )
      LEFT JOIN projection_turn_assistant_finalizations AS finalizations
        ON finalizations.thread_id = correlations.thread_id
          AND finalizations.turn_id = correlations.turn_id
      LEFT JOIN projection_thread_sessions AS sessions
        ON sessions.thread_id = correlations.thread_id
      WHERE correlations.thread_id = ${threadId} AND correlations.message_id = ${messageId}
      LIMIT 1
    `,
  });

  const getState = (input: { readonly threadId: ThreadId; readonly messageId: MessageId }) =>
    Effect.gen(function* () {
      const threads = yield* sql<{ readonly found: number }>`
        SELECT 1 AS found FROM projection_threads
        WHERE thread_id = ${input.threadId} AND deleted_at IS NULL LIMIT 1
      `;
      if (threads.length === 0) return { kind: "thread-not-found" } as const;
      const row = yield* getRow(input);
      if (Option.isNone(row)) return { kind: "correlation-not-found" } as const;
      return resolveTurnRequestWaitState(row.value);
    }).pipe(
      Effect.mapError((cause) =>
        Schema.isSchemaError(cause)
          ? toPersistenceDecodeError("TurnRequestWaitQuery.getState:decode")(cause)
          : toPersistenceSqlError("TurnRequestWaitQuery.getState:query")(cause),
      ),
    ) satisfies Effect.Effect<TurnRequestWaitState, ProjectionRepositoryError>;

  return { getState };
};
