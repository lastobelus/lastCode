import {
  compactThreadArchiveParticipant,
  NodeId,
  CommandId,
  OrchestrationV2DomainEvent,
  OrchestrationV2StoredEvent,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2Run,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type ModelSelection,
  type RuntimeMode,
  type ProviderInteractionMode,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RawEventId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderFailureTurnItem } from "@t3tools/provider-core/server/failure";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { stripUnservedToolOutputImageBytes } from "./toolOutputImageBytes.ts";
import { planIncomingMessageSummaries } from "./IncomingMessageSummary.ts";

export class ProviderEventNormalizeError extends Schema.TaggedError<ProviderEventNormalizeError>()(
  "ProviderEventNormalizeError",
  {
    providerSessionId: ProviderSessionId,
    threadId: ThreadId,
    providerEvent: ProviderAdapter.ProviderAdapterV2Event,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to normalize provider event ${this.providerEvent.type} for thread ${this.threadId}.`;
  }
}

export class ProviderEventPublishError extends Schema.TaggedError<ProviderEventPublishError>()(
  "ProviderEventPublishError",
  {
    providerSessionId: ProviderSessionId,
    eventCount: Schema.Number,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to publish ${this.eventCount} normalized provider event(s).`;
  }
}

export const ProviderEventIngestorV2Error = Schema.Union([
  ProviderEventNormalizeError,
  ProviderEventPublishError,
]);
export type ProviderEventIngestorV2Error = typeof ProviderEventIngestorV2Error.Type;

export interface ProviderTurnAnalyticsContext {
  readonly modelSelection: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
}

export class ProviderTurnAnalytics extends Context.Reference<{
  readonly record: (properties: Readonly<Record<string, unknown>>) => Effect.Effect<void>;
}>("t3/orchestration-v2/ProviderTurnAnalytics", {
  defaultValue: () => ({ record: () => Effect.void }),
}) {}

export const layerAnalytics = Layer.effect(
  ProviderTurnAnalytics,
  Effect.gen(function* () {
    const analytics = yield* AnalyticsService.AnalyticsService;
    return {
      record: (properties: Readonly<Record<string, unknown>>) =>
        analytics.record("provider.turn.completed", properties),
    };
  }),
);

function providerTurnAnalyticsProperties(input: {
  readonly driver: ProviderAdapter.ProviderAdapterV2Event["driver"];
  readonly providerTurn: OrchestrationV2ProviderTurn;
  readonly context?: ProviderTurnAnalyticsContext;
}): Readonly<Record<string, unknown>> {
  const usage = input.providerTurn.turnTokenUsage;
  const modelSelection = input.context?.modelSelection;
  const effort = modelSelection
    ? (getModelSelectionStringOptionValue(modelSelection, "reasoningEffort") ??
      getModelSelectionStringOptionValue(modelSelection, "effort"))
    : undefined;
  return {
    provider: input.driver,
    terminalStatus: input.providerTurn.status,
    usageStatus: usage?.usageStatus ?? "unavailable",
    usageScope: usage?.usageScope ?? "main_agent",
    ...(usage ? { hasSubagents: usage.hasSubagents } : {}),
    ...(usage?.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage?.cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: usage.cachedInputTokens }),
    ...(usage?.cacheCreationTokens === undefined
      ? {}
      : { cacheCreationTokens: usage.cacheCreationTokens }),
    ...(usage?.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage?.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
    ...(modelSelection ? { model: modelSelection.model, mixedModels: false } : {}),
    ...(effort ? { effort } : {}),
    ...(input.context?.runtimeMode ? { runtimeMode: input.context.runtimeMode } : {}),
    ...(input.context?.interactionMode ? { interactionMode: input.context.interactionMode } : {}),
    ...(input.providerTurn.startedAt && input.providerTurn.completedAt
      ? {
          durationMs: Math.max(
            0,
            DateTime.toEpochMillis(input.providerTurn.completedAt) -
              DateTime.toEpochMillis(input.providerTurn.startedAt),
          ),
        }
      : {}),
  };
}

