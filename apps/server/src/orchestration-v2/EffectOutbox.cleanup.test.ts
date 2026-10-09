import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  MessageId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
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

it.layer(layer)("pending execution projection", (it) => {
  it.effect("keeps queued continuations and excludes completed work and attachment cleanup", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threadId = ThreadId.make("continuation-thread");
      yield* outbox.enqueue([
        {
          id: "continuation",
          commandId: CommandId.make("continue"),
          threadId,
          request: { type: "provider-runtime.continue", sourceRunId: RunId.make("source-run") },
        },
        {
          id: "attachment-cleanup",
          availableAt: DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"),
          commandId: CommandId.make("cleanup"),
          threadId: ThreadId.make("other-thread"),
          request: { type: "attachment.cleanup", attachmentIds: [] },
        },
      ]);
      assert.deepEqual(yield* outbox.pendingExecution, [{ threadId, providerMessage: true }]);
      const claimed = Option.getOrThrow(
        yield* outbox.claimNext({ workerId: "execution-worker", leaseDurationMs: 60000 }),
      );
      assert.deepEqual(yield* outbox.pendingExecution, [{ threadId, providerMessage: true }]);
      yield* outbox.retry({
        effectId: claimed.id,
        workerId: "execution-worker",
        error: "retry",
        delayMs: 0,
      });
      assert.deepEqual(yield* outbox.pendingExecution, [{ threadId, providerMessage: true }]);
      const continued = Option.getOrThrow(
        yield* outbox.claimNext({ workerId: "execution-worker", leaseDurationMs: 60000 }),
      );
      yield* outbox.succeed({ effectId: continued.id, workerId: "execution-worker" });
      assert.isEmpty(yield* outbox.pendingExecution);
    }),
  );
});

it.layer(layer)("provider message classification", (it) => {
  it.effect("retains every execution blocker while identifying only provider-message work", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const sql = yield* SqlClient.SqlClient;
      const runId = RunId.make("run-example");
      const providerSessionId = ProviderSessionId.make("session-example");
      const providerThreadId = ProviderThreadId.make("provider-thread-example");
      const providerTurnId = ProviderTurnId.make("turn-example");
      const scopeId = CheckpointScopeId.make("scope-example");
      const requestId = CommandId.make("request-example");
      const cases: ReadonlyArray<{
        readonly request: EffectOutbox.OrchestrationEffectRequestV2;
        readonly providerMessage: boolean;
      }> = [
        { request: { type: "provider-turn.start", runId }, providerMessage: true },
        {
          request: {
            type: "provider-turn.steer",
            providerSessionId,
            providerThreadId,
            providerTurnId,
            messageId: MessageId.make("message-example"),
          },
          providerMessage: true,
        },
        {
          request: {
            type: "provider-turn.restart",
            providerSessionId,
            providerThreadId,
            providerTurnId,
            interruptedAttemptId: RunAttemptId.make("attempt-example"),
            runId,
          },
          providerMessage: true,
        },
        {
          request: { type: "provider-runtime.continue", sourceRunId: runId },
          providerMessage: true,
        },
        {
          request: {
            type: "runtime-request.respond",
            providerSessionId,
            requestId: RuntimeRequestId.make("runtime-request-example"),
          },
          providerMessage: true,
        },
        { request: { type: "checkpoint.capture", runId, scopeId }, providerMessage: false },
        {
          request: {
            type: "provider-thread.rollback",
            providerThreadId,
            checkpointId: CheckpointId.make("checkpoint-example"),
            scopeId,
          },
          providerMessage: false,
        },
        { request: { type: "thread.archive", requestId }, providerMessage: false },
        { request: { type: "subagent.promote", requestId }, providerMessage: false },
        { request: { type: "delegated-tasks.stop" }, providerMessage: false },
      ];
      yield* outbox.enqueue(
        cases.map(({ request }) => ({
          id: `effect:${request.type}`,
          commandId: CommandId.make(`command:${request.type}`),
          threadId: ThreadId.make(`thread:${request.type}`),
          request,
        })),
      );
      assert.deepEqual(
        yield* outbox.pendingExecution,
        cases
          .map(({ request, providerMessage }) => ({
            threadId: ThreadId.make(`thread:${request.type}`),
            providerMessage,
          }))
          .sort((a, b) => a.threadId.localeCompare(b.threadId)),
      );
      const mixed = ThreadId.make("thread:mixed-example");
      yield* outbox.enqueue([
        {
          id: "mixed-checkpoint",
          commandId: requestId,
          threadId: mixed,
          request: { type: "checkpoint.capture", runId, scopeId },
        },
        {
          id: "mixed-start",
          commandId: requestId,
          threadId: mixed,
          request: { type: "provider-turn.start", runId },
        },
        {
          id: "cleanup-only",
          commandId: requestId,
          threadId: ThreadId.make("thread:cleanup-example"),
          request: { type: "terminal.cleanup" },
        },
      ]);
      assert.deepEqual(
        (yield* outbox.pendingExecution).find((row) => row.threadId === mixed),
        { threadId: mixed, providerMessage: true },
      );
      assert.isFalse(
        (yield* outbox.pendingExecution).some((row) => row.threadId === "thread:cleanup-example"),
      );
      assert.deepEqual(yield* outbox.pendingCleanup, [
        { threadId: ThreadId.make("thread:cleanup-example") },
      ]);
      yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'succeeded' WHERE effect_id = 'mixed-start'`;
      assert.deepEqual(
        (yield* outbox.pendingExecution).find((row) => row.threadId === mixed),
        { threadId: mixed, providerMessage: false },
      );
    }),
  );
});
