import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  getThreadArchivePlan,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import {
  PeerArchiveDispatch,
  type PeerArchiveCommittedThread,
  type PeerArchiveDispatchInput,
} from "./LastCodePeerArchiveDispatch.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const source = EnvironmentId.make("source");
const destination = EnvironmentId.make("destination");
const sourceRoot = ThreadId.make("source:root");
const rootId = ThreadId.make("destination:root");
const ownerId = ThreadId.make("destination:intermediate");
const childId = ThreadId.make("destination:child");
const reopenedId = ThreadId.make("destination:reopened");
const newerId = ThreadId.make("destination:newer");
const retainedId = ThreadId.make("destination:retained");
const sideChatId = ThreadId.make("destination:side-chat");
const legacyId = ThreadId.make("destination:legacy-placement");

const instanceId = ProviderInstanceId.make("codex");
const db = Sqlite.layerMemory;
const testLayer = Layer.merge(
  ProviderReplayHarness.layerWithRegistry(
    { name: "peer-archive-dispatch" },
    ProviderAdapterRegistry.layerFromAdapters([]),
    { databaseLayer: db, runEffectWorker: false },
  ).pipe(
    Layer.provide(
      Layer.succeed(ServerEnvironmentIdentity, { getEnvironmentId: Effect.succeed(destination) }),
    ),
  ),
  ProjectionStore.layer.pipe(Layer.provide(db)),
);

const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const earlier = DateTime.subtract(now, { milliseconds: 1 });
const later = DateTime.add(now, { milliseconds: 1 });
const historicalMarker = { threadId: ownerId, commandId: CommandId.make("historical-archive") };
const client = { sessionId: "peer-session", label: "Peer", access: "auto", linked: true } as const;
const scope = { ownerEnvironmentId: source, ownerThreadIds: [sourceRoot], client };
const archive = (
  selectedThreadIds: readonly ThreadId[],
  typedIn: Extract<PeerArchiveDispatchInput, { kind: "archive" }>["typedIn"] = [],
) => ({ kind: "archive", ...scope, selectedThreadIds, typedIn }) as const;
const command = (id: string) =>
  ({
    type: "thread.archive",
    threadId: rootId,
    commandId: CommandId.make(id),
    childDisposition: "stop_and_archive",
  }) as const;
const completed = (requestId: CommandId) =>
  ({
    type: "thread.archive.complete",
    threadId: rootId,
    commandId: CommandId.make(`${requestId}:complete`),
    requestId,
  }) as const;

function thread(
  id: ThreadId,
  parentId: ThreadId = rootId,
  options: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2AppThread {
  return {
    id,
    title: id,
    projectId: ProjectId.make("project:peer-archive"),
    createdBy: "agent",
    creationSource: "mcp",
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "example-model" },
    runtimeMode: "auto",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    linkOrigin: client,
    lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
    creatorOrigin: {
      kind: "thread_launch",
      environmentId: id === rootId ? source : destination,
      threadId: id === rootId ? sourceRoot : parentId,
      owned: true,
    },
    forkedFrom: null,
    createdAt: earlier,
    updatedAt: earlier,
    archivedAt: null,
    settledAt: null,
    settledOverride: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...options,
  };
}

const save = Effect.fnUntraced(function* (
  row: OrchestrationV2AppThread,
  type: "thread.created" | "thread.metadata-updated" = "thread.created",
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  yield* store.apply({
    id: EventId.make(`${type}:${row.id}:${DateTime.formatIso(row.updatedAt)}`),
    type,
    threadId: row.id,
    occurredAt: row.updatedAt,
    payload: row,
  });
});

const sendFirstHumanMessage = Effect.fnUntraced(function* (id: ThreadId) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  yield* store.apply({
    id: EventId.make(`human:${id}`),
    type: "message.updated",
    threadId: id,
    occurredAt: now,
    payload: {
      id: MessageId.make(`human:${id}`),
      threadId: id,
      runId: null,
      nodeId: null,
      role: "user",
      text: "I am taking over from here.",
      attachments: [],
      streaming: false,
      createdBy: "user",
      creationSource: "web",
      createdAt: now,
      updatedAt: now,
    },
  });
});

