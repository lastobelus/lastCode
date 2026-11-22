import * as NetAddress from "effect/net/NetAddress";
import { HttpServer } from "effect/http";
import { EnvironmentId, type ModelSelection } from "@t3tools/contracts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  NodeId,
  UpdateDrainRequestId,
  UpdateDrainTargetVersion,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as WorkspaceAcquisitionTestkit from "../workspace/WorkspaceAcquisition.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as UpdateDrainRepository from "../persistence/UpdateDrainRepository.ts";
import * as UpdateDrain from "../updateDrain/UpdateDrain.ts";
import * as UpdateDrainAdmission from "../updateDrain/UpdateDrainAdmission.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderInstallationGate from "../provider/ProviderInstallationGate.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as CommandOutputHub from "./CommandOutputHub.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const layerTestDatabase = SqlitePersistence.layerMemory;
const layerTestStores = Layer.mergeAll(
  EventStore.layer,
  ProjectionStore.layer,
  EffectOutbox.layer,
).pipe(Layer.provide(layerTestDatabase));
const layerTestEventSink = EventSink.layer.pipe(
  Layer.provide(Layer.mergeAll(layerTestStores, layerTestDatabase)),
);
const CodexCapabilities: OrchestrationV2ProviderCapabilities = CodexProviderCapabilitiesV2;
const ExclusiveCapabilities: OrchestrationV2ProviderCapabilities = {
  ...CodexCapabilities,
  sessions: {
    ...CodexCapabilities.sessions,
    supportsMultipleProviderThreadsPerSession: false,
  },
};

const emptyState = {
  openCount: 0,
  closeCount: 0,
  interruptCount: 0,
  unloadedNativeThreadIds: [] as ReadonlyArray<string>,
};

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const CODEX_DRIVER = ProviderDriverKind.make("codex");

const runtimePolicy = {
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: process.cwd(),
} satisfies ProviderAdapter.ProviderAdapterV2RuntimePolicy;

function makeProviderSession(input: {
  readonly providerSessionId: ProviderSessionId;
  readonly now: DateTime.Utc;
  readonly capabilities?: OrchestrationV2ProviderCapabilities;
  readonly cwd?: string;
}): OrchestrationV2ProviderSession {
  return {
    id: input.providerSessionId,
    driver: CODEX_DRIVER,
    providerInstanceId: modelSelection.instanceId,
    status: "ready",
    cwd: input.cwd ?? process.cwd(),
    model: "gpt-5.4",
    capabilities: input.capabilities ?? CodexCapabilities,
    createdAt: input.now,
    updatedAt: input.now,
    lastError: null,
  };
}

function makeThreadCreatedEvent(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly threadId: ThreadId;
  readonly now: DateTime.Utc;
  readonly projectId?: ProjectId;
  readonly delegatedBy?: ThreadId;
}) {
  return Effect.gen(function* () {
    const projectId =
      input.projectId ??
      (yield* input.idAllocator.allocate.project({
        fixtureName: "provider-session-manager",
      }));
    const providerThreadId = input.idAllocator.derive.providerThread({
      driver: CODEX_DRIVER,
      nativeThreadId: "native-thread",
    });
    const thread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId,
      title: "Provider session manager",
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThreadId,
      lineage:
        input.delegatedBy === undefined
          ? { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId }
          : {
              parentThreadId: input.delegatedBy,
              relationshipToParent: "subagent",
              rootThreadId: input.delegatedBy,
            },
      forkedFrom: null,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    return {
      id: yield* input.idAllocator.allocate.event({ threadId: input.threadId }),
      type: "thread.created" as const,
      threadId: input.threadId,
      occurredAt: input.now,
      payload: thread,
    };
  });
}

