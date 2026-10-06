import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointScopeId,
  ChatAttachmentId,
  ChatFileAttachment,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ServerSettingsError,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CheckpointService from "./CheckpointService.ts";
import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import {
  ProviderAdapterEventStreamError,
  ProviderAdapterTurnStartError,
  type ProviderAdapterV2Error,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2EventSubscription,
  type ProviderAdapterV2SessionRuntime,
} from "./ProviderAdapter.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as ThreadRecoveryService from "./ThreadRecoveryService.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";

const driver = ProviderDriverKind.make("codex");

const RunExecutionTestLayer = RunExecutionService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
      Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
      Layer.mock(EventSink.EventSinkV2)({}),
      IdAllocator.layer,
      Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
        ingestNormalized: () => Effect.succeed([]),
      }),
      ServerSettings.layerTest(),
    ),
  ),
);

it("keeps recoverable turn failures reusable and reserves error for broken threads", () => {
  assert.equal(RunExecutionService.finalProviderThreadStatus("reusable"), "idle");
  assert.equal(RunExecutionService.finalProviderThreadStatus("broken"), "error");
});

it.effect("routes shared-runtime events only to their owning root run", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const first: RunExecutionService.ProviderEventRouteIdentity = {
      threadId: ThreadId.make("thread:shared-runtime:first"),
      runId: RunId.make("run:shared-runtime:first"),
      attemptId: RunAttemptId.make("attempt:shared-runtime:first"),
      providerThreadId: ProviderThreadId.make("provider-thread:shared-runtime:first"),
    };
    const second: RunExecutionService.ProviderEventRouteIdentity = {
      threadId: ThreadId.make("thread:shared-runtime:second"),
      runId: RunId.make("run:shared-runtime:second"),
      attemptId: RunAttemptId.make("attempt:shared-runtime:second"),
      providerThreadId: ProviderThreadId.make("provider-thread:shared-runtime:second"),
    };
    const firstTurnId = ProviderTurnId.make("provider-turn:shared-runtime:first");
    const turnEvent: ProviderAdapterV2Event = {
      type: "provider_turn.updated",
      driver,
      threadId: first.threadId,
      providerTurn: {
        id: firstTurnId,
        providerThreadId: first.providerThreadId,
        nodeId: NodeId.make("node:shared-runtime:first"),
        runAttemptId: first.attemptId,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    };
    const messageEvent: ProviderAdapterV2Event = {
      type: "message.updated",
      driver,
      message: {
        createdBy: "agent",
        creationSource: "provider",
        id: MessageId.make("message:shared-runtime:first"),
        threadId: first.threadId,
        runId: first.runId,
        nodeId: NodeId.make("node:shared-runtime:first"),
        role: "assistant",
        text: "first only",
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    };
    const terminalEvent: ProviderAdapterV2Event = {
      type: "turn.terminal",
      driver,
      providerThreadId: first.providerThreadId,
      providerTurnId: firstTurnId,
      runOrdinal: 1,
      status: "completed",
      failure: null,
      threadDisposition: "reusable",
    };

    const firstInitial = RunExecutionService.makeProviderEventRoutingState({
      identity: first,
      providerTurnId: null,
    });
    const secondInitial = RunExecutionService.makeProviderEventRoutingState({
      identity: second,
      providerTurnId: null,
    });
    const [firstTurnAccepted, firstAfterTurn] = RunExecutionService.routeProviderEvent(
      turnEvent,
      first,
      firstInitial,
    );
    const [secondTurnAccepted, secondAfterTurn] = RunExecutionService.routeProviderEvent(
      turnEvent,
      second,
      secondInitial,
    );

    assert.isTrue(firstTurnAccepted);
    assert.isFalse(secondTurnAccepted);
    assert.isTrue(RunExecutionService.routeProviderEvent(messageEvent, first, firstAfterTurn)[0]);
    assert.isFalse(
      RunExecutionService.routeProviderEvent(messageEvent, second, secondAfterTurn)[0],
    );
    assert.isTrue(RunExecutionService.routeProviderEvent(terminalEvent, first, firstAfterTurn)[0]);
    assert.isFalse(
      RunExecutionService.routeProviderEvent(terminalEvent, second, secondAfterTurn)[0],
    );
  }),
);

it("leaves a child thread created after the root turn ended to the run that is live then", () => {
  const threadId = ThreadId.make("thread:late-child");
  const rootProviderTurnId = ProviderTurnId.make("provider-turn:late-child");
  const identity: RunExecutionService.ProviderEventRouteIdentity = {
    threadId,
    runId: RunId.make("run:late-child"),
    attemptId: RunAttemptId.make("attempt:late-child"),
    providerThreadId: ProviderThreadId.make("provider-thread:late-child"),
  };
  const childCreated = (childThreadId: ThreadId): ProviderAdapterV2Event =>
    ({
      type: "app_thread.created",
      driver,
      appThread: {
        id: childThreadId,
        lineage: {
          parentThreadId: threadId,
          relationshipToParent: "subagent",
          rootThreadId: threadId,
        },
      },
    }) as ProviderAdapterV2Event;
  const earlyChild = ThreadId.make("thread:late-child:early");
  const lateChild = ThreadId.make("thread:late-child:late");

  const initial = RunExecutionService.makeProviderEventRoutingState({
    identity,
    providerTurnId: rootProviderTurnId,
  });
  const [earlyAccepted, live] = RunExecutionService.routeProviderEvent(
    childCreated(earlyChild),
    identity,
    initial,
  );
  assert.isTrue(earlyAccepted);
  const [terminalAccepted, ended] = RunExecutionService.routeProviderEvent(
    {
      type: "turn.terminal",
      driver,
      providerThreadId: identity.providerThreadId,
      providerTurnId: rootProviderTurnId,
      runOrdinal: 1,
      status: "completed",
      failure: null,
      threadDisposition: "reusable",
    },
    identity,
    live,
  );
  assert.isTrue(terminalAccepted);
  // A child the root launched before it ended stays with this run.
  assert.isTrue(ended.ownedThreadIds.has(earlyChild));
  const [lateAccepted, afterLate] = RunExecutionService.routeProviderEvent(
    childCreated(lateChild),
    identity,
    ended,
  );
  assert.isFalse(lateAccepted);
  assert.isFalse(afterLate.ownedThreadIds.has(lateChild));
});

it("does not route a superseded attempt through a reused provider thread", () => {
  const threadId = ThreadId.make("thread:shared-runtime:restart");
  const providerThreadId = ProviderThreadId.make("provider-thread:shared-runtime:restart");
  const oldAttempt: RunExecutionService.ProviderEventRouteIdentity = {
    threadId,
    runId: RunId.make("run:shared-runtime:restart"),
    attemptId: RunAttemptId.make("attempt:shared-runtime:restart:old"),
    providerThreadId,
  };
  const newAttempt: RunExecutionService.ProviderEventRouteIdentity = {
    ...oldAttempt,
    attemptId: RunAttemptId.make("attempt:shared-runtime:restart:new"),
  };
  const oldTurnEvent: ProviderAdapterV2Event = {
    type: "provider_turn.updated",
    driver,
    threadId,
    providerTurn: {
      id: ProviderTurnId.make("provider-turn:shared-runtime:restart:old"),
      providerThreadId,
      nodeId: NodeId.make("node:shared-runtime:restart:old"),
      runAttemptId: oldAttempt.attemptId,
      nativeTurnRef: null,
      ordinal: 1,
      status: "interrupted",
      startedAt: null,
      completedAt: null,
    },
  };

  const newState = RunExecutionService.makeProviderEventRoutingState({
    identity: newAttempt,
    providerTurnId: null,
  });
  assert.isFalse(RunExecutionService.routeProviderEvent(oldTurnEvent, newAttempt, newState)[0]);
});

it("routes only exact same-thread background items inherited from settled runs", () => {
  const threadId = ThreadId.make("thread:inherited-background-routing");
  const otherThreadId = ThreadId.make("thread:inherited-background-routing:other");
  const priorRunId = RunId.make("run:inherited-background-routing:prior");
  const currentRunId = RunId.make("run:inherited-background-routing:current");
  const itemId = TurnItemId.make("turn-item:inherited-background-routing");
  const identity: RunExecutionService.ProviderEventRouteIdentity = {
    threadId,
    runId: currentRunId,
    attemptId: RunAttemptId.make("attempt:inherited-background-routing:current"),
    providerThreadId: ProviderThreadId.make("provider-thread:inherited-background-routing:current"),
  };
  const initial = RunExecutionService.makeProviderEventRoutingState({
    identity,
    inheritedBackgroundTurnItems: [{ id: itemId, runId: priorRunId }],
    providerTurnId: null,
  });
  const inheritedRunning = {
    type: "turn_item.updated",
    driver,
    turnItem: {
      id: itemId,
      threadId,
      runId: priorRunId,
      providerTurnId: null,
      ordinal: 1,
      type: "subagent",
      status: "running",
    },
  } as Extract<ProviderAdapterV2Event, { type: "turn_item.updated" }>;
  const unrelatedRunItem = {
    ...inheritedRunning,
    turnItem: {
      ...inheritedRunning.turnItem,
      runId: RunId.make("run:inherited-background-routing:unrelated"),
    },
  } as ProviderAdapterV2Event;
  const unlistedPriorItem = {
    ...inheritedRunning,
    turnItem: {
      ...inheritedRunning.turnItem,
      id: TurnItemId.make("turn-item:inherited-background-routing:unrelated"),
    },
  } as ProviderAdapterV2Event;
  const unrelatedThreadItem = {
    ...inheritedRunning,
    turnItem: { ...inheritedRunning.turnItem, threadId: otherThreadId },
  } as ProviderAdapterV2Event;
  const ordinaryItem = {
    ...inheritedRunning,
    turnItem: { ...inheritedRunning.turnItem, type: "reasoning" as const },
  } as ProviderAdapterV2Event;
  const inheritedTerminal = {
    ...inheritedRunning,
    turnItem: { ...inheritedRunning.turnItem, status: "completed" as const },
  } as ProviderAdapterV2Event;

  const [runningAccepted, afterRunning] = RunExecutionService.routeProviderEvent(
    inheritedRunning,
    identity,
    initial,
  );
  assert.isTrue(runningAccepted);
  assert.isFalse(
    RunExecutionService.routeProviderEvent(unrelatedRunItem, identity, afterRunning)[0],
  );
  assert.isFalse(
    RunExecutionService.routeProviderEvent(unlistedPriorItem, identity, afterRunning)[0],
  );
  assert.isFalse(
    RunExecutionService.routeProviderEvent(unrelatedThreadItem, identity, afterRunning)[0],
  );
  assert.isFalse(RunExecutionService.routeProviderEvent(ordinaryItem, identity, afterRunning)[0]);

  const [terminalAccepted, afterTerminal] = RunExecutionService.routeProviderEvent(
    inheritedTerminal,
    identity,
    afterRunning,
  );
  assert.isTrue(terminalAccepted);
  assert.isFalse(
    RunExecutionService.routeProviderEvent(inheritedRunning, identity, afterTerminal)[0],
    "a nonterminal replay must not resurrect an inherited terminal",
  );
});

it("selects only live background items from non-completed settled prior runs", () => {
  const threadId = ThreadId.make("thread:inherited-background-selection");
  const otherThreadId = ThreadId.make("thread:inherited-background-selection:other");
  const currentProviderThreadId = ProviderThreadId.make(
    "provider-thread:inherited-background-selection:current",
  );
  const foreignProviderThreadId = ProviderThreadId.make(
    "provider-thread:inherited-background-selection:foreign-session",
  );
  const interruptedRunId = RunId.make("run:inherited-background-selection:interrupted");
  const failedRunId = RunId.make("run:inherited-background-selection:failed");
  const cancelledRunId = RunId.make("run:inherited-background-selection:cancelled");
  const completedRunId = RunId.make("run:inherited-background-selection:completed");
  const rolledBackRunId = RunId.make("run:inherited-background-selection:rolled-back");
  const currentRunId = RunId.make("run:inherited-background-selection:current");
  const inheritedItemId = TurnItemId.make("turn-item:inherited-background-selection:live");
  const failedItemId = TurnItemId.make("turn-item:inherited-background-selection:failed");
  const cancelledItemId = TurnItemId.make("turn-item:inherited-background-selection:cancelled");
  const makeRun = (
    id: RunId,
    ordinal: number,
    status: OrchestrationV2Run["status"],
    runThreadId = threadId,
  ) =>
    ({
      id,
      threadId: runThreadId,
      ordinal,
      status,
    }) as OrchestrationV2Run;
  const makeItem = (
    id: TurnItemId,
    runId: RunId,
    status: OrchestrationV2TurnItem["status"],
    type: OrchestrationV2TurnItem["type"] = "subagent",
    itemThreadId = threadId,
    providerThreadId = currentProviderThreadId,
  ) =>
    ({
      id,
      threadId: itemThreadId,
      runId,
      providerThreadId,
      type,
      status,
    }) as OrchestrationV2TurnItem;

  const selected = RunExecutionService.selectInheritedBackgroundTurnItems({
    threadId,
    currentProviderThreadId,
    currentRunOrdinal: 6,
    runs: [
      makeRun(interruptedRunId, 1, "interrupted"),
      makeRun(failedRunId, 2, "failed"),
      makeRun(cancelledRunId, 3, "cancelled"),
      makeRun(completedRunId, 4, "completed"),
      makeRun(rolledBackRunId, 5, "rolled_back"),
      makeRun(currentRunId, 6, "running"),
      makeRun(
        RunId.make("run:inherited-background-selection:other"),
        1,
        "interrupted",
        otherThreadId,
      ),
    ],
    turnItems: [
      makeItem(inheritedItemId, interruptedRunId, "running"),
      makeItem(failedItemId, failedRunId, "running"),
      makeItem(cancelledItemId, cancelledRunId, "running"),
      makeItem(
        TurnItemId.make("turn-item:inherited-background-selection:completed-run"),
        completedRunId,
        "running",
      ),
      makeItem(
        TurnItemId.make("turn-item:inherited-background-selection:terminal"),
        interruptedRunId,
        "completed",
      ),
      makeItem(
        TurnItemId.make("turn-item:inherited-background-selection:ordinary"),
        interruptedRunId,
        "running",
        "reasoning",
      ),
      makeItem(
        TurnItemId.make("turn-item:inherited-background-selection:rolled-back"),
        rolledBackRunId,
        "running",
      ),
      makeItem(
        TurnItemId.make("turn-item:inherited-background-selection:other-thread"),
        interruptedRunId,
        "running",
        "subagent",
        otherThreadId,
      ),
      makeItem(
        TurnItemId.make("turn-item:inherited-background-selection:foreign-provider"),
        interruptedRunId,
        "running",
        "subagent",
        threadId,
        foreignProviderThreadId,
      ),
    ],
  });

  assert.deepEqual(selected, [
    { id: inheritedItemId, runId: interruptedRunId },
    { id: failedItemId, runId: failedRunId },
    { id: cancelledItemId, runId: cancelledRunId },
  ]);
});

it("does not carry interrupted or still-running child ownership into later attempts", () => {
  assert.isFalse(RunExecutionService.canRouteRelatedSubagent("interrupted"));
  assert.isFalse(RunExecutionService.canRouteRelatedSubagent("failed"));
  assert.isFalse(RunExecutionService.canRouteRelatedSubagent("cancelled"));
  assert.isTrue(RunExecutionService.canRouteRelatedSubagent("completed"));
  // The launching run still ingests a running subagent's child thread.
  assert.isFalse(RunExecutionService.canRouteRelatedSubagent("running"));

  const threadId = ThreadId.make("thread:related-child:next-attempt");
  const childThreadId = ThreadId.make("thread:related-child:interrupted");
  const identity: RunExecutionService.ProviderEventRouteIdentity = {
    threadId,
    runId: RunId.make("run:related-child:next-attempt"),
    attemptId: RunAttemptId.make("attempt:related-child:next-attempt"),
    providerThreadId: ProviderThreadId.make("provider-thread:related-child:next-attempt"),
  };
  const state = RunExecutionService.makeProviderEventRoutingState({
    identity,
    providerTurnId: null,
    relatedThreadIds: RunExecutionService.canRouteRelatedSubagent("interrupted")
      ? [childThreadId]
      : [],
  });
  const childNodeId = NodeId.make("node:related-child:interrupted");
  const lateChildNode = {
    type: "node.updated",
    driver,
    node: {
      id: childNodeId,
      threadId: childThreadId,
      runId: null,
      parentNodeId: null,
      rootNodeId: childNodeId,
      kind: "root_turn",
      status: "completed",
      countsForRun: false,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: null,
      completedAt: null,
    },
  } satisfies ProviderAdapterV2Event;

  assert.isFalse(RunExecutionService.routeProviderEvent(lateChildNode, identity, state)[0]);
});

it.effect("rechecks run ownership immediately before calling the provider", () =>
  Effect.gen(function* () {
    const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
    const guardCalls = yield* Ref.make(0);
    const providerStarts = yield* Ref.make(0);
    const threadId = ThreadId.make("thread:run-execution-start-guard");
    const runId = RunId.make("run:run-execution-start-guard");
    const attemptId = RunAttemptId.make("attempt:run-execution-start-guard");
    const providerThreadId = ProviderThreadId.make("provider-thread:run-execution-start-guard");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const providerSessionId = ProviderSessionId.make("session:run-execution-start-guard");
    const rootNodeId = NodeId.make("node:run-execution-start-guard");
    const run = {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId,
    } as OrchestrationV2Run;
    const rootNode = { id: rootNodeId } as OrchestrationV2ExecutionNode;
    const providerThread = {
      id: providerThreadId,
      driver,
    } as OrchestrationV2ProviderThread;
    const attempt = {
      id: attemptId,
      providerTurnId: null,
    } as OrchestrationV2RunAttempt;
    const session = {
      events: Stream.never,
      startTurn: () => Ref.update(providerStarts, (count) => count + 1),
    } as unknown as ProviderAdapterV2SessionRuntime;

    yield* runExecution.startRootRun({
      commandId: CommandId.make("command:run-execution-start-guard"),
      appThread: { id: threadId } as OrchestrationV2AppThread,
      providerSessionId,
      session,
      run,
      rootNode,
      checkpointScope: {
        id: CheckpointScopeId.make("checkpoint-scope:run-execution-start-guard"),
      } as OrchestrationV2CheckpointScope,
      providerThread,
      attempt,
      attemptId,
      providerTurnOrdinal: 1,
      shouldStartProviderTurn: () =>
        Ref.modify(guardCalls, (calls) => [calls === 0, calls + 1] as const),
      message: {
        messageId: MessageId.make("message:run-execution-start-guard"),
        text: "Do not start after ownership changes.",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
      runtimePolicy: {
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "readOnly",
          access: { type: "fullAccess" },
          networkAccess: false,
        },
      },
    });

    assert.equal(yield* Ref.get(guardCalls), 2);
    assert.equal(yield* Ref.get(providerStarts), 0);
  }).pipe(Effect.provide(RunExecutionTestLayer)),
);

it.effect("fails the run when its ownership check cannot be read before calling the provider", () =>
  Effect.gen(function* () {
    const guardCalls = yield* Ref.make(0);
    const providerStarts = yield* Ref.make(0);
    const writes = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
    const threadId = ThreadId.make("thread:run-execution-start-guard-read");
    const runId = RunId.make("run:run-execution-start-guard-read");
    const attemptId = RunAttemptId.make("attempt:run-execution-start-guard-read");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const testLayer = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
          Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
          Layer.mock(EventSink.EventSinkV2)({
            writeIfRunCurrent: (input) =>
              Ref.update(writes, (current) => [...current, ...input.events]).pipe(
                Effect.as({ committed: true, storedEvents: [] }),
              ),
          }),
          IdAllocator.layer,
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: () => Effect.succeed([]),
          }),
          ServerSettings.layerTest(),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      yield* runExecution.startRootRun({
        commandId: CommandId.make("command:run-execution-start-guard-read"),
        appThread: { id: threadId } as OrchestrationV2AppThread,
        providerSessionId: ProviderSessionId.make("session:run-execution-start-guard-read"),
        session: {
          events: Stream.never,
          startTurn: () => Ref.update(providerStarts, (count) => count + 1),
        } as unknown as ProviderAdapterV2SessionRuntime,
        run: { id: runId, threadId, ordinal: 1, providerInstanceId } as OrchestrationV2Run,
        rootNode: {
          id: NodeId.make("node:run-execution-start-guard-read"),
        } as OrchestrationV2ExecutionNode,
        checkpointScope: {
          id: CheckpointScopeId.make("checkpoint-scope:run-execution-start-guard-read"),
        } as OrchestrationV2CheckpointScope,
        providerThread: {
          id: ProviderThreadId.make("provider-thread:run-execution-start-guard-read"),
          driver,
        } as OrchestrationV2ProviderThread,
        attempt: { id: attemptId, providerTurnId: null } as OrchestrationV2RunAttempt,
        attemptId,
        providerTurnOrdinal: 1,
        // The preparation check passes; the check right before the provider
        // call cannot read the run.
        shouldStartProviderTurn: () =>
          Ref.getAndUpdate(guardCalls, (calls) => calls + 1).pipe(
            Effect.flatMap((calls) =>
              calls === 0
                ? Effect.succeed(true)
                : Effect.fail(
                    new ProjectionStore.ProjectionStoreReadError({
                      threadId,
                      cause: "database unavailable",
                    }),
                  ),
            ),
          ),
        // The failure is settled by the guarded write, not by another read.
        shouldFinalizeRun: () =>
          Effect.fail(
            new ProjectionStore.ProjectionStoreReadError({
              threadId,
              cause: "database unavailable",
            }),
          ),
        message: {
          messageId: MessageId.make("message:run-execution-start-guard-read"),
          text: "Start while the store is down.",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "readOnly",
            access: { type: "fullAccess" },
            networkAccess: false,
          },
        },
      });
    }).pipe(Effect.provide(testLayer));

    assert.equal(yield* Ref.get(guardCalls), 2);
    assert.equal(yield* Ref.get(providerStarts), 0);
    const runUpdate = (yield* Ref.get(writes)).find((event) => event.type === "run.updated");
    assert.equal(
      runUpdate?.type === "run.updated" ? runUpdate.payload.status : undefined,
      "failed",
    );
  }),
);

