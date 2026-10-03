import { ActionResumeState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** One-time cutover of retained Action process state into the native run ledger. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const encodeState = Schema.encodeEffect(Schema.fromJsonString(ActionResumeState));
  yield* sql`
    CREATE TABLE action_resume_runs (
      ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      revision INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      output_tail TEXT
    )
  `;
  yield* sql`CREATE INDEX action_resume_runs_thread ON action_resume_runs(thread_id, ordinal)`;

  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table'
      AND name IN ('projection_thread_activities', 'projection_thread_messages')
  `;
  if (!tables.some((table) => table.name === "projection_thread_activities")) return;
  const rows = yield* sql<{ readonly thread_id: string; readonly payload_json: string }>`
    SELECT thread_id, payload_json FROM projection_thread_activities
    WHERE kind = 'action.resume.lifecycle' ORDER BY rowid
  `;
  const decode = Schema.decodeUnknownOption(Schema.fromJsonString(ActionResumeState));
  const states = new Map<string, ActionResumeState>();
  const rank = { armed: 0, pending: 1, available: 2, delivered: 3, disposed: 4 };
  for (const row of rows) {
    const decoded = decode(row.payload_json);
    if (Option.isNone(decoded) || decoded.value.threadId !== row.thread_id) continue;
    const state = decoded.value;
    const current = states.get(state.runId);
    if (
      current === undefined ||
      (state.revision ?? 0) > (current.revision ?? 0) ||
      ((state.revision ?? 0) === (current.revision ?? 0) &&
        rank[state.delivery] > rank[current.delivery])
    ) {
      states.set(state.runId, state);
    }
  }
  for (let state of states.values()) {
    if (tables.some((table) => table.name === "projection_thread_messages")) {
      const delivered = yield* sql`
        SELECT message_id FROM projection_thread_messages
        WHERE thread_id = ${state.threadId}
          AND message_id = ${`action-resume:${state.runId}:follow-up`} LIMIT 1
      `;
      if (delivered.length > 0 && state.delivery !== "disposed") {
        state = { ...state, delivery: "delivered" };
      }
    }
    const stateJson = yield* encodeState(state);
    yield* sql`
      INSERT INTO action_resume_runs (run_id, thread_id, started_at, revision, state_json)
      VALUES (${state.runId}, ${state.threadId}, ${state.startedAt}, ${state.revision ?? 0}, ${stateJson})
      ON CONFLICT (run_id) DO UPDATE SET
        state_json = excluded.state_json, revision = excluded.revision
      WHERE excluded.revision >= action_resume_runs.revision
    `;
  }
});