function makeProviderThread(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly threadId: ThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly now: DateTime.Utc;
  readonly nativeThreadId?: string;
}): OrchestrationV2ProviderThread {
  const nativeThreadId = input.nativeThreadId ?? "native-thread";
  return {
    id: input.idAllocator.derive.providerThread({
      driver: CODEX_DRIVER,
      nativeThreadId,
    }),
    driver: CODEX_DRIVER,
    providerInstanceId: modelSelection.instanceId,
    providerSessionId: input.providerSessionId,
    appThreadId: input.threadId,
    ownerNodeId: null,
    nativeThreadRef: {
      driver: CODEX_DRIVER,
      nativeId: nativeThreadId,
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

const fakeHttpServer = HttpServer.HttpServer.of({
  address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});

const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-provider-session-manager")),
  getDescriptor: Effect.die("unused"),
});

const layerTestMcpRegistry = Layer.effect(
  McpSessionRegistry.McpSessionRegistry,
  McpSessionRegistry.__testing.make(),
).pipe(
  Layer.provide(Layer.succeed(HttpServer.HttpServer, fakeHttpServer)),
  Layer.provide(Layer.succeed(ServerEnvironment.ServerEnvironment, fakeEnvironment)),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

// Keep the actual session manager, event sink and SQLite projections; only the provider process is a fixture.
function layerTest(input: {
  readonly state: Ref.Ref<typeof emptyState>;
  readonly idleTimeoutMs: number;
  readonly capabilities?: OrchestrationV2ProviderCapabilities;
  readonly beforeClose?: Effect.Effect<void>;
  readonly beforeUnload?: Effect.Effect<void>;
  readonly eventSinkLayer?: typeof layerTestEventSink;
}) {
  const sink = input.eventSinkLayer ?? layerTestEventSink;
  const adapter = ProviderAdapter.ProviderAdapterV2.of({
    instanceId: modelSelection.instanceId,
    driver: CODEX_DRIVER,
    getCapabilities: () => Effect.succeed(input.capabilities ?? CodexCapabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (open) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        yield* Ref.update(input.state, (s) => ({ ...s, openCount: s.openCount + 1 }));
        yield* Effect.addFinalizer(() =>
          Ref.update(input.state, (s) => ({ ...s, closeCount: s.closeCount + 1 })),
        );
        if (input.beforeClose !== undefined) yield* Effect.addFinalizer(() => input.beforeClose!);
        return {
          instanceId: modelSelection.instanceId,
          driver: CODEX_DRIVER,
          events: Stream.never,
          backgroundTasksEndWithProcess: true,
          providerSessionId: open.providerSessionId,
          providerSession: makeProviderSession({
            providerSessionId: open.providerSessionId,
            now,
            ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
          }),
          ensureThread: () => Effect.die("unused ensureThread"),
          resumeThread: (resume) => Effect.succeed(resume.providerThread),
          startTurn: () => Effect.void,
          steerTurn: () => Effect.void,
          interruptTurn: () =>
            Ref.update(input.state, (s) => ({ ...s, interruptCount: s.interruptCount + 1 })),
          unloadThread: ({ providerThread }) =>
            (input.beforeUnload ?? Effect.void).pipe(
              Effect.andThen(
                Ref.update(input.state, (s) => ({
                  ...s,
                  unloadedNativeThreadIds: [
                    ...s.unloadedNativeThreadIds,
                    providerThread.nativeThreadRef?.nativeId ?? "",
                  ],
                })),
              ),
            ),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
          rollbackThread: () => Effect.die("unused rollbackThread"),
          forkThread: () => Effect.die("unused forkThread"),
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  });
  const registry = ProviderAdapterRegistry.layerSingle(adapter);
  const ingestor = ProviderEventIngestor.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          getInstance: () => Effect.undefined,
        }),
        sink,
        IdAllocator.layer,
        layerTestStores,
        ThreadCommandExecutor.layer,
        Layer.mock(GitVcsDriver.GitVcsDriver)({ resolveBranchName: () => Effect.succeed(null) }),
      ),
    ),
  );
  return Layer.mergeAll(
    layerTestStores,
    sink,
    IdAllocator.layer,
    ProviderSessionManager.layerWithOptions({
      idleTimeoutMs: input.idleTimeoutMs,
      configureMcp: false,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          registry,
          sink,
          layerTestStores,
          IdAllocator.layer,
          layerTestMcpRegistry,
          McpProviderSessions.layer,
          ingestor,
          WorkspaceAcquisitionTestkit.layer,
          ProviderInstallationGate.layer,
          CommandOutputHub.layer.pipe(Layer.provide(Layer.merge(sink, layerTestStores))),
        ),
      ),
    ),
  ).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
}