it.effect(
  "dispatches only attachment-free compact commands through the native compaction path",
  () =>
    Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      const calls: Array<string> = [];
      const attachment = ChatFileAttachment.make({
        type: "file",
        id: ChatAttachmentId.make("compact-file-12345678-1234-1234-1234-123456789abc"),
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 1,
      });
      const cases = [
        { text: " /compact ", attachments: [], expected: "compact" },
        { text: "/compact", attachments: [attachment], expected: "prompt" },
        { text: "Continue the work", attachments: [], expected: "prompt" },
      ];
      for (const [index, testCase] of cases.entries()) {
        const threadId = ThreadId.make(`thread:compact-routing:${index}`);
        const attemptId = RunAttemptId.make(`attempt:compact-routing:${index}`);
        yield* runExecution.startRootRun({
          commandId: CommandId.make(`command:compact-routing:${index}`),
          appThread: { id: threadId } as OrchestrationV2AppThread,
          providerSessionId: ProviderSessionId.make(`session:compact-routing:${index}`),
          session: {
            events: Stream.never,
            startTurn: () =>
              Effect.sync(() => {
                calls.push("prompt");
              }),
            compactThread: () =>
              Effect.sync(() => {
                calls.push("compact");
              }),
          } as unknown as ProviderAdapterV2SessionRuntime,
          run: {
            id: RunId.make(`run:compact-routing:${index}`),
            threadId,
            ordinal: 1,
            providerInstanceId: ProviderInstanceId.make("codex"),
          } as OrchestrationV2Run,
          rootNode: {
            id: NodeId.make(`node:compact-routing:${index}`),
          } as OrchestrationV2ExecutionNode,
          checkpointScope: {
            id: CheckpointScopeId.make(`checkpoint:compact-routing:${index}`),
          } as OrchestrationV2CheckpointScope,
          providerThread: {
            id: ProviderThreadId.make(`provider-thread:compact-routing:${index}`),
            driver,
          } as OrchestrationV2ProviderThread,
          attempt: { id: attemptId, providerTurnId: null } as OrchestrationV2RunAttempt,
          attemptId,
          providerTurnOrdinal: 1,
          message: {
            messageId: MessageId.make(`message:compact-routing:${index}`),
            text: testCase.text,
            attachments: testCase.attachments,
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
            approvalPolicy: "never",
            sandboxPolicy: {
              type: "readOnly",
              access: { type: "fullAccess" },
              networkAccess: false,
            },
          },
        });
      }
      assert.deepEqual(
        calls,
        cases.map((testCase) => testCase.expected),
      );
    }).pipe(Effect.provide(RunExecutionTestLayer)),
);

it.effect("refreshes MCP credential liveness before calling the provider", () =>
  Effect.gen(function* () {
    const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
    const order = yield* Ref.make<ReadonlyArray<string>>([]);
    const threadId = ThreadId.make("thread:run-execution-mcp-liveness");
    const touchActiveMcpThread = vi
      .spyOn(McpSessionRegistry, "touchActiveMcpThread")
      .mockImplementation((touchedThreadId) =>
        Ref.update(order, (entries) => [...entries, `touch:${touchedThreadId}`]),
      );

    yield* runExecution
      .startRootRun({
        commandId: CommandId.make("command:run-execution-mcp-liveness"),
        appThread: { id: threadId } as OrchestrationV2AppThread,
        providerSessionId: ProviderSessionId.make("session:run-execution-mcp-liveness"),
        session: {
          events: Stream.never,
          startTurn: () => Ref.update(order, (entries) => [...entries, "start-turn"]),
        } as unknown as ProviderAdapterV2SessionRuntime,
        run: {
          id: RunId.make("run:run-execution-mcp-liveness"),
          threadId,
          ordinal: 1,
          providerInstanceId: ProviderInstanceId.make("codex"),
        } as OrchestrationV2Run,
        rootNode: {
          id: NodeId.make("node:run-execution-mcp-liveness"),
        } as OrchestrationV2ExecutionNode,
        checkpointScope: {
          id: CheckpointScopeId.make("checkpoint-scope:run-execution-mcp-liveness"),
        } as OrchestrationV2CheckpointScope,
        providerThread: {
          id: ProviderThreadId.make("provider-thread:run-execution-mcp-liveness"),
          driver,
        } as OrchestrationV2ProviderThread,
        attempt: {
          id: RunAttemptId.make("attempt:run-execution-mcp-liveness"),
          providerTurnId: null,
        } as OrchestrationV2RunAttempt,
        attemptId: RunAttemptId.make("attempt:run-execution-mcp-liveness"),
        providerTurnOrdinal: 1,
        message: {
          messageId: MessageId.make("message:run-execution-mcp-liveness"),
          text: "Keep the MCP credential alive.",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "readOnly",
            access: { type: "fullAccess" },
            networkAccess: false,
          },
        },
      })
      .pipe(Effect.ensuring(Effect.sync(() => touchActiveMcpThread.mockRestore())));

    assert.deepEqual(yield* Ref.get(order), [`touch:${threadId}`, "start-turn"]);
  }).pipe(Effect.provide(RunExecutionTestLayer)),
);

it.effect("starts the provider when checkpoint baseline capture fails", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:run-execution-baseline-failure");
    const runId = RunId.make("run:run-execution-baseline-failure");
    const attemptId = RunAttemptId.make("attempt:run-execution-baseline-failure");
    const providerThreadId = ProviderThreadId.make(
      "provider-thread:run-execution-baseline-failure",
    );
    const providerInstanceId = ProviderInstanceId.make("codex");
    const providerSessionId = ProviderSessionId.make("session:run-execution-baseline-failure");
    const rootNodeId = NodeId.make("node:run-execution-baseline-failure");
    const checkpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:run-execution-baseline-failure"),
    } as OrchestrationV2CheckpointScope;
    const providerStarts = yield* Ref.make(0);
    const writes = yield* Ref.make<
      ReadonlyArray<{
        events: ReadonlyArray<OrchestrationV2DomainEvent>;
        effects: ReadonlyArray<PendingOrchestrationEffectV2>;
      }>
    >([]);
    const testLayer = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
          Layer.mock(CheckpointService.CheckpointServiceV2)({
            captureBaseline: () =>
              Effect.fail(
                new CheckpointService.CheckpointBaselineCaptureError({
                  scopeId: checkpointScope.id,
                  ordinalWithinScope: 0,
                  cause: new Error("VCS process timed out"),
                }),
              ),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            writeWithEffects: (input) =>
              Ref.update(writes, (current) => [
                ...current,
                { events: input.events, effects: input.effects },
              ]).pipe(Effect.as([])),
          }),
          IdAllocator.layer,
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: () => Effect.succeed([]),
          }),
          ServerSettings.layerTest(),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      yield* runExecution.startRootRun({
        commandId: CommandId.make("command:run-execution-baseline-failure"),
        appThread: { id: threadId } as OrchestrationV2AppThread,
        providerSessionId,
        session: {
          events: Stream.never,
          startTurn: () => Ref.update(providerStarts, (count) => count + 1),
        } as unknown as ProviderAdapterV2SessionRuntime,
        run: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
        } as OrchestrationV2Run,
        rootNode: { id: rootNodeId } as OrchestrationV2ExecutionNode,
        checkpointScope,
        providerThread: {
          id: providerThreadId,
          driver,
        } as OrchestrationV2ProviderThread,
        attempt: {
          id: attemptId,
          providerTurnId: null,
        } as OrchestrationV2RunAttempt,
        attemptId,
        providerTurnOrdinal: 1,
        message: {
          messageId: MessageId.make("message:run-execution-baseline-failure"),
          text: "Start the provider without a baseline.",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "readOnly",
            access: { type: "fullAccess" },
            networkAccess: false,
          },
        },
      });
    }).pipe(Effect.provide(testLayer));

    assert.equal(yield* Ref.get(providerStarts), 1);

    const events = (yield* Ref.get(writes)).flatMap((write) => [...write.events]);
    const failedEvent = events.find(
      (event) =>
        (event.type === "run.updated" ||
          event.type === "run-attempt.updated" ||
          event.type === "node.updated") &&
        event.payload.status === "failed",
    );
    assert.isUndefined(failedEvent);
    const errorItem = events.find(
      (event) => event.type === "turn-item.updated" && event.payload.type === "error",
    );
    assert.isUndefined(errorItem);
  }),
);

it.effect.each(["failure", "interruption", "stale-attempt", "start-guard"] as const)(
  "handles %s before the provider turn starts",
  (scenario) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:run-execution-settings-failure");
      const runId = RunId.make("run:run-execution-settings-failure");
      const attemptId = RunAttemptId.make("attempt:run-execution-settings-failure");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const providerSessionId = ProviderSessionId.make("session:run-execution-settings-failure");
      const providerThreadId = ProviderThreadId.make(
        "provider-thread:run-execution-settings-failure",
      );
      const rootNodeId = NodeId.make("node:run-execution-settings-failure");
      const checkpointScope = {
        id: CheckpointScopeId.make("checkpoint-scope:run-execution-settings-failure"),
      } as OrchestrationV2CheckpointScope;
      const providerStarts = yield* Ref.make(0);
      const refreshes = yield* Ref.make(0);
      const guardedWrites = yield* Ref.make(0);
      const writes = yield* Ref.make<ReadonlyArray<ReadonlyArray<OrchestrationV2DomainEvent>>>([]);
      const testLayer = RunExecutionService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              captureBaseline: () =>
                scenario === "start-guard" ? Effect.void : Effect.die("not reached"),
            }),
            Layer.mock(EventSink.EventSinkV2)({
              writeIfRunCurrent: (input) =>
                Effect.gen(function* () {
                  assert.equal(input.threadId, threadId);
                  assert.equal(input.runId, runId);
                  assert.equal(input.activeAttemptId, attemptId);
                  assert.equal(input.expectedStatus, "running");
                  yield* Ref.update(guardedWrites, (count) => count + 1);
                  if (scenario === "stale-attempt") {
                    return { committed: false, storedEvents: [] };
                  }
                  yield* Ref.update(writes, (current) => [...current, input.events]);
                  return { committed: true, storedEvents: [] };
                }),
            }),
            IdAllocator.layer,
            Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
              ingestNormalized: () => Effect.succeed([]),
            }),
            scenario === "start-guard"
              ? ServerSettings.layerTest()
              : Layer.mock(ServerSettings.ServerSettingsService)({
                  getSettings:
                    scenario === "interruption"
                      ? Effect.interrupt
                      : Effect.fail(
                          new ServerSettingsError({
                            settingsPath: "<test>",
                            operation: "read-file",
                            cause: new Error("settings read failed"),
                          }),
                        ),
                }),
            Layer.succeed(RunFinalizationService.RunFinalizationObserver, {
              refresh: () => Effect.void,
              refreshAfterTurn: () => Ref.update(refreshes, (count) => count + 1),
            }),
          ),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
        yield* runExecution.startRootRun({
          commandId: CommandId.make("command:run-execution-settings-failure"),
          appThread: { id: threadId } as OrchestrationV2AppThread,
          providerSessionId,
          session: {
            events: Stream.never,
            startTurn: () => Ref.update(providerStarts, (count) => count + 1),
          } as unknown as ProviderAdapterV2SessionRuntime,
          run: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId,
            status: "running",
          } as OrchestrationV2Run,
          rootNode: { id: rootNodeId, status: "running" } as OrchestrationV2ExecutionNode,
          checkpointScope,
          providerThread: {
            id: providerThreadId,
            driver,
          } as OrchestrationV2ProviderThread,
          attempt: {
            id: attemptId,
            providerTurnId: null,
            status: "running",
          } as OrchestrationV2RunAttempt,
          attemptId,
          providerTurnOrdinal: 1,
          // A declined start is a normal exit, not a preparation failure.
          ...(scenario === "start-guard"
            ? { shouldStartProviderTurn: () => Effect.succeed(false) }
            : {}),
          message: {
            messageId: MessageId.make("message:run-execution-settings-failure"),
            text: "Start after settings fail.",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
            approvalPolicy: "never",
            sandboxPolicy: {
              type: "readOnly",
              access: { type: "fullAccess" },
              networkAccess: false,
            },
          },
        });
      }).pipe(Effect.provide(testLayer), Effect.exit);

      assert.equal(yield* Ref.get(providerStarts), 0);
      const events = (yield* Ref.get(writes)).flat();
      if (scenario === "interruption") {
        assert.isTrue(Exit.isFailure(result));
        if (Exit.isFailure(result)) assert.isTrue(Cause.hasInterruptsOnly(result.cause));
        assert.equal(yield* Ref.get(guardedWrites), 0);
        assert.equal(yield* Ref.get(refreshes), 0);
        assert.isEmpty(events);
        return;
      }
      assert.isTrue(Exit.isSuccess(result));
      if (scenario === "start-guard") {
        assert.equal(yield* Ref.get(guardedWrites), 0);
        assert.equal(yield* Ref.get(refreshes), 0);
        assert.isEmpty(events);
        return;
      }
      assert.equal(yield* Ref.get(guardedWrites), 1);
      if (scenario === "stale-attempt") {
        assert.equal(yield* Ref.get(refreshes), 0);
        assert.isEmpty(events);
        return;
      }
      assert.equal(yield* Ref.get(refreshes), 1);
      assert.deepEqual(
        events
          .filter(
            (event) =>
              event.type === "run.updated" ||
              event.type === "run-attempt.updated" ||
              event.type === "node.updated",
          )
          .map((event) => event.payload.status),
        ["failed", "failed", "failed"],
      );
      const errorItem = events.find(
        (event) => event.type === "turn-item.updated" && event.payload.type === "error",
      );
      assert.isDefined(errorItem);
      if (errorItem?.type === "turn-item.updated" && errorItem.payload.type === "error") {
        // The persisted item carries a bounded curated message; the exact
        // underlying text stays in the logged cause.
        assert.equal(errorItem.payload.failure.message, "Run preparation failed.");
      }
    }),
);

it.effect("keeps ingesting owned child events after the root turn terminalizes", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:run-execution-late-child");
    const childThreadId = ThreadId.make("thread:run-execution-late-child:child");
    const runId = RunId.make("run:run-execution-late-child");
    const attemptId = RunAttemptId.make("attempt:run-execution-late-child");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const providerSessionId = ProviderSessionId.make("session:run-execution-late-child");
    const providerThreadId = ProviderThreadId.make("provider-thread:run-execution-late-child");
    const childProviderThreadId = ProviderThreadId.make(
      "provider-thread:run-execution-late-child:child",
    );
    const rootProviderTurnId = ProviderTurnId.make("provider-turn:run-execution-late-child");
    const childProviderTurnId = ProviderTurnId.make("provider-turn:run-execution-late-child:child");
    const rootNodeId = NodeId.make("node:run-execution-late-child");
    const childNodeId = NodeId.make("node:run-execution-late-child:child");
    const subagentNodeId = NodeId.make("node:run-execution-late-child:subagent");
    const childMessageIngested = yield* Deferred.make<void>();
    const order = yield* Ref.make<ReadonlyArray<string>>([]);
    const testLayer = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
          Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
          Layer.mock(EventSink.EventSinkV2)({
            write: () => Effect.succeed([]),
            writeWithEffects: (input) =>
              Effect.gen(function* () {
                if (
                  input.events.some(
                    (event) => event.type === "run.updated" && event.runId === runId,
                  )
                ) {
                  yield* Ref.update(order, (current) => [...current, "root-finalized"]);
                }
                return [];
              }),
            writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
          }),
          IdAllocator.layer,
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: (input) =>
              Effect.gen(function* () {
                if (
                  input.event.type === "message.updated" &&
                  input.event.message.threadId === childThreadId
                ) {
                  yield* Ref.update(order, (current) => [...current, "child-message"]);
                  yield* Deferred.succeed(childMessageIngested, undefined).pipe(Effect.ignore);
                }
                return [];
              }),
          }),
          ServerSettings.layerTest(),
        ),
      ),
    );
    const events: ReadonlyArray<ProviderAdapterV2Event> = [
      {
        type: "app_thread.created",
        driver,
        appThread: {
          id: childThreadId,
          lineage: {
            parentThreadId: threadId,
            relationshipToParent: "subagent",
            rootThreadId: threadId,
          },
        },
      } as ProviderAdapterV2Event,
      {
        type: "provider_thread.updated",
        driver,
        providerThread: {
          id: childProviderThreadId,
          appThreadId: childThreadId,
        },
      } as ProviderAdapterV2Event,
      {
        type: "subagent.updated",
        driver,
        subagent: {
          id: subagentNodeId,
          threadId,
          runId,
          status: "running",
        },
      } as ProviderAdapterV2Event,
      {
        type: "provider_turn.updated",
        driver,
        threadId: childThreadId,
        providerTurn: {
          id: childProviderTurnId,
          providerThreadId: childProviderThreadId,
          nodeId: childNodeId,
          runAttemptId: null,
          status: "running",
        },
      } as ProviderAdapterV2Event,
      {
        type: "turn.terminal",
        driver,
        providerThreadId,
        providerTurnId: rootProviderTurnId,
        runOrdinal: 1,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      },
      {
        type: "message.updated",
        driver,
        message: {
          id: MessageId.make("message:run-execution-late-child:child"),
          threadId: childThreadId,
          runId: null,
          nodeId: childNodeId,
          role: "assistant",
          text: "Hello.",
          streaming: false,
        },
      } as ProviderAdapterV2Event,
      {
        type: "provider_turn.updated",
        driver,
        threadId: childThreadId,
        providerTurn: {
          id: childProviderTurnId,
          providerThreadId: childProviderThreadId,
          nodeId: childNodeId,
          runAttemptId: null,
          status: "completed",
        },
      } as ProviderAdapterV2Event,
      {
        type: "subagent.updated",
        driver,
        subagent: {
          id: subagentNodeId,
          threadId,
          runId,
          status: "completed",
        },
      } as ProviderAdapterV2Event,
    ];

    yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      yield* runExecution.startRootRun({
        commandId: CommandId.make("command:run-execution-late-child"),
        appThread: { id: threadId } as OrchestrationV2AppThread,
        providerSessionId,
        session: {
          events: Stream.fromIterable(events),
          startTurn: () => Effect.void,
        } as unknown as ProviderAdapterV2SessionRuntime,
        run: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
        } as OrchestrationV2Run,
        rootNode: { id: rootNodeId } as OrchestrationV2ExecutionNode,
        checkpointScope: {
          id: CheckpointScopeId.make("checkpoint-scope:run-execution-late-child"),
        } as OrchestrationV2CheckpointScope,
        providerThread: {
          id: providerThreadId,
          driver,
        } as OrchestrationV2ProviderThread,
        attempt: {
          id: attemptId,
          providerTurnId: rootProviderTurnId,
        } as OrchestrationV2RunAttempt,
        attemptId,
        providerTurnOrdinal: 1,
        message: {
          messageId: MessageId.make("message:run-execution-late-child:user"),
          text: "Spawn a child and finish.",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "readOnly",
            access: { type: "fullAccess" },
            networkAccess: false,
          },
        },
      });
    }).pipe(Effect.provide(testLayer));

    const observed = yield* Deferred.await(childMessageIngested).pipe(
      Effect.timeoutOption("2 seconds"),
    );
    assert.isTrue(Option.isSome(observed), "child message was not ingested after root terminal");
    assert.deepEqual(yield* Ref.get(order), ["root-finalized", "child-message"]);
  }),
);

it.effect("keeps ingesting a late background command item completion after root terminal", () =>
  Effect.gen(function* () {
    const observed = yield* runBackgroundItemScenario("bg-command", (ids) => [
      backgroundTurnItemEvent(ids, "command_execution", "running", 1),
      rootTerminalEvent(ids, "completed"),
      backgroundTurnItemEvent(ids, "command_execution", "completed", 2),
    ]);
    assert.deepEqual(observed, ["turn_item:running", "root-finalized", "turn_item:completed"]);
  }),
);

it.effect("ingests the trailing subagent item completion after the subagent row completes", () =>
  Effect.gen(function* () {
    const observed = yield* runBackgroundItemScenario("subagent-trailing-item", (ids) => [
      subagentEvent(ids, "running"),
      backgroundTurnItemEvent(ids, "subagent", "running", 1),
      rootTerminalEvent(ids, "completed"),
      subagentEvent(ids, "completed"),
      backgroundTurnItemEvent(ids, "subagent", "completed", 2),
    ]);
    assert.deepEqual(observed, [
      "subagent:running",
      "turn_item:running",
      "root-finalized",
      "subagent:completed",
      "turn_item:completed",
    ]);
  }),
);

it.effect("keeps ingesting a child thread's late background item completion", () =>
  Effect.gen(function* () {
    const observed = yield* runBackgroundItemScenario("bg-child-item", (ids) => [
      childThreadCreatedEvent(ids),
      subagentEvent(ids, "running"),
      childBackgroundTurnItemEvent(ids, "running", 1),
      rootTerminalEvent(ids, "completed"),
      subagentEvent(ids, "completed"),
      childBackgroundTurnItemEvent(ids, "completed", 2),
    ]);
    assert.deepEqual(observed, [
      "subagent:running",
      "turn_item:running",
      "root-finalized",
      "subagent:completed",
      "turn_item:completed",
    ]);
  }),
);

it.effect("keeps ingesting until the last of several background items terminalizes", () =>
  Effect.gen(function* () {
    const secondItemId = TurnItemId.make("turn-item:bg-multi:second");
    const observed = yield* runBackgroundItemScenario("bg-multi", (ids) => [
      backgroundTurnItemEvent(ids, "command_execution", "running", 1),
      backgroundTurnItemEvent(ids, "dynamic_tool", "running", 2, secondItemId),
      rootTerminalEvent(ids, "completed"),
      backgroundTurnItemEvent(ids, "command_execution", "completed", 3),
      backgroundTurnItemEvent(ids, "dynamic_tool", "completed", 4, secondItemId),
    ]);
    assert.deepEqual(observed, [
      "turn_item:running",
      "turn_item:running",
      "root-finalized",
      "turn_item:completed",
      "turn_item:completed",
    ]);
  }),
);

it.effect("does not pin ingestion on background items when the root turn is interrupted", () =>
  Effect.gen(function* () {
    const observed = yield* runBackgroundItemScenario("bg-interrupted", (ids) => [
      backgroundTurnItemEvent(ids, "command_execution", "running", 1),
      rootTerminalEvent(ids, "interrupted"),
      backgroundTurnItemEvent(ids, "command_execution", "completed", 2),
    ]);
    assert.deepEqual(observed, ["turn_item:running", "root-finalized"]);
  }),
);

it.effect("seeds inherited background items before their next update", () =>
  Effect.gen(function* () {
    const key = "inherited-background-seeded";
    const priorRunId = RunId.make(`run:${key}:prior`);
    const observed = yield* runBackgroundItemScenario(
      key,
      (ids) => [
        rootTerminalEvent(ids, "completed"),
        backgroundTurnItemEventForRun(ids, priorRunId, "subagent", "completed", 1),
      ],
      {
        loadInheritedBackgroundTurnItems: () =>
          Effect.succeed([{ id: TurnItemId.make(`turn-item:${key}`), runId: priorRunId }]),
      },
    );

    assert.deepEqual(observed, ["root-finalized", "turn_item:completed"]);
  }),
);

it.effect("releases the live run after an inherited background item terminalizes", () =>
  Effect.gen(function* () {
    const key = "inherited-background-terminal";
    const priorRunId = RunId.make(`run:${key}:prior`);
    const observed = yield* runBackgroundItemScenario(
      key,
      (ids) => [
        backgroundTurnItemEventForRun(ids, priorRunId, "subagent", "running", 1),
        rootTerminalEvent(ids, "completed"),
        backgroundTurnItemEventForRun(ids, priorRunId, "subagent", "completed", 2),
      ],
      {
        loadInheritedBackgroundTurnItems: () =>
          Effect.succeed([{ id: TurnItemId.make(`turn-item:${key}`), runId: priorRunId }]),
      },
    );

    assert.deepEqual(observed, ["turn_item:running", "root-finalized", "turn_item:completed"]);
  }),
);

