import { assert, describe, it, vi } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  NodeId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
  TextGenerationError,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import { makeSubagentConversationArtifacts } from "./SubagentProjection.ts";
import { planIncomingMessageSummaries } from "./IncomingMessageSummary.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as CommandReceipts from "./CommandReceiptStore.ts";
import * as IncomingMessageSummary from "./IncomingMessageSummaryService.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const threadId = ThreadId.make("thread:incoming-preview");
const messageId = MessageId.make("message:incoming-preview");
const commandId = CommandId.make("command:incoming-preview");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-sol" };
const original =
  "Review the build changes and preserve the existing release workflow.\nNo release has been published yet.";

function makeHarness(
  options: {
    readonly available?: boolean;
    readonly generate?: TextGeneration.TextGeneration["Service"]["generateIncomingMessageSummary"];
  } = {},
) {
  const database = SqlitePersistence.layerMemory;
  const adapter = {
    instanceId: modelSelection.instanceId,
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("Provider turns are disabled in incoming preview tests"),
  } satisfies ProviderAdapterV2Shape;
  const orchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "incoming-message-preview" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  );
  const threads = ThreadManagement.layer.pipe(Layer.provide(orchestrator));
  const outbox = EffectOutbox.layer.pipe(Layer.provide(database));
  const generate = vi.fn(
    options.generate ??
      (() => Effect.succeed({ text: "Review build changes; preserve release workflow" })),
  );
  const textGeneration = TextGeneration.TextGeneration.of({
    generateIncomingMessageSummary: generate,
    generateCommitMessage: () => Effect.die("Commit messages are not used in preview tests"),
    generatePrContent: () => Effect.die("PR content is not used in preview tests"),
    generateBranchName: () => Effect.die("Branch names are not used in preview tests"),
    generateThreadTitle: () => Effect.die("Thread titles are not used in preview tests"),
  });
  const snapshot = {
    instanceId: modelSelection.instanceId,
    driver: adapter.driver,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-01T00:00:00.000Z",
    models: [{ slug: "gpt-6-luna", name: "GPT Luna", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  } satisfies ServerProvider;
  const instance = {
    instanceId: modelSelection.instanceId,
    driverKind: adapter.driver,
    continuationIdentity: {
      driverKind: adapter.driver,
      continuationKey: `codex:instance:${modelSelection.instanceId}`,
    },
    displayName: undefined,
    enabled: true,
    snapshot: {
      resolveMaintenance: () => Effect.die("Provider maintenance is not used in preview tests"),
      getSnapshot: Effect.succeed(snapshot),
      refresh: Effect.succeed(snapshot),
      streamChanges: Stream.empty,
      applyUsageLimits: () => Effect.void,
    },
    orchestrationAdapter: adapter,
    textGeneration,
  } satisfies ProviderInstance;
  const summary = IncomingMessageSummary.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        threads,
        Layer.succeed(TextGeneration.TextGeneration, textGeneration),
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          listInstances: Effect.succeed(options.available === false ? [] : [instance]),
        }),
      ),
    ),
  );
  return {
    layer: Layer.mergeAll(
      orchestrator,
      threads,
      summary,
      outbox,
      database,
      CommandReceipts.layer.pipe(Layer.provide(database)),
    ),
    generate,
  };
}

const createThread = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  yield* threads.dispatch({
    type: "thread.create",
    commandId: CommandId.make("command:create-incoming-preview"),
    threadId,
    projectId: ProjectId.make("project:incoming-preview"),
    title: "Preview test",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
});

function dispatchMessage(
  text = original,
  createdBy: "user" | "agent" = "agent",
  scheduledTaskId?: ScheduledTaskId,
) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    return yield* threads.dispatch({
      type: "message.dispatch",
      commandId,
      threadId,
      messageId,
      text,
      attachments: [],
      modelSelection,
      dispatchMode: { type: "defer_start" },
      createdBy,
      creationSource: "server",
      ...(scheduledTaskId === undefined ? {} : { scheduledTaskId }),
    });
  });
}

const queueIncomingMessage = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  yield* threads.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("command:prepare-active-turn"),
    threadId,
    messageId: MessageId.make("message:active-turn"),
    text: "Keep this turn prepared",
    attachments: [],
    modelSelection,
    dispatchMode: { type: "defer_start" },
    createdBy: "user",
    creationSource: "web",
  });
  yield* dispatchMessage();
});

