import { MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionTurnRequestCorrelationRepositoryLive } from "../Layers/ProjectionTurnRequestCorrelations.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { ProjectionTurnRequestCorrelationRepository } from "../Services/ProjectionTurnRequestCorrelations.ts";

const layer = it.layer(
  ProjectionTurnRequestCorrelationRepositoryLive.pipe(
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
  ),
);

<<<<<<<< HEAD:apps/server/src/persistence/Migrations/051_ProjectionTurnRequestCorrelations.test.ts
<<<<<<<< HEAD:apps/server/src/persistence/Migrations/051_ProjectionTurnRequestCorrelations.test.ts
layer("051_ProjectionTurnRequestCorrelations", (it) => {
|||||||| parent of 8104aad471 (fix(lastcode): keep checkpoint migrations replayable (#95)):apps/server/src/persistence/Migrations/045_ProjectionTurnRequestCorrelations.test.ts
layer("045_ProjectionTurnRequestCorrelations", (it) => {
========
layer("046_ProjectionTurnRequestCorrelations", (it) => {
>>>>>>>> 8104aad471 (fix(lastcode): keep checkpoint migrations replayable (#95)):apps/server/src/persistence/Migrations/046_ProjectionTurnRequestCorrelations.test.ts
|||||||| parent of 6f3273be76 (fix(lastcode): make checkpoint failures self-reporting (#101)):apps/server/src/persistence/Migrations/046_ProjectionTurnRequestCorrelations.test.ts
layer("046_ProjectionTurnRequestCorrelations", (it) => {
========
layer("047_ProjectionTurnRequestCorrelations", (it) => {
>>>>>>>> 6f3273be76 (fix(lastcode): make checkpoint failures self-reporting (#101)):apps/server/src/persistence/Migrations/047_ProjectionTurnRequestCorrelations.test.ts
  it.effect("inserts once, resolves once, and deletes by owning thread", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const repository = yield* ProjectionTurnRequestCorrelationRepository;
      const sql = yield* SqlClient.SqlClient;
      const key = { threadId: ThreadId.make("thread-1"), messageId: MessageId.make("message-1") };
      yield* repository.insertPending({ ...key, requestedAt: "2026-08-22T00:00:00.000Z" });
      yield* repository.insertPending({ ...key, requestedAt: "2026-08-22T00:00:01.000Z" });
      yield* repository.resolve({
        ...key,
        turnId: TurnId.make("turn-1"),
        state: "started",
        resolvedAt: "2026-08-22T00:00:02.000Z",
      });
      yield* repository.resolve({
        ...key,
        turnId: null,
        state: "error",
        resolvedAt: "2026-08-22T00:00:03.000Z",
      });
      yield* repository.markAssistantFinalized({
        threadId: key.threadId,
        turnId: TurnId.make("turn-1"),
        finalizedAt: "2026-08-22T00:00:04.000Z",
      });
      yield* repository.markAssistantFinalized({
        threadId: key.threadId,
        turnId: TurnId.make("turn-1"),
        finalizedAt: "2026-08-22T00:00:05.000Z",
      });
      const resolved = yield* repository.get(key);
      assert.strictEqual(resolved._tag, "Some");
      if (resolved._tag === "Some") {
        assert.strictEqual(resolved.value.state, "started");
        assert.strictEqual(resolved.value.turnId, "turn-1");
        assert.strictEqual(resolved.value.requestedAt, "2026-08-22T00:00:00.000Z");
      }
      assert.deepStrictEqual(
        yield* sql<{ readonly finalizedAt: string }>`
          SELECT finalized_at AS "finalizedAt"
          FROM projection_turn_assistant_finalizations
          WHERE thread_id = ${key.threadId} AND turn_id = 'turn-1'
        `,
        [{ finalizedAt: "2026-08-22T00:00:04.000Z" }],
      );
      yield* repository.deleteByThreadId({ threadId: key.threadId });
      assert.strictEqual((yield* repository.get(key))._tag, "None");
      assert.deepStrictEqual(
        yield* sql`
          SELECT 1
          FROM projection_turn_assistant_finalizations
          WHERE thread_id = ${key.threadId}
        `,
        [],
      );
    }),
  );
});
