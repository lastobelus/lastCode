import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  OrchestrationV2Command,
  OrchestrationV2AppThreadJson,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  RunId,
  TurnItemId,
  UpdateDrainAdmissionError,
  UpdateDrainRequestId,
  UpdateDrainTargetVersion,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as UpdateDrainAdmission from "../updateDrain/UpdateDrainAdmission.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import {
  archivedShellStreamItemFromThreadShell,
  shellStreamItemFromThreadShell,
} from "./ShellStream.ts";
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

it.effect("starts child notes independently of historical copied and resolved parent notes", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    const projectId = ProjectId.make("notes:project");
    const parentId = ThreadId.make("notes:parent");
    yield* orchestrator.dispatch(create(parentId, projectId));
    for (const kind of ["ordinary", "subagent"] as const) {
      const threadId = ThreadId.make(`notes:${kind}`);
      yield* orchestrator.dispatch(create(threadId, projectId));
      const thread = yield* projections.getThread(threadId);
      const now = yield* DateTime.now;
      const copiedAt = DateTime.formatIso(DateTime.add(now, { hours: -1 }));
      yield* sink.write({
        events: [
          {
            id: EventId.make(`event:${kind}:copied-note`),
            type: "thread.metadata-updated",
            threadId,
            occurredAt: now,
            payload: {
              ...thread,
              ...(kind === "ordinary"
                ? { creatorThreadId: parentId, creatorGrouping: "grouped" as const }
                : {
                    lineage: {
                      rootThreadId: parentId,
                      parentThreadId: parentId,
                      relationshipToParent: "subagent" as const,
                    },
                  }),
              annotation: {
                body: "Copied parent note",
                anchorMessageId: MessageId.make("notes:parent-message"),
                createdAt: copiedAt,
                updatedAt: copiedAt,
                resolvedAt: copiedAt,
              },
            },
          },
          {
            id: EventId.make(`event:${kind}:own-message`),
            type: "message.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: MessageId.make(`notes:${kind}:message`),
              threadId,
              runId: null,
              nodeId: null,
              role: "user",
              text: "Own child message",
              attachments: [],
              streaming: false,
              createdAt: now,
              updatedAt: now,
              createdBy: "user",
              creationSource: "web",
            },
          },
        ],
      });
      for (const type of ["thread.annotation.resolve", "thread.annotation.reopen"] as const) {
        assert.equal(
          (yield* Effect.exit(
            orchestrator.dispatch({ type, threadId, commandId: CommandId.make(`${kind}:${type}`) }),
          ))._tag,
          "Failure",
        );
      }
      yield* orchestrator.dispatch({
        type: "thread.annotation.upsert",
        commandId: CommandId.make(`notes:${kind}:create`),
        threadId,
        body: "Own child note",
      });
      const independent = (yield* projections.getThread(threadId)).annotation;
      assert.equal(independent?.body, "Own child note");
      assert.equal(independent?.anchorMessageId, `notes:${kind}:message`);
      assert.equal(independent?.createdAt, DateTime.formatIso(now));
      assert.isNull(independent?.resolvedAt);
      yield* orchestrator.dispatch({
        type: "thread.annotation.resolve",
        commandId: CommandId.make(`notes:${kind}:resolve`),
        threadId,
      });
      const resolved = (yield* projections.getThread(threadId)).annotation;
      yield* orchestrator.dispatch({
        type: "thread.annotation.upsert",
        commandId: CommandId.make(`notes:${kind}:edit`),
        threadId,
        body: "Edited child note",
      });
      const edited = (yield* projections.getThread(threadId)).annotation;
      assert.equal(edited?.createdAt, independent?.createdAt);
      assert.isNotNull(resolved?.resolvedAt);
      assert.equal(edited?.resolvedAt, resolved?.resolvedAt);
    }
  }).pipe(Effect.provide(testLayer)),
);

