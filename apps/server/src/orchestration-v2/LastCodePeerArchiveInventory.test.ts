import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
  type ThreadOwner,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sqlite from "../persistence/Sqlite.ts";
import {
  readPeerArchiveInventory,
  readPeerArchiveOwnerScope,
} from "./LastCodePeerArchiveInventory.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const origin = EnvironmentId.make("workstation");
const destination = EnvironmentId.make("managed-server");
const thirdEnvironment = EnvironmentId.make("other-environment");
const orchestrator = ThreadId.make("thread:orchestrator");
const localChild = ThreadId.make("thread:local-child");
const remoteChild = ThreadId.make("thread:remote-child");
const typedBranch = ThreadId.make("thread:typed-branch");
const nested = ThreadId.make("thread:nested");
const direct = ThreadId.make("thread:direct");
const typedLocal = ThreadId.make("thread:typed-local");
const remotelyKept = ThreadId.make("thread:remotely-kept");

const saveThread = Effect.fn("PeerArchiveInventoryTest.saveThread")(function* (
  id: ThreadId,
  owner?: ThreadOwner,
  options?: {
    readonly typed?: boolean;
    readonly archived?: boolean;
    readonly persistent?: boolean;
  },
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const instanceId = ProviderInstanceId.make("codex");
  const thread: OrchestrationV2AppThread = {
    id,
    title: id,
    projectId: ProjectId.make(`project:${id}`),
    createdBy: owner === undefined ? "user" : "agent",
    creationSource: owner === undefined ? "web" : "mcp",
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "example-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: options?.archived ? now : null,
    settledAt: null,
    settledOverride: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...(owner === undefined
      ? {}
      : { creatorOrigin: { kind: "thread_launch", ...owner, owned: true } }),
    ...(options?.persistent ? { persistent: true } : {}),
  };
  yield* store.apply({
    id: EventId.make(`create:${id}`),
    type: "thread.created",
    threadId: id,
    occurredAt: now,
    payload: thread,
  });
  if (options?.typed) {
    yield* store.apply({
      id: EventId.make(`message:${id}`),
      type: "message.updated",
      threadId: id,
      occurredAt: now,
      payload: {
        id: MessageId.make(`message:${id}`),
        threadId: id,
        runId: null,
        nodeId: null,
        role: "user",
        text: "Keep this branch open",
        attachments: [],
        streaming: false,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
      },
    });
  }
});

const environmentLayer = (name: string) => {
  const database = Sqlite.layerMemory;
  const replay = ProviderReplayHarness.layerWithRegistry(
    { name },
    ProviderAdapterRegistry.layerFromAdapters([]),
    { databaseLayer: database, runEffectWorker: false },
  );
  return ThreadManagement.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(replay, ProjectionStore.layer.pipe(Layer.provideMerge(database))),
    ),
    Layer.fresh,
  );
};

it.effect("reads only recorded ownership across two separate environment databases", () =>
  Effect.gen(function* () {
    const request = yield* Effect.gen(function* () {
      yield* saveThread(orchestrator);
      yield* saveThread(localChild, { environmentId: origin, threadId: orchestrator });
      yield* saveThread(
        typedLocal,
        { environmentId: origin, threadId: localChild },
        { typed: true, archived: true },
      );
      const store = yield* ProjectionStore.ProjectionStoreV2;
      return yield* readPeerArchiveOwnerScope(origin, orchestrator, store);
    }).pipe(Effect.provide(environmentLayer("archive-inventory-origin")));

    assert.sameMembers([...request.ownerThreadIds], [orchestrator, localChild, typedLocal]);
    assert.deepEqual(request.keptOwnerThreadIds, [typedLocal]);

    yield* Effect.gen(function* () {
      yield* saveThread(direct, { environmentId: origin, threadId: orchestrator });
      yield* saveThread(remoteChild, { environmentId: origin, threadId: localChild });
      yield* saveThread(
        typedBranch,
        { environmentId: destination, threadId: remoteChild },
        { typed: true, archived: true },
      );
      yield* saveThread(
        nested,
        { environmentId: destination, threadId: typedBranch },
        { persistent: true },
      );
      yield* saveThread(remotelyKept, { environmentId: origin, threadId: typedLocal });
      yield* saveThread(ThreadId.make("thread:wrong-environment"), {
        environmentId: thirdEnvironment,
        threadId: orchestrator,
      });
      yield* saveThread(ThreadId.make("thread:unowned"));
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const family = threads.getThreadArchiveFamily;
      const inventory = yield* readPeerArchiveInventory(destination, request, {
        store,
        family,
        authorize: () => Effect.void,
      });
      assert.equal(inventory.environmentId, destination);
      assert.sameMembers(
        inventory.threads.map(({ threadId }) => threadId),
        [direct, remoteChild, nested, remotelyKept],
      );
      assert.sameMembers([...inventory.keptThreadIds], [nested, remotelyKept]);
      assert.deepEqual(inventory.protectedThreadIds, [nested]);

      const refusal = yield* readPeerArchiveInventory(destination, request, {
        store,
        family: () => Effect.die("Read activity before authorizing every member"),
        authorize: ({ id }) => (id === nested ? Effect.fail("denied" as const) : Effect.void),
      }).pipe(Effect.flip);
      assert.equal(refusal, "denied");
    }).pipe(Effect.provide(environmentLayer("archive-inventory-destination")));
  }),
);