it.effect("does not hold the live stream open for a foreign provider's background item", () =>
  Effect.gen(function* () {
    const key = "inherited-background-foreign-provider";
    const ids = backgroundScenarioIds(key);
    const priorRunId = RunId.make(`run:${key}:prior`);
    const foreignProviderThreadId = ProviderThreadId.make(`provider-thread:${key}:foreign-session`);
    const foreignItem = {
      id: ids.itemId,
      threadId: ids.threadId,
      runId: priorRunId,
      providerThreadId: foreignProviderThreadId,
      type: "subagent",
      status: "running",
    } as OrchestrationV2TurnItem;
    const inherited = RunExecutionService.selectInheritedBackgroundTurnItems({
      threadId: ids.threadId,
      currentProviderThreadId: ids.providerThreadId,
      currentRunOrdinal: 2,
      runs: [
        {
          id: priorRunId,
          threadId: ids.threadId,
          ordinal: 1,
          status: "interrupted",
        } as OrchestrationV2Run,
      ],
      turnItems: [foreignItem],
    });

    const observed = yield* runBackgroundItemScenario(
      key,
      (scenarioIds) => [rootTerminalEvent(scenarioIds, "completed")],
      {
        keepEventStreamOpen: true,
        loadInheritedBackgroundTurnItems: () => Effect.succeed(inherited),
      },
    );

    assert.deepEqual(inherited, []);
    assert.deepEqual(observed, ["root-finalized"]);
  }),
);

it.effect("refreshes inherited background items after event subscription", () =>
  Effect.gen(function* () {
    const key = "inherited-background-subscription-refresh";
    const ids = backgroundScenarioIds(key);
    const priorRunId = RunId.make(`run:${key}:prior`);
    const itemStatus = yield* Ref.make<OrchestrationV2TurnItem["status"]>("running");
    const loadInheritedBackgroundTurnItems = () =>
      Ref.get(itemStatus).pipe(
        Effect.map((status) =>
          RunExecutionService.selectInheritedBackgroundTurnItems({
            threadId: ids.threadId,
            currentProviderThreadId: ids.providerThreadId,
            currentRunOrdinal: 2,
            runs: [
              {
                id: priorRunId,
                threadId: ids.threadId,
                ordinal: 1,
                status: "interrupted",
              } as OrchestrationV2Run,
            ],
            turnItems: [
              {
                id: ids.itemId,
                threadId: ids.threadId,
                runId: priorRunId,
                providerThreadId: ids.providerThreadId,
                type: "subagent",
                status,
              } as OrchestrationV2TurnItem,
            ],
          }),
        ),
      );

    const observed = yield* runBackgroundItemScenario(
      key,
      (scenarioIds) => [rootTerminalEvent(scenarioIds, "completed")],
      {
        keepEventStreamOpen: true,
        loadInheritedBackgroundTurnItems,
        onSubscribe: Ref.set(itemStatus, "completed"),
      },
    );

    assert.deepEqual(yield* loadInheritedBackgroundTurnItems(), []);
    assert.deepEqual(observed, ["root-finalized"]);
  }),
);

it.effect(
  "keeps ingesting a late empty provider-thread roster while thread-scoped pending work is true",
  () =>
    Effect.gen(function* () {
      const key = "bg-roster-pending-work";
      const ids = backgroundScenarioIds(key);
      const providerInstanceId = ProviderInstanceId.make("codex");
      const now = yield* DateTime.now;
      const observed = yield* Ref.make<ReadonlyArray<string>>([]);
      const pendingByProviderThreadId = yield* Ref.make(new Map([[ids.providerThreadId, true]]));
      const scopedProbeArgs = yield* Ref.make<ReadonlyArray<ProviderThreadId>>([]);
      const ingestCalls = yield* Ref.make<
        ReadonlyArray<{
          readonly activeAttemptId: RunAttemptId | null;
          readonly eventType: string;
          readonly hasWriteIfRunCurrent: boolean;
          readonly hasWriteIfProviderThreadOwner: boolean;
          readonly expectedLastRunOrdinal: number | null;
          readonly runId: RunId | null;
          readonly rosterLength: number | null;
        }>
      >([]);
      const ingestionDone = yield* Deferred.make<void>();
      const testLayer = RunExecutionService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              captureBaseline: () => Effect.void,
            }),
            Layer.mock(EventSink.EventSinkV2)({
              write: () => Effect.succeed([]),
              writeWithEffects: (input) =>
                Effect.gen(function* () {
                  if (
                    input.events.some(
                      (event) => event.type === "run.updated" && event.runId === ids.runId,
                    )
                  ) {
                    yield* Ref.update(observed, (current) => [...current, "root-finalized"]);
                  }
                  return [];
                }),
              writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
              writeIfProviderThreadOwner: () =>
                Effect.succeed({ committed: true, storedEvents: [] }),
            }),
            IdAllocator.layer,
            Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
              ingestNormalized: (input) =>
                Effect.gen(function* () {
                  const event = input.event;
                  const rosterLength =
                    event.type === "provider_thread.updated"
                      ? (event.providerThread.pendingBackgroundTasks?.length ?? 0)
                      : null;
                  yield* Ref.update(ingestCalls, (current) => [
                    ...current,
                    {
                      activeAttemptId: input.writeIfProviderThreadOwner?.activeAttemptId ?? null,
                      eventType: event.type,
                      hasWriteIfRunCurrent: input.writeIfRunCurrent !== undefined,
                      hasWriteIfProviderThreadOwner: input.writeIfProviderThreadOwner !== undefined,
                      expectedLastRunOrdinal:
                        input.writeIfProviderThreadOwner?.expectedLastRunOrdinal ?? null,
                      runId: input.writeIfProviderThreadOwner?.runId ?? null,
                      rosterLength,
                    },
                  ]);
                  if (event.type === "provider_thread.updated" && rosterLength === 0) {
                    yield* Ref.update(pendingByProviderThreadId, (current) => {
                      const next = new Map(current);
                      next.set(event.providerThread.id, false);
                      return next;
                    });
                    yield* Ref.update(observed, (current) => [...current, "roster-cleared"]);
                  }
                  if (event.type === "turn.terminal") {
                    yield* Ref.update(observed, (current) => [...current, "terminal"]);
                  }
                  return [];
                }),
            }),
            ServerSettings.layerTest(),
          ),
        ),
      );

      const providerThreadBase = {
        id: ids.providerThreadId,
        driver,
        providerInstanceId,
        providerSessionId: ProviderSessionId.make(`session:${key}`),
        appThreadId: ids.threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle" as const,
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };

      yield* Effect.gen(function* () {
        const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
        yield* runExecution.startRootRun({
          commandId: CommandId.make(`command:${key}`),
          appThread: { id: ids.threadId } as OrchestrationV2AppThread,
          providerSessionId: ProviderSessionId.make(`session:${key}`),
          session: {
            events: Stream.empty,
            // Session-wide stays true forever; the root must consult the
            // thread-scoped probe instead of being pinned by siblings.
            hasPendingBackgroundWork: Effect.succeed(true),
            hasPendingBackgroundWorkForThread: (providerThread: OrchestrationV2ProviderThread) =>
              Effect.gen(function* () {
                yield* Ref.update(scopedProbeArgs, (current) => [...current, providerThread.id]);
                return (yield* Ref.get(pendingByProviderThreadId)).get(providerThread.id) === true;
              }),
            subscribeEvents: Effect.succeed({
              events: Stream.fromIterable([
                {
                  type: "provider_thread.updated",
                  driver,
                  providerThread: {
                    ...providerThreadBase,
                    status: "active" as const,
                    pendingBackgroundTasks: [
                      { taskId: "bg-1", description: "sleep 20", kind: "command" },
                    ],
                    updatedAt: now,
                  },
                } as ProviderAdapterV2Event,
                rootTerminalEvent(ids, "completed"),
                {
                  type: "provider_thread.updated",
                  driver,
                  providerThread: {
                    ...providerThreadBase,
                    status: "idle" as const,
                    pendingBackgroundTasks: [],
                    updatedAt: now,
                  },
                } as ProviderAdapterV2Event,
              ]),
              close: Deferred.succeed(ingestionDone, undefined),
            }),
            startTurn: () => Effect.void,
          } as unknown as ProviderAdapterV2SessionRuntime,
          run: {
            id: ids.runId,
            threadId: ids.threadId,
            ordinal: 1,
            providerInstanceId,
          } as OrchestrationV2Run,
          rootNode: { id: ids.rootNodeId } as OrchestrationV2ExecutionNode,
          checkpointScope: {
            id: CheckpointScopeId.make(`checkpoint-scope:${key}`),
          } as OrchestrationV2CheckpointScope,
          providerThread: providerThreadBase as OrchestrationV2ProviderThread,
          attempt: {
            id: ids.attemptId,
            providerTurnId: ids.rootProviderTurnId,
          } as OrchestrationV2RunAttempt,
          attemptId: ids.attemptId,
          providerTurnOrdinal: 1,
          message: {
            messageId: MessageId.make(`message:${key}:user`),
            text: "Start background work and settle.",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
            approvalPolicy: "never",
            sandboxPolicy: {
              type: "readOnly",
              access: { type: "fullAccess" },
              networkAccess: false,
            },
          },
        });
      }).pipe(Effect.provide(testLayer));

      const closed = yield* Deferred.await(ingestionDone).pipe(Effect.timeoutOption("2 seconds"));
      assert.isTrue(Option.isSome(closed), "event subscription did not release");
      assert.deepEqual(yield* Ref.get(observed), ["terminal", "root-finalized", "roster-cleared"]);
      assert.isTrue((yield* Ref.get(scopedProbeArgs)).includes(ids.providerThreadId));

      const calls = yield* Ref.get(ingestCalls);
      const preTerminalRoster = calls.find(
        (call) => call.eventType === "provider_thread.updated" && call.rosterLength === 1,
      );
      const lateClear = calls.find(
        (call) => call.eventType === "provider_thread.updated" && call.rosterLength === 0,
      );
      assert.isDefined(preTerminalRoster);
      assert.isTrue(preTerminalRoster?.hasWriteIfRunCurrent);
      assert.isFalse(preTerminalRoster?.hasWriteIfProviderThreadOwner);
      assert.isDefined(lateClear);
      assert.isFalse(
        lateClear?.hasWriteIfRunCurrent,
        "late empty roster must not use stale writeIfRunCurrent running-gate",
      );
      assert.isTrue(
        lateClear?.hasWriteIfProviderThreadOwner,
        "late empty roster must gate on provider-thread ownership",
      );
      assert.equal(lateClear?.expectedLastRunOrdinal, 1);
      assert.equal(lateClear?.runId, ids.runId);
      assert.equal(lateClear?.activeAttemptId, ids.attemptId);
    }),
);

it.effect("drops late root provider-thread writes from a superseded attempt", () =>
  Effect.gen(function* () {
    const key = "bg-roster-attempt-owner-lost";
    const ids = backgroundScenarioIds(key);
    const replacementAttemptId = RunAttemptId.make(`attempt:${key}:replacement`);
    const providerInstanceId = ProviderInstanceId.make("codex");
    const now = yield* DateTime.now;
    const observed = yield* Ref.make<ReadonlyArray<string>>([]);
    // Probe stays true forever so only ownership-loss can release the stream.
    const ingestionDone = yield* Deferred.make<void>();
    const ingestCalls = yield* Ref.make<
      ReadonlyArray<{
        readonly activeAttemptId: RunAttemptId | null;
        readonly eventType: string;
        readonly hasWriteIfProviderThreadOwner: boolean;
        readonly expectedLastRunOrdinal: number | null;
        readonly rosterLength: number | null;
        readonly committed: boolean;
      }>
    >([]);
    const testLayer = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
          Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
          Layer.mock(EventSink.EventSinkV2)({
            write: () => Effect.succeed([]),
            writeWithEffects: (input) =>
              Effect.gen(function* () {
                if (
                  input.events.some(
                    (event) => event.type === "run.updated" && event.runId === ids.runId,
                  )
                ) {
                  yield* Ref.update(observed, (current) => [...current, "root-finalized"]);
                }
                return [];
              }),
            writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
            writeIfProviderThreadOwner: () =>
              Effect.succeed({ committed: false, storedEvents: [] }),
          }),
          IdAllocator.layer,
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: (input) =>
              Effect.gen(function* () {
                const event = input.event;
                const rosterLength =
                  event.type === "provider_thread.updated"
                    ? (event.providerThread.pendingBackgroundTasks?.length ?? 0)
                    : null;
                const ownerGate = input.writeIfProviderThreadOwner;
                // Simulate the EventSink reject after a same-run replacement
                // changes activeAttemptId without advancing lastRunOrdinal.
                const rejectAsStaleOwner =
                  ownerGate !== undefined && ownerGate.activeAttemptId !== replacementAttemptId;
                yield* Ref.update(ingestCalls, (current) => [
                  ...current,
                  {
                    activeAttemptId: ownerGate?.activeAttemptId ?? null,
                    eventType: event.type,
                    hasWriteIfProviderThreadOwner: ownerGate !== undefined,
                    expectedLastRunOrdinal: ownerGate?.expectedLastRunOrdinal ?? null,
                    rosterLength,
                    committed: !rejectAsStaleOwner,
                  },
                ]);
                if (event.type === "turn.terminal") {
                  yield* Ref.update(observed, (current) => [...current, "terminal"]);
                }
                if (event.type === "provider_thread.updated" && rejectAsStaleOwner) {
                  yield* Ref.update(observed, (current) => [...current, "stale-owner-rejected"]);
                  return [];
                }
                if (event.type === "provider_thread.updated") {
                  yield* Ref.update(observed, (current) => [...current, "roster-written"]);
                }
                return [];
              }),
          }),
          ServerSettings.layerTest(),
        ),
      ),
    );

    const providerThreadBase = {
      id: ids.providerThreadId,
      driver,
      providerInstanceId,
      providerSessionId: ProviderSessionId.make(`session:${key}`),
      appThreadId: ids.threadId,
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle" as const,
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    };

    yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      yield* runExecution.startRootRun({
        commandId: CommandId.make(`command:${key}`),
        appThread: { id: ids.threadId } as OrchestrationV2AppThread,
        providerSessionId: ProviderSessionId.make(`session:${key}`),
        session: {
          events: Stream.empty,
          hasPendingBackgroundWork: Effect.succeed(true),
          hasPendingBackgroundWorkForThread: () => Effect.succeed(true),
          subscribeEvents: Effect.succeed({
            events: Stream.fromIterable([
              {
                type: "provider_thread.updated",
                driver,
                providerThread: {
                  ...providerThreadBase,
                  status: "active" as const,
                  pendingBackgroundTasks: [
                    { taskId: "bg-stale", description: "sleep 20", kind: "command" },
                  ],
                  updatedAt: now,
                },
              } as ProviderAdapterV2Event,
              rootTerminalEvent(ids, "completed"),
              // Late snapshot after a replacement attempt claimed the same
              // run ordinal. Without attempt gating this would clobber it.
              {
                type: "provider_thread.updated",
                driver,
                providerThread: {
                  ...providerThreadBase,
                  status: "idle" as const,
                  lastRunOrdinal: 1,
                  pendingBackgroundTasks: [
                    { taskId: "bg-stale", description: "sleep 20", kind: "command" },
                  ],
                  updatedAt: now,
                },
              } as ProviderAdapterV2Event,
            ]),
            close: Deferred.succeed(ingestionDone, undefined),
          }),
          startTurn: () => Effect.void,
        } as unknown as ProviderAdapterV2SessionRuntime,
        run: {
          id: ids.runId,
          threadId: ids.threadId,
          ordinal: 1,
          providerInstanceId,
        } as OrchestrationV2Run,
        rootNode: { id: ids.rootNodeId } as OrchestrationV2ExecutionNode,
        checkpointScope: {
          id: CheckpointScopeId.make(`checkpoint-scope:${key}`),
        } as OrchestrationV2CheckpointScope,
        providerThread: providerThreadBase as OrchestrationV2ProviderThread,
        attempt: {
          id: ids.attemptId,
          providerTurnId: ids.rootProviderTurnId,
        } as OrchestrationV2RunAttempt,
        attemptId: ids.attemptId,
        providerTurnOrdinal: 1,
        message: {
          messageId: MessageId.make(`message:${key}:user`),
          text: "Background work that loses ownership.",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "readOnly",
            access: { type: "fullAccess" },
            networkAccess: false,
          },
        },
      });
    }).pipe(Effect.provide(testLayer));

    const closed = yield* Deferred.await(ingestionDone).pipe(Effect.timeoutOption("2 seconds"));
    assert.isTrue(
      Option.isSome(closed),
      "subscription must release after ownership-loss reject even when probe stays true",
    );
    assert.deepEqual(yield* Ref.get(observed), [
      "roster-written",
      "terminal",
      "root-finalized",
      "stale-owner-rejected",
    ]);

    const calls = yield* Ref.get(ingestCalls);
    const lateStale = calls.find(
      (call) =>
        call.eventType === "provider_thread.updated" &&
        call.hasWriteIfProviderThreadOwner &&
        call.rosterLength === 1,
    );
    assert.isDefined(lateStale);
    assert.equal(lateStale?.expectedLastRunOrdinal, 1);
    assert.equal(lateStale?.activeAttemptId, ids.attemptId);
    assert.isFalse(lateStale?.committed);
  }),
);

it.effect(
  "keeps ingesting a late background turn-item completion after ownership-loss rejects roster writes",
  () =>
    Effect.gen(function* () {
      const key = "bg-item-after-owner-lost";
      const ids = backgroundScenarioIds(key);
      const providerInstanceId = ProviderInstanceId.make("codex");
      const now = yield* DateTime.now;
      const observed = yield* Ref.make<ReadonlyArray<string>>([]);
      // Probe stays true forever; open background items must pin the stream
      // past ownership-loss so late turn_item completions still land.
      const ingestionDone = yield* Deferred.make<void>();
      const testLayer = RunExecutionService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              captureBaseline: () => Effect.void,
            }),
            Layer.mock(EventSink.EventSinkV2)({
              write: () => Effect.succeed([]),
              writeWithEffects: (input) =>
                Effect.gen(function* () {
                  if (
                    input.events.some(
                      (event) => event.type === "run.updated" && event.runId === ids.runId,
                    )
                  ) {
                    yield* Ref.update(observed, (current) => [...current, "root-finalized"]);
                  }
                  return [];
                }),
              writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
              writeIfProviderThreadOwner: () =>
                Effect.succeed({ committed: false, storedEvents: [] }),
            }),
            IdAllocator.layer,
            Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
              ingestNormalized: (input) =>
                Effect.gen(function* () {
                  const event = input.event;
                  if (event.type === "turn.terminal") {
                    yield* Ref.update(observed, (current) => [...current, "terminal"]);
                  }
                  if (
                    event.type === "provider_thread.updated" &&
                    input.writeIfProviderThreadOwner !== undefined
                  ) {
                    yield* Ref.update(observed, (current) => [...current, "stale-owner-rejected"]);
                    return [];
                  }
                  if (event.type === "turn_item.updated") {
                    yield* Ref.update(observed, (current) => [
                      ...current,
                      `turn_item:${event.turnItem.status}`,
                    ]);
                  }
                  return [];
                }),
            }),
            ServerSettings.layerTest(),
          ),
        ),
      );

      const providerThreadBase = {
        id: ids.providerThreadId,
        driver,
        providerInstanceId,
        providerSessionId: ProviderSessionId.make(`session:${key}`),
        appThreadId: ids.threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle" as const,
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };

      yield* Effect.gen(function* () {
        const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
        yield* runExecution.startRootRun({
          commandId: CommandId.make(`command:${key}`),
          appThread: { id: ids.threadId } as OrchestrationV2AppThread,
          providerSessionId: ProviderSessionId.make(`session:${key}`),
          session: {
            events: Stream.empty,
            hasPendingBackgroundWork: Effect.succeed(true),
            hasPendingBackgroundWorkForThread: () => Effect.succeed(true),
            subscribeEvents: Effect.succeed({
              events: Stream.fromIterable([
                backgroundTurnItemEvent(ids, "command_execution", "running", 1),
                rootTerminalEvent(ids, "completed"),
                // Ownership reject after a newer run claimed lastRunOrdinal.
                {
                  type: "provider_thread.updated",
                  driver,
                  providerThread: {
                    ...providerThreadBase,
                    status: "idle" as const,
                    lastRunOrdinal: 1,
                    pendingBackgroundTasks: [
                      { taskId: "bg-stale", description: "sleep 20", kind: "command" },
                    ],
                    updatedAt: now,
                  },
                } as ProviderAdapterV2Event,
                // Late completion still writable (turn_item writes are not
                // ownership-gated); stream must stay open for it.
                backgroundTurnItemEvent(ids, "command_execution", "completed", 2),
              ]),
              close: Deferred.succeed(ingestionDone, undefined),
            }),
            startTurn: () => Effect.void,
          } as unknown as ProviderAdapterV2SessionRuntime,
          run: {
            id: ids.runId,
            threadId: ids.threadId,
            ordinal: 1,
            providerInstanceId,
          } as OrchestrationV2Run,
          rootNode: { id: ids.rootNodeId } as OrchestrationV2ExecutionNode,
          checkpointScope: {
            id: CheckpointScopeId.make(`checkpoint-scope:${key}`),
          } as OrchestrationV2CheckpointScope,
          providerThread: providerThreadBase as OrchestrationV2ProviderThread,
          attempt: {
            id: ids.attemptId,
            providerTurnId: ids.rootProviderTurnId,
          } as OrchestrationV2RunAttempt,
          attemptId: ids.attemptId,
          providerTurnOrdinal: 1,
          message: {
            messageId: MessageId.make(`message:${key}:user`),
            text: "Background item after ownership loss.",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
            approvalPolicy: "never",
            sandboxPolicy: {
              type: "readOnly",
              access: { type: "fullAccess" },
              networkAccess: false,
            },
          },
        });
      }).pipe(Effect.provide(testLayer));

      const closed = yield* Deferred.await(ingestionDone).pipe(Effect.timeoutOption("2 seconds"));
      assert.isTrue(
        Option.isSome(closed),
        "subscription must release after background item completes past ownership loss",
      );
      assert.deepEqual(yield* Ref.get(observed), [
        "turn_item:running",
        "terminal",
        "root-finalized",
        "stale-owner-rejected",
        "turn_item:completed",
      ]);
    }),
);

