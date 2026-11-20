import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadArchiveFamily,
  type ThreadOwner,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import {
  LastCodePeerArchiveTransport,
  PeerArchiveWriteTransport,
} from "../peer/LastCodePeerArchiveServices.ts";
import { PeerLinks } from "../peer/PeerLinks.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { makeLastCodeArchiveJournal } from "./LastCodeArchiveJournal.ts";
import * as LinkedOperations from "./LastCodeLinkedArchiveOperations.ts";
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

const environmentLayer = ProjectionStore.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.fresh,
);

it.effect("retries linked archive and restore independently of later local archives", () =>
  Effect.gen(function* () {
    yield* saveThread(orchestrator);
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const thread = yield* store.getThread(orchestrator);
    const archiveId = CommandId.make("local-archive");
    const now = yield* DateTime.now;
    const archived: OrchestrationV2StoredEvent = {
      sequence: 4,
      commandId: archiveId,
      event: {
        id: EventId.make("local-archive-commit"),
        type: "thread.archived",
        threadId: orchestrator,
        occurredAt: now,
        payload: { ...thread, archivedAt: now },
      },
    };
    const outcomes = [
      yield* Deferred.make<CommandId>(),
      yield* Deferred.make<CommandId>(),
      yield* Deferred.make<CommandId>(),
    ];
    const restores = [yield* Deferred.make<CommandId>(), yield* Deferred.make<CommandId>()];
    let committed = false;
    let calls = 0;
    let restoreCalls = 0;
    const local = store.apply(archived.event).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          committed = true;
        }),
      ),
      Effect.as({ sequence: 4, storedEvents: [archived] }),
    );
    yield* Effect.gen(function* () {
      const operations = yield* LinkedOperations.captureLinkedArchiveOperations;
      const result = yield* operations.dispatch(
        {
          type: "thread.archive",
          threadId: orchestrator,
          commandId: archiveId,
          linkedArchiveSelection: [
            {
              label: "Build machine",
              environmentId: destination,
              status: "ready",
              cohorts: [
                {
                  anchorThreadId: direct,
                  selectedThreadIds: [direct],
                  typedIn: [],
                  childDisposition: "archive_if_idle",
                },
              ],
            },
          ],
        },
        local,
      );
      assert.equal(result.sequence, 4);
      assert.equal(yield* Deferred.await(outcomes[0]!), archiveId);
      // The source journal still identifies the generation after event retention prunes it.
      committed = false;
      assert.equal((yield* operations.status(orchestrator))?.machines[0]?.status, "pending");
      const retry = yield* operations.dispatch(
        {
          type: "thread.archive",
          threadId: orchestrator,
          commandId: CommandId.make("explicit-retry"),
          linkedArchiveSelection: [],
          expectedLinkedArchiveCommandId: archiveId,
        },
        Effect.die("A linked retry must not archive the local thread again"),
      );
      assert.equal(retry.sequence, 4);
      assert.equal(yield* Deferred.await(outcomes[1]!), archiveId);

      const journal = makeLastCodeArchiveJournal(yield* SqlClient.SqlClient);
      const stale = yield* journal.read({
        role: "source",
        ownerEnvironmentId: origin,
        ownerThreadId: orchestrator,
        sourceArchiveCommandId: archiveId,
      });
      if (stale === null) return yield* Effect.die("Missing archive generation");
      const previous = JSON.parse(stale.stateJson);
      // A user message on the peer made its earlier choice stale.
      yield* journal.compareAndReplace(
        stale,
        stale.revision,
        JSON.stringify({
          ...previous,
          machines: previous.machines.map((machine: object) => ({
            ...machine,
            status: "blocked",
            reason: "selection_changed",
          })),
        }),
      );
      assert.equal((yield* operations.status(orchestrator))?.machines[0]?.requiresReview, true);
      yield* operations.dispatch(
        {
          type: "thread.archive",
          threadId: orchestrator,
          commandId: CommandId.make("review-updated-choice"),
          expectedLinkedArchiveCommandId: archiveId,
          linkedArchiveSelection: [
            { label: "Build machine", environmentId: destination, status: "ready", cohorts: [] },
          ],
        },
        Effect.die("Fresh linked consent must use the same local archive"),
      );
      assert.equal(yield* Deferred.await(outcomes[2]!), archiveId);

      const restoreId = CommandId.make("local-restore");
      const unarchived: OrchestrationV2StoredEvent = {
        sequence: 5,
        commandId: restoreId,
        event: {
          id: EventId.make("local-restore-commit"),
          type: "thread.unarchived",
          threadId: orchestrator,
          occurredAt: now,
          payload: thread,
        },
      };
      yield* operations.dispatch(
        { type: "thread.unarchive", threadId: orchestrator, commandId: restoreId },
        store.apply(unarchived.event).pipe(Effect.as({ sequence: 5, storedEvents: [unarchived] })),
      );
      assert.equal(yield* Deferred.await(restores[0]!), archiveId);

      const nextId = CommandId.make("next-local-archive");
      const nextAt = DateTime.add(now, { seconds: 1 });
      const nextArchive: OrchestrationV2StoredEvent = {
        ...archived,
        sequence: 6,
        commandId: nextId,
        event: {
          id: EventId.make("next-local-archive-commit"),
          type: "thread.archived",
          threadId: orchestrator,
          occurredAt: nextAt,
          payload: { ...thread, archivedAt: nextAt },
        },
      };
      yield* operations.dispatch(
        {
          type: "thread.archive",
          threadId: orchestrator,
          commandId: nextId,
          linkedArchiveSelection: [
            {
              label: "Second machine",
              environmentId: thirdEnvironment,
              status: "pending",
              reason: "offline",
            },
          ],
        },
        store
          .apply(nextArchive.event)
          .pipe(Effect.as({ sequence: 6, storedEvents: [nextArchive] })),
      );
      assert.include(yield* operations.status(orchestrator), {
        operation: "restore",
        sourceArchiveCommandId: archiveId,
      });
      yield* operations.dispatch(
        {
          type: "thread.unarchive",
          threadId: orchestrator,
          commandId: CommandId.make("retry-prior-restore"),
          expectedLinkedArchiveCommandId: archiveId,
        },
        Effect.die("Retrying an older restore must leave the new local archive alone"),
      );
      assert.equal(yield* Deferred.await(restores[1]!), archiveId);
      assert.isNotNull((yield* store.getThread(orchestrator)).archivedAt);
    }).pipe(
      Effect.provide(
        LinkedOperations.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ServerEnvironment)({ getEnvironmentId: Effect.succeed(origin) }),
              Layer.mock(EventSinkV2)({
                readByCommandId: ({ commandId }) =>
                  Stream.suspend(() =>
                    committed && commandId === archiveId ? Stream.succeed(archived) : Stream.empty,
                  ),
              }),
              Layer.mock(PeerArchiveWriteTransport)({
                apply: (id, request) =>
                  Effect.gen(function* () {
                    assert.equal(id, destination);
                    if (calls === 2) {
                      assert.equal(request.selectionRevision, 1);
                      assert.deepEqual(request.cohorts, []);
                    } else {
                      assert.deepEqual(request.cohorts[0]?.selectedThreadIds, [direct]);
                    }
                    const signal = outcomes[calls++];
                    if (signal === undefined)
                      return yield* Effect.die("Unexpected linked archive attempt");
                    yield* Deferred.succeed(signal, request.sourceArchiveCommandId);
                    return yield* Effect.never;
                  }),
                restore: (id, request) =>
                  Effect.gen(function* () {
                    assert.equal(id, destination);
                    const signal = restores[restoreCalls++];
                    if (signal === undefined)
                      return yield* Effect.die("Unexpected linked restore attempt");
                    yield* Deferred.succeed(signal, request.sourceArchiveCommandId);
                    return yield* Effect.never;
                  }),
              }),
            ),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(environmentLayer)),
);

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
              Layer.mock(LinkedOperations.LastCodeLinkedArchiveOperations)({
                status: () =>
                  Effect.succeed({
                    sourceArchiveCommandId: CommandId.make("prior-archive"),
                    operation: "restore",
                    machines: [],
                  }),
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
                        archiveChoices: { defaultCohorts: [], includingTypedInCohorts: [] },
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
    assert.equal(result.linkedArchiveOperation?.operation, "restore");
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
      assert.sameMembers(
        inventory.archiveChoices?.defaultCohorts.flatMap(
          ({ selectedThreadIds }) => selectedThreadIds,
        ) ?? [],
        [direct, remoteChild, belowDeletedPeerOwner],
      );
      assert.sameMembers(
        inventory.archiveChoices?.includingTypedInCohorts.flatMap(
          ({ selectedThreadIds }) => selectedThreadIds,
        ) ?? [],
        [direct, remoteChild, belowDeletedPeerOwner, remotelyKept],
      );

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