type TodoListPlan = Extract<OrchestrationV2PlanArtifact, { readonly kind: "todo_list" }>;

function withPlanStepDurations(
  plan: TodoListPlan,
  previous: TodoListPlan | undefined,
  occurredAt: DateTime.Utc,
): TodoListPlan {
  const occurredAtIso = DateTime.formatIso(occurredAt);
  const occurredAtMs = DateTime.toEpochMillis(occurredAt);
  const previousById = new Map(previous?.steps.map((step) => [step.id, step]));
  // Provider step IDs may be positional. Changed text must not inherit another task's timing.
  const previousStep = (step: TodoListPlan["steps"][number]) => {
    const prior = previousById.get(step.id);
    return prior?.text === step.text ? prior : undefined;
  };
  const hasNewCompletion = plan.steps.some((step) => {
    const prior = previousStep(step);
    return step.status === "completed" && prior?.status !== "completed";
  });
  let fallbackCompletionConsumed = false;

  return {
    ...plan,
    steps: plan.steps.map((step) => {
      const prior = previousStep(step);
      const baseStep = { id: step.id, text: step.text, status: step.status };
      if (step.status === "completed") {
        if (prior?.status === "completed") {
          return {
            ...baseStep,
            ...(prior.durationMs === undefined ? {} : { durationMs: prior.durationMs }),
          };
        }
        const durationAnchorAt =
          prior?.status === "running" || !fallbackCompletionConsumed
            ? prior?.durationAnchorAt
            : occurredAtIso;
        fallbackCompletionConsumed = true;
        const anchorMs =
          durationAnchorAt === undefined ? occurredAtMs : Date.parse(durationAnchorAt);
        const durationMs = Number.isFinite(anchorMs) ? Math.max(0, occurredAtMs - anchorMs) : 0;
        return {
          ...baseStep,
          ...(durationMs > 0 ? { durationMs } : {}),
        };
      }
      if (step.status === "running") {
        return {
          ...baseStep,
          durationAnchorAt:
            prior?.status === "running" ? (prior.durationAnchorAt ?? occurredAtIso) : occurredAtIso,
        };
      }
      return {
        ...baseStep,
        durationAnchorAt:
          hasNewCompletion || prior?.status !== "pending"
            ? occurredAtIso
            : (prior.durationAnchorAt ?? occurredAtIso),
      };
    }),
  };
}

/** Settled runs that carried conversation to the provider. */
const CONVERSATION_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "completed",
  "interrupted",
  "failed",
]);

/**
 * Settled runs on a provider thread that a native rewind left off the active
 * branch. A run whose provider turn has a strong native ref is judged by that
 * ref. A run without one cannot be located, so it falls with everything after
 * the last run still on the branch.
 */
function runsOffNativeBranch(input: {
  readonly projection: Pick<OrchestrationV2ThreadProjection, "runs" | "attempts" | "providerTurns">;
  readonly providerThreadId: ProviderThreadId;
  readonly retainedNativeTurnIds: ReadonlySet<string>;
  readonly reportingRunId: RunId | undefined;
}): ReadonlyArray<OrchestrationV2Run> {
  const { attempts, providerTurns, runs } = input.projection;
  const nativeTurnId = (run: OrchestrationV2Run) => {
    const attempt = attempts.find((candidate) => candidate.id === run.activeAttemptId);
    if (attempt === undefined) return null;
    const ref = providerTurns.find(
      (turn) => turn.id === attempt.providerTurnId || turn.runAttemptId === attempt.id,
    )?.nativeTurnRef;
    return ref?.strength === "strong" ? ref.nativeId : null;
  };
  const settled = runs.flatMap((run) =>
    run.providerThreadId === input.providerThreadId &&
    run.id !== input.reportingRunId &&
    CONVERSATION_RUN_STATUSES.has(run.status)
      ? [{ run, nativeTurnId: nativeTurnId(run) }]
      : [],
  );
  const lastRetainedOrdinal = settled.reduce(
    (last, { run, nativeTurnId }) =>
      nativeTurnId !== null && input.retainedNativeTurnIds.has(nativeTurnId)
        ? Math.max(last, run.ordinal)
        : last,
    0,
  );
  return settled
    .filter(({ run, nativeTurnId }) =>
      nativeTurnId === null
        ? run.ordinal > lastRetainedOrdinal
        : !input.retainedNativeTurnIds.has(nativeTurnId),
    )
    .map(({ run }) => run);
}

