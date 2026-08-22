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
});

export const makeTurnRequestWaitQuery = (sql: SqlClient.SqlClient) => {
  const getRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: ThreadId, messageId: MessageId }),
    Result: WaitRow,
    execute: ({ threadId, messageId }) => sql`
      SELECT correlations.state AS "correlationState", correlations.turn_id AS "turnId",
        turns.state AS "turnState", turns.assistant_message_id AS "assistantMessageId",
        messages.text AS "response"
      FROM projection_turn_request_correlations AS correlations
      LEFT JOIN projection_turns AS turns
        ON turns.thread_id = correlations.thread_id AND turns.turn_id = correlations.turn_id
      LEFT JOIN projection_thread_messages AS messages
        ON messages.message_id = turns.assistant_message_id
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
      const value = row.value;
      if (value.correlationState === "error" || value.correlationState === "interrupted") {
        return { kind: "terminal", state: value.correlationState } as const;
      }
      if (value.turnId !== null && value.turnState !== null && value.turnState !== "running") {
        if (value.turnState === "completed") {
          if (value.assistantMessageId === null || value.response === null) {
            return { kind: "pending" } as const;
          }
          return {
            kind: "terminal",
            state: "completed",
            turnId: value.turnId,
            response: value.response,
          } as const;
        }
        return {
          kind: "terminal",
          state: value.turnState,
          turnId: value.turnId,
        } as const;
      }
      return { kind: "pending" } as const;
    }).pipe(
      Effect.mapError((cause) =>
        Schema.isSchemaError(cause)
          ? toPersistenceDecodeError("TurnRequestWaitQuery.getState:decode")(cause)
          : toPersistenceSqlError("TurnRequestWaitQuery.getState:query")(cause),
      ),
    ) satisfies Effect.Effect<TurnRequestWaitState, ProjectionRepositoryError>;

  return { getState };
};