it.effect(
  "does not pin ingestion on a sibling session-wide pending state when this thread has no roster",
  () =>
    Effect.gen(function* () {
      const key = "bg-roster-sibling-not-pin";
      const ids = backgroundScenarioIds(key);
      const providerInstanceId = ProviderInstanceId.make("codex");
      const now = yield* DateTime.now;
      const observed = yield* Ref.make<ReadonlyArray<string>>([]);
      const ingestionDone = yield* Deferred.make<void>();
      const scopedProbeArgs = yield* Ref.make<ReadonlyArray<ProviderThreadId>>([]);
      const testLayer = RunExecutionService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              captureBaseline: () => Effect.void,
            }),
            Layer.mock(EventSink.EventSinkV2)({
              write: () => Effect.succeed([]),
              writeWithEffects: (input) =>
                Effect.gen(function* () {
                  if (
                    input.events.some(
                      (event) => event.type === "run.updated" && event.runId === ids.runId,
                    )
                  ) {
                    yield* Ref.update(observed, (current) => [...current, "root-finalized"]);
                  }
                  return [];
                }),
              writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
            }),
            IdAllocator.layer,
            Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
              ingestNormalized: (input) =>
                Effect.gen(function* () {
                  if (input.event.type === "turn.terminal") {
                    yield* Ref.update(observed, (current) => [...current, "terminal"]);
                  }
                  return [];
                }),
            }),
            ServerSettings.layerTest(),
          ),
        ),
      );

      const providerThreadBase = {
        id: ids.providerThreadId,
        driver,
        providerInstanceId,
        providerSessionId: ProviderSessionId.make(`session:${key}`),
        appThreadId: ids.threadId,
        ownerNodeId: null,
        nativeThreadRef: {
          driver,
          nativeId: "native-self",
          strength: "strong" as const,
        },
        nativeConversationHeadRef: null,
        status: "idle" as const,
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const siblingProviderThreadId = ProviderThreadId.make(`provider-thread:${key}:sibling`);

      yield* Effect.gen(function* () {
        const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
        yield* runExecution.startRootRun({
          commandId: CommandId.make(`command:${key}`),
          appThread: { id: ids.threadId } as OrchestrationV2AppThread,
          providerSessionId: ProviderSessionId.make(`session:${key}`),
          session: {
            events: Stream.empty,
            // Session-wide stays true (sibling has work). Stop must use only
            // the scoped probe for this root's provider thread.
            hasPendingBackgroundWork: Effect.succeed(true),
            hasPendingBackgroundWorkForThread: (providerThread: OrchestrationV2ProviderThread) =>
              Effect.gen(function* () {
                yield* Ref.update(scopedProbeArgs, (current) => [...current, providerThread.id]);
                // Own thread has no roster; sibling would report true if probed.
                return providerThread.id !== ids.providerThreadId;
              }),
            subscribeEvents: Effect.succeed({
              events: Stream.fromIterable([
                rootTerminalEvent(ids, "completed"),
                // Sibling thread update after terminal. Own-thread scoped
                // pending is false, so this root must release without waiting
                // for sibling-driven session-wide pending work.
                {
                  type: "provider_thread.updated",
                  driver,
                  providerThread: {
                    ...providerThreadBase,
                    id: siblingProviderThreadId,
                    appThreadId: ThreadId.make(`thread:${key}:sibling`),
                    nativeThreadRef: {
                      driver,
                      nativeId: "native-sibling",
                      strength: "strong" as const,
                    },
                    pendingBackgroundTasks: [
                      { taskId: "sibling-bg", description: "other thread", kind: "command" },
                    ],
                    updatedAt: now,
                  },
                } as ProviderAdapterV2Event,
              ]),
              close: Deferred.succeed(ingestionDone, undefined),
            }),
            startTurn: () => Effect.void,
          } as unknown as ProviderAdapterV2SessionRuntime,
          run: {
            id: ids.runId,
            threadId: ids.threadId,
            ordinal: 1,
            providerInstanceId,
          } as OrchestrationV2Run,
          rootNode: { id: ids.rootNodeId } as OrchestrationV2ExecutionNode,
          checkpointScope: {
            id: CheckpointScopeId.make(`checkpoint-scope:${key}`),
          } as OrchestrationV2CheckpointScope,
          providerThread: providerThreadBase as OrchestrationV2ProviderThread,
          attempt: {
            id: ids.attemptId,
            providerTurnId: ids.rootProviderTurnId,
          } as OrchestrationV2RunAttempt,
          attemptId: ids.attemptId,
          providerTurnOrdinal: 1,
          message: {
            messageId: MessageId.make(`message:${key}:user`),
            text: "Settle without local pending work.",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
            approvalPolicy: "never",
            sandboxPolicy: {
              type: "readOnly",
              access: { type: "fullAccess" },
              networkAccess: false,
            },
          },
        });
      }).pipe(Effect.provide(testLayer));

      const closed = yield* Deferred.await(ingestionDone).pipe(Effect.timeoutOption("2 seconds"));
      assert.isTrue(Option.isSome(closed), "event subscription did not release");
      // Critical: release while session-wide hasPendingBackgroundWork stays true
      // and the scoped probe reports false for this root's provider thread.
      const observedEvents = [...(yield* Ref.get(observed))];
      assert.includeMembers(observedEvents, ["terminal", "root-finalized"]);
      const probedIds = yield* Ref.get(scopedProbeArgs);
      assert.isTrue(probedIds.includes(ids.providerThreadId));
      assert.isFalse(probedIds.includes(siblingProviderThreadId));
    }),
);

it.effect(
  "cascade-terminalizes run-owned subagent rows on interrupt before root finalization",
  () =>
    Effect.gen(function* () {
      const ids = backgroundScenarioIds("subagent-interrupt-cascade");
      const childThreadId = ids.childThreadId;
      const unrelatedChildThreadId = ThreadId.make(
        "thread:subagent-interrupt-cascade:unrelated-child",
      );
      const providerInstanceId = ProviderInstanceId.make("codex");
      const written = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
      const ingested = yield* Ref.make<ReadonlyArray<ProviderAdapterV2Event>>([]);
      const ingestionDone = yield* Deferred.make<void>();
      const testLayer = RunExecutionService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              captureBaseline: () => Effect.void,
            }),
            Layer.mock(EventSink.EventSinkV2)({
              write: () => Effect.succeed([]),
              writeWithEffects: (input) =>
                Effect.gen(function* () {
                  yield* Ref.update(written, (current) => [...current, ...input.events]);
                  return [];
                }),
              writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
            }),
            IdAllocator.layer,
            Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
              ingestNormalized: (input) =>
                Ref.update(ingested, (current) => [...current, input.event]).pipe(Effect.as([])),
            }),
            ServerSettings.layerTest(),
          ),
        ),
      );

      const runningSubagent = makeRunOwnedSubagentFixture({
        ids,
        providerInstanceId,
        childThreadId,
        driver,
        status: "running",
      });
      const runningTurnItem = makeRunOwnedSubagentTurnItemFixture({
        ids,
        providerInstanceId,
        childThreadId,
        driver,
        status: "running",
      });
      const runningNode = makeRunOwnedSubagentNodeFixture({
        ids,
        status: "running",
      });
      const runningChildNode = makeRunOwnedSubagentChildNodeFixture({
        ids,
        status: "running",
      });
      const runningChildTurnItem = makeLinkedChildTurnItemFixture({
        ids,
        driver,
        type: "command_execution",
      });
      const suppressedChildAssistantTurnItem = makeLinkedChildTurnItemFixture({
        ids: {
          ...ids,
          childItemId: TurnItemId.make("turn-item:subagent-interrupt-cascade:suppressed-assistant"),
        },
        driver,
        type: "assistant_message",
      });
      const unrelatedChildNode = {
        ...runningChildNode,
        id: NodeId.make("node:subagent-interrupt-cascade:unrelated-child"),
        threadId: unrelatedChildThreadId,
        runId: ids.runId,
        rootNodeId: NodeId.make("node:subagent-interrupt-cascade:unrelated-child"),
      };
      const unrelatedChildTurnItem = {
        ...runningChildTurnItem,
        id: TurnItemId.make("turn-item:subagent-interrupt-cascade:unrelated-child"),
        threadId: unrelatedChildThreadId,
        nodeId: unrelatedChildNode.id,
      };

      yield* Effect.gen(function* () {
        const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
        yield* runExecution.startRootRun({
          commandId: CommandId.make("command:subagent-interrupt-cascade"),
          appThread: { id: ids.threadId } as OrchestrationV2AppThread,
          providerSessionId: ProviderSessionId.make("session:subagent-interrupt-cascade"),
          session: {
            events: Stream.empty,
            subscribeEvents: Effect.succeed({
              events: Stream.fromIterable([
                childThreadCreatedEvent(ids),
                {
                  type: "subagent.updated",
                  driver,
                  subagent: runningSubagent,
                },
                {
                  type: "node.updated",
                  driver,
                  node: runningNode,
                },
                {
                  type: "node.updated",
                  driver,
                  node: runningChildNode,
                },
                {
                  type: "node.updated",
                  driver,
                  node: unrelatedChildNode,
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: runningTurnItem,
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: runningChildTurnItem,
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: suppressedChildAssistantTurnItem,
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: unrelatedChildTurnItem,
                },
                rootTerminalEvent(ids, "interrupted"),
                // Late provider completion after interrupt must not be ingested.
                {
                  type: "subagent.updated",
                  driver,
                  subagent: {
                    ...runningSubagent,
                    status: "completed" as const,
                    result: "should-not-apply",
                    completedAt: runningSubagent.updatedAt,
                  },
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: {
                    ...runningTurnItem,
                    status: "completed" as const,
                    result: "should-not-apply",
                    completedAt: runningTurnItem.updatedAt,
                    updatedAt: runningTurnItem.updatedAt,
                  },
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: {
                    ...runningChildTurnItem,
                    status: "completed" as const,
                    completedAt: runningChildTurnItem.updatedAt,
                    updatedAt: runningChildTurnItem.updatedAt,
                  },
                },
                {
                  type: "node.updated",
                  driver,
                  node: {
                    ...runningChildNode,
                    status: "completed" as const,
                    completedAt: runningChildNode.startedAt,
                  },
                },
              ] satisfies ReadonlyArray<ProviderAdapterV2Event>),
              close: Deferred.succeed(ingestionDone, undefined),
            }),
            startTurn: () => Effect.void,
          } as unknown as ProviderAdapterV2SessionRuntime,
          run: {
            id: ids.runId,
            threadId: ids.threadId,
            ordinal: 1,
            providerInstanceId,
          } as OrchestrationV2Run,
          rootNode: { id: ids.rootNodeId } as OrchestrationV2ExecutionNode,
          checkpointScope: {
            id: CheckpointScopeId.make("checkpoint-scope:subagent-interrupt-cascade"),
          } as OrchestrationV2CheckpointScope,
          providerThread: {
            id: ids.providerThreadId,
            driver,
          } as OrchestrationV2ProviderThread,
          attempt: {
            id: ids.attemptId,
            providerTurnId: ids.rootProviderTurnId,
          } as OrchestrationV2RunAttempt,
          attemptId: ids.attemptId,
          relatedThreadIds: [unrelatedChildThreadId],
          providerTurnOrdinal: 1,
          message: {
            messageId: MessageId.make("message:subagent-interrupt-cascade:user"),
            text: "Spawn a subagent then stop.",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
            approvalPolicy: "never",
            sandboxPolicy: {
              type: "readOnly",
              access: { type: "fullAccess" },
              networkAccess: false,
            },
          },
        });
      }).pipe(Effect.provide(testLayer));

      const closed = yield* Deferred.await(ingestionDone).pipe(Effect.timeoutOption("2 seconds"));
      assert.isTrue(Option.isSome(closed), "event ingestion fiber did not finish");

      const events = yield* Ref.get(written);
      const subagentEvents = events.flatMap((event) =>
        event.type === "subagent.updated" ? [event] : [],
      );
      const turnItemEvents = events.flatMap((event) => {
        if (event.type !== "turn-item.updated" || event.payload.type !== "subagent") {
          return [];
        }
        return [
          {
            ...event,
            payload: event.payload,
          },
        ];
      });
      const nodeEvents = events.flatMap((event) =>
        event.type === "node.updated" &&
        event.payload.status === "interrupted" &&
        (event.payload.id === runningNode.id || event.payload.id === runningChildNode.id)
          ? [event]
          : [],
      );
      const runUpdatedIndex = events.findIndex((event) => event.type === "run.updated");
      assert.isAtLeast(runUpdatedIndex, 0, "root run.updated must be written");

      assert.lengthOf(subagentEvents, 1);
      const terminalSubagent = subagentEvents[0];
      assert.isDefined(terminalSubagent);
      assert.equal(terminalSubagent.payload.status, "interrupted");
      assert.equal(terminalSubagent.payload.childThreadId, childThreadId);
      assert.equal(terminalSubagent.payload.result, null);
      assert.isNotNull(terminalSubagent.payload.completedAt);

      assert.lengthOf(turnItemEvents, 1);
      const terminalTurnItem = turnItemEvents[0];
      assert.isDefined(terminalTurnItem);
      assert.equal(terminalTurnItem.payload.status, "interrupted");
      assert.equal(terminalTurnItem.payload.childThreadId, childThreadId);
      assert.equal(terminalTurnItem.payload.result, null);

      const terminalChildTurnItems = events.flatMap((event) =>
        event.type === "turn-item.updated" &&
        event.payload.id === runningChildTurnItem.id &&
        event.payload.status === "interrupted"
          ? [event]
          : [],
      );
      assert.lengthOf(terminalChildTurnItems, 1);
      const terminalChildTurnItem = terminalChildTurnItems[0];
      assert.isDefined(terminalChildTurnItem);
      assert.equal(terminalChildTurnItem.threadId, childThreadId);
      assert.equal(terminalChildTurnItem.payload.threadId, childThreadId);
      assert.equal(terminalChildTurnItem.payload.runId, null);
      assert.equal(terminalChildTurnItem.payload.type, "command_execution");
      assert.isFalse(
        events.some(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.id === unrelatedChildTurnItem.id &&
            event.payload.status === "interrupted",
        ),
        "related but unlinked child turn items must not cascade",
      );
      assert.isFalse(
        events.some(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.id === suppressedChildAssistantTurnItem.id,
        ),
        "suppressed streaming child items must not be created by the cascade",
      );

      assert.lengthOf(nodeEvents, 2);
      assert.isTrue(
        nodeEvents.some(
          (event) => event.payload.id === runningNode.id && event.payload.kind === "subagent",
        ),
      );
      assert.isFalse(
        events.some(
          (event) =>
            event.type === "node.updated" &&
            event.payload.id === unrelatedChildNode.id &&
            event.payload.status === "interrupted",
        ),
        "owned child threads without a live run-owned subagent link must not cascade",
      );
      assert.isTrue(
        nodeEvents.some(
          (event) =>
            event.payload.id === runningChildNode.id &&
            event.runId === (runningChildNode.runId ?? ids.runId) &&
            event.payload.threadId === childThreadId &&
            event.payload.kind === "root_turn",
        ),
      );

      const cascadeIndexes = events.flatMap((event, index) => {
        if (event.type === "subagent.updated" && event.payload.status === "interrupted") {
          return [index];
        }
        if (
          event.type === "turn-item.updated" &&
          event.payload.status === "interrupted" &&
          (event.payload.type === "subagent" || event.payload.id === runningChildTurnItem.id)
        ) {
          return [index];
        }
        if (event.type === "node.updated" && event.payload.status === "interrupted") {
          return event.payload.id === runningNode.id || event.payload.id === runningChildNode.id
            ? [index]
            : [];
        }
        return [];
      });
      assert.isTrue(
        cascadeIndexes.every((index) => index < runUpdatedIndex),
        "subagent cascade must precede run.updated",
      );
      assert.isFalse(
        events.some((event) => {
          if (event.type === "subagent.updated") {
            return event.payload.status === "completed";
          }
          if (event.type === "turn-item.updated" && event.payload.type === "subagent") {
            return event.payload.status === "completed";
          }
          return false;
        }),
        "late provider completion must not reopen cascaded subagent rows",
      );
      assert.isFalse(
        (yield* Ref.get(ingested)).some(
          (event) =>
            (event.type === "subagent.updated" && event.subagent.status === "completed") ||
            (event.type === "turn_item.updated" && event.turnItem.status === "completed") ||
            (event.type === "node.updated" && event.node.status === "completed"),
        ),
        "late provider completion must not be ingested after interrupt",
      );
    }),
);

it.effect(
  "cascades linked child-thread nodes after run-owned subagent and turn-item terminalize",
  () =>
    Effect.gen(function* () {
      const ids = backgroundScenarioIds("subagent-link-survives-terminal");
      const childThreadId = ids.childThreadId;
      const unrelatedChildThreadId = ThreadId.make(
        "thread:subagent-link-survives-terminal:unrelated-child",
      );
      const providerInstanceId = ProviderInstanceId.make("codex");
      const written = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
      const ingestionDone = yield* Deferred.make<void>();
      const testLayer = RunExecutionService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              captureBaseline: () => Effect.void,
            }),
            Layer.mock(EventSink.EventSinkV2)({
              write: () => Effect.succeed([]),
              writeWithEffects: (input) =>
                Effect.gen(function* () {
                  yield* Ref.update(written, (current) => [...current, ...input.events]);
                  return [];
                }),
              writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
            }),
            IdAllocator.layer,
            Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
              ingestNormalized: () => Effect.succeed([]),
            }),
            ServerSettings.layerTest(),
          ),
        ),
      );

      const runningSubagent = makeRunOwnedSubagentFixture({
        ids,
        providerInstanceId,
        childThreadId,
        driver,
        status: "running",
      });
      const runningTurnItem = makeRunOwnedSubagentTurnItemFixture({
        ids,
        providerInstanceId,
        childThreadId,
        driver,
        status: "running",
      });
      const runningNode = makeRunOwnedSubagentNodeFixture({
        ids,
        status: "running",
      });
      const runningChildNode = makeRunOwnedSubagentChildNodeFixture({
        ids,
        status: "running",
      });
      const unrelatedChildNode = {
        ...runningChildNode,
        id: NodeId.make("node:subagent-link-survives-terminal:unrelated-child"),
        threadId: unrelatedChildThreadId,
        runId: ids.runId,
        rootNodeId: NodeId.make("node:subagent-link-survives-terminal:unrelated-child"),
      };
      const completedAt = runningSubagent.updatedAt;

      yield* Effect.gen(function* () {
        const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
        yield* runExecution.startRootRun({
          commandId: CommandId.make("command:subagent-link-survives-terminal"),
          appThread: { id: ids.threadId } as OrchestrationV2AppThread,
          providerSessionId: ProviderSessionId.make("session:subagent-link-survives-terminal"),
          session: {
            events: Stream.empty,
            subscribeEvents: Effect.succeed({
              events: Stream.fromIterable([
                childThreadCreatedEvent(ids),
                {
                  type: "subagent.updated",
                  driver,
                  subagent: runningSubagent,
                },
                {
                  type: "node.updated",
                  driver,
                  node: runningNode,
                },
                {
                  type: "node.updated",
                  driver,
                  node: runningChildNode,
                },
                {
                  type: "node.updated",
                  driver,
                  node: unrelatedChildNode,
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: runningTurnItem,
                },
                // Subagent + turn-item settle before root interrupt; linkage
                // must still prove the open child-thread node is cascadeable.
                {
                  type: "subagent.updated",
                  driver,
                  subagent: {
                    ...runningSubagent,
                    status: "completed" as const,
                    result: "subagent finished first",
                    completedAt,
                  },
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: {
                    ...runningTurnItem,
                    status: "completed" as const,
                    result: "turn item finished first",
                    completedAt,
                    updatedAt: completedAt,
                  },
                },
                {
                  type: "node.updated",
                  driver,
                  node: {
                    ...runningNode,
                    status: "completed" as const,
                    completedAt,
                  },
                },
                rootTerminalEvent(ids, "interrupted"),
              ] satisfies ReadonlyArray<ProviderAdapterV2Event>),
              close: Deferred.succeed(ingestionDone, undefined),
            }),
            startTurn: () => Effect.void,
          } as unknown as ProviderAdapterV2SessionRuntime,
          run: {
            id: ids.runId,
            threadId: ids.threadId,
            ordinal: 1,
            providerInstanceId,
          } as OrchestrationV2Run,
          rootNode: { id: ids.rootNodeId } as OrchestrationV2ExecutionNode,
          checkpointScope: {
            id: CheckpointScopeId.make("checkpoint-scope:subagent-link-survives-terminal"),
          } as OrchestrationV2CheckpointScope,
          providerThread: {
            id: ids.providerThreadId,
            driver,
          } as OrchestrationV2ProviderThread,
          attempt: {
            id: ids.attemptId,
            providerTurnId: ids.rootProviderTurnId,
          } as OrchestrationV2RunAttempt,
          attemptId: ids.attemptId,
          relatedThreadIds: [unrelatedChildThreadId],
          providerTurnOrdinal: 1,
          message: {
            messageId: MessageId.make("message:subagent-link-survives-terminal:user"),
            text: "Subagent settles before root interrupt.",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
            approvalPolicy: "never",
            sandboxPolicy: {
              type: "readOnly",
              access: { type: "fullAccess" },
              networkAccess: false,
            },
          },
        });
      }).pipe(Effect.provide(testLayer));

      const closed = yield* Deferred.await(ingestionDone).pipe(Effect.timeoutOption("2 seconds"));
      assert.isTrue(Option.isSome(closed), "event ingestion fiber did not finish");

      const events = yield* Ref.get(written);
      const runUpdatedIndex = events.findIndex((event) => event.type === "run.updated");
      assert.isAtLeast(runUpdatedIndex, 0, "root run.updated must be written");

      const cascadedChildNodeEvents = events.flatMap((event, index) =>
        event.type === "node.updated" &&
        event.payload.id === runningChildNode.id &&
        event.payload.status === "interrupted"
          ? [{ event, index }]
          : [],
      );
      assert.lengthOf(
        cascadedChildNodeEvents,
        1,
        "open linked child-thread node must cascade after subagent/turn-item terminalize",
      );
      const cascadedChild = cascadedChildNodeEvents[0];
      assert.isDefined(cascadedChild);
      assert.isTrue(
        cascadedChild.index < runUpdatedIndex,
        "child-thread cascade must precede run.updated",
      );
      assert.equal(cascadedChild.event.payload.threadId, childThreadId);
      assert.equal(cascadedChild.event.payload.kind, "root_turn");
      assert.isFalse(
        events.some(
          (event) =>
            event.type === "node.updated" &&
            event.payload.id === unrelatedChildNode.id &&
            event.payload.status === "interrupted",
        ),
        "related but unlinked child threads must not cascade",
      );
      assert.isFalse(
        events.some(
          (event) => event.type === "subagent.updated" && event.payload.status === "interrupted",
        ),
        "already-terminal subagent rows must not be re-cascaded",
      );
      assert.isFalse(
        events.some(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.type === "subagent" &&
            event.payload.status === "interrupted",
        ),
        "already-terminal subagent turn items must not be re-cascaded",
      );
    }),
);

