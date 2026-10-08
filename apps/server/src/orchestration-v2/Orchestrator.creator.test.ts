import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  OrchestrationV2AppThreadJson,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EventStore from "./EventStore.ts";
import * as EventSink from "./EventSink.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import { DispatchModeLimit } from "./DispatchModeLimit.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

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
const database = SqlitePersistence.layerMemory;
const testLayer = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  EffectOutbox.layer.pipe(Layer.provide(database)),
  ProjectionMaintenance.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        database,
        EventStore.layer.pipe(Layer.provide(database)),
        ProjectionStore.layer.pipe(Layer.provide(database)),
      ),
    ),
  ),
  ProviderReplayHarness.layerWithRegistry(
    { name: "lastcode-metadata" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
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

const createOrdinary = (threadId: ThreadId, creatorThreadId: ThreadId, projectId: ProjectId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      ...create(threadId, projectId),
      createdBy: "agent",
      creationSource: "mcp",
      creatorThreadId,
    });
  });

const attachIdleProvider = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: EventId.make(`idle-provider:${threadId}`),
          type: "provider-thread.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: ProviderThreadId.make(`provider:${threadId}`),
            driver: ProviderDriverKind.make("codex"),
            providerInstanceId: instanceId,
            providerSessionId: ProviderSessionId.make(`session:${threadId}`),
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
    });
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

it.effect.each(["thread.archive", "thread.delete"] as const)(
  "%s releases interactive children without stopping their work or losing provenance",
  (action) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const project = ProjectId.make("creator:project");
      const creator = ThreadId.make("creator:origin");
      const child = ThreadId.make("creator:interactive");
      const grandchild = ThreadId.make("creator:nested-interactive");
      const independent = ThreadId.make("creator:already-independent");
      yield* orchestrator.dispatch(create(creator, project));
      yield* createOrdinary(child, creator, project);
      yield* createOrdinary(grandchild, child, project);
      yield* createOrdinary(independent, creator, project);
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("show-independently"),
        threadId: independent,
        creatorGrouping: "independent",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("interactive-work"),
        threadId: child,
        messageId: MessageId.make("interactive-message"),
        text: "Continue this independent conversation's work",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const before = yield* store.getThreadProjection(child);
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make("inherited-placement"),
            type: "thread.metadata-updated",
            threadId: child,
            occurredAt: now,
            payload: {
              ...before.thread,
              persistent: true,
              pinnedAt: now,
              pinOrderKey: "a",
              activeOrderKey: "b",
            },
          },
        ],
      });
      const commandId = CommandId.make(`inactive:${action}`);
      const receipt = yield* orchestrator.dispatch({
        type: action,
        commandId,
        threadId: creator,
      });
      const after = yield* store.getThreadProjection(child);
      assert.equal(after.thread.creatorGrouping, "independent");
      assert.equal(after.thread.creatorThreadId, creator);
      assert.deepEqual(after.thread.lineage, before.thread.lineage);
      assert.isTrue(after.thread.persistent);
      assert.isNull(after.thread.pinnedAt);
      assert.isNull(after.thread.pinOrderKey);
      assert.isNull(after.thread.activeOrderKey);
      assert.isNull(after.thread.archivedAt);
      assert.isNull(after.thread.deletedAt);
      assert.deepEqual(after.runs, before.runs);
      assert.deepEqual(after.messages, before.messages);
      assert.equal((yield* store.getThread(grandchild)).creatorGrouping, "grouped");
      assert.equal((yield* store.getThread(independent)).creatorGrouping, "independent");
      assert.isFalse(
        (yield* outbox.listByCommandId(commandId)).some((effect) => effect.threadId === child),
      );
      assert.isFalse(receipt.storedEvents.some((stored) => stored.event.threadId === independent));
      const replay = yield* orchestrator.dispatch({ type: action, commandId, threadId: creator });
      assert.equal(replay.sequence, receipt.sequence);
      if (action === "thread.archive") {
        yield* orchestrator.dispatch({
          type: "thread.unarchive",
          commandId: CommandId.make("restore-creator"),
          threadId: creator,
        });
        assert.equal((yield* store.getThread(child)).creatorGrouping, "independent");
      }
    }).pipe(Effect.provide(testLayer)),
);