describe("IncomingMessageSummaryService", () => {
  it.effect.each([
    ["short", "Review the build", 0],
    ["long", original, 1],
  ] as const)(
    "commits a newly delegated child and its %s first message atomically",
    ([_name, task, expectedCalls]) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const service = yield* IncomingMessageSummary.IncomingMessageSummaryService;
        yield* createThread;
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("command:start-delegating-parent"),
          threadId,
          messageId: MessageId.make("message:delegating-parent"),
          text: "Delegate the build review",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const parentRun = (yield* threads.getThreadProjection(threadId)).runs[0]!;
        const delegation = {
          type: "delegated_task.request" as const,
          commandId,
          parentThreadId: threadId,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId!,
          task,
          modelSelection,
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          createdBy: "agent" as const,
          creationSource: "mcp" as const,
        };
        const committed = yield* threads.dispatch(delegation);
        const parent = yield* threads.getThreadProjection(threadId);
        assert.equal(parent.subagents.length, 1);
        const childThreadId = parent.subagents[0]!.childThreadId!;
        const child = yield* threads.getThreadProjection(childThreadId);
        const message = child.messages[0]!;
        const item = child.turnItems.find((item) => item.type === "user_message");
        assert.equal(child.messages.length, 1);
        assert.equal(message.text, task);
        assert.equal(item?.type === "user_message" ? item.text : undefined, task);
        const expectedPending = expectedCalls === 1 ? { status: "pending" as const } : undefined;
        assert.deepEqual(message.incomingSummary, expectedPending);
        assert.deepEqual(
          item?.type === "user_message" ? item.incomingSummary : undefined,
          expectedPending,
        );
        assert.equal(
          committed.storedEvents.some(
            ({ event }) => event.type === "thread.created" && event.threadId === childThreadId,
          ),
          true,
        );
        assert.equal(
          committed.storedEvents.some(
            ({ event }) => event.type === "message.updated" && event.payload.id === message.id,
          ),
          true,
        );
        const summaryEffects = (yield* outbox.listByCommandId(commandId)).filter(
          (effect) => effect.request.type === "incoming-message.summarize",
        );
        assert.equal(summaryEffects.length, expectedCalls);
        if (expectedCalls === 1) {
          assert.equal(summaryEffects[0]?.threadId, childThreadId);
        }
        yield* threads.dispatch(delegation);
        assert.equal((yield* threads.getThreadProjection(threadId)).subagents.length, 1);
        assert.equal(
          (yield* outbox.listByCommandId(commandId)).filter(
            (effect) => effect.request.type === "incoming-message.summarize",
          ).length,
          expectedCalls,
        );
        yield* service.execute({ threadId: childThreadId, messageId: message.id, attemptCount: 1 });
        const completed = yield* threads.getThreadProjection(childThreadId);
        const completedItem = completed.turnItems.find((item) => item.type === "user_message");
        const expectedSummary =
          expectedCalls === 1
            ? { status: "ready" as const, text: "Review build changes; preserve release workflow" }
            : undefined;
        assert.deepEqual(completed.messages[0]?.incomingSummary, expectedSummary);
        assert.deepEqual(
          completedItem?.type === "user_message" ? completedItem.incomingSummary : undefined,
          expectedSummary,
        );
        assert.equal(completed.messages[0]?.text, task);
        assert.equal(harness.generate.mock.calls.length, expectedCalls);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("invalidates an edited body while generation runs and ignores the old completion", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<{ text: string }>();
      const harness = makeHarness({
        generate: () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish))),
      });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const service = yield* IncomingMessageSummary.IncomingMessageSummaryService;
        yield* createThread;
        yield* queueIncomingMessage;
        const run = (yield* threads.getThreadProjection(threadId)).runs.find(
          (run) => run.userMessageId === messageId,
        )!;
        const generation = yield* service
          .execute({ threadId, messageId, attemptCount: 1 })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        const edited = "Review the deployment policy instead.\nKeep the old release workflow.";
        const editCommandId = CommandId.make("command:edit-pending-preview");
        yield* threads.dispatch({
          type: "queued-run.edit",
          commandId: editCommandId,
          threadId,
          runId: run.id,
          text: edited,
        });
        const during = yield* threads.getThreadProjection(threadId);
        assert.deepEqual(
          during.messages.find((message) => message.id === messageId)?.incomingSummary,
          { status: "failed" },
        );
        assert.equal(during.messages.find((message) => message.id === messageId)?.text, edited);
        assert.equal((yield* outbox.listByCommandId(editCommandId)).length, 0);
        yield* Deferred.succeed(finish, { text: "A preview of the previous body" });
        yield* Fiber.join(generation);
        yield* service.execute({ threadId, messageId, attemptCount: 1 });
        const after = yield* threads.getThreadProjection(threadId);
        assert.equal(after.messages.find((message) => message.id === messageId)?.text, edited);
        assert.deepEqual(
          after.messages.find((message) => message.id === messageId)?.incomingSummary,
          { status: "failed" },
        );
        assert.equal(harness.generate.mock.calls.length, 1);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect(
    "invalidates a completed preview when the body is edited without generating again",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const service = yield* IncomingMessageSummary.IncomingMessageSummaryService;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        yield* createThread;
        yield* queueIncomingMessage;
        yield* service.execute({ threadId, messageId, attemptCount: 1 });
        const before = yield* threads.getThreadProjection(threadId);
        assert.equal(
          before.messages.find((message) => message.id === messageId)?.incomingSummary?.status,
          "ready",
        );
        const edited = "Pause the release and investigate the failed build.";
        const editCommandId = CommandId.make("command:edit-ready-preview");
        yield* threads.dispatch({
          type: "queued-run.edit",
          commandId: editCommandId,
          threadId,
          runId: before.runs.find((run) => run.userMessageId === messageId)!.id,
          text: edited,
        });
        yield* service.execute({ threadId, messageId, attemptCount: 1 });
        const after = yield* threads.getThreadProjection(threadId);
        assert.equal(after.messages.find((message) => message.id === messageId)?.text, edited);
        assert.deepEqual(
          after.messages.find((message) => message.id === messageId)?.incomingSummary,
          { status: "failed" },
        );
        assert.equal((yield* outbox.listByCommandId(editCommandId)).length, 0);
        assert.equal(harness.generate.mock.calls.length, 1);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect.each([
    ["final long body", "Initial short task", original, 1],
    ["final short body", original, "Review the build", 0],
  ] as const)(
    "summarizes only the batch's %s",
    ([_name, initialText, finalText, expectedCalls]) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const service = yield* IncomingMessageSummary.IncomingMessageSummaryService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        yield* createThread;
        const now = yield* DateTime.now;
        const artifacts = makeSubagentConversationArtifacts({
          messageId,
          turnItemId: TurnItemId.make("batched-item"),
          threadId,
          rootNodeId: NodeId.make("batched-node"),
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          role: "user",
          text: initialText,
          ordinal: 1,
          now,
        });
        if (artifacts.turnItem.type !== "user_message") {
          return yield* Effect.die("Expected a user message timeline fixture");
        }
        const planned = yield* planIncomingMessageSummaries({
          commandId,
          events: [
            {
              id: EventId.make("batch-initial-body"),
              type: "message.updated",
              threadId,
              occurredAt: now,
              payload: artifacts.message,
            },
            {
              id: EventId.make("batch-final-body"),
              type: "message.updated",
              threadId,
              occurredAt: now,
              payload: { ...artifacts.message, text: finalText },
            },
            {
              id: EventId.make("batch-final-item"),
              type: "turn-item.updated",
              threadId,
              occurredAt: now,
              payload: { ...artifacts.turnItem, text: finalText },
            },
          ],
        }).pipe(Effect.provide(ProjectionStore.layer));
        assert.equal(planned.effects.length, expectedCalls);
        yield* sink.writeWithEffects(planned);
        yield* service.execute({ threadId, messageId, attemptCount: 1 });
        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(projection.messages[0]?.text, finalText);
        assert.equal(harness.generate.mock.calls.length, expectedCalls);
        if (expectedCalls === 1) {
          assert.equal(harness.generate.mock.calls[0]?.[0].message, finalText);
          assert.equal(projection.messages[0]?.incomingSummary?.status, "ready");
        } else {
          assert.equal(projection.messages[0]?.incomingSummary, undefined);
        }
      }).pipe(Effect.provide(harness.layer));
    },
  );
  it.effect(
    "completes a native timeline item whose id differs from the server's message item id",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const sink = yield* EventSink.EventSinkV2;
        const service = yield* IncomingMessageSummary.IncomingMessageSummaryService;
        yield* createThread;
        const now = yield* DateTime.now;
        const artifacts = makeSubagentConversationArtifacts({
          messageId,
          turnItemId: TurnItemId.make("native-preview-item"),
          threadId,
          rootNodeId: NodeId.make("native-preview-node"),
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          role: "user",
          text: original,
          ordinal: 1,
          now,
        });
        yield* sink.write({
          events: [
            {
              id: EventId.make("native-preview-message-event"),
              type: "message.updated",
              threadId,
              occurredAt: now,
              payload: { ...artifacts.message, incomingSummary: { status: "pending" } },
            },
            {
              id: EventId.make("native-preview-item-event"),
              type: "turn-item.updated",
              threadId,
              occurredAt: now,
              payload: artifacts.turnItem,
            },
          ],
        });
        yield* service.execute({ threadId, messageId, attemptCount: 1 });
        const projection = yield* threads.getThreadProjection(threadId);
        const item = projection.turnItems.find((item) => item.id === artifacts.turnItem.id);
        assert.deepEqual(item?.type === "user_message" ? item.incomingSummary : undefined, {
          status: "ready",
          text: "Review build changes; preserve release workflow",
        });
      }).pipe(Effect.provide(harness.layer));
    },
  );
  it.effect(
    "persists one pending preview and completes both projections without changing the provider message",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const service = yield* IncomingMessageSummary.IncomingMessageSummaryService;
        yield* createThread;
        yield* dispatchMessage();
        yield* dispatchMessage();
        const before = yield* threads.getThreadProjection(threadId);
        assert.deepEqual(before.messages[0]?.incomingSummary, { status: "pending" });
        assert.deepEqual(
          before.turnItems.find((item) => item.type === "user_message")?.type,
          "user_message",
        );
        assert.equal(
          (yield* outbox.listByCommandId(commandId)).filter(
            (item) => item.request.type === "incoming-message.summarize",
          ).length,
          1,
        );
        yield* service.execute({ threadId, messageId, attemptCount: 1 });
        yield* service.execute({ threadId, messageId, attemptCount: 1 });
        const after = yield* threads.getThreadProjection(threadId);
        const expected = {
          status: "ready" as const,
          text: "Review build changes; preserve release workflow",
        };
        assert.deepEqual(after.messages[0]?.incomingSummary, expected);
        const item = after.turnItems.find((item) => item.type === "user_message");
        assert.deepEqual(
          item?.type === "user_message" ? item.incomingSummary : undefined,
          expected,
        );
        assert.equal(after.messages[0]?.text, original);
        assert.deepEqual(after.messages[0]?.updatedAt, before.messages[0]?.updatedAt);
        assert.equal(harness.generate.mock.calls.length, 1);
        assert.deepEqual(harness.generate.mock.calls[0]?.[0].modelSelection, {
          instanceId: modelSelection.instanceId,
          model: "gpt-6-luna",
          options: [
            { id: "reasoningEffort", value: "xhigh" },
            { id: "serviceTier", value: "default" },
          ],
        });
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect.each([
    ["short incoming text", "Review the build changes", "agent"],
    [
      "user text that looks like a JSON agent envelope",
      '{"sender":"agent","body":"Review the build changes and preserve the existing release workflow. No release has been published yet."}',
      "user",
    ],
  ] as const)("does not schedule generation for %s", ([_name, text, actor]) => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      yield* createThread;
      yield* dispatchMessage(text, actor);
      const projection = yield* threads.getThreadProjection(threadId);
      assert.equal(projection.messages[0]?.incomingSummary, undefined);
      assert.equal(
        (yield* outbox.listByCommandId(commandId)).some(
          (row) => row.request.type === "incoming-message.summarize",
        ),
        false,
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("recognizes scheduled task attribution even when the creator is user", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      yield* createThread;
      yield* dispatchMessage(original, "user", ScheduledTaskId.make("task:build-audit"));
      assert.deepEqual(
        (yield* threads.getThreadProjection(threadId)).messages[0]?.incomingSummary,
        { status: "pending" },
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect.each([
    ["unavailable Luna", false, 1, undefined],
    ["recovered provider attempt", true, 2, undefined],
    [
      "generation failure",
      true,
      1,
      () =>
        Effect.fail(
          new TextGenerationError({
            operation: "generateIncomingMessageSummary",
            detail: "Generation failed",
          }),
        ),
    ],
  ] as const)("stops the pending state after %s", ([_name, available, attemptCount, generate]) => {
    const harness = makeHarness({ available, ...(generate === undefined ? {} : { generate }) });
    return Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const service = yield* IncomingMessageSummary.IncomingMessageSummaryService;
      yield* createThread;
      yield* dispatchMessage();
      yield* service.execute({ threadId, messageId, attemptCount });
      const projection = yield* threads.getThreadProjection(threadId);
      assert.deepEqual(projection.messages[0]?.incomingSummary, { status: "failed" });
      assert.equal(projection.messages[0]?.text, original);
      assert.equal(harness.generate.mock.calls.length, generate === undefined ? 0 : 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("bounds generation time and preserves the original after timeout", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const harness = makeHarness({
        generate: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const service = yield* IncomingMessageSummary.IncomingMessageSummaryService;
        yield* createThread;
        yield* dispatchMessage();
        const running = yield* service
          .execute({ threadId, messageId, attemptCount: 1 })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        yield* TestClock.adjust("45 seconds");
        yield* Fiber.join(running);
        assert.deepEqual(
          (yield* threads.getThreadProjection(threadId)).messages[0]?.incomingSummary,
          { status: "failed" },
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("keeps primary effects claimable while a preview is generating", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      yield* createThread;
      yield* dispatchMessage();
      const preview = yield* outbox.claimNext({
        workerId: "preview-worker",
        leaseDurationMs: 60_000,
        incomingSummaryLane: "only",
      });
      assert.equal(Option.isSome(preview), true);
      yield* outbox.enqueue([
        {
          id: "primary-cleanup",
          commandId: CommandId.make("command:cleanup"),
          threadId,
          request: { type: "terminal.cleanup" },
        },
      ]);
      const primary = yield* outbox.claimNext({
        workerId: "primary-worker",
        leaseDurationMs: 60_000,
        incomingSummaryLane: "exclude",
      });
      assert.equal(Option.isSome(primary) ? primary.value.id : undefined, "primary-cleanup");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect.each(["complete", "fail"] as const)(
    "settles a summary during archive stopping and preserves it after %s",
    (outcome) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const receipts = yield* CommandReceipts.CommandReceiptStoreV2;
        const service = yield* IncomingMessageSummary.IncomingMessageSummaryService;
        yield* createThread;
        yield* dispatchMessage();
        const childId = ThreadId.make("summary-archive:child");
        const root = (yield* threads.getThreadRecords(threadId, [])).thread;
        const now = yield* DateTime.now;
        const sink = yield* EventSink.EventSinkV2;
        yield* sink.write({
          events: [
            {
              id: EventId.make("summary-archive:child-created"),
              type: "thread.created",
              threadId: childId,
              occurredAt: now,
              payload: {
                ...root,
                id: childId,
                title: "Owned child",
                lineage: {
                  parentThreadId: threadId,
                  rootThreadId: threadId,
                  relationshipToParent: "subagent",
                },
              },
            },
          ],
        });
        const archiveId = CommandId.make(`summary-archive:${outcome}`);
        yield* orchestrator.dispatch({
          type: "thread.archive",
          threadId,
          commandId: archiveId,
          childDisposition: "stop_and_archive",
          expectedChildThreadIds: [childId],
        });
        assert.equal(
          (yield* threads.getThreadRecords(threadId, [])).thread.archivePending?.status,
          "stopping",
        );
        yield* service.execute({ threadId, messageId, attemptCount: 1 });
        const expected = {
          status: "ready",
          text: "Review build changes; preserve release workflow",
        };
        const during = yield* threads.getThreadProjection(threadId);
        assert.deepEqual(during.messages[0]?.incomingSummary, expected);
        assert.equal(during.messages[0]?.text, original);
        const completionId = CommandId.make(`incoming-message-summary:${messageId}:complete`);
        const receipt = yield* receipts.getByCommandId(completionId);
        assert.equal(Option.isSome(receipt) ? receipt.value.status : undefined, "accepted");
        if (outcome === "complete") {
          yield* threads.executeArchive({ threadId, requestId: archiveId });
          yield* threads.dispatch({
            type: "thread.unarchive",
            threadId,
            commandId: CommandId.make("summary-restore"),
          });
        } else {
          yield* orchestrator.dispatch({
            type: "thread.archive.fail",
            threadId,
            commandId: CommandId.make(`${archiveId}:failed`),
            requestId: archiveId,
            error: "Controlled stop failure",
          });
          yield* threads.dispatch({
            type: "thread.unarchive",
            threadId,
            commandId: CommandId.make("summary-dismiss"),
            expectedArchiveCommandId: archiveId,
          });
        }
        yield* service.execute({ threadId, messageId, attemptCount: 2 });
        const after = yield* threads.getThreadProjection(threadId);
        assert.deepEqual(after.messages[0]?.incomingSummary, expected);
        const item = after.turnItems.find((item) => item.type === "user_message");
        assert.deepEqual(
          item?.type === "user_message" ? item.incomingSummary : undefined,
          expected,
        );
        assert.equal(harness.generate.mock.calls.length, 1);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("ignores a stale completion for a different original message", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      yield* createThread;
      yield* dispatchMessage();
      yield* threads.dispatch({
        type: "message.incoming-summary.complete",
        commandId: CommandId.make("command:stale-complete"),
        threadId,
        messageId,
        sourceText: "A different message",
        summary: { status: "ready", text: "A stale preview" },
      });
      assert.deepEqual(
        (yield* threads.getThreadProjection(threadId)).messages[0]?.incomingSummary,
        { status: "pending" },
      );
    }).pipe(Effect.provide(harness.layer));
  });
});
