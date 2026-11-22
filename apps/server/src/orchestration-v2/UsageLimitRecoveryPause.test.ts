import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { makePausedEnvironment } from "./EnvironmentAutomation.testkit.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2 } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Queued recovery must not launch a provider during this test"),
} as ProviderAdapterV2["Service"];
const database = SqlitePersistence.layerMemory;
const testLayer = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  EffectOutbox.layer.pipe(Layer.provide(database)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "usage-limit-pause" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

it.effect.each(["resume", "cancel-recovery"] as const)(
  "holds a real quota recovery admitted after Pause and preserves the queue on %s",
  (scenario) =>
    Effect.gen(function* () {
      const pause = yield* makePausedEnvironment;
      yield* Ref.set(pause.state, null);
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const threadId = ThreadId.make(`quota-pause-${scenario}`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId: ProjectId.make(`${threadId}:project`),
          title: "Limited thread",
          modelSelection: { instanceId, model: "gpt-6" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${threadId}:start`),
          threadId,
          messageId: MessageId.make(`${threadId}:start`),
          text: "Start work.",
          attachments: [],
          dispatchMode: { type: "defer_start" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${threadId}:manual-queued`),
          threadId,
          messageId: MessageId.make(`${threadId}:manual-queued`),
          text: "Do this after the limit clears.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "server",
        });
        const source = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        const now = yield* DateTime.now;
        const resetAt = DateTime.formatIso(DateTime.add(now, { minutes: 1 }));
        yield* sink.write({
          events: [
            {
              id: EventId.make(`${threadId}:failed`),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: { ...source, status: "failed", completedAt: now },
            },
            {
              id: EventId.make(`${threadId}:quota-error`),
              type: "turn-item.updated",
              threadId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make(`${threadId}:quota-error`),
                type: "error",
                threadId,
                runId: source.id,
                nodeId: source.rootNodeId,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 2,
                status: "failed",
                title: "Usage limit reached",
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                failure: {
                  class: "usage_limit",
                  message: "Plan limit reached.",
                  code: "usageLimitExceeded",
                  retryable: null,
                  resetAt,
                },
              },
            },
          ],
        });
        const limited = (yield* orchestrator.getThreadShell(threadId))!;
        yield* orchestrator.dispatch(
          limitRecoveryCommand(limited, true, DateTime.toEpochMillis(now))!,
        );
        yield* TestClock.adjust("1 minute");
        const armed = (yield* orchestrator.getThreadShell(threadId))!;
        const command = limitRecoveryCommand(
          armed,
          true,
          DateTime.toEpochMillis(yield* DateTime.now),
        )!;
        assert.equal(command.type, "message.dispatch");
        // The sweep prepared this command while open; Pause wins before admission.
        yield* pause.pause;
        yield* orchestrator.dispatch(command);
        yield* orchestrator.dispatch(command);
        yield* orchestrator.resumeQueuedRuns;
        const held = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          held.runs.map((run) => run.status),
          ["failed", "queued", "queued"],
        );
        assert.equal(held.messages.length, 3);
        const recoveryRun = held.runs[2]!;
        const promotionId = CommandId.make(`command:system:start-queued:${recoveryRun.id}`);
        assert.isEmpty(yield* outbox.listByCommandId(promotionId));
        if (scenario === "cancel-recovery")
          yield* orchestrator.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`${threadId}:cancel-recovery`),
            threadId,
            limitRecovery: { runId: source.id, resetAt, autoResume: false },
          });
        yield* pause.resume;
        yield* orchestrator.resumeQueuedRuns;
        yield* orchestrator.resumeQueuedRuns;
        yield* orchestrator.dispatch(command);
        const resumed = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(resumed.messages.length, 3);
        assert.equal(resumed.runs.length, 3);
        assert.equal(resumed.runs[1]?.status, "queued");
        assert.equal(resumed.runs[2]?.status, scenario === "resume" ? "starting" : "queued");
        assert.equal(
          (yield* outbox.listByCommandId(promotionId)).filter(
            (effect) => effect.request.type === "provider-turn.start",
          ).length,
          scenario === "resume" ? 1 : 0,
        );
      }).pipe(Effect.provide(testLayer.pipe(Layer.provide(pause.layer))));
    }),
);