it.effect.each(["root message", "intervening message", "promotion"] as const)(
  "rejects a reviewed peer archive after a %s and preserves its rejection receipt",
  (change) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const orchestrator = yield* OrchestratorV2;
      const intermediate = thread(ownerId);
      yield* save(thread(rootId));
      yield* save(intermediate);
      yield* save(thread(childId, ownerId));
      const reviewed = archive([rootId, childId]);
      const humanId = change === "root message" ? rootId : ownerId;
      if (change === "promotion") {
        yield* save(
          {
            ...intermediate,
            lineage: { ...intermediate.lineage, independent: true },
            updatedAt: now,
          },
          "thread.metadata-updated",
        );
      } else yield* sendFirstHumanMessage(humanId);

      const request = command("peer:rejected");
      const rejected = yield* orchestrator
        .dispatch(request)
        .pipe(Effect.provideService(PeerArchiveDispatch, reviewed), Effect.flip);
      assert.strictEqual(rejected._tag, "OrchestratorDispatchError");
      const refreshed = archive(
        change === "promotion" ? [rootId] : reviewed.selectedThreadIds,
        change === "promotion"
          ? []
          : [{ threadId: humanId, latestHumanMessageAt: DateTime.formatIso(now) }],
      );
      const replay = yield* orchestrator
        .dispatch(request)
        .pipe(Effect.provideService(PeerArchiveDispatch, refreshed), Effect.flip);
      assert.strictEqual(replay._tag, "OrchestratorCommandPreviouslyRejectedError");
      for (const id of reviewed.selectedThreadIds)
        assert.isTrue((yield* store.getThread(id)).archivePending == null);

      yield* orchestrator
        .dispatch(command("peer:fresh"))
        .pipe(Effect.provideService(PeerArchiveDispatch, refreshed));
      assert.strictEqual((yield* store.getThread(rootId)).archivePending?.status, "stopping");
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each(["different environment", "different link"] as const)(
  "refuses a selected child with a %s despite an authorized anchor",
  (mismatch) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const orchestrator = yield* OrchestratorV2;
      yield* save(thread(rootId));
      yield* save(
        thread(
          childId,
          rootId,
          mismatch === "different environment"
            ? {
                creatorOrigin: {
                  kind: "thread_launch",
                  environmentId: EnvironmentId.make("unrelated-environment"),
                  threadId: sourceRoot,
                  owned: true,
                },
              }
            : { linkOrigin: { ...client, sessionId: "other-session" } },
        ),
      );
      const result = yield* orchestrator
        .dispatch(command("peer:wrong-authority"))
        .pipe(Effect.provideService(PeerArchiveDispatch, archive([rootId, childId])), Effect.flip);
      assert.strictEqual(result._tag, "OrchestratorDispatchError");
      for (const id of [rootId, childId]) {
        const row = yield* store.getThread(id);
        assert.isNull(row.archivedAt);
        assert.isTrue(row.archivePending == null);
      }
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each(["first human message", "promotion", "raised mode"] as const)(
  "rechecks %s before completing a persisted shutdown without the caller context",
  (change) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const orchestrator = yield* OrchestratorV2;
      const intermediate = thread(ownerId);
      yield* save(thread(rootId));
      yield* save(intermediate);
      yield* save(thread(childId, ownerId));
      const request = command("peer:shutdown");
      yield* orchestrator
        .dispatch(request)
        .pipe(Effect.provideService(PeerArchiveDispatch, archive([rootId, childId])));
      if (change === "first human message") yield* sendFirstHumanMessage(ownerId);
      else if (change === "promotion") {
        yield* save(
          {
            ...intermediate,
            lineage: { ...intermediate.lineage, independent: true },
            updatedAt: now,
          },
          "thread.metadata-updated",
        );
      } else {
        const held = yield* store.getThread(childId);
        yield* save(
          { ...held, runtimeMode: "full-access", updatedAt: now },
          "thread.metadata-updated",
        );
      }

      const rejected = yield* orchestrator.dispatch(completed(request.commandId)).pipe(Effect.flip);
      assert.strictEqual(
        rejected._tag,
        change === "raised mode"
          ? "OrchestratorThreadAboveModeLimitError"
          : "OrchestratorDispatchError",
      );
      yield* orchestrator.dispatch({
        type: "thread.archive.fail",
        threadId: rootId,
        commandId: CommandId.make(`${request.commandId}:failed`),
        requestId: request.commandId,
        error: "Review changed during shutdown.",
      });
      for (const id of [rootId, childId]) {
        const row = yield* store.getThread(id);
        assert.isNull(row.archivedAt);
        assert.strictEqual(row.archivePending?.status, "failed");
      }
      assert.isTrue((yield* store.getThread(ownerId)).archivePending == null);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "archives only selected threads and restores only their matching committed transitions",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const orchestrator = yield* OrchestratorV2;
      const root = thread(rootId);
      yield* save(root);
      yield* save(thread(ownerId, rootId, { archivedAt: earlier, archivedWith: historicalMarker }));
      yield* save(thread(childId, ownerId));
      yield* save(thread(reopenedId));
      yield* save(thread(newerId));
      yield* save(thread(retainedId));
      yield* save(thread(sideChatId, rootId, { lineage: { ...root.lineage, sideChat: true } }));
      yield* save(
        thread(legacyId, rootId, {
          creatorOrigin: { kind: "thread_launch", environmentId: destination, threadId: rootId },
          creatorThreadId: rootId,
          creatorGrouping: "grouped",
        }),
      );
      const task = {
        id: NodeId.make("retained-task"),
        threadId: rootId,
        runId: null,
        parentNodeId: NodeId.make("retained-parent"),
        origin: "app_owned",
        createdBy: "agent",
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: instanceId,
        providerThreadId: null,
        childThreadId: retainedId,
        nativeTaskRef: null,
        prompt: "Keep working",
        title: null,
        model: null,
        status: "running",
        result: null,
        startedAt: earlier,
        completedAt: null,
        updatedAt: earlier,
      } as const;
      yield* store.apply({
        id: EventId.make("retained-task"),
        type: "subagent.updated",
        threadId: rootId,
        nodeId: task.id,
        occurredAt: earlier,
        payload: task,
      });

      const request = command("peer:exact");
      const selected = [childId, reopenedId, newerId, rootId];
      yield* orchestrator
        .dispatch(request)
        .pipe(Effect.provideService(PeerArchiveDispatch, archive(selected)));
      const pending = getThreadArchivePlan((yield* store.getThread(rootId)).archivePending);
      assert.isNotNull(pending);
      assert.strictEqual(pending!.peer?.linkSessionId, client.sessionId);
      assert.sameMembers([...pending!.archiveThreadIds], selected);
      assert.strictEqual(pending!.archiveThreadIds[0], rootId);

      const result = yield* orchestrator.dispatch(completed(request.commandId));
      const committed: PeerArchiveCommittedThread[] = result.storedEvents.flatMap(({ event }) =>
        event.type === "thread.archived" &&
        event.payload.archivedAt !== null &&
        event.payload.archivedWith != null
          ? [
              {
                threadId: event.threadId,
                archivedAt: DateTime.formatIso(event.payload.archivedAt),
                archivedWith: event.payload.archivedWith,
              },
            ]
          : [],
      );
      assert.sameMembers(
        committed.map(({ threadId }) => threadId),
        selected,
      );
      for (const { archivedWith } of committed)
        assert.deepEqual(archivedWith, { threadId: rootId, commandId: request.commandId });
      for (const id of [retainedId, sideChatId, legacyId]) {
        const untouched = yield* store.getThread(id);
        assert.isNull(untouched.archivedAt);
        assert.isTrue(untouched.archivePending == null);
      }
      assert.strictEqual(
        (yield* store.getThreadRecords(rootId, ["subagents"])).subagents[0]?.status,
        "running",
      );
      assert.deepEqual((yield* store.getThread(ownerId)).archivedWith, historicalMarker);

      const reopened = yield* store.getThread(reopenedId);
      const newer = yield* store.getThread(newerId);
      const archivedRoot = yield* store.getThread(rootId);
      const newerMarker = { threadId: newerId, commandId: CommandId.make("separate-archive") };
      yield* save(
        { ...reopened, archivedAt: null, archivedWith: null, updatedAt: later },
        "thread.metadata-updated",
      );
      yield* save(
        { ...newer, archivedAt: later, archivedWith: newerMarker, updatedAt: later },
        "thread.metadata-updated",
      );
      // Even the same marker is insufficient if the archived transition has changed.
      yield* save(
        { ...archivedRoot, archivedAt: later, updatedAt: later },
        "thread.metadata-updated",
      );

      const restore = yield* orchestrator
        .dispatch({
          type: "thread.unarchive",
          commandId: CommandId.make("peer:restore"),
          threadId: rootId,
        })
        .pipe(Effect.provideService(PeerArchiveDispatch, { kind: "restore", ...scope, committed }));
      assert.deepEqual(
        restore.storedEvents
          .filter(({ event }) => event.type === "thread.unarchived")
          .map(({ event }) => event.threadId),
        [childId],
      );
      assert.isNull((yield* store.getThread(childId)).archivedAt);
      assert.isNull((yield* store.getThread(reopenedId)).archivedAt);
      assert.deepEqual((yield* store.getThread(newerId)).archivedWith, newerMarker);
      assert.deepEqual((yield* store.getThread(rootId)).archivedAt, later);
      assert.deepEqual((yield* store.getThread(ownerId)).archivedWith, historicalMarker);
    }).pipe(Effect.provide(testLayer)),
);
