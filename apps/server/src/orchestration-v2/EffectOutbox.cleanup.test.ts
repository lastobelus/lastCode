import { assert, it } from "@effect/vitest";
import { CommandId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EffectOutbox from "./EffectOutbox.ts";

const layer = EffectOutbox.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

it.layer(layer)("unfinished cleanup projection", (it) => {
  it.effect(
    "keeps pending, running and backoff cleanup, excluding settled history and payloads",
    () =>
      Effect.gen(function* () {
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("cleanup-thread");
        yield* outbox.enqueue([
          {
            id: "cleanup-detach",
            commandId: CommandId.make("delete"),
            threadId,
            request: {
              type: "provider-session.detach",
              providerSessionId: ProviderSessionId.make("session"),
            },
          },
        ]);
        assert.deepEqual(yield* outbox.pendingCleanup, [{ threadId }]);
        const claimed = Option.getOrThrow(
          yield* outbox.claimNext({ workerId: "cleanup-worker", leaseDurationMs: 60000 }),
        );
        assert.deepEqual(yield* outbox.pendingCleanup, [{ threadId }]);
        yield* outbox.retry({
          effectId: claimed.id,
          workerId: "cleanup-worker",
          error: "retry",
          delayMs: 600000,
        });
        assert.deepEqual(yield* outbox.pendingCleanup, [{ threadId }]);
        assert.isTrue(
          Option.isNone(
            yield* outbox.claimNext({ workerId: "cleanup-worker", leaseDurationMs: 60000 }),
          ),
        );
        // Only narrow columns are read; corrupt payload history cannot hide cleanup.
        yield* sql`UPDATE orchestration_v2_effect_outbox SET payload_json = 'invalid'`;
        assert.deepEqual(yield* outbox.pendingCleanup, [{ threadId }]);
        yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'failed'`;
        assert.isEmpty(yield* outbox.pendingCleanup);
        for (const type of ["terminal.cleanup", "terminal.archive-cleanup"] as const) {
          yield* outbox.enqueue([
            { id: type, commandId: CommandId.make(type), threadId, request: { type } },
          ]);
        }
        assert.deepEqual(yield* outbox.pendingCleanup, [{ threadId }]);
        for (let count = 0; count < 2; count += 1) {
          const effect = Option.getOrThrow(
            yield* outbox.claimNext({ workerId: "cleanup-worker", leaseDurationMs: 60000 }),
          );
          yield* outbox.succeed({ effectId: effect.id, workerId: "cleanup-worker" });
        }
        assert.isEmpty(yield* outbox.pendingCleanup);
        yield* outbox.enqueue([
          {
            id: "unrelated",
            commandId: CommandId.make("unrelated"),
            threadId,
            request: { type: "thread.archive", requestId: CommandId.make("archive") },
          },
        ]);
        assert.isEmpty(yield* outbox.pendingCleanup);
      }),
  );
});
