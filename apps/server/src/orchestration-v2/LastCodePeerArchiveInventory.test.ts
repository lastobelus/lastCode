import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadArchiveFamily,
  type ThreadOwner,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { LastCodePeerArchiveTransport } from "../peer/LastCodePeerArchiveTransport.ts";
import { PeerLinks } from "../peer/PeerLinks.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as LinkedPreview from "./LastCodeLinkedArchivePreview.ts";
import {
  readPeerArchiveInventory,
  readPeerArchiveOwnerScope,
} from "./LastCodePeerArchiveInventory.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

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
const deletedPeerOwner = ThreadId.make("thread:deleted-peer-owner");
const belowDeletedPeerOwner = ThreadId.make("thread:below-deleted-peer-owner");

const saveThread = Effect.fn("PeerArchiveInventoryTest.saveThread")(function* (
  id: ThreadId,
  owner?: ThreadOwner,
  options?: {
    readonly typed?: boolean;
    readonly archived?: boolean;
    readonly deleted?: boolean;
    readonly persistent?: boolean;
    readonly unread?: boolean;
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
  if (options?.typed || options?.unread) {
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
        role: options.typed ? "user" : "assistant",
        text: options.typed ? "Keep this branch open" : "The work is ready to review",
        attachments: [],
        streaming: false,
        createdBy: options.typed ? "user" : "agent",
        creationSource: options.typed ? "web" : "mcp",
        createdAt: now,
        updatedAt: now,
      },
    });
  }
  if (options?.deleted) {
    yield* store.apply({
      id: EventId.make(`delete:${id}`),
      type: "thread.deleted",
      threadId: id,
      occurredAt: now,
      payload: { ...thread, deletedAt: now },
    });
  }
});

const environmentLayer = ProjectionStore.layer.pipe(Layer.provide(Sqlite.layerMemory), Layer.fresh);

it.effect("shares the linked preview deadline between owner lookup and peer inventory", () =>
  Effect.gen(function* () {
    yield* saveThread(orchestrator);
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const root = yield* store.getThreadShell(orchestrator);
    if (root === null) return yield* Effect.die("Missing preview root");
    const family: OrchestrationV2ThreadArchiveFamily = {
      threads: [root],
      childThreadIds: [],
      activeChildThreadIds: [],
      activeThreadIds: [],
      unreadThreadIds: [],
      promotableChildThreadIds: [],
      keptThreadIds: [],
      protectedChildThreadIds: [],
      nativeStopCount: 0,
      requiresConfirmation: false,
      canPromote: false,
      canStopAndArchive: true,
    };
    const lookupStarted = yield* Deferred.make<void>();
    const finishLookup = yield* Deferred.make<void>();
    const peerStarted = yield* Deferred.make<void>();
    const now = yield* DateTime.now;
    const peers = [
      { environmentId: destination, label: "Build machine" },
      { environmentId: thirdEnvironment, label: "Ready machine" },
    ].map((peer) => ({
      ...peer,
      urls: ["https://example.test"],
      access: "auto" as const,
      linkedAt: now,
      expiresAt: now,
      lastReachedAt: null,
      lastError: null,
    }));
    const preview = yield* LinkedPreview.LastCodeLinkedArchivePreview.pipe(
      Effect.flatMap(({ load }) => load(orchestrator, family)),
      Effect.provide(
        LinkedPreview.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ServerEnvironment)({ getEnvironmentId: Effect.succeed(origin) }),
              Layer.mock(PeerLinks)({
                enabled: Effect.succeed(true),
                listStored: Effect.succeed(peers),
              }),
              Layer.succeed(ProjectionStore.ProjectionStoreV2, {
                ...store,
                getArchiveFamilyThreadIds: (id) =>
                  Deferred.succeed(lookupStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(finishLookup)),
                    Effect.andThen(store.getArchiveFamilyThreadIds(id)),
                  ),
              }),
              Layer.succeed(LastCodePeerArchiveTransport, {
                inventory: (environmentId) =>
                  environmentId === destination
                    ? Deferred.succeed(peerStarted, undefined).pipe(Effect.andThen(Effect.never))
                    : Effect.succeed({
                        environmentId,
                        threads: [],
                        typedInThreadIds: [],
                        activeThreadIds: [],
                        unreadThreadIds: [],
                        protectedThreadIds: [],
                        keptThreadIds: [],
                      }),
              }),
            ),
          ),
        ),
      ),
      Effect.forkScoped,
    );
    yield* Deferred.await(lookupStarted);
    yield* TestClock.adjust("600 millis");
    yield* Deferred.succeed(finishLookup, undefined);
    yield* Deferred.await(peerStarted);
    yield* TestClock.adjust("400 millis");
    assert.isDefined(preview.pollUnsafe());
    const result = yield* Fiber.join(preview);
    assert.deepEqual(
      result.linkedArchivePreview?.map(({ label, status }) => ({ label, status })),
      [
        { label: "Build machine", status: "pending" },
        { label: "Ready machine", status: "ready" },
      ],
    );
  }).pipe(Effect.provide(environmentLayer)),
);

it.effect("reads only recorded ownership across two separate environment databases", () =>
  Effect.gen(function* () {
    const request = yield* Effect.gen(function* () {
      yield* saveThread(orchestrator);
      yield* saveThread(
        localChild,
        { environmentId: origin, threadId: orchestrator },
        { typed: true, deleted: true },
      );
      yield* saveThread(
        typedLocal,
        { environmentId: origin, threadId: localChild },
        { typed: true, archived: true },
      );
      const store = yield* ProjectionStore.ProjectionStoreV2;
      return yield* readPeerArchiveOwnerScope(origin, orchestrator, store);
    }).pipe(Effect.provide(environmentLayer));

    assert.sameMembers([...request.ownerThreadIds], [orchestrator, localChild, typedLocal]);
    assert.deepEqual(request.keptOwnerThreadIds, [typedLocal]);

    yield* Effect.gen(function* () {
      yield* saveThread(
        direct,
        { environmentId: origin, threadId: orchestrator },
        { unread: true },
      );
      yield* saveThread(remoteChild, { environmentId: origin, threadId: localChild });
      yield* saveThread(
        deletedPeerOwner,
        { environmentId: destination, threadId: remoteChild },
        { typed: true, deleted: true },
      );
      yield* saveThread(belowDeletedPeerOwner, {
        environmentId: destination,
        threadId: deletedPeerOwner,
      });
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
      const inventory = yield* readPeerArchiveInventory(destination, request, {
        store,
        authorize: () => Effect.void,
      });
      assert.equal(inventory.environmentId, destination);
      assert.sameMembers(
        inventory.threads.map(({ threadId }) => threadId),
        [direct, remoteChild, nested, remotelyKept, belowDeletedPeerOwner],
      );
      assert.sameMembers([...inventory.keptThreadIds], [nested, remotelyKept]);
      assert.deepEqual(inventory.protectedThreadIds, [nested]);
      assert.deepEqual(inventory.unreadThreadIds, [direct]);

      const refusal = yield* readPeerArchiveInventory(destination, request, {
        store: {
          ...store,
          getThreadRecords: () => Effect.die("Read activity before authorizing every member"),
        },
        authorize: ({ id }) => (id === nested ? Effect.fail("denied" as const) : Effect.void),
      }).pipe(Effect.flip);
      assert.equal(refusal, "denied");
    }).pipe(Effect.provide(environmentLayer));
  }),
);