it.effect("cascade helper is provider-neutral for Claude and Codex-shaped child projections", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    let nextId = 0;
    const allocateEventId = () =>
      Effect.sync(() => EventId.make(`event:cascade-helper:${nextId++}`));

    for (const driverKind of [
      ProviderDriverKind.make("claudeAgent"),
      ProviderDriverKind.make("codex"),
    ] as const) {
      const runId = RunId.make(`run:cascade-helper:${driverKind}`);
      const threadId = ThreadId.make(`thread:cascade-helper:${driverKind}`);
      const childThreadId = ThreadId.make(`thread:cascade-helper:${driverKind}:child`);
      const subagentId = NodeId.make(`node:cascade-helper:${driverKind}:subagent`);
      const childNodeId = NodeId.make(`node:cascade-helper:${driverKind}:child-root`);
      const providerInstanceId = ProviderInstanceId.make(String(driverKind));
      const terminalStatus = driverKind === "claudeAgent" ? "failed" : "cancelled";
      const subagent: OrchestrationV2Subagent = {
        id: subagentId,
        threadId,
        runId,
        parentNodeId: NodeId.make(`node:cascade-helper:${driverKind}:root`),
        origin: "provider_native",
        createdBy: "agent",
        driver: driverKind,
        providerInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: {
          driver: driverKind,
          nativeId: `native-${driverKind}`,
          strength: "strong",
        },
        prompt: "hold",
        title: "hold",
        model: null,
        status: "running",
        progress: "partial progress",
        result: "partial result",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      };
      const turnItem = {
        id: TurnItemId.make(`turn-item:cascade-helper:${driverKind}`),
        threadId,
        runId,
        nodeId: subagentId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: subagent.nativeTaskRef,
        parentItemId: null,
        ordinal: 3,
        status: "running" as const,
        title: "hold",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "subagent" as const,
        subagentId,
        origin: "provider_native" as const,
        driver: driverKind,
        providerInstanceId,
        childThreadId,
        prompt: "hold",
        progress: "partial progress",
        result: "partial result",
      } satisfies Extract<OrchestrationV2TurnItem, { type: "subagent" }>;
      const node: OrchestrationV2ExecutionNode = {
        id: subagentId,
        threadId,
        runId,
        parentNodeId: NodeId.make(`node:cascade-helper:${driverKind}:root`),
        rootNodeId: NodeId.make(`node:cascade-helper:${driverKind}:root`),
        kind: "subagent",
        status: "running",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: subagent.nativeTaskRef,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      };
      const openChildNode: OrchestrationV2ExecutionNode = {
        id: childNodeId,
        threadId: childThreadId,
        runId: null,
        parentNodeId: null,
        rootNodeId: childNodeId,
        kind: "root_turn",
        status: "running",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      };
      const childTurnItem: OrchestrationV2TurnItem =
        driverKind === "claudeAgent"
          ? {
              id: TurnItemId.make(`turn-item:cascade-helper:${driverKind}:child-reasoning`),
              threadId: childThreadId,
              runId: null,
              nodeId: childNodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "running",
              title: "Working",
              startedAt: now,
              completedAt: null,
              updatedAt: now,
              type: "reasoning",
              text: "partial progress",
              streaming: true,
            }
          : {
              id: TurnItemId.make(`turn-item:cascade-helper:${driverKind}:child-command`),
              threadId: childThreadId,
              runId: null,
              nodeId: childNodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "running",
              title: "sleep 300",
              startedAt: now,
              completedAt: null,
              updatedAt: now,
              type: "command_execution",
              input: "sleep 300",
            };

      const events = yield* RunExecutionService.cascadeTerminalizeRunOwnedSubagents({
        run: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
        } as OrchestrationV2Run,
        open: {
          subagents: new Map([[subagentId, subagent]]),
          turnItems: new Map([[subagentId, turnItem]]),
          childTurnItems: new Map(),
          nodes: new Map([[subagentId, node]]),
          linkedChildThreadIds: new Set([childThreadId]),
        },
        status: terminalStatus,
        completedAt: now,
        allocateEventId,
      });

      assert.equal(events.length, 3, `${driverKind}: subagent + node + turn item`);
      const terminalSubagent = events.find((event) => event.type === "subagent.updated");
      assert.isDefined(terminalSubagent);
      if (terminalSubagent?.type !== "subagent.updated") {
        assert.fail("expected subagent.updated event");
        return;
      }
      assert.equal(terminalSubagent.payload.status, terminalStatus);
      assert.equal(terminalSubagent.payload.childThreadId, childThreadId);
      assert.equal(terminalSubagent.payload.progress, "partial progress");
      assert.equal(terminalSubagent.payload.result, "partial result");
      assert.equal(terminalSubagent.payload.driver, driverKind);

      const terminalItem = events.find(
        (event) => event.type === "turn-item.updated" && event.payload.type === "subagent",
      );
      assert.isDefined(terminalItem);
      if (terminalItem?.type !== "turn-item.updated" || terminalItem.payload.type !== "subagent") {
        assert.fail("expected subagent turn-item.updated event");
        return;
      }
      assert.equal(terminalItem.payload.status, terminalStatus);
      assert.equal(terminalItem.payload.childThreadId, childThreadId);
      assert.equal(terminalItem.payload.progress, "partial progress");
      assert.equal(terminalItem.payload.result, "partial result");

      // Shared cascade path: after subagent/turn-item rows are gone, only the
      // preserved linkage may prove an open child-thread node is cascadeable.
      const afterTerminalLinkEvents =
        yield* RunExecutionService.cascadeTerminalizeRunOwnedSubagents({
          run: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId,
          } as OrchestrationV2Run,
          open: {
            subagents: new Map(),
            turnItems: new Map(),
            childTurnItems: new Map([[childTurnItem.id, childTurnItem]]),
            nodes: new Map([[childNodeId, openChildNode]]),
            linkedChildThreadIds: new Set([childThreadId]),
          },
          status: terminalStatus,
          completedAt: now,
          allocateEventId,
        });
      assert.equal(
        afterTerminalLinkEvents.length,
        2,
        `${driverKind}: linked child node and turn item cascade after link rows terminalize`,
      );
      const cascadedChild = afterTerminalLinkEvents.find((event) => event.type === "node.updated");
      assert.isDefined(cascadedChild);
      if (cascadedChild?.type !== "node.updated") {
        assert.fail("expected node.updated for linked child thread");
        return;
      }
      assert.equal(cascadedChild.payload.id, childNodeId);
      assert.equal(cascadedChild.payload.threadId, childThreadId);
      assert.equal(cascadedChild.payload.status, terminalStatus);
      assert.equal(cascadedChild.payload.kind, "root_turn");
      const cascadedChildTurnItem = afterTerminalLinkEvents.find(
        (event) => event.type === "turn-item.updated",
      );
      assert.isDefined(cascadedChildTurnItem);
      if (cascadedChildTurnItem?.type !== "turn-item.updated") {
        assert.fail("expected turn-item.updated for linked child thread");
        return;
      }
      assert.equal(cascadedChildTurnItem.threadId, childThreadId);
      assert.equal(cascadedChildTurnItem.payload.id, childTurnItem.id);
      assert.equal(cascadedChildTurnItem.payload.status, terminalStatus);
      assert.equal(cascadedChildTurnItem.payload.runId, null);
      assert.equal(cascadedChildTurnItem.payload.type, childTurnItem.type);
      if (cascadedChildTurnItem.payload.type === "reasoning") {
        assert.isFalse(cascadedChildTurnItem.payload.streaming);
      }
    }
  }),
);

it.effect("omits interrupt results and subagent cascade for a superseded attempt", () =>
  Effect.gen(function* () {
    const { written, observed } = yield* captureRootRunTermination({
      key: "steer-supersede",
      shouldFinalizeRun: () => Effect.succeed(false),
      seedOpenSubagent: true,
    });
    assert.deepEqual(
      written.map((item) => item.type),
      [],
    );
    assert.deepEqual(observed, []);
  }),
);

it.effect("emits run_interrupt_result when superseded attempt still has a hard-stop request", () =>
  Effect.gen(function* () {
    const { written, observed } = yield* captureRootRunTermination({
      key: "stop-then-steer-supersede",
      shouldFinalizeRun: () => Effect.succeed(false),
      hasUnpairedRunInterruptRequest: () => Effect.succeed(true),
    });
    assert.deepEqual(
      written.map((item) => item.type),
      ["run_interrupt_result"],
    );
    assert.deepEqual(observed, ["pull-requests-refreshed"]);
    const ids = backgroundScenarioIds("stop-then-steer-supersede");
    const expectedRequestId = yield* Effect.gen(function* () {
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      return idAllocator.derive.runSignalTurnItem({
        runId: ids.runId,
        signal: "interrupt-request",
      });
    }).pipe(Effect.provide(IdAllocator.layer));
    assert.equal(written[0]?.parentItemId, expectedRequestId);
  }),
);

it.effect("omits run_interrupt_result when superseded attempt request is already paired", () =>
  Effect.gen(function* () {
    const { written, observed } = yield* captureRootRunTermination({
      key: "stop-then-steer-already-paired",
      shouldFinalizeRun: () => Effect.succeed(false),
      hasUnpairedRunInterruptRequest: () => Effect.succeed(false),
    });
    assert.deepEqual(
      written.map((item) => item.type),
      [],
    );
    assert.deepEqual(observed, []);
  }),
);

it.effect("emits run_interrupt_result when hard-stop finalizes the active attempt", () =>
  Effect.gen(function* () {
    const { written, observed } = yield* captureRootRunTermination({
      key: "hard-stop",
      shouldFinalizeRun: () => Effect.succeed(true),
    });
    assert.deepEqual(
      written.map((item) => item.type),
      ["run_interrupt_result"],
    );
    assert.deepEqual(observed, ["run:interrupted", "pull-requests-refreshed"]);
  }),
);

it.effect.each(["completed", "interrupted", "cancelled", "failed"] as const)(
  "refreshes pull requests after the current root run %s",
  (status) =>
    Effect.gen(function* () {
      const { observed } = yield* captureRootRunTermination({
        key: `pull-request-refresh:${status}`,
        shouldFinalizeRun: () => Effect.succeed(true),
        events: (ids) => Stream.make(rootTerminalEvent(ids, status)),
      });
      assert.deepEqual(observed, [
        `run:${status === "completed" ? "waiting" : status}`,
        "pull-requests-refreshed",
      ]);
    }),
);

it.effect("records a finished run as failed when its ownership check cannot be read", () =>
  Effect.gen(function* () {
    const { observed } = yield* captureRootRunTermination({
      key: "finalize-guard-read-failure",
      shouldFinalizeRun: () =>
        Effect.fail(
          new ProjectionStore.ProjectionStoreReadError({
            threadId: ThreadId.make("thread:finalize-guard-read-failure"),
            cause: "database unavailable",
          }),
        ),
      events: (ids) => Stream.make(rootTerminalEvent(ids, "completed")),
    });
    // The fallback settles through the guarded write instead of the same
    // failing read, so the run does not stay running.
    assert.include(observed, "run:failed");
  }),
);

it.effect("does not refresh pull requests for auxiliary or stale provider terminals", () =>
  Effect.gen(function* () {
    const { observed } = yield* captureRootRunTermination({
      key: "pull-request-refresh:auxiliary",
      shouldFinalizeRun: () => Effect.succeed(true),
      events: (ids) =>
        Stream.fromIterable([
          rootTerminalEvent(
            { ...ids, rootProviderTurnId: ProviderTurnId.make("turn:child") },
            "completed",
          ),
          rootTerminalEvent(
            { ...ids, rootProviderTurnId: ProviderTurnId.make("turn:previous") },
            "interrupted",
          ),
        ]),
    });
    assert.deepEqual(observed, []);
  }),
);

it.effect("refreshes pull requests after a provider stream exits with an error", () =>
  Effect.gen(function* () {
    const { written, observed } = yield* captureRootRunTermination({
      key: "pull-request-refresh:stream-error",
      shouldFinalizeRun: () => Effect.succeed(true),
      events: () =>
        Stream.fail(
          new ProviderAdapterEventStreamError({
            driver,
            providerSessionId: ProviderSessionId.make("session:exited"),
            cause: "provider process exited",
          }),
        ),
    });
    assert.deepEqual(observed, ["run:failed", "pull-requests-refreshed"]);
    assert.deepEqual(
      written.map((item) => item.type),
      ["error"],
    );
    const error = written.find((item) => item.type === "error");
    assert.include(error?.failure.message ?? "", "provider event stream closed unexpectedly");
  }),
);

it.effect("refreshes pull requests only once when startup failure closes its event stream", () =>
  Effect.gen(function* () {
    const ingestionStarted = yield* Deferred.make<void>();
    const { observed, written } = yield* captureRootRunTermination({
      key: "pull-request-refresh:startup-error",
      shouldFinalizeRun: () => Effect.succeed(true),
      events: () =>
        Stream.unwrap(Deferred.succeed(ingestionStarted, undefined).pipe(Effect.as(Stream.never))),
      startTurn: (input) =>
        Deferred.await(ingestionStarted).pipe(
          Effect.andThen(
            Effect.fail(
              new ProviderAdapterTurnStartError({
                driver,
                threadId: input.threadId,
                providerThreadId: input.providerThread.id,
                runId: input.runId,
                cause: "provider rejected the turn",
              }),
            ),
          ),
        ),
    });
    assert.equal(observed.filter((item) => item === "pull-requests-refreshed").length, 1);
    assert.equal(observed[0], "run:failed");
    const error = written.find((item) => item.type === "error");
    assert.include(error?.failure.message ?? "", "provider could not start this turn");
  }),
);

it.effect("keeps completed runs completed when pull request refresh fails", () =>
  Effect.gen(function* () {
    const { observed } = yield* captureRootRunTermination({
      key: "pull-request-refresh:refresh-failure",
      shouldFinalizeRun: () => Effect.succeed(true),
      events: (ids) => Stream.make(rootTerminalEvent(ids, "completed")),
      refreshAfterTurn: Effect.die("refresh failed"),
    });
    assert.deepEqual(observed, ["run:waiting", "pull-requests-refreshed"]);
  }),
);

function captureRootRunTermination(input: {
  readonly key: string;
  readonly shouldFinalizeRun: () => Effect.Effect<boolean, ProjectionStore.ProjectionStoreV2Error>;
  readonly hasUnpairedRunInterruptRequest?: () => Effect.Effect<boolean, never>;
  readonly seedOpenSubagent?: boolean;
  readonly events?: (
    ids: BackgroundScenarioIds,
  ) => Stream.Stream<ProviderAdapterV2Event, ProviderAdapterV2Error>;
  readonly startTurn?: ProviderAdapterV2SessionRuntime["startTurn"];
  readonly refreshAfterTurn?: Effect.Effect<void>;
  readonly recovery?: Partial<ThreadRecoveryService.ThreadRecoveryService["Service"]>;
  readonly inspectTurn?: ProviderAdapterV2SessionRuntime["inspectTurn"];
  readonly acknowledgeTurnTerminal?: ProviderAdapterV2SessionRuntime["acknowledgeTurnTerminal"];
  readonly isShuttingDown?: ProviderAdapterV2SessionRuntime["isShuttingDown"];
  readonly providerDriver?: ProviderDriverKind;
  readonly subscribeEvents?: ProviderAdapterV2SessionRuntime["subscribeEvents"];
  readonly hasPendingBackgroundWorkForThread?: ProviderAdapterV2SessionRuntime["hasPendingBackgroundWorkForThread"];
  readonly persistedBackgroundEvents?: ReadonlyArray<ProviderAdapterV2Event>;
  readonly failRecordingEvent?: (event: ProviderAdapterV2Event) => boolean;
  readonly wrapWriteIfProviderThreadOwner?: (
    write: EventSink.EventSinkV2Shape["writeIfProviderThreadOwner"],
  ) => EventSink.EventSinkV2Shape["writeIfProviderThreadOwner"];
  readonly onIngested?: (event: ProviderAdapterV2Event) => Effect.Effect<void>;
  readonly afterIngestion?:
    | Effect.Effect<void, ThreadRecoveryService.ThreadRecoveryError>
    | ((
        persist: (events: ReadonlyArray<ProviderAdapterV2Event>) => Effect.Effect<void>,
      ) => Effect.Effect<void, ThreadRecoveryService.ThreadRecoveryError>);
}) {
  return Effect.gen(function* () {
    const ids = backgroundScenarioIds(input.key);
    const fixtureDriver = input.providerDriver ?? driver;
    const providerInstanceId = ProviderInstanceId.make(String(fixtureDriver));
    const runningSubagent = makeRunOwnedSubagentFixture({
      ids,
      providerInstanceId,
      childThreadId: ids.childThreadId,
      driver: fixtureDriver,
      status: "running",
    });
    const writtenItems = yield* Ref.make<ReadonlyArray<OrchestrationV2TurnItem>>([]);
    const writtenEvents = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
    const writtenEffects = yield* Ref.make<ReadonlyArray<PendingOrchestrationEffectV2>>([]);
    const ingested = yield* Ref.make<ReadonlyArray<ProviderAdapterV2Event>>([]);
    const durable = yield* Ref.make(input.persistedBackgroundEvents ?? []);
    const observed = yield* Ref.make<ReadonlyArray<string>>([]);
    const ingestionDone = yield* Deferred.make<void>();
    const captureTurnItem = (payload: OrchestrationV2TurnItem) =>
      Ref.update(writtenItems, (current) => [...current, payload]);
    const providerThread = makeRecoveryProviderThreadFixture(ids, input.key, {
      driver: fixtureDriver,
      providerInstanceId,
    });
    const applyCommittedEvents = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
      Ref.update(durable, (current) => [
        ...current,
        ...events.flatMap((event): ProviderAdapterV2Event[] => {
          switch (event.type) {
            case "node.updated":
              return [{ type: "node.updated", driver: fixtureDriver, node: event.payload }];
            case "subagent.updated":
              return [{ type: "subagent.updated", driver: fixtureDriver, subagent: event.payload }];
            case "turn-item.updated":
              return [
                { type: "turn_item.updated", driver: fixtureDriver, turnItem: event.payload },
              ];
            case "provider-thread.updated":
              return [
                {
                  type: "provider_thread.updated",
                  driver: fixtureDriver,
                  providerThread: event.payload,
                },
              ];
            default:
              return [];
          }
        }),
      ]);
    const captureFinalEvents = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
      Effect.gen(function* () {
        // The real sink applies projections before returning from its commit.
        // Subsequent hydration must see those rows, including interruptions.
        yield* applyCommittedEvents(events);
        yield* Ref.update(writtenEvents, (current) => [...current, ...events]);
        for (const event of events) {
          if (event.type === "turn-item.updated") {
            yield* captureTurnItem(event.payload);
          }
          if (event.type === "run.updated") {
            yield* Ref.update(observed, (current) => [...current, `run:${event.payload.status}`]);
          }
        }
      });
    const writeIfProviderThreadOwner: EventSink.EventSinkV2Shape["writeIfProviderThreadOwner"] = (
      payload,
    ) => captureFinalEvents(payload.events).pipe(Effect.as({ committed: true, storedEvents: [] }));
    const testLayer = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          input.recovery === undefined
            ? Layer.empty
            : Layer.mock(ThreadRecoveryService.ThreadRecoveryService)(input.recovery),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadRecords: (threadId) =>
              Ref.get(durable).pipe(
                Effect.map((events) => {
                  const nodes = new Map<NodeId, OrchestrationV2ExecutionNode>();
                  const subagents = new Map<NodeId, OrchestrationV2Subagent>();
                  const turnItems = new Map<TurnItemId, OrchestrationV2TurnItem>();
                  const providerThreads = new Map<ProviderThreadId, OrchestrationV2ProviderThread>([
                    [providerThread.id, providerThread],
                  ]);
                  for (const event of events) {
                    if (event.type === "node.updated" && event.node.threadId === threadId)
                      nodes.set(event.node.id, event.node);
                    if (event.type === "subagent.updated" && event.subagent.threadId === threadId)
                      subagents.set(event.subagent.id, event.subagent);
                    if (event.type === "turn_item.updated" && event.turnItem.threadId === threadId)
                      turnItems.set(event.turnItem.id, event.turnItem);
                    if (event.type === "provider_thread.updated")
                      providerThreads.set(event.providerThread.id, event.providerThread);
                  }
                  const referencedProviderThreads = new Set(
                    [...subagents.values()].map((subagent) => subagent.providerThreadId),
                  );
                  return {
                    thread: { id: threadId } as OrchestrationV2AppThread,
                    runs: [],
                    attempts: [],
                    nodes: [...nodes.values()],
                    subagents: [...subagents.values()],
                    turnItems: [...turnItems.values()],
                    providerThreads: [...providerThreads.values()].filter(
                      (thread) =>
                        thread.appThreadId === threadId ||
                        referencedProviderThreads.has(thread.id) ||
                        (thread.ownerNodeId !== null && nodes.has(thread.ownerNodeId)),
                    ),
                    providerSessions: [],
                    providerTurns: [],
                    runtimeRequests: [],
                    messages: [],
                    plans: [],
                    checkpointScopes: [],
                    checkpoints: [],
                    contextHandoffs: [],
                    contextTransfers: [],
                    visibleTurnItems: [],
                    updatedAt: providerThread.updatedAt,
                  } satisfies OrchestrationV2ThreadProjection;
                }),
              ),
          }),
          Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
          Layer.mock(EventSink.EventSinkV2)({
            write: (payload) =>
              Effect.gen(function* () {
                yield* applyCommittedEvents(payload.events);
                for (const event of payload.events) {
                  if (event.type === "turn-item.updated") {
                    yield* captureTurnItem(event.payload);
                  }
                }
                return [];
              }),
            writeWithEffects: (payload) =>
              captureFinalEvents(payload.events).pipe(
                Effect.andThen(
                  Ref.update(writtenEffects, (current) => [...current, ...payload.effects]),
                ),
                Effect.as([]),
              ),
            writeIfRunCurrent: (payload) =>
              captureFinalEvents(payload.events).pipe(
                Effect.andThen(
                  Ref.update(writtenEffects, (current) => [...current, ...(payload.effects ?? [])]),
                ),
                Effect.as({ committed: true, storedEvents: [] }),
              ),
            writeIfProviderThreadOwner:
              input.wrapWriteIfProviderThreadOwner?.(writeIfProviderThreadOwner) ??
              writeIfProviderThreadOwner,
          }),
          IdAllocator.layer,
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: (payload) =>
              Ref.update(ingested, (current) => [...current, payload.event]).pipe(
                Effect.andThen(Ref.update(durable, (current) => [...current, payload.event])),
                Effect.andThen(input.onIngested?.(payload.event) ?? Effect.void),
                Effect.andThen(
                  Effect.suspend(() =>
                    input.failRecordingEvent?.(payload.event)
                      ? Effect.die("Recording failed after persistence")
                      : Effect.succeed([]),
                  ),
                ),
              ),
            normalize: () => Effect.succeed([]),
          }),
          ServerSettings.layerTest(),
          Layer.succeed(RunFinalizationService.RunFinalizationObserver, {
            refresh: () => Effect.void,
            refreshAfterTurn: () =>
              Ref.update(observed, (current) => [...current, "pull-requests-refreshed"]).pipe(
                Effect.andThen(input.refreshAfterTurn ?? Effect.void),
              ),
          }),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      yield* runExecution.startRootRun({
        commandId: CommandId.make(`command:${input.key}`),
        appThread: { id: ids.threadId } as OrchestrationV2AppThread,
        providerSessionId: ProviderSessionId.make(`session:${input.key}`),
        session: {
          events: Stream.empty,
          ...(input.inspectTurn === undefined ? {} : { inspectTurn: input.inspectTurn }),
          ...(input.acknowledgeTurnTerminal === undefined
            ? {}
            : { acknowledgeTurnTerminal: input.acknowledgeTurnTerminal }),
          ...(input.isShuttingDown === undefined ? {} : { isShuttingDown: input.isShuttingDown }),
          ...(input.hasPendingBackgroundWorkForThread === undefined
            ? {}
            : { hasPendingBackgroundWorkForThread: input.hasPendingBackgroundWorkForThread }),
          subscribeEvents:
            input.subscribeEvents?.pipe(
              Effect.flatMap(bufferRecoveryTestSubscription),
              Effect.map((subscription) => ({
                ...subscription,
                close: subscription.close.pipe(
                  Effect.andThen(Deferred.succeed(ingestionDone, undefined)),
                ),
              })),
            ) ??
            Effect.succeed({
              events:
                input.events?.(ids) ??
                Stream.fromIterable([
                  ...(input.seedOpenSubagent
                    ? [
                        { type: "subagent.updated", driver, subagent: runningSubagent } as const,
                        {
                          type: "node.updated",
                          driver,
                          node: makeRunOwnedSubagentNodeFixture({ ids, status: "running" }),
                        } as const,
                        {
                          type: "turn_item.updated",
                          driver,
                          turnItem: makeRunOwnedSubagentTurnItemFixture({
                            ids,
                            providerInstanceId,
                            childThreadId: ids.childThreadId,
                            driver,
                            status: "running",
                          }),
                        } as const,
                      ]
                    : []),
                  rootTerminalEvent(ids, "interrupted"),
                ] satisfies ReadonlyArray<ProviderAdapterV2Event>),
              close: Deferred.succeed(ingestionDone, undefined),
            }),
          startTurn: input.startTurn ?? (() => Effect.void),
        } as unknown as ProviderAdapterV2SessionRuntime,
        run: {
          id: ids.runId,
          threadId: ids.threadId,
          ordinal: 1,
          providerInstanceId,
        } as OrchestrationV2Run,
        rootNode: {
          id: ids.rootNodeId,
          providerTurnId: ids.rootProviderTurnId,
        } as OrchestrationV2ExecutionNode,
        checkpointScope: {
          id: CheckpointScopeId.make(`checkpoint-scope:${input.key}`),
        } as OrchestrationV2CheckpointScope,
        providerThread,
        attempt: {
          id: ids.attemptId,
          providerTurnId: ids.rootProviderTurnId,
        } as OrchestrationV2RunAttempt,
        attemptId: ids.attemptId,
        providerTurnOrdinal: 1,
        shouldFinalizeRun: input.shouldFinalizeRun,
        ...(input.hasUnpairedRunInterruptRequest === undefined
          ? {}
          : {
              hasUnpairedRunInterruptRequest: input.hasUnpairedRunInterruptRequest,
            }),
        message: {
          messageId: MessageId.make(`message:${input.key}`),
          text: "interrupt projection",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "readOnly",
            access: { type: "fullAccess" },
            networkAccess: false,
          },
        },
      });
    }).pipe(Effect.provide(testLayer));

    yield* Deferred.await(ingestionDone);
    yield* typeof input.afterIngestion === "function"
      ? input.afterIngestion((events) => Ref.update(durable, (current) => [...current, ...events]))
      : (input.afterIngestion ?? Effect.void);
    return {
      written: yield* Ref.get(writtenItems),
      events: yield* Ref.get(writtenEvents),
      effects: yield* Ref.get(writtenEffects),
      ingested: yield* Ref.get(ingested),
      durable: yield* Ref.get(durable),
      observed: yield* Ref.get(observed),
    };
  });
}

