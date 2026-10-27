import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import { makePausedEnvironment } from "./EnvironmentAutomation.testkit.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  ProviderAdapterCapabilitiesError,
  type ProviderAdapterV2,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Queue tests do not launch a provider"),
} as ProviderAdapterV2["Service"];
const database = SqlitePersistence.layerMemory;
const testLayer = (testAdapter: ProviderAdapterV2["Service"]) =>
  Layer.mergeAll(
    database,
    ProjectionStore.layer.pipe(Layer.provide(database)),
    EffectOutbox.layer.pipe(Layer.provide(database)),
    ProviderReplayHarness.layerWithRegistry(
      { name: "environment-pause-queue" },
      ProviderAdapterRegistry.layerFromAdapters([testAdapter]),
      { databaseLayer: database, runEffectWorker: false },
    ),
  );

it.effect.each(
  (["pause", "resume"] as const).flatMap((direction) =>
    (["starting", "failed"] as const).map((outcome) => ({ direction, outcome })),
  ),
)(
  "makes $direction $outcome ahead of a held queue without releasing ordinary work",
  ({ direction, outcome }) =>
    Effect.gen(function* () {
      const pause = yield* makePausedEnvironment;
      if (direction === "resume") yield* pause.resume;
      const capabilitiesFail = yield* Ref.make(false);
      const testAdapter = {
        ...adapter,
        getCapabilities: () =>
          Ref.get(capabilitiesFail).pipe(
            Effect.flatMap((fail) =>
              fail
                ? Effect.fail(new ProviderAdapterCapabilitiesError({ driver: adapter.driver }))
                : adapter.getCapabilities(),
            ),
          ),
      } satisfies ProviderAdapterV2["Service"];
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const sink = yield* EventSink.EventSinkV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const threadId = ThreadId.make(`held-environment-${direction}`);
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${threadId}:create`),
          threadId,
          projectId: ProjectId.make(`${threadId}:project`),
          title: "Held queue",
          modelSelection: { instanceId, model: "gpt-6" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        const send = (id: string, text: string) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(id),
            threadId,
            messageId: MessageId.make(id),
            text,
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "server",
          });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${threadId}:active`),
          threadId,
          messageId: MessageId.make(`${threadId}:active`),
          text: "Work already running",
          attachments: [],
          dispatchMode: { type: "defer_start" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* send(`${threadId}:held`, "Keep this queued until I resume its queue.");
        const initial = yield* orchestrator.getThreadProjection(threadId);
        const active = initial.runs[0]!;
        const held = initial.runs[1]!;
        const now = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make(`${threadId}:running`),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: { ...active, status: "running", startedAt: now },
            },
            {
              id: EventId.make(`${threadId}:hold`),
              type: "run.updated",
              threadId,
              occurredAt: now,
              payload: { ...held, queueHeld: true },
            },
          ],
        });
        const controlId = `environment-pause:queue-fixture:${threadId}:${direction}:0`;
        yield* send(controlId, direction === "pause" ? "pause to go offline" : "resume");
        yield* send(`${threadId}:ordinary-after-control`, "Another ordinary prompt");
        const queued = yield* orchestrator.getThreadProjection(threadId);
        const control = queued.runs[2]!;
        assert.equal(control.status, "queued");
        assert.notEqual(control.queueHeld, true);
        assert.isTrue(queued.runs[3]?.queueHeld);
        assert.isFalse(yield* projections.canStartQueuedRun(threadId));
        // Keep promotion manual here: publishing completion would also wake the
        // orchestrator's terminal-event subscriber before the eligibility assertion.
        yield* projections.apply({
          id: EventId.make(`${threadId}:active-completed`),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: { ...active, status: "completed", startedAt: now, completedAt: now },
        });
        assert.isTrue(yield* projections.canStartQueuedRun(threadId));
        yield* Ref.set(capabilitiesFail, outcome === "failed");
        yield* orchestrator.resumeQueuedRuns;
        yield* orchestrator.resumeQueuedRuns;
        const started = yield* orchestrator.getThreadProjection(threadId);
        const delivered = started.runs.find((run) => run.id === control.id)!;
        assert.equal(delivered.status, outcome);
        const promotionId = CommandId.make(`command:system:start-queued:${control.id}`);
        assert.equal(
          (yield* outbox.listByCommandId(promotionId)).filter(
            (effect) => effect.request.type === "provider-turn.start",
          ).length,
          outcome === "starting" ? 1 : 0,
        );
        if (outcome === "starting")
          yield* sink.write({
            events: [
              {
                id: EventId.make(`${threadId}:control-completed`),
                type: "run.updated",
                threadId,
                occurredAt: now,
                payload: { ...delivered, status: "completed", startedAt: now, completedAt: now },
              },
            ],
          });
        else
          assert.lengthOf(
            started.turnItems.filter((item) => item.type === "error" && item.runId === control.id),
            1,
          );
        yield* orchestrator.resumeQueuedRuns;
        const final = yield* orchestrator.getThreadProjection(threadId);
        assert.isFalse(yield* projections.canStartQueuedRun(threadId));
        for (const run of [held, queued.runs[3]!]) {
          const remaining = final.runs.find((candidate) => candidate.id === run.id)!;
          assert.equal(remaining.status, "queued");
          assert.isTrue(remaining.queueHeld);
          assert.isEmpty(
            yield* outbox.listByCommandId(CommandId.make(`command:system:start-queued:${run.id}`)),
          );
        }
      }).pipe(Effect.provide(testLayer(testAdapter).pipe(Layer.provide(pause.layer))));
    }),
);
