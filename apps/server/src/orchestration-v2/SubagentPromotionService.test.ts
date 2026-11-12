import { assert, describe, it, vi } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  ProviderAdapterForkThreadError,
  ProviderAdapterReadThreadSnapshotError,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as SubagentPromotion from "./SubagentPromotionService.ts";

const sourceId = ThreadId.make("thread:native-child");
const targetId = ThreadId.make("thread:promoted-child");
const requestId = CommandId.make("command:promote-child");
const boundaryId = ProviderTurnId.make("provider-turn:child-boundary");
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const now = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");

function makeHarness(
  options: {
    readonly status?: "waiting" | "forking" | "failed" | "promoted";
    readonly unsupported?: boolean;
    readonly failFork?: boolean;
    readonly failSnapshot?: boolean;
    readonly badFork?: boolean;
    readonly failFirstCommit?: boolean;
  } = {},
) {
  const sourceProviderThread = {
    id: ProviderThreadId.make("provider-thread:child"),
    driver,
    providerInstanceId: instanceId,
    providerSessionId: ProviderSessionId.make("provider-session:gone-parent"),
    appThreadId: sourceId,
    ownerNodeId: null,
    nativeThreadRef: {
      driver,
      nativeId: "native-child",
      strength: "strong" as const,
    },
    nativeConversationHeadRef: null,
    status: "not_loaded" as const,
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const forkedProviderThread = {
    ...sourceProviderThread,
    id: ProviderThreadId.make("provider-thread:promoted"),
    appThreadId: targetId,
    nativeThreadRef: { ...sourceProviderThread.nativeThreadRef, nativeId: "native-fork" },
  };
  const source: OrchestrationV2ThreadProjection = {
    thread: {
      id: sourceId,
      projectId: ProjectId.make("project:promotion"),
      title: "Native child",
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: "/workspace",
      activeProviderThreadId: sourceProviderThread.id,
      lineage: {
        parentThreadId: ThreadId.make("thread:parent"),
        relationshipToParent: "subagent",
        rootThreadId: ThreadId.make("thread:parent"),
      },
      forkedFrom: null,
      createdBy: "agent",
      creationSource: "provider",
      subagentPromotion: {
        requestId,
        targetThreadId: targetId,
        status: options.status ?? "forking",
        sourceProviderTurnId: boundaryId,
        error: null,
        createdBy: "user",
        creationSource: "web",
        requestedAt: now,
        updatedAt: now,
      },
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
      lastVisitedAt: null,
    },
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [sourceProviderThread],
    providerTurns: [
      {
        id: boundaryId,
        providerThreadId: sourceProviderThread.id,
        runAttemptId: null,
        nodeId: NodeId.make("node:native-child"),
        nativeTurnRef: { driver, nativeId: "native-boundary", strength: "strong" },
        ordinal: 1,
        status: "completed",
        startedAt: now,
        completedAt: now,
      },
    ],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: now,
  };
  const nativeMessage = {
    id: MessageId.make("message:native-history"),
    threadId: targetId,
    runId: null,
    nodeId: null,
    role: "assistant" as const,
    text: "Native inherited context",
    attachments: [],
    streaming: false,
    createdBy: "agent" as const,
    creationSource: "provider" as const,
    createdAt: now,
    updatedAt: now,
  };
  const fork = vi.fn<ProviderAdapterV2SessionRuntime["forkThread"]>(() =>
    options.failFork
      ? Effect.fail(
          new ProviderAdapterForkThreadError({
            driver,
            providerThreadId: sourceProviderThread.id,
            cause: "native fork failed",
          }),
        )
      : Effect.succeed(options.badFork ? sourceProviderThread : forkedProviderThread),
  );
  const read = vi.fn<ProviderAdapterV2SessionRuntime["readThreadSnapshot"]>(() =>
    options.failSnapshot
      ? Effect.fail(
          new ProviderAdapterReadThreadSnapshotError({
            driver,
            providerThreadId: forkedProviderThread.id,
            cause: "native snapshot failed",
          }),
        )
      : Effect.succeed({
          providerThread: forkedProviderThread,
          providerTurns: [],
          messages: [nativeMessage],
          runtimeRequests: [],
        }),
  );
  const forbidden = () => Effect.die("Promotion must not resume or start a source turn.");
  const runtime: ProviderAdapterV2SessionRuntime = {
    instanceId,
    driver,
    providerSessionId: sourceProviderThread.providerSessionId,
    providerSession: {
      id: sourceProviderThread.providerSessionId,
      providerInstanceId: instanceId,
      driver,
      status: "ready",
      cwd: "/workspace",
      model: "gpt-5.4",
      capabilities: CodexProviderCapabilitiesV2,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    },
    events: Stream.empty,
    ensureThread: forbidden,
    resumeThread: forbidden,
    startTurn: forbidden,
    steerTurn: forbidden,
    interruptTurn: forbidden,
    respondToRuntimeRequest: forbidden,
    rollbackThread: forbidden,
    forkThread: fork,
    readThreadSnapshot: read,
  };
  const closed = vi.fn();
  const open = vi.fn<ProviderAdapterV2["Service"]["openSession"]>(() =>
    Effect.addFinalizer(() => Effect.sync(closed)).pipe(Effect.as(runtime)),
  );
  const adapter: ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    openSession: open,
    getCapabilities: () =>
      Effect.succeed({
        ...CodexProviderCapabilitiesV2,
        threads: {
          ...CodexProviderCapabilitiesV2.threads,
          canForkFromSubagentThread: options.unsupported !== true,
        },
      }),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  };
  let commitCount = 0;
  const dispatch = vi.fn<Orchestrator.OrchestratorV2["Service"]["dispatch"]>((command) =>
    Effect.gen(function* () {
      commitCount += 1;
      if (options.failFirstCommit && commitCount === 1) {
        return yield* new Orchestrator.OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "temporary commit failure",
        });
      }
      return { commandId: command.commandId, sequence: 1, storedEvents: [] };
    }),
  );
  const layer = SubagentPromotion.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () => Effect.succeed(source),
        }),
        ProviderAdapterRegistry.layerSingle(adapter),
        RuntimePolicy.layer,
        Layer.mock(Orchestrator.OrchestratorV2)({ dispatch }),
      ),
    ),
  );
  return { layer, source, open, fork, read, dispatch, closed, nativeMessage };
}