export interface ProviderEventIngestInput {
  readonly providerSessionId: ProviderSessionId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly commandId?: CommandId;
  readonly threadId: ThreadId;
  readonly runId?: RunId;
  readonly nodeId?: NodeId;
  readonly rawEventId?: RawEventId;
  readonly event: ProviderAdapter.ProviderAdapterV2Event;
  readonly analyticsContext?: ProviderTurnAnalyticsContext;
}

export interface ProviderEventIngestorV2Shape {
  readonly normalize: (
    input: ProviderEventIngestInput,
  ) => Effect.Effect<ReadonlyArray<OrchestrationV2DomainEvent>, ProviderEventIngestorV2Error>;
  readonly ingestNormalized: (
    input: ProviderEventIngestInput & {
      /**
       * Atomically reject mutable provider state emitted by an attempt that
       * lost ownership while the adapter event was in flight.
       */
      readonly writeIfRunCurrent?: {
        readonly runId: RunId;
        readonly activeAttemptId: RunAttemptId;
        readonly expectedStatus: OrchestrationV2Run["status"];
      };
      /**
       * Atomically reject provider-thread snapshots from an attempt that no
       * longer owns the run or from a run that no longer owns the thread.
       */
      readonly writeIfProviderThreadOwner?: {
        readonly providerThreadId: ProviderThreadId;
        readonly runId: RunId;
        readonly activeAttemptId: RunAttemptId;
        readonly expectedLastRunOrdinal: number;
      };
    },
  ) => Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, ProviderEventIngestorV2Error>;
}

export class ProviderEventIngestorV2 extends Context.Service<
  ProviderEventIngestorV2,
  ProviderEventIngestorV2Shape
>()("t3/orchestration-v2/ProviderEventIngestor/ProviderEventIngestorV2") {}

function compactUndefined<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

const decodeDomainEvent = Schema.decodeUnknownEffect(OrchestrationV2DomainEvent);

export const layer: Layer.Layer<
  ProviderEventIngestorV2,
  never,
  | EventSink.EventSinkV2
  | IdAllocator.IdAllocatorV2
  | ProjectionStore.ProjectionStoreV2
  | ThreadCommandExecutor.ThreadCommandExecutor