it.effect("deferred archive releases interactive children only after successful completion", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const project = ProjectId.make("creator:project");
    const creator = ThreadId.make("creator:origin");
    const child = ThreadId.make("creator:interactive");
    yield* orchestrator.dispatch(create(creator, project));
    yield* createOrdinary(child, creator, project);
    yield* attachIdleProvider(creator);
    const request = {
      type: "thread.archive" as const,
      commandId: CommandId.make("archive-request"),
      threadId: creator,
    };
    yield* orchestrator.dispatch(request);
    assert.equal((yield* store.getThread(creator)).archivePending?.status, "stopping");
    assert.equal((yield* store.getThread(child)).creatorGrouping, "grouped");
    yield* orchestrator.dispatch({
      type: "thread.archive.fail",
      commandId: CommandId.make("archive-failed"),
      threadId: creator,
      requestId: request.commandId,
      error: "Disposable stop failed",
    });
    assert.equal((yield* store.getThread(child)).creatorGrouping, "grouped");
    const retry = { ...request, commandId: CommandId.make("archive-retry") };
    yield* orchestrator.dispatch(retry);
    yield* orchestrator.dispatch({
      type: "thread.archive.complete",
      commandId: CommandId.make("archive-complete"),
      threadId: creator,
      requestId: retry.commandId,
    });
    assert.isNotNull((yield* store.getThread(creator)).archivedAt);
    assert.equal((yield* store.getThread(child)).creatorGrouping, "independent");
  }).pipe(Effect.provide(testLayer)),
);

it.effect.each(["archived", "deleted", "stopping"] as const)(
  "new interactive conversations stay independent when their creator is %s",
  (state) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const project = ProjectId.make("creator:project");
      const creator = ThreadId.make("creator:origin");
      const child = ThreadId.make("creator:new-interactive");
      yield* orchestrator.dispatch(create(creator, project));
      if (state === "stopping") yield* attachIdleProvider(creator);
      yield* orchestrator.dispatch({
        type: state === "deleted" ? "thread.delete" : "thread.archive",
        commandId: CommandId.make(`make-creator:${state}`),
        threadId: creator,
      });
      yield* createOrdinary(child, creator, project);
      const thread = yield* store.getThread(child);
      assert.equal(thread.creatorGrouping, "independent");
      assert.equal(thread.creatorThreadId, creator);
      assert.isNull(thread.lineage.parentThreadId);
      const refused = yield* orchestrator
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("regroup-unavailable-creator"),
          threadId: child,
          creatorGrouping: "grouped",
        })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "OrchestratorDispatchError");
      assert.equal((yield* store.getThread(child)).creatorGrouping, "independent");
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each(["archive", "delete", "deferred-archive"] as const)(
  "%s checks an interactive release target against the caller's permissions before changes",
  (action) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const project = ProjectId.make("creator:project");
      const creator = ThreadId.make("creator:origin");
      const child = ThreadId.make("creator:interactive");
      yield* orchestrator.dispatch({
        ...create(creator, project),
        runtimeMode: "approval-required",
      });
      yield* createOrdinary(child, creator, project);
      if (action === "deferred-archive") yield* attachIdleProvider(creator);
      const rejected = yield* orchestrator
        .dispatch({
          type: action === "delete" ? "thread.delete" : "thread.archive",
          commandId: CommandId.make(`limited:${action}`),
          threadId: creator,
        })
        .pipe(
          Effect.provideService(DispatchModeLimit, {
            runtimeMode: "approval-required",
            interactionMode: "default",
          }),
          Effect.flip,
        );
      assert.equal(rejected._tag, "OrchestratorThreadAboveModeLimitError");
      assert.isNull((yield* store.getThread(creator)).archivedAt);
      assert.isNull((yield* store.getThread(creator)).deletedAt);
      assert.isNull((yield* store.getThread(creator)).archivePending ?? null);
      assert.equal((yield* store.getThread(child)).creatorGrouping, "grouped");
    }).pipe(Effect.provide(testLayer)),
);