it.effect.each(["completion", "timeout"] as const)(
  "worktree teardown waits for concurrent session scope close (%s)",
  (outcome) =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      const closeEntered = yield* Deferred.make<void>();
      const allowClose = yield* Deferred.make<void>();
      const beforeClose = Deferred.succeed(closeEntered, undefined).pipe(
        Effect.andThen(Deferred.await(allowClose)),
      );
      yield* Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const ids = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make(`teardown-${outcome}`);
        const providerSessionId = yield* ids.allocate.providerSession({
          providerInstanceId: modelSelection.instanceId,
          threadId,
        });
        yield* sink.write({
          events: [yield* makeThreadCreatedEvent({ idAllocator: ids, threadId, now })],
        });
        yield* manager.open({ threadId, providerSessionId, modelSelection, runtimePolicy });
        const requestId = UpdateDrainRequestId.make(`teardown-update-${outcome}`);
        const admission = yield* UpdateDrainAdmission.makeUpdateDrainAdmission().pipe(
          Effect.provide(
            Layer.mergeAll(
              UpdateDrain.layer.pipe(
                Layer.provide(UpdateDrainRepository.layer),
                Layer.provide(layerTestDatabase),
              ),
              Layer.mock(TerminalManager)({ refreshMetadata: Effect.succeed([]) }),
              EffectOutbox.layer.pipe(Layer.provide(layerTestDatabase)),
            ),
          ),
        );
        yield* admission.dispatch({
          type: "update-drain.start",
          commandId: CommandId.make(`teardown-update-start-${outcome}`),
          requestId,
          targetVersion: UpdateDrainTargetVersion.make("1.2.3"),
          createdAt: DateTime.formatIso(now),
        });
        // A live idle provider is reusable state, not an execution blocker.
        assert.deepEqual((yield* admission.status).blockers, []);
        const durableCleanup = yield* EffectOutbox.EffectOutboxV2;
        yield* durableCleanup.enqueue([
          {
            id: `held-close:${outcome}`,
            commandId: CommandId.make(`held-close:${outcome}`),
            threadId,
            request: { type: "provider-session.detach", providerSessionId },
          },
        ]);
        const cleanupRow = Option.getOrThrow(
          yield* durableCleanup.claimNext({ workerId: "held-close" }),
        );
        // Let the durable owner finish while the adapter finalizer is still held.
        // The later runtime read must retain the stopping blocker independently.
        const outboxDetach = yield* manager
          .detach({ threadId, providerSessionId })
          .pipe(Effect.forkChild);
        yield* Deferred.await(closeEntered);
        yield* durableCleanup.succeed({ effectId: cleanupRow.id, workerId: "held-close" });
        assert.isEmpty(yield* durableCleanup.pendingCleanup);
        assert.isTrue(Option.isNone(yield* manager.get(providerSessionId)));
        assert.deepEqual(yield* manager.pendingExecution, [
          { providerSessionId, status: "stopping" },
        ]);
        assert.deepEqual((yield* admission.status).blockers, [
          { type: "provider-runtime", providerSessionId, status: "stopping" },
        ]);
        assert.equal(
          (yield* Effect.result(admission.claimActivation({ requestId })))._tag,
          "Failure",
        );
        const teardownDone = yield* Ref.make(false);
        const teardown = yield* manager.teardownThread({ threadId, providerSessionId }).pipe(
          Effect.tap(() => Ref.set(teardownDone, true)),
          Effect.result,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        assert.isFalse(yield* Ref.get(teardownDone));
        if (outcome === "timeout") {
          // The ordinary detach persists release after 30s, while cleanup must still fail
          // until the detached adapter finalizer actually finishes.
          yield* TestClock.adjust("30 seconds");
          yield* Fiber.join(outboxDetach);
          yield* TestClock.adjust("30 seconds");
          assert.equal((yield* Fiber.join(teardown))._tag, "Failure");
          assert.isTrue(yield* manager.isLive(providerSessionId));
          assert.deepEqual((yield* admission.status).blockers, [
            { type: "provider-runtime", providerSessionId, status: "stopping" },
          ]);
          assert.equal(
            (yield* Effect.result(admission.claimActivation({ requestId })))._tag,
            "Failure",
          );
          assert.equal((yield* Ref.get(state)).closeCount, 0);
          assert.lengthOf((yield* projections.getThreadProjection(threadId)).providerSessions, 1);
        }
        yield* Deferred.succeed(allowClose, undefined);
        yield* Fiber.join(outboxDetach);
        if (outcome === "completion") assert.equal((yield* Fiber.join(teardown))._tag, "Success");
        yield* manager.teardownThread({ threadId, providerSessionId });
        assert.equal((yield* Ref.get(state)).closeCount, 1);
        assert.isEmpty((yield* projections.getThreadProjection(threadId)).providerSessions);
        assert.deepEqual(yield* manager.pendingExecution, []);
        assert.deepEqual((yield* admission.status).blockers, []);
        assert.equal(
          (yield* admission.claimActivation({ requestId })).commandType,
          "update-drain.claim",
        );
      }).pipe(
        Effect.ensuring(Deferred.succeed(allowClose, undefined)),
        Effect.provide(
          layerTest({
            state,
            idleTimeoutMs: 60_000,
            capabilities: ExclusiveCapabilities,
            beforeClose,
          }),
        ),
      );
    }),
);

