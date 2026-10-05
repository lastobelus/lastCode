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
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Metadata does not launch a provider"),
} as ProviderAdapterV2Shape;
const database = SqlitePersistenceMemory;
const testLayer = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "lastcode-metadata" },
    ProviderAdapterRegistry.makeLayer([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

const create = (threadId: ThreadId, projectId: ProjectId) => ({
  type: "thread.create" as const,
  commandId: CommandId.make(`create:${threadId}`),
  threadId,
  projectId,
  title: "Metadata thread",
  modelSelection: { instanceId, model: "gpt-6" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  createdBy: "user" as const,
  creationSource: "web" as const,
});

it.effect(
  "preserves new messages and rejected Steer promotions while the active attempt needs recovery",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("recovery-routing");
      yield* orchestrator.dispatch(create(threadId, ProjectId.make("recovery-routing-project")));
      const send = (id: string) => ({
        type: "message.dispatch" as const,
        commandId: CommandId.make(id),
        threadId,
        messageId: MessageId.make(id),
        text: id,
        attachments: [],
        createdBy: "user" as const,
        creationSource: "web" as const,
        dispatchMode: { type: "start_immediately" as const },
      });
      yield* orchestrator.dispatch(send("initial"));
      const initial = yield* orchestrator.getThreadProjection(threadId);
      const run = initial.runs[0]!;
      assert.isNotNull(run.activeAttemptId);
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make("recovery-routing-running"),
            type: "run.updated",
            threadId,
            occurredAt: now,
            payload: { ...run, status: "running" },
          },
          {
            id: EventId.make("recovery-routing-receipt"),
            type: "thread.metadata-updated",
            threadId,
            occurredAt: now,
            payload: {
              ...initial.thread,
              recovery: {
                runId: run.id,
                attemptId: run.activeAttemptId!,
                status: "recovering",
                detail: "Restoring completion",
                updatedAt: now,
              },
            },
          },
        ],
      });
      for (const deliveryIntent of ["auto", "steer"] as const) {
        yield* orchestrator.dispatch({ ...send(`recovery-${deliveryIntent}`), deliveryIntent });
      }
      const queued = yield* orchestrator.getThreadProjection(threadId);
      const queuedRuns = queued.runs.filter((candidate) => candidate.status === "queued");
      assert.lengthOf(queuedRuns, 2);
      const error = yield* orchestrator
        .dispatch({
          type: "queued-message.promote-to-steer",
          commandId: CommandId.make("recovery-promote"),
          threadId,
          queuedRunId: queuedRuns[0]!.id,
          targetRunId: run.id,
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "OrchestratorDispatchError");
      if (error._tag === "OrchestratorDispatchError") {
        assert.include(String(error.cause), "needs recovery");
      }
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.lengthOf(
        after.runs.filter((candidate) => candidate.status === "queued"),
        2,
      );
      assert.equal(
        after.messages.find((message) => message.id === MessageId.make("recovery-auto"))?.text,
        "recovery-auto",
      );
      assert.equal(after.runs.find((candidate) => candidate.id === run.id)?.status, "running");
    }).pipe(Effect.provide(testLayer)),
);
