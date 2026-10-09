import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  ThreadId,
  getOwnedThreadFamily,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { DispatchModeLimit } from "./DispatchModeLimit.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

const instanceId = ProviderInstanceId.make("codex");
let fixtureNumber = 0;
const adapter: ProviderAdapterV2Shape = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("Lifecycle tests do not run provider effects"),
};
const BaseTestLayer = Layer.mergeAll(
  ProviderReplayHarness.layerWithRegistry(
    { name: "thread-family-lifecycle" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { runEffectWorker: false, databaseLayer: SqlitePersistence.layerMemory },
  ),
  EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
  ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
);
const LifecycleTestLayer = Layer.merge(
  BaseTestLayer,
  ProviderEventIngestor.layer.pipe(
    Layer.provide(Layer.mergeAll(BaseTestLayer, IdAllocator.layer, ThreadCommandExecutor.layer)),
  ),
);
const TestLayer = ThreadManagementService.layer.pipe(Layer.provideMerge(LifecycleTestLayer));
const seed = Effect.fn("ThreadFamilyLifecycle.seed")(function* () {
  const number = ++fixtureNumber;
  const rootId = ThreadId.make(`family-root:${number}`);
  const nativeId = ThreadId.make(`native-child:${number}`);
  const nestedId = ThreadId.make(`nested-app-owned-child:${number}`);
  const independentId = ThreadId.make(`independently-archived-child:${number}`);
  const forkId = ThreadId.make(`independent-fork:${number}`);
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const teardowns: Array<{ threadId: ThreadId; providerSessionId: ProviderSessionId }> = [];
  const now = yield* DateTime.now;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create-family:${rootId}`),
    threadId: rootId,
    projectId: ProjectId.make("project"),
    title: "Family root",
    modelSelection: { instanceId, model: "model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  const root = yield* store.getThread(rootId);
  for (const [id, parentId, source, relationship] of [
    [nativeId, rootId, "provider", "subagent"],
    [nestedId, nativeId, "mcp", "subagent"],
    [independentId, rootId, "mcp", "subagent"],
    [forkId, rootId, "web", "fork"],
  ] as const) {
    yield* sink.write({
      events: [
        {
          id: EventId.make(`seed:${id}`),
          type: "thread.created",
          threadId: id,
          occurredAt: now,
          payload: {
            ...root,
            id,
            title: id,
            createdBy: "agent",
            creationSource: source,
            lineage: {
              parentThreadId: parentId,
              rootThreadId: rootId,
              relationshipToParent: relationship,
            },
            forkedFrom: { type: "node", nodeId: NodeId.make(`source:${id}`) },
          },
        },
      ],
    });
  }
  const command = Effect.fnUntraced(function* (
    type: "thread.archive" | "thread.unarchive" | "thread.delete",
    id: string,
    threadId = rootId,
  ) {
    const commandId = CommandId.make(`${id}:${rootId}`);
    const family =
      type === "thread.archive"
        ? getOwnedThreadFamily(
            yield* Effect.forEach(yield* store.getOwnedThreadIds(threadId), (id) =>
              store.getThread(id),
            ),
            threadId,
          )
        : undefined;
    const requested = yield* orchestrator.dispatch({
      type,
      commandId,
      threadId,
      ...(family === undefined
        ? {}
        : {
            childDisposition: "stop_and_archive" as const,
            expectedChildThreadIds: family.children.map((child) => child.id),
          }),
    });
    if (
      type !== "thread.archive" ||
      (yield* store.getThread(threadId)).archivePending?.status !== "stopping"
    )
      return { ...requested, effectCommandIds: [commandId] };
    assert.isNull((yield* store.getThread(threadId)).archivedAt);
    // The harness has no worker. Drive real strict shutdown with a test
    // teardown so both phases run without opening a provider or touching live state.
    yield* threads.executeArchive({ threadId, requestId: commandId }).pipe(
      Effect.provide(
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          teardownThread: (input) =>
            Effect.sync(() => {
              teardowns.push(input);
            }),
        }),
      ),
    );
    const completionId = CommandId.make(`${commandId}:complete`);
    // Replaying the completed command reads its persisted events without
    // repeating archive work, allowing callers to inspect both phases together.
    const completed = yield* orchestrator.dispatch({
      type: "thread.archive.complete",
      commandId: completionId,
      threadId,
      requestId: commandId,
    });
    return {
      ...completed,
      storedEvents: [...requested.storedEvents, ...completed.storedEvents],
      effectCommandIds: [commandId, completionId],
    };
  });
  return {
    orchestrator,
    store,
    sink,
    root,
    now,
    command,
    teardowns,
    rootId,
    nativeId,
    nestedId,
    independentId,
    forkId,
  };
});

it.layer(TestLayer)("thread family lifecycle", (it) => {
  it.effect("checks the broader-mode owner before deletion releases its promotion", () =>
    Effect.gen(function* () {
      const h = yield* seed();
      for (const threadId of [h.rootId, h.nativeId, h.nestedId, h.independentId]) {
        const thread = yield* h.store.getThread(threadId);
        yield* h.sink.write({
          events: [
            {
              id: EventId.make(`lower-delete:${threadId}`),
              type: "thread.metadata-updated",
              threadId,
              occurredAt: h.now,
              payload: {
                ...thread,
                runtimeMode: "approval-required",
                ...(threadId === h.rootId
                  ? {
                      lineage: {
                        parentThreadId: h.forkId,
                        rootThreadId: h.forkId,
                        relationshipToParent: "fork",
                      },
                      forkedFrom: {
                        type: "provider_thread",
                        providerThreadId: ProviderThreadId.make(`promotion-source:${h.rootId}`),
                      },
                    }
                  : {}),
              },
            },
          ],
        });
      }
      const source = yield* h.store.getThread(h.forkId);
      const promotion = {
        requestId: CommandId.make(`promotion:${h.rootId}`),
        targetThreadId: h.rootId,
        status: "waiting" as const,
        error: null,
        requestedAt: h.now,
        updatedAt: h.now,
        createdBy: "user" as const,
        creationSource: "web" as const,
      };
      yield* h.sink.write({
        events: [
          {
            id: EventId.make(`promotion-owner:${h.rootId}`),
            type: "thread.metadata-updated",
            threadId: h.forkId,
            occurredAt: h.now,
            payload: { ...source, subagentPromotion: promotion },
          },
        ],
      });
      const refused = yield* h.command("thread.delete", "limited-promotion-release").pipe(
        Effect.provideService(DispatchModeLimit, {
          runtimeMode: "approval-required",
          interactionMode: "default",
        }),
        Effect.flip,
      );
      assert.equal(refused._tag, "OrchestratorThreadAboveModeLimitError");
      if (refused._tag === "OrchestratorThreadAboveModeLimitError")
        assert.equal(refused.threadId, h.forkId);
      assert.isNull((yield* h.store.getThread(h.rootId)).deletedAt);
      assert.deepEqual((yield* h.store.getThread(h.forkId)).subagentPromotion, promotion);
    }),
  );

  it.effect.each(["archived", "deleted"] as const)(
    "does not release a prepared run from a previously %s thread",
    (state) =>
      Effect.gen(function* () {
        const h = yield* seed();
        yield* h.orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`prepare:${h.rootId}`),
          threadId: h.nestedId,
          messageId: MessageId.make(`prepared-message:${h.rootId}`),
          text: "Prepare workspace",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          dispatchMode: { type: "defer_start" },
        });
        const { thread, runs } = yield* h.store.getThreadRecords(h.nestedId, ["runs"]);
        const run = runs[0];
        assert.equal(run?.status, "preparing");
        if (run === undefined) throw new Error("No prepared run");
        yield* h.sink.write({
          events: [
            {
              id: EventId.make(`old-lifecycle:${h.rootId}`),
              type: state === "archived" ? "thread.archived" : "thread.deleted",
              threadId: h.nestedId,
              occurredAt: h.now,
              payload: {
                ...thread,
                archivedAt: state === "archived" ? h.now : null,
                deletedAt: state === "deleted" ? h.now : null,
              },
            },
          ],
        });
        const commandId = CommandId.make(`late-preparation:${h.rootId}`);
        const result = yield* Effect.exit(
          h.orchestrator.dispatch({
            type: "prepared-run.release",
            commandId,
            threadId: h.nestedId,
            runId: run.id,
          }),
        );
        assert.isTrue(Exit.isFailure(result));
        assert.equal(
          (yield* h.store.getThreadRecords(h.nestedId, ["runs"])).runs[0]?.status,
          "preparing",
        );
        assert.deepEqual(
          yield* (yield* EffectOutbox.EffectOutboxV2).listByCommandId(commandId),
          [],
        );
      }),
  );

  it.effect.each(["preparing", "starting", "running", "waiting"] as const)(
    "rejects archive without family consent atomically while a child is %s",
    (status) =>
      Effect.gen(function* () {
        const h = yield* seed();
        const runId = RunId.make(`unfinished:${h.rootId}`);
        yield* h.sink.write({
          events: [
            {
              id: EventId.make(`unfinished-event:${h.rootId}`),
              type: "run.updated",
              threadId: h.nestedId,
              occurredAt: h.now,
              payload: {
                id: runId,
                threadId: h.nestedId,
                ordinal: 1,
                providerInstanceId: instanceId,
                modelSelection: h.root.modelSelection,
                providerThreadId: null,
                userMessageId: MessageId.make(`unfinished-message:${h.rootId}`),
                rootNodeId: null,
                activeAttemptId: null,
                status,
                requestedAt: h.now,
                startedAt: null,
                completedAt: null,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
          ],
        });
        const refused = yield* Effect.flip(
          h.orchestrator.dispatch({
            type: "thread.archive",
            commandId: CommandId.make(`unfinished-family:${h.rootId}`),
            threadId: h.rootId,
          }),
        );
        assert.equal(refused._tag, "OrchestratorDispatchError");
        if (refused._tag === "OrchestratorDispatchError")
          assert.equal(
            refused.cause,
            "Choose whether to stop and archive the subagents or keep them separately before archiving.",
          );
        for (const id of [h.rootId, h.nativeId, h.nestedId])
          assert.isNull((yield* h.store.getThread(id)).archivedAt);
        assert.deepEqual(
          yield* (yield* EffectOutbox.EffectOutboxV2).listByCommandId(
            CommandId.make(`unfinished-family:${h.rootId}`),
          ),
          [],
        );
      }),
  );

  it.effect("restores a late native child inherited from a legacy parent archive", () =>
    Effect.gen(function* () {
      const h = yield* seed();
      yield* h.sink.write({
        events: [
          {
            id: EventId.make(`legacy-owner:${h.rootId}`),
            type: "thread.archived",
            threadId: h.rootId,
            occurredAt: h.now,
            payload: { ...h.root, archivedAt: h.now },
          },
        ],
      });
      const childId = ThreadId.make(`late-legacy-child:${h.rootId}`);
      const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      yield* ingestor.ingestNormalized({
        threadId: h.rootId,
        providerInstanceId: instanceId,
        providerSessionId: ProviderSessionId.make(`legacy-session:${h.rootId}`),
        event: {
          type: "app_thread.created",
          driver: adapter.driver,
          appThread: {
            ...h.root,
            id: childId,
            lineage: {
              parentThreadId: h.rootId,
              rootThreadId: h.rootId,
              relationshipToParent: "subagent",
            },
          },
        },
      });
      const child = yield* h.store.getThread(childId);
      assert.isNotNull(child.archivedAt);
      assert.deepEqual(child.archivedWith, (yield* h.store.getThread(h.rootId)).archivedWith);
      yield* h.command("thread.unarchive", "restore-legacy-owner");
      assert.isNull((yield* h.store.getThread(childId)).archivedAt);
    }),
  );

  it.effect.each(["thread.archive", "thread.unarchive", "thread.delete"] as const)(
    "refuses limited %s before recording family changes or cleanup",
    (type) =>
      Effect.gen(function* () {
        const h = yield* seed();
        if (type === "thread.unarchive") yield* h.command("thread.archive", "prepare-restore");
        for (const id of [h.rootId, h.nativeId, h.independentId]) {
          const thread = yield* h.store.getThread(id);
          yield* h.sink.write({
            events: [
              {
                id: EventId.make(`limit:${id}`),
                type: "thread.metadata-updated",
                threadId: id,
                occurredAt: h.now,
                payload: { ...thread, runtimeMode: "approval-required" },
              },
            ],
          });
        }
        const before = yield* h.store.getThread(h.rootId);
        const refused = yield* h.command(type, "limited-family").pipe(
          Effect.provideService(DispatchModeLimit, {
            runtimeMode: "approval-required",
            interactionMode: "default",
          }),
          Effect.flip,
        );
        assert.equal(refused._tag, "OrchestratorThreadAboveModeLimitError");
        if (refused._tag === "OrchestratorThreadAboveModeLimitError")
          assert.equal(refused.threadId, h.nestedId);
        assert.deepEqual(yield* h.store.getThread(h.rootId), before);
        assert.deepEqual(
          yield* (yield* EffectOutbox.EffectOutboxV2).listByCommandId(
            CommandId.make(`limited-family:${h.rootId}`),
          ),
          [],
        );
      }),
  );

  it.effect.each(["thread.archive", "thread.delete"] as const)(
    "%s keeps separate cleanup for family members sharing a provider session",
    (type) =>
      Effect.gen(function* () {
        const h = yield* seed();
        const sessionId = ProviderSessionId.make(`shared-session:${h.rootId}`);
        for (const threadId of [h.rootId, h.nestedId]) {
          yield* h.sink.write({
            events: [
              {
                id: EventId.make(`attach:${threadId}`),
                type: "provider-session.attached",
                threadId,
                occurredAt: h.now,
                driver: adapter.driver,
                providerInstanceId: instanceId,
                payload: {
                  id: sessionId,
                  providerInstanceId: instanceId,
                  driver: adapter.driver,
                  status: "ready",
                  cwd: "/workspace",
                  model: "model",
                  capabilities: CodexProviderCapabilitiesV2,
                  lastError: null,
                  createdAt: h.now,
                  updatedAt: h.now,
                },
              },
            ],
          });
        }
        const result = yield* h.command(type, "shared-cleanup");
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const effects = (yield* Effect.forEach(result.effectCommandIds, (id) =>
          outbox.listByCommandId(id),
        )).flat();
        if (type === "thread.archive") {
          assert.deepEqual(
            h.teardowns.toSorted((a, b) => a.threadId.localeCompare(b.threadId)),
            [h.rootId, h.nestedId]
              .toSorted()
              .map((threadId) => ({ threadId, providerSessionId: sessionId })),
          );
        } else {
          assert.deepEqual(
            effects
              .filter((effect) => effect.request.type === "provider-session.detach")
              .map((effect) => effect.threadId)
              .toSorted(),
            [h.rootId, h.nestedId].toSorted(),
          );
        }
      }),
  );

  it.effect(
    "archives recursive native and app-owned children in one transaction, preserving independent archives and forks",
    () =>
      Effect.gen(function* () {
        const h = yield* seed();
        const { rootId, nativeId, nestedId, independentId, forkId } = h;
        yield* h.command("thread.archive", "archive-independent", independentId);
        const original = yield* h.store.getThread(independentId);
        const result = yield* h.command("thread.archive", "archive-family");
        assert.deepEqual(
          result.storedEvents
            .filter((e) => e.event.type === "thread.archived")
            .map((e) => e.event.threadId)
            .toSorted(),
          [rootId, nativeId, nestedId].toSorted(),
        );
        for (const id of [rootId, nativeId, nestedId]) {
          const thread = yield* h.store.getThread(id);
          assert.isNotNull(thread.archivedAt);
          assert.equal(thread.archivedWith?.commandId, `archive-family:${rootId}`);
        }
        assert.isNull((yield* h.store.getThread(forkId)).archivedAt);
        assert.deepEqual(
          (yield* h.store.getThread(independentId)).archivedWith,
          original.archivedWith,
        );
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const effects = (yield* Effect.forEach(result.effectCommandIds, (id) =>
          outbox.listByCommandId(id),
        )).flat();
        assert.deepEqual(
          effects
            .filter((e) => e.request.type === "terminal.archive-cleanup")
            .map((e) => e.threadId)
            .toSorted(),
          [rootId, nativeId, nestedId].toSorted(),
        );
        yield* h.command("thread.unarchive", "restore-family");
        for (const id of [rootId, nativeId, nestedId])
          assert.isNull((yield* h.store.getThread(id)).archivedAt);
        assert.isNotNull((yield* h.store.getThread(independentId)).archivedAt);
      }),
  );

  it.effect("keeps repaired grandchildren with their independently archived owner", () =>
    Effect.gen(function* () {
      const h = yield* seed();
      const child = yield* h.store.getThread(h.nativeId);
      yield* h.sink.write({
        events: [
          {
            id: EventId.make(`old-child-archive:${h.rootId}`),
            type: "thread.archived",
            threadId: h.nativeId,
            occurredAt: h.now,
            payload: { ...child, archivedAt: h.now },
          },
        ],
      });
      yield* h.command("thread.archive", "archive-root");
      yield* h.command("thread.unarchive", "restore-root");
      assert.isNotNull((yield* h.store.getThread(h.nativeId)).archivedAt);
      assert.isNotNull((yield* h.store.getThread(h.nestedId)).archivedAt);
      yield* h.command("thread.unarchive", "restore-own-child", h.nativeId);
      assert.isNull((yield* h.store.getThread(h.nestedId)).archivedAt);
    }),
  );

  it.effect("refuses to restore a cohort child before its archived owner", () =>
    Effect.gen(function* () {
      const h = yield* seed();
      const { nativeId, nestedId } = h;
      yield* h.command("thread.archive", "first-archive");
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(h.command("thread.unarchive", "restore-child", nestedId)),
        ),
      );
      assert.isNotNull((yield* h.store.getThread(nestedId)).archivedAt);
      yield* h.command("thread.unarchive", "restore-root");
      assert.isNull((yield* h.store.getThread(nestedId)).archivedAt);
      assert.isNull((yield* h.store.getThread(nativeId)).archivedAt);
    }),
  );

  it.effect("deletes archived and active owned descendants with independent cleanup effects", () =>
    Effect.gen(function* () {
      const h = yield* seed();
      const { rootId, nativeId, nestedId, independentId, forkId } = h;
      yield* h.command("thread.archive", "archive-child", nativeId);
      const result = yield* h.command("thread.delete", "delete-family");
      assert.deepEqual(
        result.storedEvents
          .filter((e) => e.event.type === "thread.deleted")
          .map((e) => e.event.threadId)
          .toSorted(),
        [rootId, nativeId, nestedId, independentId].toSorted(),
      );
      for (const id of [rootId, nativeId, nestedId, independentId])
        assert.isNotNull((yield* h.store.getThread(id)).deletedAt);
      assert.isNull((yield* h.store.getThread(forkId)).deletedAt);
      const effects = yield* (yield* EffectOutbox.EffectOutboxV2).listByCommandId(
        CommandId.make(`delete-family:${rootId}`),
      );
      assert.deepEqual(
        effects
          .filter((e) => e.request.type === "terminal.cleanup")
          .map((e) => e.threadId)
          .toSorted(),
        [rootId, nativeId, nestedId, independentId].toSorted(),
      );
    }),
  );

  it.effect(
    "repairs previously archived parents through durable commands, then restores the repaired cohort",
    () =>
      Effect.gen(function* () {
        const h = yield* seed();
        const { rootId, nativeId, nestedId } = h;
        yield* h.sink.write({
          events: [
            {
              id: EventId.make("old-single-archive"),
              type: "thread.archived",
              threadId: rootId,
              occurredAt: h.now,
              payload: { ...h.root, archivedAt: h.now },
            },
          ],
        });
        yield* h.orchestrator.recoverDelegatedTasks;
        const repaired = yield* h.store.getThread(nativeId);
        assert.isNotNull(repaired.archivedAt);
        assert.equal(repaired.archivedWith?.threadId, rootId);
        yield* h.orchestrator.recoverDelegatedTasks;
        assert.deepEqual((yield* h.store.getThread(nativeId)).archivedWith, repaired.archivedWith);
        yield* h.command("thread.unarchive", "restore-repaired");
        assert.isNull((yield* h.store.getThread(nestedId)).archivedAt);
      }),
  );

  it.effect("repairs children stranded by a previous single-thread deletion", () =>
    Effect.gen(function* () {
      const h = yield* seed();
      const { rootId, nestedId, forkId } = h;
      yield* h.sink.write({
        events: [
          {
            id: EventId.make("old-single-delete"),
            type: "thread.deleted",
            threadId: rootId,
            occurredAt: h.now,
            payload: { ...h.root, deletedAt: h.now },
          },
        ],
      });
      yield* h.orchestrator.recoverDelegatedTasks;
      assert.isNotNull((yield* h.store.getThread(nestedId)).deletedAt);
      assert.isNull((yield* h.store.getThread(forkId)).deletedAt);
    }),
  );

  it.effect.each(["thread.archive", "thread.delete"] as const)(
    "rejects %s atomically when an owned descendant is protected",
    (type) =>
      Effect.gen(function* () {
        const h = yield* seed();
        const { rootId, nativeId, nestedId } = h;
        const child = yield* h.store.getThread(nestedId);
        yield* h.sink.write({
          events: [
            {
              id: EventId.make(`protect-child:${rootId}`),
              type: "thread.metadata-updated",
              threadId: nestedId,
              occurredAt: h.now,
              payload: { ...child, persistent: true },
            },
          ],
        });
        const result = yield* Effect.exit(h.command(type, "protected-family"));
        assert.isTrue(Exit.isFailure(result));
        const root = yield* h.store.getThread(rootId);
        assert.isNull(root.archivedAt);
        assert.isNull(root.deletedAt);
        assert.isNull((yield* h.store.getThread(nativeId)).archivedAt);
      }),
  );
});
