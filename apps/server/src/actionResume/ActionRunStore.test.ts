import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ActionResumeState, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import migration from "./ActionRunMigration.ts";
import * as ActionRunStore from "./ActionRunStore.ts";

const threadId = ThreadId.make("action-store-thread");
const run = (runId: string, overrides: Partial<ActionResumeState> = {}): ActionResumeState => ({
  runId,
  threadId,
  projectId: ProjectId.make("action-store-project"),
  actionId: "wait",
  actionName: "Wait",
  terminalId: `action-${runId}`,
  outcome: "running",
  delivery: "armed",
  startedAt: "2026-10-02T00:00:00.000Z",
  finishedAt: null,
  exitCode: null,
  exitSignal: null,
  revision: 0,
  ...overrides,
});
const SqlLayer = NodeSqliteClient.layer({ filename: ":memory:" }).pipe(
  Layer.provide(NodeServices.layer),
);
const TestLayer = ActionRunStore.layer.pipe(
  Layer.provideMerge(Layer.effectDiscard(migration).pipe(Layer.provideMerge(SqlLayer))),
);

it.effect(
  "retains exact runs and bounded output without allowing an older revision to replace completion",
  () =>
    Effect.gen(function* () {
      const store = yield* ActionRunStore.ActionRunStore;
      yield* store.save(
        run("z-first", { outcome: "succeeded", delivery: "delivered", revision: 4 }),
        "x".repeat(12_010),
      );
      yield* store.save(run("z-first", { revision: 3 }), "stale output");
      yield* store.save(run("a-second"));
      const first = Option.getOrThrow(yield* store.get(threadId, "z-first"));
      assert.equal(first.state.delivery, "delivered");
      assert.equal(first.outputTail?.length, 12_000);
      assert.isTrue(Option.isNone(yield* store.get(ThreadId.make("unrelated-thread"), "z-first")));
      assert.deepEqual(
        (yield* store.listLatest).map((state) => state.runId),
        ["a-second"],
      );
    }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "cutover preserves delivery ordering and recognizes an already-sent old transcript result",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE projection_thread_activities (thread_id TEXT, kind TEXT, payload_json TEXT)`;
      yield* sql`CREATE TABLE projection_thread_messages (thread_id TEXT, message_id TEXT)`;
      const encode = Schema.encodeEffect(Schema.fromJsonString(ActionResumeState));
      const states = [
        run("disposed", { outcome: "succeeded", delivery: "disposed", revision: 2 }),
        run("disposed", { outcome: "succeeded", delivery: "pending", revision: 2 }),
        run("revision", { outcome: "succeeded", delivery: "disposed", revision: 1 }),
        run("revision", { outcome: "succeeded", delivery: "pending", revision: 3 }),
        run("sent", { outcome: "succeeded", delivery: "pending", revision: 3 }),
      ];
      for (const state of states) {
        const json = yield* encode(state);
        yield* sql`INSERT INTO projection_thread_activities VALUES (${threadId}, 'action.resume.lifecycle', ${json})`;
      }
      yield* sql`INSERT INTO projection_thread_activities VALUES (${threadId}, 'action.resume.lifecycle', 'malformed')`;
      yield* sql`INSERT INTO projection_thread_messages VALUES (${threadId}, 'action-resume:sent:follow-up')`;
      yield* migration;
      yield* Effect.gen(function* () {
        const store = yield* ActionRunStore.ActionRunStore;
        assert.equal(
          Option.getOrThrow(yield* store.get(threadId, "disposed")).state.delivery,
          "disposed",
        );
        assert.equal(
          Option.getOrThrow(yield* store.get(threadId, "revision")).state.delivery,
          "pending",
        );
        assert.equal(
          Option.getOrThrow(yield* store.get(threadId, "sent")).state.delivery,
          "delivered",
        );
      }).pipe(Effect.provide(ActionRunStore.layer));
    }).pipe(Effect.provide(SqlLayer)),
);
