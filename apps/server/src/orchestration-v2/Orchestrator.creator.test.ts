import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  OrchestrationV2AppThreadJson,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const encodeAppThreadJson = Schema.encodeEffect(OrchestrationV2AppThreadJson);
const decodeAppThreadJson = Schema.decodeEffect(OrchestrationV2AppThreadJson);

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
  ProjectionMaintenance.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        database,
        EventStore.layer.pipe(Layer.provide(database)),
        ProjectionStore.layer.pipe(Layer.provide(database)),
      ),
    ),
  ),
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
  "keeps creator history and ordinary ownership through grouping, archives and event replay",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const creator = ThreadId.make("creator:origin");
      const threadId = ThreadId.make("creator:ordinary");
      const project = ProjectId.make("creator:project");
      yield* orchestrator.dispatch(create(creator, project));
      const creation = {
        ...create(threadId, project),
        createdBy: "agent" as const,
        creationSource: "mcp" as const,
        creatorThreadId: creator,
      };
      const receipt = yield* orchestrator.dispatch(creation);
      const created = receipt.storedEvents.find((stored) => stored.event.type === "thread.created");
      assert.isDefined(created);
      assert.equal((yield* projections.getThread(threadId)).creatorGrouping, "grouped");
      for (const grouping of ["independent", "grouped"] as const) {
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`creator:placement:${grouping}`),
          threadId,
          creatorGrouping: grouping,
        });
        const thread = yield* projections.getThread(threadId);
        assert.equal(thread.creatorThreadId, creator);
        assert.equal(thread.creatorGrouping, grouping);
        assert.deepEqual(thread.lineage, {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: threadId,
        });
        assert.isNull(thread.forkedFrom);
        assert.equal((yield* projections.getThreadShell(threadId))?.creatorGrouping, grouping);
        assert.equal((yield* projections.getThreadShell(threadId))?.creatorThreadId, creator);
      }
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("creator:archive"),
        threadId,
      });
      assert.equal(
        (yield* projections.getShellSnapshot({ location: "archive" })).archivedThreads[0]
          ?.creatorThreadId,
        creator,
      );
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.equal((yield* projections.getThread(threadId)).creatorThreadId, creator);
      assert.equal((yield* projections.getThreadShell(threadId))?.creatorGrouping, "grouped");
      // Replay uses a separate shell constructor from the SQL read path.
      const replayedShell = yield* Effect.gen(function* () {
        const replay = yield* ProjectionStore.ProjectionStoreV2;
        yield* replay.apply(created!.event);
        return yield* replay.getThreadShell(threadId);
      }).pipe(Effect.provide(ProjectionStore.layerMemory));
      assert.equal(replayedShell?.creatorThreadId, creator);
      assert.equal(replayedShell?.creatorGrouping, "grouped");
      const duplicate = yield* orchestrator
        .dispatch({
          ...creation,
          commandId: CommandId.make("creator:replacement"),
          creatorThreadId: ThreadId.make("creator:other"),
        })
        .pipe(Effect.flip);
      assert.equal(duplicate._tag, "OrchestratorDispatchError");
      assert.equal((yield* projections.getThread(threadId)).creatorThreadId, creator);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("does not infer historical creators and rejects invalid attribution or placement", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const historical = ThreadId.make("creator:historical");
    const project = ProjectId.make("creator:project");
    yield* orchestrator.dispatch({
      ...create(historical, project),
      createdBy: "agent",
      creationSource: "mcp",
    });
    const thread = yield* projections.getThread(historical);
    const encoded = yield* encodeAppThreadJson(thread);
    const decoded = yield* decodeAppThreadJson(encoded);
    assert.isUndefined(decoded.creatorThreadId);
    assert.isUndefined(decoded.creatorGrouping);
    assert.isUndefined((yield* projections.getThreadShell(historical))?.creatorThreadId);
    const placement = yield* orchestrator
      .dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("creator:unknown-placement"),
        threadId: historical,
        creatorGrouping: "grouped",
      })
      .pipe(Effect.flip);
    assert.equal(placement._tag, "OrchestratorDispatchError");
    for (const [suffix, creatorThreadId, createdBy] of [
      ["self", ThreadId.make("creator:self"), "agent"],
      ["missing", ThreadId.make("creator:missing-origin"), "agent"],
      ["user", historical, "user"],
    ] as const) {
      const invalid = yield* orchestrator
        .dispatch({
          ...create(ThreadId.make(`creator:${suffix}`), project),
          creatorThreadId,
          createdBy,
        })
        .pipe(Effect.flip);
      assert.ok(
        invalid._tag === "OrchestratorDispatchError" ||
          invalid._tag === "OrchestratorProjectionError",
      );
    }
    const now = yield* DateTime.now;
    const child = ThreadId.make("creator:subagent");
    yield* projections.apply({
      id: EventId.make("creator:subagent-event"),
      type: "thread.created",
      threadId: child,
      occurredAt: now,
      payload: {
        ...thread,
        id: child,
        creatorThreadId: historical,
        lineage: {
          parentThreadId: historical,
          relationshipToParent: "subagent",
          rootThreadId: historical,
        },
      },
    });
    const childPlacement = yield* orchestrator
      .dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("creator:subagent-placement"),
        threadId: child,
        creatorGrouping: "independent",
      })
      .pipe(Effect.flip);
    assert.equal(childPlacement._tag, "OrchestratorDispatchError");
  }).pipe(Effect.provide(testLayer)),
);