// The fixture's adapter stream feeds a manager-style queue. The replacement
// reader must consume all earlier events before acknowledging its marker.
function bufferRecoveryTestSubscription(subscription: ProviderAdapterV2EventSubscription) {
  if (subscription.requestDrain !== undefined) return Effect.succeed(subscription);
  return Effect.gen(function* () {
    type Signal =
      | { readonly event: ProviderAdapterV2Event }
      | { readonly cause: Cause.Cause<ProviderAdapterV2Error> };
    const queue = yield* Queue.unbounded<Signal, Cause.Done>();
    const producer = yield* subscription.events.pipe(
      Stream.runForEach((event) => Queue.offer(queue, { event })),
      Effect.catchCause((cause) => Queue.offer(queue, { cause })),
      Effect.andThen(Queue.end(queue)),
      Effect.forkDetach,
    );
    return {
      events: Stream.fromQueue(queue).pipe(
        Stream.mapEffect((signal) =>
          "event" in signal ? Effect.succeed(signal.event) : Effect.failCause(signal.cause),
        ),
      ),
      close: Fiber.interrupt(producer).pipe(
        Effect.andThen(Queue.end(queue)),
        Effect.andThen(subscription.close),
        Effect.asVoid,
      ),
      requestDrain: (barrier) =>
        Effect.gen(function* () {
          const observation = yield* barrier.observe;
          yield* Queue.offer(queue, {
            event: { type: "events.barrier", driver, after: barrier.after(observation) },
          });
        }),
    } satisfies ProviderAdapterV2EventSubscription;
  });
}

interface BackgroundScenarioIds {
  readonly threadId: ThreadId;
  readonly childThreadId: ThreadId;
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
  readonly providerThreadId: ProviderThreadId;
  readonly rootProviderTurnId: ProviderTurnId;
  readonly rootNodeId: NodeId;
  readonly itemId: TurnItemId;
  readonly childItemId: TurnItemId;
  readonly subagentNodeId: NodeId;
}

function backgroundScenarioIds(key: string): BackgroundScenarioIds {
  return {
    threadId: ThreadId.make(`thread:${key}`),
    childThreadId: ThreadId.make(`thread:${key}:child`),
    runId: RunId.make(`run:${key}`),
    attemptId: RunAttemptId.make(`attempt:${key}`),
    providerThreadId: ProviderThreadId.make(`provider-thread:${key}`),
    rootProviderTurnId: ProviderTurnId.make(`provider-turn:${key}`),
    rootNodeId: NodeId.make(`node:${key}`),
    itemId: TurnItemId.make(`turn-item:${key}`),
    childItemId: TurnItemId.make(`turn-item:${key}:child`),
    subagentNodeId: NodeId.make(`node:${key}:subagent`),
  };
}

function makeRecoveryProviderThreadFixture(
  ids: BackgroundScenarioIds,
  key: string,
  overrides: Partial<OrchestrationV2ProviderThread> = {},
): OrchestrationV2ProviderThread {
  const now = DateTime.makeUnsafe("2026-07-21T12:00:00.000Z");
  const fixtureDriver = overrides.driver ?? driver;
  return {
    id: ids.providerThreadId,
    driver,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: ProviderSessionId.make(`session:${key}`),
    appThreadId: ids.threadId,
    ownerNodeId: null,
    nativeThreadRef: {
      driver: fixtureDriver,
      nativeId: `native-thread:${key}`,
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function childThreadCreatedEvent(ids: BackgroundScenarioIds): ProviderAdapterV2Event {
  return {
    type: "app_thread.created",
    driver,
    appThread: {
      id: ids.childThreadId,
      lineage: {
        parentThreadId: ids.threadId,
        relationshipToParent: "subagent",
        rootThreadId: ids.threadId,
      },
    },
  } as ProviderAdapterV2Event;
}

function childBackgroundTurnItemEvent(
  ids: BackgroundScenarioIds,
  status: "running" | "completed" | "idle",
  ordinal: number,
): ProviderAdapterV2Event {
  return {
    type: "turn_item.updated",
    driver,
    turnItem: {
      id: ids.childItemId,
      threadId: ids.childThreadId,
      runId: null,
      providerTurnId: null,
      ordinal,
      type: "command_execution",
      status,
    },
  } as ProviderAdapterV2Event;
}

function backgroundTurnItemEvent(
  ids: BackgroundScenarioIds,
  type: "command_execution" | "dynamic_tool" | "subagent",
  status: "running" | "completed" | "idle",
  ordinal: number,
  itemId?: TurnItemId,
): ProviderAdapterV2Event {
  return {
    type: "turn_item.updated",
    driver,
    turnItem: {
      id: itemId ?? ids.itemId,
      threadId: ids.threadId,
      runId: ids.runId,
      providerTurnId: ids.rootProviderTurnId,
      ordinal,
      type,
      status,
    },
  } as ProviderAdapterV2Event;
}

function backgroundTurnItemEventForRun(
  ids: BackgroundScenarioIds,
  runId: RunId,
  type: "command_execution" | "dynamic_tool" | "subagent",
  status: "running" | "completed" | "idle",
  ordinal: number,
): ProviderAdapterV2Event {
  const event = backgroundTurnItemEvent(ids, type, status, ordinal);
  if (event.type !== "turn_item.updated") {
    return event;
  }
  return { ...event, turnItem: { ...event.turnItem, runId } };
}

function subagentEvent(
  ids: BackgroundScenarioIds,
  status: "running" | "completed" | "idle",
): ProviderAdapterV2Event {
  return {
    type: "subagent.updated",
    driver,
    subagent: {
      id: ids.subagentNodeId,
      threadId: ids.threadId,
      runId: ids.runId,
      status,
    },
  } as ProviderAdapterV2Event;
}

function makeRunOwnedSubagentFixture(input: {
  readonly ids: BackgroundScenarioIds;
  readonly providerInstanceId: ProviderInstanceId;
  readonly childThreadId: ThreadId;
  readonly driver: typeof driver;
  readonly status: "running" | "interrupted";
}): OrchestrationV2Subagent {
  const now = DateTime.makeUnsafe("2026-07-21T12:00:00.000Z");
  return {
    id: input.ids.subagentNodeId,
    threadId: input.ids.threadId,
    runId: input.ids.runId,
    parentNodeId: input.ids.rootNodeId,
    origin: "provider_native",
    createdBy: "agent",
    driver: input.driver,
    providerInstanceId: input.providerInstanceId,
    providerThreadId: null,
    childThreadId: input.childThreadId,
    nativeTaskRef: {
      driver: input.driver,
      nativeId: `task:${input.ids.subagentNodeId}`,
      strength: "strong",
    },
    prompt: "hold",
    title: "Live-test subagent hold",
    model: null,
    status: input.status,
    result: null,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
  };
}

function makeRunOwnedSubagentTurnItemFixture(input: {
  readonly ids: BackgroundScenarioIds;
  readonly providerInstanceId: ProviderInstanceId;
  readonly childThreadId: ThreadId;
  readonly driver: typeof driver;
  readonly status: "running" | "interrupted";
}): Extract<OrchestrationV2TurnItem, { type: "subagent" }> {
  const now = DateTime.makeUnsafe("2026-07-21T12:00:00.000Z");
  return {
    id: input.ids.itemId,
    threadId: input.ids.threadId,
    runId: input.ids.runId,
    nodeId: input.ids.subagentNodeId,
    providerThreadId: input.ids.providerThreadId,
    providerTurnId: input.ids.rootProviderTurnId,
    nativeItemRef: {
      driver: input.driver,
      nativeId: `task:${input.ids.subagentNodeId}`,
      strength: "strong",
    },
    parentItemId: null,
    ordinal: 3,
    status: input.status,
    title: "Live-test subagent hold",
    startedAt: now,
    completedAt: null,
    updatedAt: now,
    type: "subagent",
    subagentId: input.ids.subagentNodeId,
    origin: "provider_native",
    driver: input.driver,
    providerInstanceId: input.providerInstanceId,
    childThreadId: input.childThreadId,
    prompt: "hold",
    result: null,
  };
}

function makeLinkedChildTurnItemFixture(input: {
  readonly ids: BackgroundScenarioIds;
  readonly driver: typeof driver;
  readonly type: "assistant_message" | "command_execution" | "reasoning";
}): OrchestrationV2TurnItem {
  const now = DateTime.makeUnsafe("2026-07-21T12:00:00.000Z");
  const base = {
    id: input.ids.childItemId,
    threadId: input.ids.childThreadId,
    runId: null,
    nodeId: NodeId.make(`${input.ids.subagentNodeId}:child-root`),
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "running" as const,
    title: "Working",
    startedAt: now,
    completedAt: null,
    updatedAt: now,
  };
  if (input.type === "assistant_message") {
    return {
      ...base,
      type: "assistant_message",
      messageId: MessageId.make(`${input.ids.childItemId}:message`),
      text: "partial response",
      streaming: true,
    };
  }
  if (input.type === "reasoning") {
    return {
      ...base,
      type: "reasoning",
      text: "partial progress",
      streaming: true,
    };
  }
  return {
    ...base,
    type: "command_execution",
    input: "sleep 300",
  };
}

function makeRunOwnedSubagentNodeFixture(input: {
  readonly ids: BackgroundScenarioIds;
  readonly status: "running" | "interrupted";
}): OrchestrationV2ExecutionNode {
  const now = DateTime.makeUnsafe("2026-07-21T12:00:00.000Z");
  return {
    id: input.ids.subagentNodeId,
    threadId: input.ids.threadId,
    runId: input.ids.runId,
    parentNodeId: input.ids.rootNodeId,
    rootNodeId: input.ids.rootNodeId,
    kind: "subagent",
    status: input.status,
    countsForRun: false,
    providerThreadId: input.ids.providerThreadId,
    providerTurnId: input.ids.rootProviderTurnId,
    nativeItemRef: {
      driver,
      nativeId: `task:${input.ids.subagentNodeId}`,
      strength: "strong",
    },
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: now,
    completedAt: null,
  };
}

function makeRunOwnedSubagentChildNodeFixture(input: {
  readonly ids: BackgroundScenarioIds;
  readonly status: "running" | "interrupted";
}): OrchestrationV2ExecutionNode {
  const now = DateTime.makeUnsafe("2026-07-21T12:00:00.000Z");
  return {
    id: NodeId.make(`${input.ids.subagentNodeId}:child-root`),
    threadId: input.ids.childThreadId,
    runId: null,
    parentNodeId: null,
    rootNodeId: NodeId.make(`${input.ids.subagentNodeId}:child-root`),
    kind: "root_turn",
    status: input.status,
    countsForRun: false,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: now,
    completedAt: null,
  };
}

function rootTerminalEvent(
  ids: BackgroundScenarioIds,
  status: "completed" | "interrupted" | "cancelled" | "failed",
): Extract<ProviderAdapterV2Event, { type: "turn.terminal" }> {
  const common = {
    type: "turn.terminal" as const,
    driver,
    providerThreadId: ids.providerThreadId,
    providerTurnId: ids.rootProviderTurnId,
    runOrdinal: 1,
    threadDisposition: "reusable" as const,
  };
  return status === "failed"
    ? {
        ...common,
        status,
        failureItemOrdinal: 101,
        failure: {
          class: "provider_error",
          message: "Provider failed",
          code: null,
          retryable: null,
        },
      }
    : { ...common, status, failure: null };
}

function runBackgroundItemScenario(
  key: string,
  makeEvents: (ids: BackgroundScenarioIds) => ReadonlyArray<ProviderAdapterV2Event>,
  options?: {
    readonly keepEventStreamOpen?: boolean;
    readonly loadInheritedBackgroundTurnItems?: () => Effect.Effect<
      ReadonlyArray<{ readonly id: TurnItemId; readonly runId: RunId }>
    >;
    readonly onSubscribe?: Effect.Effect<void>;
  },
) {
  return Effect.gen(function* () {
    const ids = backgroundScenarioIds(key);
    const providerInstanceId = ProviderInstanceId.make("codex");
    const observed = yield* Ref.make<ReadonlyArray<string>>([]);
    const ingestionDone = yield* Deferred.make<void>();
    const testLayer = RunExecutionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
          Layer.mock(CheckpointService.CheckpointServiceV2)({ captureBaseline: () => Effect.void }),
          Layer.mock(EventSink.EventSinkV2)({
            write: () => Effect.succeed([]),
            writeWithEffects: (input) =>
              Effect.gen(function* () {
                if (
                  input.events.some(
                    (event) => event.type === "run.updated" && event.runId === ids.runId,
                  )
                ) {
                  yield* Ref.update(observed, (current) => [...current, "root-finalized"]);
                }
                return [];
              }),
            writeIfRunCurrent: () => Effect.succeed({ committed: true, storedEvents: [] }),
          }),
          IdAllocator.layer,
          Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
            ingestNormalized: (input) =>
              Effect.gen(function* () {
                const event = input.event;
                if (event.type === "turn_item.updated") {
                  yield* Ref.update(observed, (current) => [
                    ...current,
                    `turn_item:${event.turnItem.status}`,
                  ]);
                }
                if (event.type === "subagent.updated") {
                  yield* Ref.update(observed, (current) => [
                    ...current,
                    `subagent:${event.subagent.status}`,
                  ]);
                }
                return [];
              }),
          }),
          ServerSettings.layerTest(),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
      yield* runExecution.startRootRun({
        commandId: CommandId.make(`command:${key}`),
        appThread: { id: ids.threadId } as OrchestrationV2AppThread,
        providerSessionId: ProviderSessionId.make(`session:${key}`),
        session: {
          events: Stream.empty,
          subscribeEvents: Effect.gen(function* () {
            yield* options?.onSubscribe ?? Effect.void;
            const events = Stream.fromIterable(makeEvents(ids));
            return {
              events:
                options?.keepEventStreamOpen === true
                  ? events.pipe(Stream.concat(Stream.never))
                  : events,
              close: Deferred.succeed(ingestionDone, undefined),
            };
          }),
          startTurn: () => Effect.void,
        } as unknown as ProviderAdapterV2SessionRuntime,
        run: {
          id: ids.runId,
          threadId: ids.threadId,
          ordinal: 1,
          providerInstanceId,
        } as OrchestrationV2Run,
        rootNode: { id: ids.rootNodeId } as OrchestrationV2ExecutionNode,
        checkpointScope: {
          id: CheckpointScopeId.make(`checkpoint-scope:${key}`),
        } as OrchestrationV2CheckpointScope,
        providerThread: {
          id: ids.providerThreadId,
          driver,
        } as OrchestrationV2ProviderThread,
        attempt: {
          id: ids.attemptId,
          providerTurnId: ids.rootProviderTurnId,
        } as OrchestrationV2RunAttempt,
        attemptId: ids.attemptId,
        ...(options?.loadInheritedBackgroundTurnItems === undefined
          ? {}
          : {
              loadInheritedBackgroundTurnItems: options.loadInheritedBackgroundTurnItems,
            }),
        providerTurnOrdinal: 1,
        message: {
          messageId: MessageId.make(`message:${key}:user`),
          text: "Start a background item and finish.",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "readOnly",
            access: { type: "fullAccess" },
            networkAccess: false,
          },
        },
      });
    }).pipe(Effect.provide(testLayer));

    const closed = yield* Deferred.await(ingestionDone).pipe(Effect.timeoutOption("2 seconds"));
    assert.isTrue(Option.isSome(closed), "event ingestion fiber did not finish");
    return yield* Ref.get(observed);
  });
}

it.effect("releases ingestion after idle subagent rows and items settle", () =>
  Effect.gen(function* () {
    const observed = yield* runBackgroundItemScenario(
      "subagent-idle",
      (ids) => [
        subagentEvent(ids, "running"),
        backgroundTurnItemEvent(ids, "subagent", "running", 1),
        subagentEvent(ids, "idle"),
        backgroundTurnItemEvent(ids, "subagent", "idle", 2),
        rootTerminalEvent(ids, "completed"),
      ],
      { keepEventStreamOpen: true },
    );
    assert.deepEqual(observed, [
      "subagent:running",
      "turn_item:running",
      "subagent:idle",
      "turn_item:idle",
      "root-finalized",
    ]);
  }),
);

it.effect(
  "retains a failed event consumer for confirmed-terminal recovery without starting another turn",
  () =>
    Effect.gen(function* () {
      let registration:
        | Parameters<ThreadRecoveryService.ThreadRecoveryService["Service"]["register"]>[0]
        | undefined;
      let starts = 0;
      let suspected = false;
      const ids = backgroundScenarioIds("recover-consumer");
      const terminal = rootTerminalEvent(ids, "completed");
      const result = yield* captureRootRunTermination({
        key: "recover-consumer",
        shouldFinalizeRun: () => Effect.succeed(true),
        events: () =>
          Stream.fail(
            new ProviderAdapterEventStreamError({
              driver,
              providerSessionId: ProviderSessionId.make("session:recover-consumer"),
              cause: "Recording stream failed",
            }),
          ),
        startTurn: () =>
          Effect.sync(() => {
            starts++;
          }),
        inspectTurn: () => Effect.succeed({ status: "terminal", event: terminal }),
        recovery: {
          register: (value) =>
            Effect.sync(() => {
              registration = value;
            }),
          suspect: () =>
            Effect.sync(() => {
              suspected = true;
            }),
          completed: () => Effect.void,
        },
        afterIngestion: Effect.gen(function* () {
          assert.isTrue(suspected);
          assert.isDefined(registration);
          const inspection = yield* registration!.inspect;
          assert.equal(inspection.status, "terminal");
          if (inspection.status === "terminal")
            yield* registration!.finalize(
              inspection.event,
              [
                {
                  id: EventId.make("recovery:receipt"),
                  type: "thread.metadata-updated",
                  threadId: ids.threadId,
                  occurredAt: yield* DateTime.now,
                  payload: { id: ids.threadId } as OrchestrationV2AppThread,
                },
              ],
              { runtimeReleased: false },
            );
        }),
      });
      assert.equal(starts, 1);
      assert.include(result.observed, "run:waiting");
    }),
);