it.effect("worktree teardown retains an older close when the same session ID is reused", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    const closeEntered = yield* Deferred.make<void>();
    const allowClose = yield* Deferred.make<void>();
    let closes = 0;
    const beforeClose = Effect.suspend(() =>
      ++closes === 1
        ? Deferred.succeed(closeEntered, undefined).pipe(Effect.andThen(Deferred.await(allowClose)))
        : Effect.void,
    );
    yield* Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const ids = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const now = yield* DateTime.now;
      const first = ThreadId.make("reused-session-first");
      const other = ThreadId.make("reused-session-other");
      const providerSessionId = yield* ids.allocate.providerSession({
        providerInstanceId: modelSelection.instanceId,
        threadId: first,
      });
      yield* sink.write({
        events: [
          yield* makeThreadCreatedEvent({ idAllocator: ids, threadId: first, now }),
          yield* makeThreadCreatedEvent({ idAllocator: ids, threadId: other, now }),
        ],
      });
      yield* manager.open({ threadId: first, providerSessionId, modelSelection, runtimePolicy });
      const firstClose = yield* manager.close(providerSessionId).pipe(Effect.forkChild);
      yield* Deferred.await(closeEntered);
      yield* manager.open({ threadId: other, providerSessionId, modelSelection, runtimePolicy });
      yield* manager.close(providerSessionId);
      assert.equal((yield* Ref.get(state)).closeCount, 1);
      const teardown = yield* manager
        .teardownThread({ threadId: first, providerSessionId })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.equal(teardown.pollUnsafe(), undefined);
      yield* Deferred.succeed(allowClose, undefined);
      yield* Fiber.join(firstClose);
      yield* Fiber.join(teardown);
      assert.equal((yield* Ref.get(state)).closeCount, 2);
    }).pipe(
      Effect.ensuring(Deferred.succeed(allowClose, undefined)),
      Effect.provide(
        layerTest({
          state,
          idleTimeoutMs: 60_000,
          capabilities: ExclusiveCapabilities,
          beforeClose,
        }),
      ),
    );
  }),
);

it.effect(
  "worktree teardown retries shared-thread unload failure and preserves the other thread",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      let failUnload = true;
      const beforeUnload = Effect.suspend(() =>
        failUnload ? Effect.die("Native unload failed.") : Effect.void,
      );
      yield* Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const ids = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const first = ThreadId.make("shared-teardown-first");
        const second = ThreadId.make("shared-teardown-other");
        const providerSessionId = ids.derive.providerSession({
          providerInstanceId: modelSelection.instanceId,
        });
        yield* sink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator: ids, threadId: first, now }),
            yield* makeThreadCreatedEvent({ idAllocator: ids, threadId: second, now }),
            {
              id: yield* ids.allocate.event({ threadId: first }),
              type: "provider-thread.updated",
              threadId: first,
              driver: CODEX_DRIVER,
              occurredAt: now,
              payload: makeProviderThread({
                idAllocator: ids,
                threadId: first,
                providerSessionId,
                now,
              }),
            },
          ],
        });
        const runtime = yield* manager.open({
          threadId: first,
          providerSessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* manager.open({ threadId: second, providerSessionId, modelSelection, runtimePolicy });
        assert.equal(
          (yield* Effect.result(manager.teardownThread({ threadId: first, providerSessionId })))
            ._tag,
          "Failure",
        );
        assert.strictEqual(Option.getOrThrow(yield* manager.get(providerSessionId)), runtime);
        assert.equal((yield* Ref.get(state)).closeCount, 0);
        assert.lengthOf((yield* projections.getThreadProjection(first)).providerSessions, 1);
        failUnload = false;
        yield* manager.teardownThread({ threadId: first, providerSessionId });
        assert.deepStrictEqual((yield* Ref.get(state)).unloadedNativeThreadIds, ["native-thread"]);
        assert.strictEqual(Option.getOrThrow(yield* manager.get(providerSessionId)), runtime);
        assert.equal((yield* Ref.get(state)).closeCount, 0);
        assert.isEmpty((yield* projections.getThreadProjection(first)).providerSessions);
        assert.deepEqual(yield* manager.pendingExecution, []);
        assert.equal(
          (yield* projections.getThreadProjection(second)).providerSessions[0]?.status,
          "ready",
        );
      }).pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 60_000, beforeUnload })));
    }),
);