it.effect("deferred archive rechecks the saved permission ceiling before interactive release", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const project = ProjectId.make("creator:project");
    const creator = ThreadId.make("creator:origin");
    const child = ThreadId.make("creator:interactive");
    yield* orchestrator.dispatch({ ...create(creator, project), runtimeMode: "approval-required" });
    yield* createOrdinary(child, creator, project);
    yield* orchestrator.dispatch({
      type: "thread.runtime-mode.set",
      commandId: CommandId.make("lower-interactive-mode"),
      threadId: child,
      runtimeMode: "approval-required",
    });
    yield* attachIdleProvider(creator);
    const request = {
      type: "thread.archive" as const,
      commandId: CommandId.make("limited-archive-request"),
      threadId: creator,
    };
    yield* orchestrator.dispatch(request).pipe(
      Effect.provideService(DispatchModeLimit, {
        runtimeMode: "approval-required",
        interactionMode: "default",
      }),
    );
    yield* orchestrator.dispatch({
      type: "thread.runtime-mode.set",
      commandId: CommandId.make("raise-interactive-mode"),
      threadId: child,
      runtimeMode: "full-access",
    });
    const refused = yield* orchestrator
      .dispatch({
        type: "thread.archive.complete",
        commandId: CommandId.make("limited-archive-complete"),
        threadId: creator,
        requestId: request.commandId,
      })
      .pipe(Effect.flip);
    assert.equal(refused._tag, "OrchestratorThreadAboveModeLimitError");
    assert.isNull((yield* store.getThread(creator)).archivedAt);
    assert.equal((yield* store.getThread(child)).creatorGrouping, "grouped");
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "archiving a creator releases placement without disturbing its child's own pending archive",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const project = ProjectId.make("creator:project");
      const creator = ThreadId.make("creator:origin");
      const child = ThreadId.make("creator:interactive");
      yield* orchestrator.dispatch(create(creator, project));
      yield* createOrdinary(child, creator, project);
      yield* attachIdleProvider(child);
      const request = {
        type: "thread.archive" as const,
        commandId: CommandId.make("child-own-archive"),
        threadId: child,
      };
      yield* orchestrator.dispatch(request);
      const pending = (yield* store.getThread(child)).archivePending;
      assert.equal(pending?.status, "stopping");
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("creator-archive"),
        threadId: creator,
      });
      assert.equal((yield* store.getThread(child)).creatorGrouping, "independent");
      assert.deepEqual((yield* store.getThread(child)).archivePending, pending);
      yield* orchestrator.dispatch({
        type: "thread.archive.complete",
        commandId: CommandId.make("child-own-archive-complete"),
        threadId: child,
        requestId: request.commandId,
      });
      assert.equal((yield* store.getThread(child)).creatorGrouping, "independent");
      assert.isNotNull((yield* store.getThread(child)).archivedAt);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("concurrent archive and interactive creation cannot leave a grouped orphan", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const project = ProjectId.make("creator:project");
    const creator = ThreadId.make("creator:z-origin");
    const child = ThreadId.make("creator:a-interactive");
    yield* orchestrator.dispatch(create(creator, project));
    yield* Effect.all(
      [
        createOrdinary(child, creator, project),
        orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("concurrent-archive"),
          threadId: creator,
        }),
      ],
      { concurrency: "unbounded" },
    );
    assert.isNotNull((yield* store.getThread(creator)).archivedAt);
    assert.equal((yield* store.getThread(child)).creatorGrouping, "independent");
  }).pipe(Effect.provide(testLayer)),
);