it.effect("retains terminal evidence until failed finalization is durably recovered", () =>
  Effect.gen(function* () {
    let registration:
      | Parameters<ThreadRecoveryService.ThreadRecoveryService["Service"]["register"]>[0]
      | undefined;
    const ids = backgroundScenarioIds("recover-terminal-ack");
    const terminal = rootTerminalEvent(ids, "completed");
    let retained = true;
    let committed = false;
    let finalizationAttempts = 0;
    let starts = 0;
    const inspectTurn = () =>
      Effect.sync(() =>
        retained
          ? { status: "terminal" as const, event: terminal }
          : { status: "unknown" as const },
      );
    const result = yield* captureRootRunTermination({
      key: "recover-terminal-ack",
      shouldFinalizeRun: () =>
        Effect.suspend(() => {
          finalizationAttempts++;
          return finalizationAttempts === 1
            ? Effect.die("Finalization database read failed")
            : Effect.succeed(true);
        }),
      events: () => Stream.make(terminal),
      startTurn: () =>
        Effect.sync(() => {
          starts++;
        }),
      inspectTurn,
      acknowledgeTurnTerminal: (input) =>
        Effect.sync(() => {
          assert.isTrue(committed);
          if (
            input.providerThreadId === terminal.providerThreadId &&
            input.providerTurnId === terminal.providerTurnId
          )
            retained = false;
        }),
      refreshAfterTurn: Effect.sync(() => {
        committed = true;
      }),
      recovery: {
        register: (value) =>
          Effect.sync(() => {
            registration = value;
          }),
        suspect: () => Effect.void,
        completed: () => Effect.void,
      },
      afterIngestion: Effect.gen(function* () {
        assert.isFalse(committed);
        assert.isDefined(registration);
        const inspection = yield* registration!.inspect;
        assert.deepEqual(inspection, { status: "terminal", event: terminal });
        if (inspection.status !== "terminal") return yield* Effect.die("Missing terminal evidence");
        yield* registration!.finalize(inspection.event, [], { runtimeReleased: false });
        assert.deepEqual(yield* inspectTurn(), { status: "unknown" });
      }),
    });
    assert.equal(starts, 1);
    assert.equal(finalizationAttempts, 2);
    assert.deepEqual(
      result.observed.filter((event) => event.startsWith("run:")),
      ["run:waiting"],
    );
    assert.equal(result.events.filter((event) => event.type === "run-attempt.updated").length, 1);
  }),
);

it.effect("does not mark a finalized root suspect when its retained background reader fails", () =>
  Effect.gen(function* () {
    let suspected = 0;
    let completed = 0;
    const result = yield* captureRootRunTermination({
      key: "recover-post-terminal",
      shouldFinalizeRun: () => Effect.succeed(true),
      events: (ids) =>
        Stream.fromIterable([
          backgroundTurnItemEvent(ids, "command_execution", "running", 1),
          rootTerminalEvent(ids, "completed"),
        ]).pipe(
          Stream.concat(
            Stream.fail(
              new ProviderAdapterEventStreamError({
                driver,
                providerSessionId: ProviderSessionId.make("session:recover-post-terminal"),
                cause: "Background stream failed",
              }),
            ),
          ),
        ),
      inspectTurn: () => Effect.succeed({ status: "unknown" }),
      recovery: {
        register: () => Effect.void,
        suspect: () =>
          Effect.sync(() => {
            suspected++;
          }),
        completed: () =>
          Effect.sync(() => {
            completed++;
          }),
      },
    });
    assert.equal(completed, 1);
    assert.equal(suspected, 0);
    assert.deepEqual(
      result.observed.filter((event) => event.startsWith("run:")),
      ["run:waiting"],
    );
  }),
);

it.effect.each([
  {
    runtimeReleased: false,
    name: "settles lost background outcomes when the exact thread probe confirms its drain",
  },
  {
    runtimeReleased: true,
    name: "settles lost background outcomes atomically when recovery confirms runtime release",
  },
])("$name", ({ runtimeReleased }) =>
  Effect.gen(function* () {
    const key = `recover-background-drained:${runtimeReleased}`;
    const ids = backgroundScenarioIds(key);
    const providerInstanceId = ProviderInstanceId.make("codex");
    const completedItemId = TurnItemId.make(`${ids.itemId}:completed-history`);
    const dynamicItemId = TurnItemId.make(`${ids.itemId}:dynamic`);
    const subagentItemIds = { ...ids, itemId: TurnItemId.make(`${ids.itemId}:subagent`) };
    const receipt: OrchestrationV2DomainEvent = {
      id: EventId.make(`${key}:receipt`),
      type: "thread.metadata-updated",
      threadId: ids.threadId,
      occurredAt: yield* DateTime.now,
      payload: { id: ids.threadId } as OrchestrationV2AppThread,
    };
    let registration:
      | Parameters<ThreadRecoveryService.ThreadRecoveryService["Service"]["register"]>[0]
      | undefined;
    let subscriptions = 0;
    let starts = 0;
    const resumedClosed = yield* Deferred.make<void>();
    const result = yield* captureRootRunTermination({
      key,
      shouldFinalizeRun: () => Effect.succeed(true),
      // This row committed before the consumer's lifecycle tracker failed.
      persistedBackgroundEvents: [
        backgroundTurnItemEvent(ids, "dynamic_tool", "running", 3, dynamicItemId),
      ],
      subscribeEvents: Effect.sync(() => {
        subscriptions++;
        return {
          events:
            subscriptions === 1
              ? Stream.fromIterable([
                  childThreadCreatedEvent(ids),
                  backgroundTurnItemEvent(
                    ids,
                    "command_execution",
                    "completed",
                    1,
                    completedItemId,
                  ),
                  backgroundTurnItemEvent(ids, "command_execution", "running", 2),
                  {
                    type: "subagent.updated",
                    driver,
                    subagent: makeRunOwnedSubagentFixture({
                      ids,
                      providerInstanceId,
                      childThreadId: ids.childThreadId,
                      driver,
                      status: "running",
                    }),
                  },
                  {
                    type: "turn_item.updated",
                    driver,
                    turnItem: makeRunOwnedSubagentTurnItemFixture({
                      ids: subagentItemIds,
                      providerInstanceId,
                      childThreadId: ids.childThreadId,
                      driver,
                      status: "running",
                    }),
                  },
                  {
                    type: "node.updated",
                    driver,
                    node: makeRunOwnedSubagentChildNodeFixture({ ids, status: "running" }),
                  },
                  {
                    type: "turn_item.updated",
                    driver,
                    turnItem: makeLinkedChildTurnItemFixture({
                      ids,
                      driver,
                      type: "command_execution",
                    }),
                  },
                  backgroundTurnItemEventForRun(
                    ids,
                    RunId.make(`${key}:sibling`),
                    "command_execution",
                    "running",
                    4,
                  ),
                ] satisfies ReadonlyArray<ProviderAdapterV2Event>).pipe(
                  Stream.concat(
                    Stream.fail(
                      new ProviderAdapterEventStreamError({
                        driver,
                        providerSessionId: ProviderSessionId.make(`session:${key}`),
                        cause: "Consumer stopped before recording the root terminal",
                      }),
                    ),
                  ),
                )
              : Stream.never,
          close: subscriptions === 1 ? Effect.void : Deferred.succeed(resumedClosed, undefined),
        };
      }),
      hasPendingBackgroundWorkForThread: () => Effect.succeed(runtimeReleased),
      inspectTurn: () =>
        Effect.succeed({ status: "terminal", event: rootTerminalEvent(ids, "completed") }),
      startTurn: () =>
        Effect.sync(() => {
          starts++;
        }),
      recovery: {
        register: (value) =>
          Effect.sync(() => {
            registration = value;
          }),
        suspect: () => Effect.void,
        completed: () => Effect.void,
      },
      afterIngestion: Effect.gen(function* () {
        assert.isDefined(registration);
        yield* registration!.finalize(rootTerminalEvent(ids, "completed"), [receipt], {
          runtimeReleased,
        });
        if (!runtimeReleased) yield* Deferred.await(resumedClosed);
      }),
    });
    assert.equal(starts, 1);
    assert.equal(subscriptions, runtimeReleased ? 1 : 2);
    assert.deepEqual(
      result.written.map((item) => [item.id, item.status]).sort(),
      [
        [ids.itemId, "interrupted"],
        [dynamicItemId, "interrupted"],
        [subagentItemIds.itemId, "interrupted"],
        [ids.childItemId, "interrupted"],
      ].sort(),
    );
    assert.isFalse(result.written.some((item) => item.id === completedItemId));
    assert.equal(result.events.filter((event) => event.id === receipt.id).length, 1);
    assert.deepEqual(
      result.observed.filter((value) => value.startsWith("run:")),
      ["run:waiting"],
    );
    assert.equal(result.effects.length, 1);
    assert.equal(result.effects[0]?.request.type, "checkpoint.capture");
    assert.isTrue(
      result.events.some(
        (event) =>
          event.type === "provider-thread.updated" &&
          event.payload.id === ids.providerThreadId &&
          event.payload.pendingBackgroundTasks?.length === 0,
      ),
    );
    assert.isTrue(
      result.events.some(
        (event) =>
          event.type === "node.updated" &&
          event.payload.threadId === ids.childThreadId &&
          event.payload.status === "interrupted",
      ),
    );
  }),
);

it.effect.each([
  {
    drainOutcome: "completed",
    name: "reattaches recovery ingestion until live background work reports its real completion",
  },
  {
    drainOutcome: "completion_lost",
    name: "heals a lost completion when the recovered reader observes the exact background drain",
  },
  {
    drainOutcome: "runtime_released",
    name: "settles recovered background rows when the reattached runtime later exits",
  },
  {
    drainOutcome: "recording_failed",
    name: "retains the recovered reader after recording fails and preserves its saved completion",
  },
] as const)("$name", ({ drainOutcome }) =>
  Effect.gen(function* () {
    const completionWasLost =
      drainOutcome === "completion_lost" || drainOutcome === "runtime_released";
    const key = `recover-background-live:${drainOutcome}`;
    const ids = backgroundScenarioIds(key);
    const pending = yield* Ref.make(true);
    const allowCompletion = yield* Deferred.make<void>();
    const resumed = yield* Deferred.make<void>();
    const closed = yield* Deferred.make<void>();
    let registration:
      | Parameters<ThreadRecoveryService.ThreadRecoveryService["Service"]["register"]>[0]
      | undefined;
    let subscriptions = 0;
    let runtimeReleased = false;
    const result = yield* captureRootRunTermination({
      key,
      shouldFinalizeRun: () => Effect.succeed(true),
      failRecordingEvent: (event) =>
        drainOutcome === "recording_failed" &&
        event.type === "turn_item.updated" &&
        event.turnItem.status === "completed",
      subscribeEvents: Effect.gen(function* () {
        subscriptions++;
        if (subscriptions === 1) {
          return {
            events: Stream.make(
              backgroundTurnItemEvent(ids, "command_execution", "running", 1),
            ).pipe(
              Stream.concat(
                Stream.fail(
                  new ProviderAdapterEventStreamError({
                    driver,
                    providerSessionId: ProviderSessionId.make(`session:${key}`),
                    cause: "Original reader failed",
                  }),
                ),
              ),
            ),
            close: Effect.void,
          };
        }
        yield* Deferred.succeed(resumed, undefined);
        if (drainOutcome === "runtime_released") {
          return {
            events: Stream.fromEffect(
              Deferred.await(allowCompletion).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    runtimeReleased = true;
                  }),
                ),
              ),
            ).pipe(
              Stream.flatMap(() =>
                Stream.fail(
                  new ProviderAdapterEventStreamError({
                    driver,
                    providerSessionId: ProviderSessionId.make(`session:${key}`),
                    cause: "Reattached provider exited",
                  }),
                ),
              ),
            ),
            close: Deferred.succeed(closed, undefined),
          };
        }
        return {
          events: Stream.fromEffect(Deferred.await(allowCompletion)).pipe(
            Stream.flatMap(() =>
              completionWasLost
                ? Stream.empty
                : Stream.make(backgroundTurnItemEvent(ids, "command_execution", "completed", 2)),
            ),
            Stream.concat(
              Stream.fromEffect(
                Ref.set(pending, false).pipe(
                  Effect.as({
                    type: "provider_thread.updated",
                    driver,
                    providerThread: makeRecoveryProviderThreadFixture(ids, key),
                  } satisfies ProviderAdapterV2Event),
                ),
              ),
            ),
            Stream.concat(Stream.never),
          ),
          close: Deferred.succeed(closed, undefined),
        };
      }),
      hasPendingBackgroundWorkForThread: () => Ref.get(pending),
      inspectTurn: () =>
        Effect.sync(() => ({
          status: "terminal" as const,
          event: rootTerminalEvent(ids, "completed"),
          ...(runtimeReleased ? { runtimeReleased: true as const } : {}),
        })),
      recovery: {
        register: (value) =>
          Effect.sync(() => {
            registration = value;
          }),
        suspect: () => Effect.void,
        completed: () => Effect.void,
      },
      afterIngestion: Effect.gen(function* () {
        yield* registration!.finalize(rootTerminalEvent(ids, "completed"), [], {
          runtimeReleased: false,
        });
        yield* Deferred.await(resumed);
        assert.isFalse(yield* Deferred.isDone(closed));
        yield* Deferred.succeed(allowCompletion, undefined);
        yield* Deferred.await(closed);
      }),
    });
    assert.equal(subscriptions, 2);
    assert.deepEqual(
      result.observed.filter((value) => value.startsWith("run:")),
      ["run:waiting"],
    );
    assert.deepEqual(
      result.written.map((item) => item.status),
      completionWasLost ? ["interrupted"] : [],
    );
    assert.equal(
      result.ingested.filter(
        (event) => event.type === "turn_item.updated" && event.turnItem.status === "completed",
      ).length,
      completionWasLost ? 0 : 1,
    );
  }),
);

it.effect.each(["node_first", "queued_before_reader", "after_pending_marker"] as const)(
  "preserves queued command and tool completions during recovery (%s)",
  (timing) =>
    Effect.gen(function* () {
      const key = `recover-native-order:${timing}`;
      const ids = backgroundScenarioIds(key);
      const toolId = TurnItemId.make(`${ids.itemId}:tool`);
      const pending = yield* Ref.make(true);
      const publication = yield* Semaphore.make(1);
      const queue = yield* Queue.unbounded<ProviderAdapterV2Event, Cause.Done>();
      const markerQueued = yield* Deferred.make<void>();
      const allowMarker = yield* Deferred.make<void>();
      const closed = yield* Deferred.make<void>();
      let firstMarker = true;
      let subscriptions = 0;
      let registration:
        | Parameters<ThreadRecoveryService.ThreadRecoveryService["Service"]["register"]>[0]
        | undefined;
      const complete = publication.withPermits(1)(
        Effect.gen(function* () {
          // Codex clears its native tracker before its node/item publications.
          yield* Ref.set(pending, false);
          yield* Queue.offer(queue, {
            type: "node.updated",
            driver,
            node: {
              id: NodeId.make(`${key}:command`),
              threadId: ids.threadId,
              runId: ids.runId,
              providerThreadId: ids.providerThreadId,
              status: "completed",
            } as OrchestrationV2ExecutionNode,
          });
          for (const [type, id] of [
            ["command_execution", ids.itemId],
            ["dynamic_tool", toolId],
          ] as const) {
            const event = backgroundTurnItemEvent(ids, type, "completed", 2, id);
            assert.equal(event.type, "turn_item.updated");
            if (
              event.type !== "turn_item.updated" ||
              (event.turnItem.type !== "command_execution" &&
                event.turnItem.type !== "dynamic_tool")
            )
              return;
            yield* Queue.offer(queue, {
              ...event,
              turnItem: {
                ...event.turnItem,
                output: `${type} real output`,
                ...(event.turnItem.type === "command_execution" ? { exitCode: 0 } : {}),
              },
            });
          }
        }),
      );
      const result = yield* captureRootRunTermination({
        key,
        shouldFinalizeRun: () => Effect.succeed(true),
        subscribeEvents: Effect.gen(function* () {
          subscriptions++;
          if (subscriptions === 1)
            return {
              events: Stream.make(
                backgroundTurnItemEvent(ids, "command_execution", "running", 1),
                backgroundTurnItemEvent(ids, "dynamic_tool", "running", 1, toolId),
              ).pipe(
                Stream.concat(
                  Stream.fail(
                    new ProviderAdapterEventStreamError({
                      driver,
                      providerSessionId: ProviderSessionId.make(`session:${key}`),
                      cause: "Reader stopped",
                    }),
                  ),
                ),
              ),
              close: Effect.void,
            };
          if (timing === "queued_before_reader") yield* complete;
          return {
            events: Stream.fromQueue(queue),
            close: Queue.end(queue).pipe(
              Effect.andThen(Deferred.succeed(closed, undefined)),
              Effect.asVoid,
            ),
            requestDrain: (barrier) =>
              publication.withPermits(1)(
                Effect.gen(function* () {
                  const captured = yield* barrier.observe;
                  const hold = firstMarker && timing === "after_pending_marker";
                  firstMarker = false;
                  yield* Queue.offer(queue, {
                    type: "events.barrier",
                    driver,
                    after: (hold ? Deferred.await(allowMarker) : Effect.void).pipe(
                      Effect.andThen(barrier.after(captured)),
                    ),
                  });
                  yield* Deferred.succeed(markerQueued, undefined);
                }),
              ),
          } satisfies ProviderAdapterV2EventSubscription;
        }),
        hasPendingBackgroundWorkForThread: () => Ref.get(pending),
        inspectTurn: () =>
          Effect.succeed({ status: "terminal", event: rootTerminalEvent(ids, "completed") }),
        recovery: {
          register: (value) =>
            Effect.sync(() => {
              registration = value;
            }),
          suspect: () => Effect.void,
          completed: () => Effect.void,
        },
        afterIngestion: Effect.gen(function* () {
          yield* registration!.finalize(rootTerminalEvent(ids, "completed"), [], {
            runtimeReleased: false,
          });
          if (timing !== "queued_before_reader") {
            yield* Deferred.await(markerQueued);
            assert.isFalse(yield* Deferred.isDone(closed));
            yield* complete;
            yield* Deferred.succeed(allowMarker, undefined);
          }
          yield* Deferred.await(closed);
        }),
      });
      assert.isEmpty(result.written);
      const completions = result.ingested.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.status === "completed"
          ? [event.turnItem]
          : [],
      );
      assert.deepEqual(
        completions.map((item) => item.id),
        [ids.itemId, toolId],
      );
      assert.deepEqual(
        completions.map((item) =>
          item.type === "command_execution" || item.type === "dynamic_tool" ? item.output : null,
        ),
        ["command_execution real output", "dynamic_tool real output"],
      );
      assert.equal(
        completions[0]?.type === "command_execution" ? completions[0].exitCode : null,
        0,
      );
    }),
);

