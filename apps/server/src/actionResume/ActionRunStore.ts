import { ActionResumeState, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export class ActionRunStoreError extends Schema.TaggedError<ActionRunStoreError>()(
  "ActionRunStoreError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Unable to ${this.operation} retained Project Action state.`;
  }
}

const RetainedActionRun = Schema.Struct({
  state: Schema.fromJsonString(ActionResumeState),
  outputTail: Schema.NullOr(Schema.String.check(Schema.isMaxLength(12_000))),
});
type RetainedActionRun = typeof RetainedActionRun.Type;

export class ActionRunStore extends Context.Service<
  ActionRunStore,
  {
    readonly listLatest: Effect.Effect<ReadonlyArray<ActionResumeState>, ActionRunStoreError>;
    readonly get: (
      threadId: ThreadId,
      runId: string,
    ) => Effect.Effect<Option.Option<RetainedActionRun>, ActionRunStoreError>;
    readonly save: (
      state: ActionResumeState,
      outputTail?: string,
    ) => Effect.Effect<void, ActionRunStoreError>;
  }
>()("t3/actionResume/ActionRunStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const encodeState = Schema.encodeEffect(Schema.fromJsonString(ActionResumeState));
  const decode = Schema.decodeUnknownEffect(Schema.Array(RetainedActionRun));
  const mapError = (operation: string) => (cause: unknown) =>
    new ActionRunStoreError({ operation, cause });
  const save = Effect.fn("ActionRunStore.save")(
    function* (state: ActionResumeState, outputTail?: string) {
      const stateJson = yield* encodeState(state);
      yield* sql`
      INSERT INTO action_resume_runs (run_id, thread_id, started_at, revision, state_json, output_tail)
      VALUES (${state.runId}, ${state.threadId}, ${state.startedAt}, ${state.revision ?? 0}, ${stateJson}, ${outputTail?.slice(-12_000) ?? null})
      ON CONFLICT (run_id) DO UPDATE SET
        state_json = excluded.state_json, revision = excluded.revision,
        output_tail = COALESCE(excluded.output_tail, action_resume_runs.output_tail)
      WHERE excluded.revision >= action_resume_runs.revision
    `;
    },
    Effect.mapError(mapError("save")),
  );

  return ActionRunStore.of({
    listLatest: sql`SELECT state_json FROM action_resume_runs AS current
      WHERE NOT EXISTS (
        SELECT 1 FROM action_resume_runs AS newer WHERE newer.thread_id = current.thread_id
        AND newer.ordinal > current.ordinal
      ) ORDER BY thread_id`.pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ state_json: Schema.fromJsonString(ActionResumeState) })),
        ),
      ),
      Effect.map((rows) => rows.map((row) => row.state_json)),
      Effect.mapError(mapError("load")),
    ),
    get: (threadId, runId) =>
      sql`
      SELECT state_json AS state, output_tail AS outputTail FROM action_resume_runs
      WHERE thread_id = ${threadId} AND run_id = ${runId}
    `.pipe(
        Effect.flatMap(decode),
        Effect.map((rows) => Option.fromNullishOr(rows[0])),
        Effect.mapError(mapError("load")),
      ),
    save,
  });
});

export const layer = Layer.effect(ActionRunStore, make);