describe("native subagent promotion execution", () => {
  it.effect(
    "forks a runless child without its parent session and preserves the pinned native history",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const service = yield* SubagentPromotion.SubagentPromotionService;
        yield* service.execute({ threadId: sourceId, requestId });
        assert.strictEqual(harness.fork.mock.calls[0]?.[0].providerTurnId, boundaryId);
        assert.strictEqual(
          harness.fork.mock.calls[0]?.[0].sourceProviderThread.nativeThreadRef?.nativeId,
          "native-child",
        );
        assert.strictEqual(harness.open.mock.calls[0]?.[0].threadId, targetId);
        const command = harness.dispatch.mock.calls[0]?.[0];
        assert.strictEqual(command?.type, "subagent.promote.complete");
        if (command?.type === "subagent.promote.complete") {
          assert.deepEqual(command.snapshot.messages, [harness.nativeMessage]);
          assert.strictEqual(command.providerThread.nativeThreadRef?.nativeId, "native-fork");
        }
        assert.strictEqual(harness.closed.mock.calls.length, 1);
        assert.strictEqual(harness.source.thread.subagentPromotion?.status, "forking");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect.each(["waiting", "failed", "promoted"] as const)(
    "does not fork a %s request",
    (status) => {
      const harness = makeHarness({ status });
      return Effect.gen(function* () {
        const service = yield* SubagentPromotion.SubagentPromotionService;
        yield* service.execute({ threadId: sourceId, requestId });
        assert.strictEqual(harness.open.mock.calls.length, 0);
        assert.strictEqual(harness.dispatch.mock.calls.length, 0);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect.each(["unsupported", "failFork", "failSnapshot", "badFork"] as const)(
    "records %s without publishing a target",
    (failure) => {
      const harness = makeHarness({ [failure]: true });
      return Effect.gen(function* () {
        const service = yield* SubagentPromotion.SubagentPromotionService;
        yield* service.execute({ threadId: sourceId, requestId });
        assert.strictEqual(harness.dispatch.mock.calls.length, 1);
        assert.strictEqual(harness.dispatch.mock.calls[0]?.[0].type, "subagent.promote.fail");
        const command = harness.dispatch.mock.calls[0]?.[0];
        if (command?.type === "subagent.promote.fail") {
          assert.isFalse(command.error.includes("SubagentPromotionService"));
          assert.isFalse(command.error.includes("/Users/"));
        }
        if (failure === "unsupported") assert.strictEqual(harness.open.mock.calls.length, 0);
        if (failure === "failFork") assert.strictEqual(harness.read.mock.calls.length, 0);
        if (failure === "badFork") assert.strictEqual(harness.read.mock.calls.length, 0);
        if (failure === "failSnapshot") assert.strictEqual(harness.closed.mock.calls.length, 1);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "records a retryable promotion failure when completion exhausts the outbox attempts",
    () => {
      const harness = makeHarness({ failFirstCommit: true });
      return Effect.gen(function* () {
        const service = yield* SubagentPromotion.SubagentPromotionService;
        yield* service.execute({ threadId: sourceId, requestId, willRetry: false });
        assert.strictEqual(harness.fork.mock.calls.length, 1);
        assert.strictEqual(harness.dispatch.mock.calls.length, 2);
        const failed = harness.dispatch.mock.calls[1]?.[0];
        assert.strictEqual(failed?.type, "subagent.promote.fail");
        assert.notStrictEqual(failed?.commandId, harness.dispatch.mock.calls[0]?.[0].commandId);
        if (failed?.type === "subagent.promote.fail") {
          assert.include(failed.error, "retry promotion");
        }
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "reuses the native result when an outbox retry follows a failed completion commit",
    () => {
      const harness = makeHarness({ failFirstCommit: true });
      return Effect.gen(function* () {
        const service = yield* SubagentPromotion.SubagentPromotionService;
        const first = yield* Effect.result(service.execute({ threadId: sourceId, requestId }));
        assert.strictEqual(first._tag, "Failure");
        yield* service.execute({ threadId: sourceId, requestId });
        assert.strictEqual(harness.fork.mock.calls.length, 1);
        assert.strictEqual(harness.read.mock.calls.length, 1);
        assert.strictEqual(harness.dispatch.mock.calls.length, 2);
      }).pipe(Effect.provide(harness.layer));
    },
  );
});