it.effect.each([
  ...(["failed", "interrupted", "cancelled"] as const).flatMap((status) => [
    { status, outcome: "completion_lost" as const },
    { status, outcome: "queued_completions" as const },
    { status, outcome: "unknown_probe" as const },
  ]),
  { status: "failed" as const, outcome: "settlement_retry" as const },
  { status: "failed" as const, outcome: "settlement_owner_lost" as const },
  { status: "failed" as const, outcome: "settlement_shutdown" as const },
])("drains retained $status roots after recording fails ($outcome)", ({ status, outcome }) =>
  Effect.gen(function* () {
    const key = `recover-retained-terminal:${status}:${outcome}`;
    const retriesSettlement =
      outcome === "settlement_retry" ||
      outcome === "settlement_owner_lost" ||
      outcome === "settlement_shutdown";
    const completionWasLost = outcome === "completion_lost" || retriesSettlement;
    const ids = backgroundScenarioIds(key);
    const providerInstanceId = ProviderInstanceId.make("codex");
    const now = yield* DateTime.now;
    const parentProvider = makeRecoveryProviderThreadFixture(ids, key);
    const childProvider = {
      ...parentProvider,
      id: ProviderThreadId.make(`${ids.providerThreadId}:child`),
      appThreadId: ids.childThreadId,
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      forkedFrom: { providerThreadId: parentProvider.id, providerTurnId: ids.rootProviderTurnId },
    } satisfies OrchestrationV2ProviderThread;
    const nativeParent = {
      ...makeRunOwnedSubagentFixture({
        ids,
        providerInstanceId,
        childThreadId: ids.childThreadId,
        driver,
        status: "running",
      }),
      providerThreadId: childProvider.id,
    };
    const parentNode = makeRunOwnedSubagentNodeFixture({ ids, status: "running" });
    const parentItem = {
      ...makeRunOwnedSubagentTurnItemFixture({
        ids: { ...ids, itemId: TurnItemId.make(`${ids.itemId}:subagent`) },
        providerInstanceId,
        childThreadId: ids.childThreadId,
        driver,
        status: "running",
      }),
      providerThreadId: childProvider.id,
    };
    const childNode = {
      ...makeRunOwnedSubagentChildNodeFixture({ ids, status: "running" }),
      providerThreadId: childProvider.id,
    };
    const linkedChildItem = makeLinkedChildTurnItemFixture({
      ids,
      driver,
      type: "command_execution",
    });
    if (linkedChildItem.type !== "command_execution")
      return yield* Effect.die("Expected a native child command");
    const childItem = { ...linkedChildItem, providerThreadId: childProvider.id };
    const commandItem = {
      ...childItem,
      id: ids.itemId,
      threadId: ids.threadId,
      runId: ids.runId,
      nodeId: ids.rootNodeId,
      providerThreadId: ids.providerThreadId,
      providerTurnId: ids.rootProviderTurnId,
      input: "command",
    } satisfies Extract<OrchestrationV2TurnItem, { type: "command_execution" }>;
    const toolItem = {
      ...commandItem,
      id: TurnItemId.make(`${ids.itemId}:tool`),
      type: "dynamic_tool",
      toolName: "example_tool",
      input: { value: "work" },
    } satisfies Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>;
    const savedHistory = {
      ...commandItem,
      id: TurnItemId.make(`${ids.itemId}:saved-history`),
      status: "completed",
      completedAt: now,
      output: "Previously saved output",
      exitCode: 0,
    } satisfies OrchestrationV2TurnItem;
    const savedChildHistory = {
      ...savedHistory,
      id: TurnItemId.make(`${ids.childItemId}:saved-history`),
      threadId: ids.childThreadId,
      runId: null,
      nodeId: childNode.id,
      providerThreadId: childProvider.id,
      providerTurnId: null,
    };
    const completedDuringBackoff = {
      ...toolItem,
      status: "completed",
      completedAt: now,
      output: "Tool output saved during settlement retry",
    } satisfies OrchestrationV2TurnItem;
    const queue = yield* Queue.unbounded<ProviderAdapterV2Event, Cause.Done>();
    const publication = yield* Semaphore.make(1);
    const probe = yield* Ref.make<"pending" | "unknown" | "drained">(
      outcome === "unknown_probe" ? "unknown" : "pending",
    );
    const commandPersisted = yield* Deferred.make<void>();
    const firstMarkerConsumed = yield* Deferred.make<void>();
    const drainedMarkerConsumed = yield* Deferred.make<void>();
    const firstWriteFailed = yield* Deferred.make<void>();
    const secondWriteFailed = yield* Deferred.make<void>();
    const settlementCommitted = yield* Deferred.make<void>();
    const closed = yield* Deferred.make<void>();
    let settlementWrites = 0;
    const attemptedSettlementItemIds: TurnItemId[][] = [];
    let starts = 0;
    let ownerRevoked = false;
    let shuttingDown = false;
    let firstMarker = true;
    let subscriptions = 0;
    let registration:
      | Parameters<ThreadRecoveryService.ThreadRecoveryService["Service"]["register"]>[0]
      | undefined;
    const complete = publication.withPermits(1)(
      Effect.gen(function* () {
        // Native completion clears the tracker before emitting multiple
        // node/item updates. The marker uses the same publication permit.
        yield* Ref.set(probe, "drained");
        yield* Queue.offerAll(queue, [
          {
            type: "node.updated",
            driver,
            node: { ...parentNode, status: "completed", completedAt: now },
          },
          {
            type: "turn_item.updated",
            driver,
            turnItem: {
              ...commandItem,
              status: "completed",
              completedAt: now,
              output: "Real command output",
              exitCode: 0,
            },
          },
          {
            type: "turn_item.updated",
            driver,
            turnItem: {
              ...toolItem,
              status: "completed",
              completedAt: now,
              output: "Real tool output",
            },
          },
          {
            type: "subagent.updated",
            driver,
            subagent: {
              ...nativeParent,
              status: "completed",
              completedAt: now,
              result: "Real child result",
            },
          },
          {
            type: "turn_item.updated",
            driver,
            turnItem: {
              ...parentItem,
              status: "completed",
              completedAt: now,
              result: "Real child result",
            },
          },
          {
            type: "node.updated",
            driver,
            node: { ...childNode, status: "completed", completedAt: now },
          },
          {
            type: "turn_item.updated",
            driver,
            turnItem: {
              ...childItem,
              status: "completed",
              completedAt: now,
              output: "Real child output",
              exitCode: 0,
            },
          },
        ] satisfies ReadonlyArray<ProviderAdapterV2Event>);
      }),
    );
    const terminal = rootTerminalEvent(ids, status);
    const result = yield* captureRootRunTermination({
      key,
      shouldFinalizeRun: () => Effect.succeed(true),
      startTurn: () =>
        Effect.sync(() => {
          starts++;
        }),
      isShuttingDown: Effect.sync(() => shuttingDown),
      ...(retriesSettlement
        ? {
            wrapWriteIfProviderThreadOwner:
              (write: EventSink.EventSinkV2Shape["writeIfProviderThreadOwner"]) =>
              (payload: Parameters<EventSink.EventSinkV2Shape["writeIfProviderThreadOwner"]>[0]) =>
                Effect.gen(function* () {
                  if (payload.guardRecoveredBackground === undefined) return yield* write(payload);
                  settlementWrites++;
                  attemptedSettlementItemIds.push(
                    payload.events.flatMap((event) =>
                      event.type === "turn-item.updated" ? [event.payload.id] : [],
                    ),
                  );
                  assert.isTrue(yield* Deferred.isDone(drainedMarkerConsumed));
                  if (settlementWrites === 1) {
                    yield* Deferred.succeed(firstWriteFailed, undefined);
                    return yield* Effect.fail(
                      new EventSink.EventSinkWriteError({
                        eventCount: payload.events.length,
                        cause: "Settlement commit unavailable",
                      }),
                    );
                  }
                  if (settlementWrites === 2 && outcome === "settlement_retry") {
                    yield* Deferred.succeed(secondWriteFailed, undefined);
                    return yield* Effect.die("SQL settlement commit failed");
                  }
                  if (ownerRevoked) return { committed: false, storedEvents: [] };
                  const committed = yield* write(payload);
                  yield* Deferred.succeed(settlementCommitted, undefined);
                  return committed;
                }),
          }
        : {}),
      // The tool and native child were saved without reaching the failed
      // reader's tracker or routing state. No child-created event is replayed.
      persistedBackgroundEvents: [
        { type: "turn_item.updated", driver, turnItem: toolItem },
        { type: "turn_item.updated", driver, turnItem: savedHistory },
        { type: "turn_item.updated", driver, turnItem: savedChildHistory },
        { type: "provider_thread.updated", driver, providerThread: childProvider },
        { type: "node.updated", driver, node: childNode },
        { type: "turn_item.updated", driver, turnItem: childItem },
      ],
      onIngested: (event) =>
        event.type === "turn_item.updated" && event.turnItem.id === commandItem.id
          ? Deferred.succeed(commandPersisted, undefined).pipe(Effect.asVoid)
          : Effect.void,
      failRecordingEvent: (event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.id === commandItem.id &&
        event.turnItem.status === "running",
      subscribeEvents: Effect.gen(function* () {
        subscriptions++;
        if (subscriptions === 1)
          return {
            events: Stream.make(
              { type: "subagent.updated", driver, subagent: nativeParent },
              { type: "node.updated", driver, node: parentNode },
              { type: "turn_item.updated", driver, turnItem: parentItem },
              { type: "turn_item.updated", driver, turnItem: commandItem },
            ),
            close: Effect.void,
          };
        if (outcome === "queued_completions") yield* complete;
        return {
          events: Stream.fromQueue(queue),
          close: Queue.end(queue).pipe(
            Effect.andThen(Deferred.succeed(closed, undefined)),
            Effect.asVoid,
          ),
          requestDrain: (barrier) =>
            publication.withPermits(1)(
              Effect.gen(function* () {
                const captured = yield* barrier.observe;
                const first = firstMarker;
                firstMarker = false;
                yield* Queue.offer(queue, {
                  type: "events.barrier",
                  driver,
                  after: barrier
                    .after(captured)
                    .pipe(
                      Effect.andThen(
                        first ? Deferred.succeed(firstMarkerConsumed, undefined) : Effect.void,
                      ),
                      Effect.andThen(
                        captured === "drained"
                          ? Deferred.succeed(drainedMarkerConsumed, undefined)
                          : Effect.void,
                      ),
                      Effect.asVoid,
                    ),
                });
              }),
            ),
        } satisfies ProviderAdapterV2EventSubscription;
      }),
      hasPendingBackgroundWorkForThread: () =>
        Ref.get(probe).pipe(
          Effect.flatMap((state) =>
            state === "unknown"
              ? Effect.die("Native probe unavailable")
              : Effect.succeed(state === "pending"),
          ),
        ),
      inspectTurn: () => Effect.succeed({ status: "terminal", event: terminal }),
      recovery: {
        register: (value) =>
          Effect.sync(() => {
            registration = value;
          }),
        suspect: () => Effect.void,
        completed: () => Effect.void,
      },
      afterIngestion: (persist) =>
        Effect.gen(function* () {
          yield* Deferred.await(commandPersisted);
          const registered = registration;
          if (registered === undefined) return yield* Effect.die("Recovery was not registered");
          const inspection = yield* registered.inspect;
          assert.equal(inspection.status, "terminal");
          if (inspection.status !== "terminal")
            return yield* Effect.die("Expected retained terminal");
          assert.equal(inspection.event.status, status);
          yield* registered.finalize(inspection.event, [], { runtimeReleased: false });
          if (outcome !== "queued_completions") {
            yield* Deferred.await(firstMarkerConsumed);
            assert.isFalse(yield* Deferred.isDone(closed));
            if (outcome === "unknown_probe") yield* complete;
            else
              yield* publication.withPermits(1)(
                Ref.set(probe, "drained").pipe(
                  Effect.andThen(
                    Queue.offer(queue, {
                      type: "provider_thread.updated",
                      driver,
                      providerThread: parentProvider,
                    }),
                  ),
                ),
              );
          }
          if (retriesSettlement) {
            yield* Deferred.await(firstWriteFailed);
            assert.isFalse(yield* Deferred.isDone(closed));
            // No more native events are emitted after the drained marker.
            // The ordered consumer must retry without another routing wakeup.
            ownerRevoked = outcome === "settlement_owner_lost";
            shuttingDown = outcome === "settlement_shutdown";
            if (outcome === "settlement_retry")
              yield* persist([
                { type: "turn_item.updated", driver, turnItem: completedDuringBackoff },
              ]);
            yield* TestClock.adjust("999 millis");
            assert.equal(settlementWrites, 1);
            yield* TestClock.adjust("1 millis");
            if (outcome === "settlement_retry") {
              yield* Deferred.await(secondWriteFailed);
              assert.isFalse(yield* Deferred.isDone(closed));
              yield* TestClock.adjust("1999 millis");
              assert.equal(settlementWrites, 2);
              yield* TestClock.adjust("1 millis");
              yield* Deferred.await(settlementCommitted);
            }
          }
          yield* Deferred.await(closed);
        }),
    });
    const ownedItemIds = new Set([commandItem.id, toolItem.id, parentItem.id, childItem.id]);
    assert.equal(subscriptions, 2);
    assert.equal(starts, 1);
    if (retriesSettlement) {
      assert.equal(
        settlementWrites,
        outcome === "settlement_retry" ? 3 : outcome === "settlement_owner_lost" ? 2 : 1,
      );
      assert.equal(yield* Deferred.isDone(settlementCommitted), outcome === "settlement_retry");
      const expectedIds = [...ownedItemIds].sort();
      assert.deepEqual(attemptedSettlementItemIds[0]?.toSorted(), expectedIds);
      if (outcome === "settlement_retry") {
        assert.deepEqual(
          attemptedSettlementItemIds.slice(1).map((itemIds) => itemIds.toSorted()),
          [
            expectedIds.filter((id) => id !== toolItem.id),
            expectedIds.filter((id) => id !== toolItem.id),
          ],
        );
        const saved = result.durable.findLast(
          (event) => event.type === "turn_item.updated" && event.turnItem.id === toolItem.id,
        );
        assert.deepEqual(
          saved?.type === "turn_item.updated" ? saved.turnItem : undefined,
          completedDuringBackoff,
        );
      }
    }
    assert.deepEqual(
      result.observed.filter((value) => value.startsWith("run:")),
      [`run:${status}`],
    );
    assert.equal(result.effects.length, status === "failed" ? 0 : 1);
    assert.deepEqual(
      result.written
        .filter((item) => ownedItemIds.has(item.id))
        .map((item) => [item.id, item.status])
        .sort(),
      outcome === "completion_lost"
        ? [...ownedItemIds].map((id) => [id, "interrupted"]).sort()
        : outcome === "settlement_retry"
          ? [...ownedItemIds]
              .filter((id) => id !== toolItem.id)
              .map((id) => [id, "interrupted"])
              .sort()
          : [],
    );
    assert.isFalse(
      result.written.some(
        (item) => item.id === savedHistory.id || item.id === savedChildHistory.id,
      ),
    );
    for (const history of [savedHistory, savedChildHistory]) {
      const saved = result.durable.findLast(
        (event) => event.type === "turn_item.updated" && event.turnItem.id === history.id,
      );
      assert.deepEqual(saved?.type === "turn_item.updated" ? saved.turnItem : undefined, history);
    }
    if (!completionWasLost) {
      const completions = result.ingested.flatMap((event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.status === "completed" &&
        ownedItemIds.has(event.turnItem.id)
          ? [event.turnItem]
          : [],
      );
      assert.deepEqual(
        completions.map((item) => item.id),
        [...ownedItemIds],
      );
      assert.deepEqual(
        completions.flatMap((item) =>
          item.type === "command_execution" || item.type === "dynamic_tool" ? [item.output] : [],
        ),
        ["Real command output", "Real tool output", "Real child output"],
      );
      assert.isTrue(
        result.ingested.some(
          (event) =>
            event.type === "node.updated" &&
            event.node.id === childNode.id &&
            event.node.status === "completed",
        ),
      );
    }
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect.each(
  (["codex", "claudeAgent"] as const).flatMap((provider) => [
    { provider, lifecycle: "confirmed_release" as const },
    { provider, lifecycle: "stale_subscription" as const },
    { provider, lifecycle: "server_shutdown" as const },
  ]),
)("preserves native child ownership across $lifecycle ($provider)", ({ provider, lifecycle }) =>
  Effect.gen(function* () {
    const key = `native-child:${provider}:${lifecycle}`;
    const ids = backgroundScenarioIds(key);
    const fixtureDriver = ProviderDriverKind.make(provider);
    const providerInstanceId = ProviderInstanceId.make(provider);
    const parentProvider = makeRecoveryProviderThreadFixture(ids, key, {
      driver: fixtureDriver,
      providerInstanceId,
    });
    const childProvider = {
      ...parentProvider,
      id: ProviderThreadId.make(`${ids.providerThreadId}:child`),
      appThreadId: ids.childThreadId,
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      nativeThreadRef: {
        driver: fixtureDriver,
        nativeId: `native-child:${key}`,
        strength: "strong" as const,
      },
      forkedFrom: { providerThreadId: parentProvider.id, providerTurnId: ids.rootProviderTurnId },
    } satisfies OrchestrationV2ProviderThread;
    const nativeParent = {
      ...makeRunOwnedSubagentFixture({
        ids,
        providerInstanceId,
        childThreadId: ids.childThreadId,
        driver: fixtureDriver,
        status: "running",
      }),
      providerThreadId: provider === "codex" ? childProvider.id : parentProvider.id,
    };
    const subagentIds = { ...ids, itemId: TurnItemId.make(`${ids.itemId}:subagent`) };
    const parentItem = {
      ...makeRunOwnedSubagentTurnItemFixture({
        ids: subagentIds,
        providerInstanceId,
        childThreadId: ids.childThreadId,
        driver: fixtureDriver,
        status: "running",
      }),
      providerThreadId: nativeParent.providerThreadId,
    };
    // Both adapters create a local root with no cross-thread parent node.
    // Codex binds it to a child provider; Claude shares the parent's query.
    const childNode = {
      ...makeRunOwnedSubagentChildNodeFixture({ ids, status: "running" }),
      providerThreadId: provider === "codex" ? childProvider.id : null,
    } satisfies OrchestrationV2ExecutionNode;
    const linkedChildItem = makeLinkedChildTurnItemFixture({
      ids,
      driver: fixtureDriver,
      type: "command_execution",
    });
    if (linkedChildItem.type !== "command_execution")
      return yield* Effect.die("Expected a native child command");
    const childItem = {
      ...linkedChildItem,
      providerThreadId: childNode.providerThreadId,
    } satisfies Extract<OrchestrationV2TurnItem, { type: "command_execution" }>;
    const terminal = { ...rootTerminalEvent(ids, "completed"), driver: fixtureDriver };
    const initial: ProviderAdapterV2Event[] = (
      [
        childThreadCreatedEvent(ids),
        ...(provider === "codex"
          ? [
              {
                type: "provider_thread.updated",
                driver: fixtureDriver,
                providerThread: childProvider,
              } as const,
            ]
          : []),
        backgroundTurnItemEvent(ids, "command_execution", "running", 1),
        { type: "subagent.updated", driver: fixtureDriver, subagent: nativeParent },
        {
          type: "node.updated",
          driver: fixtureDriver,
          node: makeRunOwnedSubagentNodeFixture({ ids, status: "running" }),
        },
        { type: "turn_item.updated", driver: fixtureDriver, turnItem: parentItem },
        { type: "node.updated", driver: fixtureDriver, node: childNode },
        { type: "turn_item.updated", driver: fixtureDriver, turnItem: childItem },
      ] satisfies ReadonlyArray<ProviderAdapterV2Event>
    ).map((event) => ({ ...event, driver: fixtureDriver }));
    let registration:
      | Parameters<ThreadRecoveryService.ThreadRecoveryService["Service"]["register"]>[0]
      | undefined;
    let subscriptions = 0;
    let released = lifecycle === "server_shutdown";
    const replacementClosed = yield* Deferred.make<void>();
    const result = yield* captureRootRunTermination({
      key,
      providerDriver: fixtureDriver,
      shouldFinalizeRun: () => Effect.succeed(true),
      subscribeEvents: Effect.sync(() => {
        subscriptions++;
        if (subscriptions > 1) {
          released = true;
          return { events: Stream.empty, close: Deferred.succeed(replacementClosed, undefined) };
        }
        return {
          events:
            lifecycle === "server_shutdown"
              ? Stream.fromIterable([...initial, terminal])
              : Stream.fromIterable(initial).pipe(
                  Stream.concat(
                    Stream.fail(
                      new ProviderAdapterEventStreamError({
                        driver: fixtureDriver,
                        providerSessionId: parentProvider.providerSessionId!,
                        cause: "Original reader stopped",
                      }),
                    ),
                  ),
                ),
          close: Effect.void,
        };
      }),
      isShuttingDown: Effect.succeed(lifecycle === "server_shutdown"),
      inspectTurn: () =>
        Effect.sync(() => ({
          status: "terminal" as const,
          event: terminal,
          ...(released ? { runtimeReleased: true as const } : {}),
        })),
      recovery: {
        register: (value) =>
          Effect.sync(() => {
            registration = value;
          }),
        suspect: () => Effect.void,
        completed: () => Effect.void,
      },
      afterIngestion: Effect.gen(function* () {
        if (lifecycle === "server_shutdown") return;
        if (lifecycle === "confirmed_release") released = true;
        const inspection = yield* registration!.inspect;
        assert.equal(inspection.status, "terminal");
        if (inspection.status !== "terminal") return;
        assert.equal(inspection.runtimeReleased === true, lifecycle === "confirmed_release");
        yield* registration!.finalize(inspection.event, [], {
          runtimeReleased: lifecycle === "confirmed_release",
        });
        if (lifecycle === "stale_subscription") yield* Deferred.await(replacementClosed);
      }),
    });
    assert.equal(subscriptions, lifecycle === "stale_subscription" ? 2 : 1);
    assert.deepEqual(
      result.written.map((item) => [item.id, item.status]).sort(),
      lifecycle === "server_shutdown"
        ? []
        : [
            [ids.itemId, "interrupted"],
            [subagentIds.itemId, "interrupted"],
            [ids.childItemId, "interrupted"],
          ].sort(),
    );
    assert.equal(
      result.events.some(
        (event) =>
          event.type === "node.updated" &&
          event.payload.id === childNode.id &&
          event.payload.status === "interrupted" &&
          event.payload.parentNodeId === null,
      ),
      lifecycle !== "server_shutdown",
    );
    assert.deepEqual(
      result.observed.filter((value) => value.startsWith("run:")),
      ["run:waiting"],
    );
  }),
);

it.effect("keeps durable-only background rows open after an unknown captured probe", () =>
  Effect.gen(function* () {
    const key = "recover-durable-only-unknown";
    const ids = backgroundScenarioIds(key);
    const queue = yield* Queue.unbounded<ProviderAdapterV2Event, Cause.Done>();
    const unknownObserved = yield* Deferred.make<void>();
    const closed = yield* Deferred.make<void>();
    let released = false;
    let subscriptions = 0;
    let registration:
      | Parameters<ThreadRecoveryService.ThreadRecoveryService["Service"]["register"]>[0]
      | undefined;
    const result = yield* captureRootRunTermination({
      key,
      shouldFinalizeRun: () => Effect.succeed(true),
      persistedBackgroundEvents: [backgroundTurnItemEvent(ids, "command_execution", "running", 1)],
      subscribeEvents: Effect.sync(() => {
        subscriptions++;
        if (subscriptions === 1)
          return {
            events: Stream.fail(
              new ProviderAdapterEventStreamError({
                driver,
                providerSessionId: ProviderSessionId.make(`session:${key}`),
                cause: "Tracker never ran",
              }),
            ),
            close: Effect.void,
          };
        return {
          events: Stream.fromQueue(queue),
          close: Deferred.succeed(closed, undefined),
          requestDrain: (barrier) =>
            Effect.gen(function* () {
              const captured = yield* barrier.observe;
              assert.equal(captured, "unknown");
              yield* Queue.offer(queue, {
                type: "events.barrier",
                driver,
                after: barrier
                  .after(captured)
                  .pipe(Effect.andThen(Deferred.succeed(unknownObserved, undefined))),
              });
            }),
        } satisfies ProviderAdapterV2EventSubscription;
      }),
      hasPendingBackgroundWorkForThread: () => Effect.die("Probe unavailable"),
      inspectTurn: () =>
        Effect.sync(() => ({
          status: "terminal" as const,
          event: rootTerminalEvent(ids, "completed"),
          ...(released ? { runtimeReleased: true as const } : {}),
        })),
      recovery: {
        register: (value) =>
          Effect.sync(() => {
            registration = value;
          }),
        suspect: () => Effect.void,
        completed: () => Effect.void,
      },
      afterIngestion: Effect.gen(function* () {
        yield* registration!.finalize(rootTerminalEvent(ids, "completed"), [], {
          runtimeReleased: false,
        });
        yield* Deferred.await(unknownObserved);
        assert.isFalse(yield* Deferred.isDone(closed));
        released = true;
        yield* Queue.end(queue);
        yield* Deferred.await(closed);
      }),
    });
    assert.deepEqual(
      result.written.map((item) => item.status),
      ["interrupted"],
    );
    assert.equal(subscriptions, 2);
  }),
);

it.effect(
  "settles native background rows after an ordinary completed reader loses its runtime",
  () =>
    Effect.gen(function* () {
      const key = "ordinary-terminal-background-release";
      const ids = backgroundScenarioIds(key);
      const providerInstanceId = ProviderInstanceId.make("codex");
      const toolId = TurnItemId.make(`${ids.itemId}:tool`);
      const subagentIds = { ...ids, itemId: TurnItemId.make(`${ids.itemId}:subagent`) };
      const result = yield* captureRootRunTermination({
        key,
        shouldFinalizeRun: () => Effect.succeed(true),
        events: () =>
          Stream.fromIterable([
            childThreadCreatedEvent(ids),
            backgroundTurnItemEvent(ids, "command_execution", "running", 1),
            backgroundTurnItemEvent(ids, "dynamic_tool", "running", 2, toolId),
            {
              type: "subagent.updated",
              driver,
              subagent: makeRunOwnedSubagentFixture({
                ids,
                providerInstanceId,
                childThreadId: ids.childThreadId,
                driver,
                status: "running",
              }),
            },
            {
              type: "turn_item.updated",
              driver,
              turnItem: makeRunOwnedSubagentTurnItemFixture({
                ids: subagentIds,
                providerInstanceId,
                childThreadId: ids.childThreadId,
                driver,
                status: "running",
              }),
            },
            {
              type: "node.updated",
              driver,
              node: makeRunOwnedSubagentChildNodeFixture({ ids, status: "running" }),
            },
            {
              type: "turn_item.updated",
              driver,
              turnItem: makeLinkedChildTurnItemFixture({ ids, driver, type: "command_execution" }),
            },
            rootTerminalEvent(ids, "completed"),
          ] satisfies ReadonlyArray<ProviderAdapterV2Event>).pipe(
            Stream.concat(
              Stream.fail(
                new ProviderAdapterEventStreamError({
                  driver,
                  providerSessionId: ProviderSessionId.make(`session:${key}`),
                  cause: "Runtime released after root completion",
                }),
              ),
            ),
          ),
        inspectTurn: () =>
          Effect.succeed({
            status: "terminal",
            event: rootTerminalEvent(ids, "completed"),
            runtimeReleased: true,
          }),
      });
      assert.deepEqual(
        result.written.map((item) => [item.id, item.status]).sort(),
        [
          [ids.itemId, "interrupted"],
          [toolId, "interrupted"],
          [subagentIds.itemId, "interrupted"],
          [ids.childItemId, "interrupted"],
        ].sort(),
      );
      assert.deepEqual(
        result.observed.filter((value) => value.startsWith("run:")),
        ["run:waiting"],
      );
      assert.equal(result.effects.length, 1);
    }),
);