it.effect("confirmed teardown survives a later persistence failure and a runtime-free retry", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(emptyState);
    let failDetachWrite = false;
    const failingSink = Layer.effect(
      EventSink.EventSinkV2,
      Effect.gen(function* () {
        const delegate = yield* EventSink.EventSinkV2;
        return EventSink.EventSinkV2.of({
          ...delegate,
          write: (input) =>
            failDetachWrite &&
            input.events.some((event) => event.type === "provider-session.detached")
              ? Effect.fail(new EventSink.EventSinkWriteError({ eventCount: input.events.length }))
              : delegate.write(input),
        });
      }),
    ).pipe(Layer.provide(layerTestEventSink));
    yield* Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const ids = yield* IdAllocator.IdAllocatorV2;
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const first = ThreadId.make("durable-teardown-first");
      const second = ThreadId.make("durable-teardown-second");
      const providerSessionId = ids.derive.providerSession({
        providerInstanceId: modelSelection.instanceId,
      });
      for (const threadId of [first, second])
        yield* sink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator: ids, threadId, now }),
            {
              id: yield* ids.allocate.event({ threadId }),
              type: "provider-session.attached",
              threadId,
              occurredAt: now,
              payload: makeProviderSession({ providerSessionId, now }),
            },
          ],
        });
      yield* manager.teardownThread({ threadId: first, providerSessionId });
      failDetachWrite = true;
      const failure = yield* manager
        .teardownThread({ threadId: second, providerSessionId })
        .pipe(Effect.flip);
      assert.instanceOf(failure, ProviderSessionManager.ProviderSessionReleaseError);
      assert.isEmpty((yield* projections.getThreadProjection(first)).providerSessions);
      assert.lengthOf((yield* projections.getThreadProjection(second)).providerSessions, 1);
      failDetachWrite = false;
      yield* manager.teardownThread({ threadId: second, providerSessionId });
      yield* manager.teardownThread({ threadId: first, providerSessionId });
      assert.isEmpty((yield* projections.getThreadProjection(second)).providerSessions);
      assert.equal((yield* Ref.get(state)).openCount, 0);
    }).pipe(
      Effect.provide(layerTest({ state, idleTimeoutMs: 60_000, eventSinkLayer: failingSink })),
    );
  }),
);

it.effect(
  "terminal teardown unloads a native child that never attached to its shared runtime",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      yield* Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const ids = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const now = yield* DateTime.now;
        const parentId = ThreadId.make("native-mirror-parent");
        const childId = ThreadId.make("native-mirror-child");
        const sessionId = ids.derive.providerSession({
          providerInstanceId: modelSelection.instanceId,
        });
        const childEvent = yield* makeThreadCreatedEvent({
          idAllocator: ids,
          threadId: childId,
          now,
        });
        const childProviderThread = makeProviderThread({
          idAllocator: ids,
          threadId: childId,
          providerSessionId: sessionId,
          now,
        });
        yield* eventSink.write({
          events: [
            yield* makeThreadCreatedEvent({ idAllocator: ids, threadId: parentId, now }),
            {
              ...childEvent,
              payload: {
                ...childEvent.payload,
                creationSource: "provider",
                lineage: {
                  parentThreadId: parentId,
                  relationshipToParent: "subagent",
                  rootThreadId: parentId,
                },
              },
            },
            {
              id: yield* ids.allocate.event({ threadId: childId }),
              type: "provider-thread.updated",
              threadId: childId,
              occurredAt: now,
              payload: childProviderThread,
            },
          ],
        });
        yield* manager.open({
          threadId: parentId,
          providerSessionId: sessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* manager.teardownThread({ threadId: childId, providerSessionId: sessionId });
        assert.deepEqual((yield* Ref.get(state)).unloadedNativeThreadIds, ["native-thread"]);
        assert.isTrue(Option.isSome(yield* manager.get(sessionId)));
        assert.equal((yield* Ref.get(state)).closeCount, 0);
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        assert.isEmpty((yield* projections.getThreadProjection(childId)).providerSessions);
        assert.equal(
          (yield* projections.getThreadProjection(parentId)).providerSessions[0]?.status,
          "ready",
        );
      }).pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 60_000 })));
    }),
);