> = Layer.effect(
  ProviderEventIngestorV2,
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const analytics = yield* ProviderTurnAnalytics;
    const completedTurnAnalytics = new Set<string>();

    const makeDomainEvent = (
      input: ProviderEventIngestInput,
      payloadInput: {
        readonly type: OrchestrationV2DomainEvent["type"];
        readonly payload: OrchestrationV2DomainEvent["payload"];
        readonly threadId?: ThreadId;
        readonly runId?: RunId | null;
        readonly nodeId?: NodeId | null;
        readonly occurredAt?: DateTime.Utc;
      },
    ) =>
      Effect.gen(function* () {
        const threadId = payloadInput.threadId ?? input.threadId;
        const eventId = yield* idAllocator.allocate.event({
          threadId,
          providerSessionId: input.providerSessionId,
        });
        const occurredAt = payloadInput.occurredAt ?? (yield* DateTime.now);
        return yield* decodeDomainEvent(
          compactUndefined({
            id: eventId,
            type: payloadInput.type,
            threadId,
            runId: payloadInput.runId ?? input.runId,
            nodeId: payloadInput.nodeId ?? input.nodeId,
            driver: input.event.driver,
            providerInstanceId: input.providerInstanceId,
            rawEventId: input.rawEventId,
            occurredAt,
            payload: payloadInput.payload,
          }),
        );
      });

    const dismissNativeUserInputs = Effect.fn("ProviderEventIngestor.dismissNativeUserInputs")(
      function* (
        input: ProviderEventIngestInput,
        providerTurnId: ProviderTurnId,
        threadId = input.threadId,
      ) {
        const pending = yield* projections.getPendingNativeUserInputs(threadId, providerTurnId);
        const now = yield* DateTime.now;
        const events: Array<OrchestrationV2DomainEvent> = [];
        for (const request of pending.runtimeRequests) {
          events.push(
            yield* makeDomainEvent(input, {
              type: "runtime-request.updated",
              threadId,
              nodeId: request.nodeId,
              payload: { ...request, status: "cancelled", resolvedAt: now },
            }),
          );
        }
        for (const node of pending.nodes) {
          events.push(
            yield* makeDomainEvent(input, {
              type: "node.updated",
              threadId,
              nodeId: node.id,
              runId: node.runId,
              payload: { ...node, status: "cancelled", completedAt: now },
            }),
          );
        }
        for (const item of pending.turnItems) {
          events.push(
            yield* makeDomainEvent(input, {
              type: "turn-item.updated",
              threadId,
              nodeId: item.nodeId,
              runId: item.runId,
              payload: { ...item, status: "cancelled", completedAt: now, updatedAt: now },
            }),
          );
        }
        return events;
      },
    );

    /**
     * A native subagent's thread starts on the parent's model when the
     * provider names the real one later (a Claude agent file's model arrives
     * with the subagent's first reply). Clients read the thread's model, so
     * move the thread to the reported one. Thread commands rewrite the whole
     * thread row under the thread's lock, so this read and write take it too.
     */
    const syncSubagentThreadModel = Effect.fn("ProviderEventIngestor.syncSubagentThreadModel")(
      function* (input: ProviderEventIngestInput, subagent: OrchestrationV2Subagent) {
        const { childThreadId, model } = subagent;
        if (subagent.origin !== "provider_native" || childThreadId === null || model === null) {
          return [];
        }
        const staleThread = projections.getThread(childThreadId).pipe(
          Effect.map((thread) => (thread.modelSelection.model === model ? null : thread)),
          Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
        );
        // Nearly every update already matches; only a mismatch takes the lock.
        if ((yield* staleThread) === null) return [];
        return yield* threadCommands.withLock(
          childThreadId,
          Effect.gen(function* () {
            const thread = yield* staleThread;
            if (thread === null) return [];
            const now = yield* DateTime.now;
            const event = yield* makeDomainEvent(input, {
              type: "thread.model-selection-updated",
              threadId: thread.id,
              // The parent's options belong to the parent's model.
              payload: {
                ...thread,
                modelSelection: { instanceId: thread.modelSelection.instanceId, model },
                updatedAt: now,
              },
              occurredAt: now,
            });
            return yield* eventSink.write({ events: [event] });
          }),
        );
      },
    );

    /**
     * The provider rewound its conversation outside T3. Retire the runs that
     * fell off its active branch with the same run, root-node, and checkpoint
     * updates CheckpointRollbackService writes for a T3 revert. The run
     * reporting the rewind performed it and stays, so it keeps lastRunOrdinal.
     */
    const rollBackRewoundRuns = Effect.fn("ProviderEventIngestor.rollBackRewoundRuns")(function* (
      input: ProviderEventIngestInput,
      rewind: {
        readonly threadId: ThreadId;
        readonly providerThreadId: ProviderThreadId;
        readonly retainedNativeTurnIds: ReadonlySet<string>;
      },
    ) {
      const projection = yield* projections.getThreadRecords(rewind.threadId, [
        "runs",
        "attempts",
        "providerTurns",
        "nodes",
        "checkpoints",
      ]);
      const runs = runsOffNativeBranch({
        projection,
        providerThreadId: rewind.providerThreadId,
        retainedNativeTurnIds: rewind.retainedNativeTurnIds,
        reportingRunId: input.runId,
      });
      if (runs.length === 0) return [];
      const now = yield* DateTime.now;
      const eventId = () =>
        idAllocator.allocate.event({
          threadId: rewind.threadId,
          providerSessionId: input.providerSessionId,
        });
      const runIds = new Set(runs.map((run) => run.id));
      const events: Array<OrchestrationV2DomainEvent> = [];
      for (const checkpoint of projection.checkpoints) {
        if (checkpoint.status !== "ready" || checkpoint.runId === null) continue;
        if (!runIds.has(checkpoint.runId)) continue;
        events.push({
          id: yield* eventId(),
          type: "checkpoint.captured",
          threadId: rewind.threadId,
          runId: checkpoint.runId,
          nodeId: checkpoint.nodeId,
          providerInstanceId: input.providerInstanceId,
          occurredAt: now,
          payload: { ...checkpoint, status: "stale" },
        });
      }
      for (const run of runs) {
        const rootNode = projection.nodes.find((node) => node.id === run.rootNodeId);
        events.push({
          id: yield* eventId(),
          type: "run.updated",
          threadId: rewind.threadId,
          runId: run.id,
          ...(rootNode === undefined ? {} : { nodeId: rootNode.id }),
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...run, status: "rolled_back", completedAt: now },
        });
        if (rootNode !== undefined) {
          events.push({
            id: yield* eventId(),
            type: "node.updated",
            threadId: rewind.threadId,
            runId: run.id,
            nodeId: rootNode.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...rootNode, status: "rolled_back", completedAt: now },
          });
        }
      }
      return events;
    });

    const normalize: ProviderEventIngestorV2Shape["normalize"] = (input) => {
      const providerEvent = input.event;
      if (providerEvent.type === "events.barrier") return Effect.succeed([]);
      return Effect.gen(function* () {
        switch (providerEvent.type) {
          case "app_thread.created": {
            // Native sessions can reannounce children after reconnecting. Creation
            // must not replace their durable app metadata, including promotion.
            const existing = yield* projections.getThread(providerEvent.appThread.id).pipe(
              Effect.catchTags({
                ProjectionStoreThreadNotFoundError: () => Effect.succeed(null),
              }),
            );
            if (existing !== null) return [];
            const parentId = providerEvent.appThread.lineage.parentThreadId;
            const parent =
              parentId === null
                ? null
                : yield* projections.getThread(parentId).pipe(
                    Effect.catchTags({
                      ProjectionStoreThreadNotFoundError: () => Effect.succeed(null),
                    }),
                  );
            const archiveOwner =
              parent !== null && parent.archivedAt !== null && parent.deletedAt === null
                ? (parent.archivedWith ?? {
                    threadId: parent.id,
                    commandId: CommandId.make(
                      `legacy-archive:${parent.id}:${DateTime.formatIso(parent.archivedAt)}`,
                    ),
                  })
                : parent?.archivedWith;
            const appThread =
              parent !== null && providerEvent.appThread.lineage.relationshipToParent === "subagent"
                ? {
                    ...providerEvent.appThread,
                    archivedAt: parent.archivedAt,
                    deletedAt: parent.deletedAt,
                    archivedWith: archiveOwner,
                    archivePending:
                      parent.archivedAt === null
                        ? compactThreadArchiveParticipant(parent.archivePending)
                        : null,
                  }
                : providerEvent.appThread;
            return [
              ...(parent !== null &&
              parent.archivedAt !== null &&
              parent.deletedAt === null &&
              parent.archivedWith == null &&
              providerEvent.appThread.lineage.relationshipToParent === "subagent"
                ? [
                    yield* makeDomainEvent(input, {
                      type: "thread.metadata-updated",
                      threadId: parent.id,
                      payload: { ...parent, archivedWith: archiveOwner },
                    }),
                  ]
                : []),
              yield* makeDomainEvent(input, {
                type: "thread.created",
                threadId: providerEvent.appThread.id,
                payload: appThread,
              }),
            ];
          }
          case "provider_session.updated":
            return [
              yield* makeDomainEvent(input, {
                type: "provider-session.updated",
                payload: providerEvent.providerSession,
              }),
            ];
          case "provider_thread.updated": {
            const threadId = providerEvent.providerThread.appThreadId ?? input.threadId;
            const updated = yield* makeDomainEvent(input, {
              type: "provider-thread.updated",
              threadId,
              payload: providerEvent.providerThread,
            });
            return providerEvent.retainedNativeTurnIds === undefined
              ? [updated]
              : [
                  updated,
                  ...(yield* rollBackRewoundRuns(input, {
                    threadId,
                    providerThreadId: providerEvent.providerThread.id,
                    retainedNativeTurnIds: new Set(providerEvent.retainedNativeTurnIds),
                  })),
                ];
          }
          case "provider_turn.updated":
            return [
              ...(["completed", "interrupted", "failed", "cancelled"].includes(
                providerEvent.providerTurn.status,
              )
                ? yield* dismissNativeUserInputs(
                    input,
                    providerEvent.providerTurn.id,
                    providerEvent.threadId,
                  )
                : []),
              yield* makeDomainEvent(input, {
                type: "provider-turn.updated",
                ...(providerEvent.threadId === undefined
                  ? {}
                  : { threadId: providerEvent.threadId }),
                payload: providerEvent.providerTurn,
                nodeId: providerEvent.providerTurn.nodeId,
              }),
            ];
          case "node.updated":
            return [
              yield* makeDomainEvent(input, {
                type: "node.updated",
                threadId: providerEvent.node.threadId,
                payload: providerEvent.node,
                runId: providerEvent.node.runId,
                nodeId: providerEvent.node.id,
              }),
            ];
          case "subagent.updated":
            return [
              yield* makeDomainEvent(input, {
                type: "subagent.updated",
                threadId: providerEvent.subagent.threadId,
                payload: providerEvent.subagent,
                runId: providerEvent.subagent.runId,
                nodeId: providerEvent.subagent.id,
              }),
            ];
          case "message.updated":
            return [
              yield* makeDomainEvent(input, {
                type: "message.updated",
                threadId: providerEvent.message.threadId,
                payload: providerEvent.message,
                runId: providerEvent.message.runId,
                nodeId: providerEvent.message.nodeId,
              }),
            ];
          case "turn_item.updated":
            return [
              yield* makeDomainEvent(input, {
                type: "turn-item.updated",
                threadId: providerEvent.turnItem.threadId,
                payload: stripUnservedToolOutputImageBytes(providerEvent.turnItem),
                runId: providerEvent.turnItem.runId,
                nodeId: providerEvent.turnItem.nodeId,
              }),
            ];
          case "runtime_request.updated":
            return [
              yield* makeDomainEvent(input, {
                type: "runtime-request.updated",
                ...(providerEvent.threadId === undefined
                  ? {}
                  : { threadId: providerEvent.threadId }),
                payload: providerEvent.runtimeRequest,
                nodeId: providerEvent.runtimeRequest.nodeId,
              }),
            ];
          case "plan.updated": {
            const occurredAt = yield* DateTime.now;
            const plan = providerEvent.plan;
            const previous =
              plan.kind === "todo_list"
                ? yield* projections.getPlan(plan.threadId, plan.id)
                : undefined;
            const payload =
              plan.kind === "todo_list"
                ? withPlanStepDurations(
                    plan,
                    previous?.kind === "todo_list" ? previous : undefined,
                    occurredAt,
                  )
                : plan;
            return [
              yield* makeDomainEvent(input, {
                type: "plan.updated",
                threadId: plan.threadId,
                payload,
                runId: plan.runId,
                nodeId: plan.nodeId,
                occurredAt,
              }),
            ];
          }
          case "turn.terminal":
            const dismissed = yield* dismissNativeUserInputs(input, providerEvent.providerTurnId);
            if (providerEvent.status !== "failed") {
              return dismissed;
            }
            const occurredAt = yield* DateTime.now;
            return [
              ...dismissed,
              yield* makeDomainEvent(input, {
                type: "turn-item.updated",
                payload: makeProviderFailureTurnItem({
                  driver: providerEvent.driver,
                  threadId: input.threadId,
                  runId: input.runId ?? null,
                  nodeId: input.nodeId ?? null,
                  providerThreadId: providerEvent.providerThreadId,
                  providerTurnId: providerEvent.providerTurnId,
                  itemOrdinal: providerEvent.failureItemOrdinal,
                  failure: providerEvent.failure,
                  ...(providerEvent.retry === undefined ? {} : { retry: providerEvent.retry }),
                  ...(providerEvent.retryStartedAt === undefined
                    ? {}
                    : { retryStartedAt: providerEvent.retryStartedAt }),
                  occurredAt,
                }),
              }),
            ];
        }
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderEventNormalizeError({
              providerSessionId: input.providerSessionId,
              threadId: input.threadId,
              providerEvent,
              cause,
            }),
        ),
      );
    };
    return ProviderEventIngestorV2.of({
      normalize,
      ingestNormalized: (input) =>
        Effect.gen(function* () {
          const normalizedEvents = yield* normalize(input);
          const summaries = yield* planIncomingMessageSummaries({
            events: normalizedEvents,
            commandId:
              input.commandId ?? CommandId.make(`command:incoming-preview:${input.rawEventId}`),
          }).pipe(
            Effect.provideService(ProjectionStore.ProjectionStoreV2, projections),
            Effect.mapError(
              (cause) =>
                new ProviderEventPublishError({
                  providerSessionId: input.providerSessionId,
                  eventCount: normalizedEvents.length,
                  cause,
                }),
            ),
          );
          const events = summaries.events;
          if (events.length === 0) {
            return [];
          }
          // A native child can become inactive before its provider identity
          // arrives. Later turns need fresh cleanup even after an earlier unload.
          const effects: Array<PendingOrchestrationEffectV2> = [...summaries.effects];
          const incoming = input.event;
          if (
            incoming.type === "provider_thread.updated" ||
            (incoming.type === "provider_turn.updated" &&
              (incoming.providerTurn.status === "pending" ||
                incoming.providerTurn.status === "running"))
          ) {
            const targetId =
              incoming.type === "provider_thread.updated"
                ? incoming.providerThread.appThreadId
                : (incoming.threadId ?? input.threadId);
            if (targetId !== null) {
              const owner = yield* projections.getThread(targetId).pipe(
                Effect.catchTags({
                  ProjectionStoreThreadNotFoundError: () => Effect.succeed(null),
                }),
                Effect.mapError(
                  (cause) =>
                    new ProviderEventNormalizeError({
                      providerSessionId: input.providerSessionId,
                      threadId: input.threadId,
                      providerEvent: incoming,
                      cause,
                    }),
                ),
              );
              if (owner !== null && (owner.archivedAt !== null || owner.deletedAt !== null)) {
                const providerThread =
                  incoming.type === "provider_thread.updated"
                    ? incoming.providerThread
                    : (yield* projections.getThreadRecords(targetId, ["providerThreads"]).pipe(
                        Effect.mapError(
                          (cause) =>
                            new ProviderEventNormalizeError({
                              providerSessionId: input.providerSessionId,
                              threadId: input.threadId,
                              providerEvent: incoming,
                              cause,
                            }),
                        ),
                      )).providerThreads.find(
                        (thread) => thread.id === incoming.providerTurn.providerThreadId,
                      );
                if (
                  providerThread?.appThreadId === targetId &&
                  providerThread.providerSessionId !== null
                ) {
                  const eventId = events.find(
                    (event) =>
                      event.type === "provider-thread.updated" ||
                      event.type === "provider-turn.updated",
                  )!.id;
                  effects.push({
                    id: `effect:inactive-native-detach:${eventId}`,
                    commandId:
                      input.commandId ??
                      CommandId.make(`command:inactive-native-detach:${eventId}`),
                    threadId: targetId,
                    request: {
                      type: "provider-session.detach",
                      providerSessionId: providerThread.providerSessionId,
                      revokeMcpCredential: true,
                    },
                  });
                }
              }
            }
          }
          const mapWriteError = (cause: unknown) =>
            new ProviderEventPublishError({
              providerSessionId: input.providerSessionId,
              eventCount: events.length,
              cause,
            });
          if (input.writeIfProviderThreadOwner !== undefined) {
            const ownerResult = yield* eventSink
              .writeIfProviderThreadOwner({
                guardPendingUserInputCancellations: true,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                ...input.writeIfProviderThreadOwner,
                events,
                effects,
              })
              .pipe(Effect.mapError(mapWriteError));
            return ownerResult.storedEvents;
          }
          if (input.writeIfRunCurrent === undefined) {
            const writeInput = {
              guardPendingUserInputCancellations: true,
              ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
              events,
            };
            return yield* (
              effects.length === 0
                ? eventSink.write(writeInput)
                : eventSink.writeWithEffects({ ...writeInput, effects })
            ).pipe(Effect.mapError(mapWriteError));
          }
          const result = yield* eventSink
            .writeIfRunCurrent({
              guardPendingUserInputCancellations: true,
              ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
              threadId: input.threadId,
              ...input.writeIfRunCurrent,
              events,
              effects,
            })
            .pipe(Effect.mapError(mapWriteError));
          return result.storedEvents;
        }).pipe(
          Effect.flatMap((storedEvents) =>
            storedEvents.length === 0 || input.event.type !== "subagent.updated"
              ? Effect.succeed(storedEvents)
              : syncSubagentThreadModel(input, input.event.subagent).pipe(
                  Effect.map((synced) => [...storedEvents, ...synced]),
                  Effect.mapError(
                    (cause) =>
                      new ProviderEventPublishError({
                        providerSessionId: input.providerSessionId,
                        eventCount: 1,
                        cause,
                      }),
                  ),
                ),
          ),
          Effect.tap((storedEvents) =>
            Effect.gen(function* () {
              if (storedEvents.length === 0 || input.event.type !== "provider_turn.updated") return;
              const providerTurn = input.event.providerTurn;
              if (
                providerTurn.status !== "completed" &&
                providerTurn.status !== "failed" &&
                providerTurn.status !== "interrupted" &&
                providerTurn.status !== "cancelled"
              )
                return;
              const key = `${input.providerInstanceId}:${providerTurn.id}`;
              if (completedTurnAnalytics.has(key)) return;
              completedTurnAnalytics.add(key);
              if (completedTurnAnalytics.size > 4096) {
                const oldest = completedTurnAnalytics.values().next().value;
                if (oldest !== undefined) completedTurnAnalytics.delete(oldest);
              }
              yield* analytics.record(
                providerTurnAnalyticsProperties({
                  driver: input.event.driver,
                  providerTurn,
                  ...(input.analyticsContext === undefined
                    ? {}
                    : { context: input.analyticsContext }),
                }),
              );
            }),
          ),
          (ingest) =>
            input.event.type === "app_thread.created" &&
            input.event.appThread.lineage.parentThreadId !== null
              ? threadCommands.withLock(input.event.appThread.lineage.parentThreadId, ingest)
              : input.event.type === "provider_thread.updated" &&
                  input.event.providerThread.appThreadId !== null
                ? threadCommands.withLock(input.event.providerThread.appThreadId, ingest)
                : input.event.type === "provider_turn.updated"
                  ? threadCommands.withLock(input.event.threadId ?? input.threadId, ingest)
                  : input.event.type === "message.updated" ||
                      input.event.type === "turn_item.updated"
                    ? threadCommands.withLock(
                        input.event.type === "message.updated"
                          ? input.event.message.threadId
                          : input.event.turnItem.threadId,
                        ingest,
                      )
                    : ingest,
        ),
    });
  }),
);