it.effect(
  "terminal detach interrupts and unloads an unbound native child without stopping an unrelated shared-session owner",
  () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(emptyState);
      yield* Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const ids = yield* IdAllocator.IdAllocatorV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const now = yield* DateTime.now;
        const parentId = ThreadId.make("completed-native-parent");
        const childId = ThreadId.make("unbound-native-child");
        const otherId = ThreadId.make("unrelated-native-owner");
        const sessionId = ids.derive.providerSession({
          providerInstanceId: modelSelection.instanceId,
        });
        for (const [threadId, nativeThreadId, status] of [
          [parentId, "completed-parent", "completed"],
          [childId, "running-native-child", "running"],
          [otherId, "unrelated-ordinary-owner", "running"],
        ] as const) {
          const created = yield* makeThreadCreatedEvent({ idAllocator: ids, threadId, now });
          const thread = makeProviderThread({
            idAllocator: ids,
            threadId,
            providerSessionId: sessionId,
            now,
            nativeThreadId,
          });
          yield* sink.write({
            events: [
              {
                ...created,
                payload: {
                  ...created.payload,
                  activeProviderThreadId: thread.id,
                  ...(threadId === childId
                    ? {
                        creationSource: "provider" as const,
                        createdBy: "agent" as const,
                        lineage: {
                          parentThreadId: parentId,
                          rootThreadId: parentId,
                          relationshipToParent: "subagent" as const,
                        },
                      }
                    : {}),
                },
              },
              {
                id: yield* ids.allocate.event({ threadId }),
                type: "provider-thread.updated",
                threadId,
                occurredAt: now,
                payload: thread,
              },
              {
                id: yield* ids.allocate.event({ threadId }),
                type: "provider-turn.updated",
                threadId,
                occurredAt: now,
                payload: {
                  id: ids.derive.providerTurn({
                    driver: CODEX_DRIVER,
                    nativeTurnId: `turn:${nativeThreadId}`,
                  }),
                  providerThreadId: thread.id,
                  nodeId: NodeId.make(`node:${nativeThreadId}`),
                  runAttemptId: null,
                  nativeTurnRef: null,
                  ordinal: 1,
                  status,
                  startedAt: now,
                  completedAt: status === "completed" ? now : null,
                },
              },
            ],
          });
        }
        const runtime = yield* manager.open({
          threadId: parentId,
          providerSessionId: sessionId,
          modelSelection,
          runtimePolicy,
        });
        yield* manager.open({
          threadId: otherId,
          providerSessionId: sessionId,
          modelSelection,
          runtimePolicy,
        });
        // Native children never attach to the manager; only their provider threads reference the session.
        assert.deepEqual(
          (yield* store.getThreadRecords(childId, ["providerSessions"])).providerSessions,
          [],
        );
        yield* manager.detach({
          threadId: parentId,
          providerSessionId: sessionId,
          revokeMcpCredential: true,
        });
        yield* manager.detach({
          threadId: childId,
          providerSessionId: sessionId,
          revokeMcpCredential: true,
        });
        const current = yield* Ref.get(state);
        assert.equal(current.interruptCount, 1);
        assert.deepEqual(current.unloadedNativeThreadIds, [
          "completed-parent",
          "running-native-child",
        ]);
        assert.equal(current.closeCount, 0);
        assert.strictEqual(
          yield* manager.open({
            threadId: otherId,
            providerSessionId: sessionId,
            modelSelection,
            runtimePolicy,
          }),
          runtime,
        );
        assert.equal((yield* Ref.get(state)).openCount, 1);
        assert.equal(
          (yield* store.getThreadRecords(otherId, ["providerTurns"])).providerTurns[0]?.status,
          "running",
        );
      }).pipe(Effect.provide(layerTest({ state, idleTimeoutMs: 30_000 })));
    }),
);
