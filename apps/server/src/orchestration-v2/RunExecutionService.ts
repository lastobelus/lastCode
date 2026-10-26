import { makeAssistantStreamingFilter } from "./assistantStreaming.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  isOrchestrationV2WorkActive,
  CommandId,
  type EventId,
  type ModelSelection,
  type NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type ProviderSessionId,
  type ProviderThreadId,
  type ProviderTurnId,
  type RunAttemptId,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Option from "effect/Option";
import * as ThreadRecoveryService from "./ThreadRecoveryService.ts";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProjectionStoreV2Error } from "./ProjectionStore.ts";
import {
  makeProviderFailure,
  makeProviderFailureTurnItem,
} from "@t3tools/provider-core/server/failure";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

export interface ProviderEventRoutingState {
  readonly ownedThreadIds: ReadonlySet<ThreadId>;
  // After root settlement, new children belong to the live run unless their coordinator still holds this run open.
  readonly rootTurnEnded: boolean;
  readonly workflowMemberParents: ReadonlyMap<ThreadId, ThreadId>;
  readonly ownedProviderThreadIds: ReadonlySet<ProviderThreadId>;
  readonly ownedProviderTurns: ReadonlyMap<ProviderTurnId, ProviderThreadId>;
  readonly inheritedBackgroundTurnItems: ReadonlyMap<TurnItemId, OrchestrationV2Run["id"]>;
  readonly rootProviderTurnId: ProviderTurnId | null;
}

export interface ProviderEventRouteIdentity {
  readonly threadId: ThreadId;
  readonly runId: OrchestrationV2Run["id"];
  readonly attemptId: RunAttemptId;
  readonly providerThreadId: ProviderThreadId;
}

export interface InheritedBackgroundTurnItemRoute {
  readonly id: TurnItemId;
  readonly runId: OrchestrationV2Run["id"];
}

type ProviderTerminalEvent = Extract<
  ProviderAdapter.ProviderAdapterV2Event,
  { readonly type: "turn.terminal" }
>;

function isTerminalProviderTurnStatus(status: OrchestrationV2ProviderTurn["status"]): boolean {
  return (
    status === "completed" ||
    status === "interrupted" ||
    status === "failed" ||
    status === "cancelled"
  );
}

function isSettledSubagentStatus(status: OrchestrationV2Subagent["status"]): boolean {
  return !isOrchestrationV2WorkActive(status);
}

/** A provider-native subagent's turns arrive on its parent's run, but the parent agent started them. */
const NATIVE_SUBAGENT_TURN_ORIGIN: ProviderEventIngestor.ProviderTurnOrigin = {
  createdBy: "agent",
  creationSource: "provider",
  scheduled: false,
  subagent: true,
};

const backgroundCapableTurnItemTypes: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "command_execution",
  "dynamic_tool",
  "subagent",
]);

function isSettledTurnItemStatus(status: OrchestrationV2TurnItem["status"]): boolean {
  return !isOrchestrationV2WorkActive(status);
}

function isSettledRunEligibleForInheritedBackground(status: OrchestrationV2Run["status"]): boolean {
  return status === "interrupted" || status === "failed" || status === "cancelled";
}

/** Use durable provider-thread lineage; sessions can host multiple threads. */
export function selectInheritedBackgroundTurnItems(input: {
  readonly threadId: ThreadId;
  readonly currentProviderThreadId: ProviderThreadId;
  readonly currentRunOrdinal: number;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
}): ReadonlyArray<InheritedBackgroundTurnItemRoute> {
  const settledPriorRunIds = new Set(
    input.runs
      .filter(
        (run) =>
          run.threadId === input.threadId &&
          run.ordinal < input.currentRunOrdinal &&
          isSettledRunEligibleForInheritedBackground(run.status),
      )
      .map((run) => run.id),
  );
  return input.turnItems.flatMap((turnItem) =>
    turnItem.threadId === input.threadId &&
    turnItem.providerThreadId === input.currentProviderThreadId &&
    turnItem.runId !== null &&
    settledPriorRunIds.has(turnItem.runId) &&
    backgroundCapableTurnItemTypes.has(turnItem.type) &&
    !isSettledTurnItemStatus(turnItem.status)
      ? [{ id: turnItem.id, runId: turnItem.runId }]
      : [],
  );
}

type SubagentTurnItem = Extract<OrchestrationV2TurnItem, { readonly type: "subagent" }>;

type OpenRunOwnedSubagentProjection = {
  readonly subagents: ReadonlyMap<NodeId, OrchestrationV2Subagent>;
  readonly turnItems: ReadonlyMap<NodeId, SubagentTurnItem>;
  readonly childTurnItems: ReadonlyMap<TurnItemId, OrchestrationV2TurnItem>;
  readonly nodes: ReadonlyMap<NodeId, OrchestrationV2ExecutionNode>;
  readonly linkedChildThreadIds: ReadonlySet<ThreadId>;
};

type RunOwnedSubagentTerminalStatus = Extract<
  OrchestrationV2Subagent["status"],
  "interrupted" | "failed" | "cancelled"
>;

function isOpenExecutionNodeStatus(status: OrchestrationV2ExecutionNode["status"]): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

function isRunOwnedSubagentTerminalStatus(
  status: ProviderTerminalEvent["status"],
): status is RunOwnedSubagentTerminalStatus {
  return status === "interrupted" || status === "failed" || status === "cancelled";
}

function childTurnsContinue(terminal: ProviderTerminalEvent): boolean {
  return terminal.status === "failed" && terminal.childTurnsContinue === true;
}

/** Launching runs still ingest running subagents; taking them over would duplicate events. */
export function canRouteRelatedSubagent(status: OrchestrationV2Subagent["status"]): boolean {
  return status === "completed";
}

function emptyOpenRunOwnedSubagentProjection(): OpenRunOwnedSubagentProjection {
  return {
    subagents: new Map(),
    turnItems: new Map(),
    childTurnItems: new Map(),
    nodes: new Map(),
    linkedChildThreadIds: new Set(),
  };
}

function withLinkedChildThreadId(
  current: OpenRunOwnedSubagentProjection,
  childThreadId: ThreadId | null,
): OpenRunOwnedSubagentProjection {
  if (childThreadId === null || current.linkedChildThreadIds.has(childThreadId)) {
    return current;
  }
  const linkedChildThreadIds = new Set(current.linkedChildThreadIds);
  linkedChildThreadIds.add(childThreadId);
  return { ...current, linkedChildThreadIds };
}

export const cascadeTerminalizeRunOwnedSubagents = Effect.fn(
  "RunExecutionService.cascadeTerminalizeRunOwnedSubagents",
)(function* (input: {
  readonly run: OrchestrationV2Run;
  readonly open: OpenRunOwnedSubagentProjection;
  readonly status: RunOwnedSubagentTerminalStatus;
  readonly completedAt: DateTime.Utc;
  readonly allocateEventId: () => Effect.Effect<EventId, IdAllocator.IdAllocatorV2AllocationError>;
}): Effect.fn.Return<
  ReadonlyArray<OrchestrationV2DomainEvent>,
  IdAllocator.IdAllocatorV2AllocationError
> {
  const events: Array<OrchestrationV2DomainEvent> = [];
  // Prefer lifetime linkage over currently-open rows: subagent/turn-item
  // snapshots may terminalize before the linked child-thread node settles.
  const childThreadIds = new Set(input.open.linkedChildThreadIds);
  for (const item of [...input.open.subagents.values(), ...input.open.turnItems.values()]) {
    if (item.childThreadId !== null) {
      childThreadIds.add(item.childThreadId);
    }
  }
  const keys = new Set<NodeId>([
    ...input.open.subagents.keys(),
    ...input.open.turnItems.keys(),
    ...input.open.nodes.keys(),
  ]);
  for (const key of keys) {
    const subagent = input.open.subagents.get(key);
    if (subagent !== undefined && !isSettledSubagentStatus(subagent.status)) {
      events.push({
        id: yield* input.allocateEventId(),
        type: "subagent.updated",
        threadId: subagent.threadId,
        runId: input.run.id,
        nodeId: subagent.id,
        driver: subagent.driver,
        providerInstanceId: subagent.providerInstanceId,
        occurredAt: input.completedAt,
        payload: {
          ...subagent,
          status: input.status,
          completedAt: input.completedAt,
          updatedAt: input.completedAt,
        },
      });
    }
    const node = input.open.nodes.get(key);
    if (
      node !== undefined &&
      ((node.threadId === input.run.threadId && node.runId === input.run.id) ||
        childThreadIds.has(node.threadId)) &&
      isOpenExecutionNodeStatus(node.status)
    ) {
      events.push({
        id: yield* input.allocateEventId(),
        type: "node.updated",
        threadId: node.threadId,
        runId: node.runId ?? input.run.id,
        nodeId: node.id,
        providerInstanceId: input.run.providerInstanceId,
        occurredAt: input.completedAt,
        payload: {
          ...node,
          status: input.status,
          completedAt: input.completedAt,
        },
      });
    }
    const turnItem = input.open.turnItems.get(key);
    if (
      turnItem !== undefined &&
      turnItem.runId === input.run.id &&
      !isSettledTurnItemStatus(turnItem.status)
    ) {
      events.push({
        id: yield* input.allocateEventId(),
        type: "turn-item.updated",
        threadId: turnItem.threadId,
        runId: input.run.id,
        ...(turnItem.nodeId === null ? {} : { nodeId: turnItem.nodeId }),
        providerInstanceId: input.run.providerInstanceId,
        occurredAt: input.completedAt,
        payload: {
          ...turnItem,
          status: input.status,
          completedAt: input.completedAt,
          updatedAt: input.completedAt,
        },
      });
    }
  }
  for (const turnItem of input.open.childTurnItems.values()) {
    if (!childThreadIds.has(turnItem.threadId) || isSettledTurnItemStatus(turnItem.status)) {
      continue;
    }
    events.push({
      id: yield* input.allocateEventId(),
      type: "turn-item.updated",
      threadId: turnItem.threadId,
      runId: turnItem.runId ?? input.run.id,
      ...(turnItem.nodeId === null ? {} : { nodeId: turnItem.nodeId }),
      providerInstanceId: input.run.providerInstanceId,
      occurredAt: input.completedAt,
      payload: {
        ...turnItem,
        ...("streaming" in turnItem ? { streaming: false } : {}),
        status: input.status,
        completedAt: input.completedAt,
        updatedAt: input.completedAt,
      },
    });
  }
  return events;
});

function finalProviderThreadStatus(
  disposition: ProviderTerminalEvent["threadDisposition"],
): OrchestrationV2ProviderThread["status"] {
  return disposition === "broken" ? "error" : "idle";
}

export function makeProviderEventRoutingState(input: {
  readonly identity: ProviderEventRouteIdentity;
  readonly inheritedBackgroundTurnItems?: ReadonlyArray<InheritedBackgroundTurnItemRoute>;
  readonly providerTurnId: ProviderTurnId | null;
  readonly relatedThreadIds?: ReadonlyArray<ThreadId>;
  readonly relatedProviderThreadIds?: ReadonlyArray<ProviderThreadId>;
}): ProviderEventRoutingState {
  return {
    ownedThreadIds: new Set([input.identity.threadId, ...(input.relatedThreadIds ?? [])]),
    rootTurnEnded: false,
    workflowMemberParents: new Map(),
    ownedProviderThreadIds: new Set([
      input.identity.providerThreadId,
      ...(input.relatedProviderThreadIds ?? []),
    ]),
    ownedProviderTurns:
      input.providerTurnId === null
        ? new Map()
        : new Map([[input.providerTurnId, input.identity.providerThreadId]]),
    inheritedBackgroundTurnItems: new Map(
      (input.inheritedBackgroundTurnItems ?? []).map((item) => [item.id, item.runId]),
    ),
    rootProviderTurnId: input.providerTurnId,
  };
}

export function routeProviderEvent(
  event: ProviderAdapter.ProviderAdapterV2Event,
  input: ProviderEventRouteIdentity,
  state: ProviderEventRoutingState,
): readonly [boolean, ProviderEventRoutingState] {
  const ownsThread = (threadId: ThreadId): boolean => state.ownedThreadIds.has(threadId);
  const ownsChildThread = (threadId: ThreadId): boolean =>
    threadId !== input.threadId && ownsThread(threadId);
  const ownsRun = (runId: string | null): boolean => runId === input.runId;
  const addProviderThread = (providerThreadId: ProviderThreadId): ProviderEventRoutingState => ({
    ...state,
    ownedProviderThreadIds: new Set([...state.ownedProviderThreadIds, providerThreadId]),
  });
  const addProviderTurn = (
    providerTurnId: ProviderTurnId,
    providerThreadId: ProviderThreadId,
    root: boolean,
  ): ProviderEventRoutingState => ({
    ...state,
    ownedProviderTurns: new Map(state.ownedProviderTurns).set(providerTurnId, providerThreadId),
    rootProviderTurnId: root ? providerTurnId : state.rootProviderTurnId,
  });

  switch (event.type) {
    case "events.barrier":
      return [true, state];
    case "provider_session.updated":
      return [false, state];
    case "app_thread.created": {
      if (event.appThread.id === input.threadId) {
        return [true, state];
      }
      const isOwnedSubagent =
        event.appThread.lineage.relationshipToParent === "subagent" &&
        event.appThread.lineage.parentThreadId !== null &&
        ownsThread(event.appThread.lineage.parentThreadId) &&
        (!state.rootTurnEnded ||
          state.workflowMemberParents.get(event.appThread.id) ===
            event.appThread.lineage.parentThreadId);
      if (!isOwnedSubagent) {
        return [false, state];
      }
      return [
        true,
        {
          ...state,
          ownedThreadIds: new Set([...state.ownedThreadIds, event.appThread.id]),
        },
      ];
    }
    case "provider_thread.updated": {
      const belongs =
        state.ownedProviderThreadIds.has(event.providerThread.id) ||
        (event.providerThread.appThreadId !== null && ownsThread(event.providerThread.appThreadId));
      return belongs ? [true, addProviderThread(event.providerThread.id)] : [false, state];
    }
    case "provider_turn.updated": {
      const isRoot = event.providerTurn.runAttemptId === input.attemptId;
      const belongs =
        isRoot ||
        (event.providerTurn.providerThreadId !== input.providerThreadId &&
          state.ownedProviderThreadIds.has(event.providerTurn.providerThreadId)) ||
        state.ownedProviderTurns.has(event.providerTurn.id) ||
        (event.threadId !== undefined && ownsChildThread(event.threadId));
      return belongs
        ? [
            true,
            addProviderTurn(event.providerTurn.id, event.providerTurn.providerThreadId, isRoot),
          ]
        : [false, state];
    }
    case "node.updated": {
      const belongs = ownsRun(event.node.runId) || ownsChildThread(event.node.threadId);
      if (!belongs || event.node.providerThreadId === null) {
        return [belongs, state];
      }
      return [true, addProviderThread(event.node.providerThreadId)];
    }
    case "subagent.updated": {
      const moved = event.subagent;
      if (
        moved.origin === "provider_native" &&
        moved.threadId === input.threadId &&
        moved.runId !== null &&
        !ownsRun(moved.runId) &&
        moved.childThreadId !== null &&
        ownsChildThread(moved.childThreadId)
      ) {
        const ownedThreadIds = new Set(state.ownedThreadIds);
        ownedThreadIds.delete(moved.childThreadId);
        const ownedProviderThreadIds = new Set(state.ownedProviderThreadIds);
        if (moved.providerThreadId !== null) ownedProviderThreadIds.delete(moved.providerThreadId);
        const ownedProviderTurns = new Map(state.ownedProviderTurns);
        for (const [turnId, threadId] of ownedProviderTurns) {
          if (threadId === moved.providerThreadId) ownedProviderTurns.delete(turnId);
        }
        return [false, { ...state, ownedThreadIds, ownedProviderThreadIds, ownedProviderTurns }];
      }
      const belongs = ownsRun(event.subagent.runId) || ownsChildThread(event.subagent.threadId);
      const coordinator = event.subagent;
      // Resumes reattribute child threads to the live run, which may not have observed their creation.
      const adopted =
        ownsRun(coordinator.runId) &&
        !state.rootTurnEnded &&
        isOrchestrationV2WorkActive(coordinator.status) &&
        coordinator.origin === "provider_native" &&
        coordinator.childThreadId !== null &&
        !ownsThread(coordinator.childThreadId)
          ? {
              ...state,
              ownedThreadIds: new Set([...state.ownedThreadIds, coordinator.childThreadId]),
            }
          : state;
      if (
        !ownsRun(coordinator.runId) ||
        coordinator.workflow === undefined ||
        coordinator.childThreadId === null
      ) {
        return [belongs, adopted];
      }
      const workflowMemberParents = new Map(state.workflowMemberParents);
      for (const member of coordinator.workflow.agents) {
        if (member.childThreadId !== undefined) {
          workflowMemberParents.set(member.childThreadId, coordinator.childThreadId);
        }
      }
      return [true, { ...adopted, workflowMemberParents }];
    }
    case "message.updated":
      return [ownsRun(event.message.runId) || ownsChildThread(event.message.threadId), state];
    case "turn_item.updated": {
      if (ownsRun(event.turnItem.runId) || ownsChildThread(event.turnItem.threadId)) {
        return [true, state];
      }
      const inheritedRunId = state.inheritedBackgroundTurnItems.get(event.turnItem.id);
      const isInheritedBackgroundItem =
        event.turnItem.threadId === input.threadId &&
        event.turnItem.runId !== null &&
        event.turnItem.runId === inheritedRunId &&
        backgroundCapableTurnItemTypes.has(event.turnItem.type);
      if (!isInheritedBackgroundItem) {
        return [false, state];
      }
      if (!isSettledTurnItemStatus(event.turnItem.status)) {
        return [true, state];
      }
      const inheritedBackgroundTurnItems = new Map(state.inheritedBackgroundTurnItems);
      inheritedBackgroundTurnItems.delete(event.turnItem.id);
      return [true, { ...state, inheritedBackgroundTurnItems }];
    }
    case "plan.updated":
      return [ownsRun(event.plan.runId) || ownsChildThread(event.plan.threadId), state];
    case "runtime_request.updated":
      return [
        (event.threadId !== undefined && ownsChildThread(event.threadId)) ||
          (event.runtimeRequest.providerTurnId !== null &&
            state.ownedProviderTurns.has(event.runtimeRequest.providerTurnId)),
        state,
      ];
    case "command_output.delta":
      // The session manager hands live output to the command output hub; runs never see it.
      return [false, state];
    case "turn.terminal":
      return event.providerTurnId === state.rootProviderTurnId
        ? [true, { ...state, rootTurnEnded: true }]
        : [false, state];
  }
}

export class RunExecutionStartError extends Schema.TaggedError<RunExecutionStartError>()(
  "RunExecutionStartError",
  {
    commandId: CommandId,
    runId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to start orchestration V2 run execution ${this.runId}.`;
  }
}

export class RunExecutionIngestError extends Schema.TaggedError<RunExecutionIngestError>()(
  "RunExecutionIngestError",
  {
    runId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed while ingesting orchestration V2 run execution ${this.runId}.`;
  }
}

const isRunExecutionIngestError = Schema.is(RunExecutionIngestError);

export const RunExecutionServiceV2Error = Schema.Union([
  RunExecutionStartError,
  RunExecutionIngestError,
]);
export type RunExecutionServiceV2Error = typeof RunExecutionServiceV2Error.Type;

export interface RunExecutionServiceV2StartRootRunInput {
  readonly commandId: CommandId;
  readonly appThread: OrchestrationV2AppThread;
  readonly providerSessionId: ProviderSessionId;
  readonly session: ProviderAdapter.ProviderAdapterV2SessionRuntime;
  readonly run: OrchestrationV2Run;
  readonly rootNode: OrchestrationV2ExecutionNode;
  readonly checkpointScope: OrchestrationV2CheckpointScope;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly attempt: OrchestrationV2RunAttempt;
  readonly attemptId: RunAttemptId;
  readonly providerTurnOrdinal: number;
  readonly nativeThreadHasTurns?: boolean;
  readonly loadInheritedBackgroundTurnItems?: () => Effect.Effect<
    ReadonlyArray<InheritedBackgroundTurnItemRoute>,
    unknown
  >;
  readonly relatedThreadIds?: ReadonlyArray<ThreadId>;
  readonly relatedProviderThreadIds?: ReadonlyArray<ProviderThreadId>;
  readonly shouldStartProviderTurn?: () => Effect.Effect<boolean, ProjectionStoreV2Error>;
  readonly shouldFinalizeRun?: () => Effect.Effect<boolean, ProjectionStoreV2Error>;
  readonly hasUnpairedRunInterruptRequest?: () => Effect.Effect<boolean, never>;
  readonly loadRunInterruptReason?: () => Effect.Effect<string | undefined, never>;
  /** Records actual native acceptance rather than merely scheduling a start. */
  readonly onMessageDelivery?: (delivered: boolean) => Effect.Effect<void>;
  readonly message: ProviderAdapter.ProviderAdapterV2TurnMessage;
  readonly modelSelection: ModelSelection;
  readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
}

export interface RunExecutionServiceV2Shape {
  readonly startRootRun: (
    input: RunExecutionServiceV2StartRootRunInput,
  ) => Effect.Effect<void, RunExecutionServiceV2Error>;
}

export class RunExecutionServiceV2 extends Context.Service<
  RunExecutionServiceV2,
  RunExecutionServiceV2Shape
>()("t3/orchestration-v2/RunExecutionService/RunExecutionServiceV2") {}

export const layer: Layer.Layer<
  RunExecutionServiceV2,
  never,
  | CheckpointService.CheckpointServiceV2
  | EventSink.EventSinkV2
  | IdAllocator.IdAllocatorV2
  | ProviderEventIngestor.ProviderEventIngestorV2
  | ProjectionStore.ProjectionStoreV2
  | ServerSettings.ServerSettingsService
  | McpAppModelContext.McpAppModelContext
  | TurnItemPositionStore.TurnItemPositionStoreV2
> = Layer.effect(
  RunExecutionServiceV2,
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const checkpointService = yield* CheckpointService.CheckpointServiceV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const providerEventIngestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const mcpAppModelContext = yield* McpAppModelContext.McpAppModelContext;
    const turnItemPositions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const finalizationObserver = yield* RunFinalizationService.RunFinalizationObserver;
    const recovery = yield* Effect.serviceOption(ThreadRecoveryService.ThreadRecoveryService);
    const projections = yield* ProjectionStore.ProjectionStoreV2;

    const writeFinalRunEvents = Effect.fn("RunExecutionService.writeFinalRunEvents")(
      function* (input: {
        readonly run: OrchestrationV2Run;
        readonly rootNode: OrchestrationV2ExecutionNode;
        readonly checkpointScope: OrchestrationV2CheckpointScope;
        readonly providerThread: OrchestrationV2ProviderThread;
        readonly attempt: OrchestrationV2RunAttempt;
        readonly shouldFinalizeRun?: () => Effect.Effect<boolean, ProjectionStoreV2Error>;
        readonly hasUnpairedRunInterruptRequest?: () => Effect.Effect<boolean, never>;
        readonly loadRunInterruptReason?: () => Effect.Effect<string | undefined, never>;
        readonly openRunOwnedSubagents?: OpenRunOwnedSubagentProjection;
        readonly interruptedProviderTurn?: OrchestrationV2ProviderTurn;
        readonly terminal: ProviderTerminalEvent;
        readonly completedAt?: DateTime.Utc;
        readonly recoveryReceipt?: ReadonlyArray<OrchestrationV2DomainEvent>;
        readonly backgroundSettlement?: ReadonlyArray<OrchestrationV2DomainEvent>;
        readonly backgroundProviderSessionId?: ProviderSessionId;
        readonly clearPendingBackgroundTasks?: boolean;
        readonly failureItemPersisted: boolean;
        readonly refreshAfterTurn: Effect.Effect<void>;
        readonly writeIfRunCurrent?: {
          readonly activeAttemptId: RunAttemptId;
          readonly expectedStatus: OrchestrationV2Run["status"];
        };
      }) {
        const completedAt = input.completedAt ?? (yield* DateTime.now);
        const finalizedAttempt: OrchestrationV2RunAttempt | null = {
          ...input.attempt,
          status: input.terminal.status,
          completedAt,
        };
        const shouldFinalizeRun =
          input.shouldFinalizeRun === undefined ? true : yield* input.shouldFinalizeRun();
        if (!shouldFinalizeRun) {
          if (input.terminal.status === "interrupted") {
            const hasUnpairedRequest =
              input.hasUnpairedRunInterruptRequest === undefined
                ? false
                : yield* input.hasUnpairedRunInterruptRequest();
            if (hasUnpairedRequest) {
              const reason =
                input.loadRunInterruptReason === undefined
                  ? undefined
                  : yield* input.loadRunInterruptReason();
              yield* eventSink.writeWithEffects({
                effects: [],
                events: [
                  {
                    id: yield* idAllocator.allocate.event({ threadId: input.run.threadId }),
                    type: "turn-item.updated" as const,
                    threadId: input.run.threadId,
                    runId: input.run.id,
                    nodeId: input.rootNode.id,
                    providerInstanceId: input.run.providerInstanceId,
                    occurredAt: completedAt,
                    payload: makeInterruptResultTurnItem({
                      idAllocator,
                      run: input.run,
                      rootNode: input.rootNode,
                      providerThread: input.providerThread,
                      reason,
                      completedAt,
                    }),
                  },
                ],
              });
              yield* input.refreshAfterTurn;
            }
          }
          return;
        }
        const allocateEventId = () => idAllocator.allocate.event({ threadId: input.run.threadId });
        const reason =
          input.terminal.status === "interrupted" && input.loadRunInterruptReason !== undefined
            ? yield* input.loadRunInterruptReason()
            : undefined;
        const open = input.openRunOwnedSubagents ?? emptyOpenRunOwnedSubagentProjection();
        const hasOpenSubagentProjection =
          open.subagents.size > 0 ||
          open.turnItems.size > 0 ||
          open.childTurnItems.size > 0 ||
          open.nodes.size > 0;
        const cascadedSubagentEvents =
          input.backgroundSettlement === undefined &&
          isRunOwnedSubagentTerminalStatus(input.terminal.status) &&
          !childTurnsContinue(input.terminal) &&
          hasOpenSubagentProjection
            ? yield* cascadeTerminalizeRunOwnedSubagents({
                run: input.run,
                open,
                status: input.terminal.status,
                completedAt,
                allocateEventId,
              })
            : [];
        const persistedStatus =
          input.terminal.status === "completed" ? "waiting" : input.terminal.status;
        // Omit delegatedCompletion; the startup snapshot must not overwrite newer acknowledgements, successors, or Stop barriers.
        const { delegatedCompletion: _delegatedCompletion, ...runWithoutDelegatedCompletion } =
          input.run;
        const finalizedRun: OrchestrationV2Run = {
          ...runWithoutDelegatedCompletion,
          status: persistedStatus,
          completedAt: input.terminal.status === "completed" ? null : completedAt,
        };
        const finalizedRootNode: OrchestrationV2ExecutionNode = {
          ...input.rootNode,
          status: persistedStatus,
          completedAt: input.terminal.status === "completed" ? null : completedAt,
          checkpointScopeId: input.checkpointScope.id,
        };
        const finalizedProviderThread: OrchestrationV2ProviderThread = {
          ...input.providerThread,
          status: finalProviderThreadStatus(input.terminal.threadDisposition),
          ...(input.clearPendingBackgroundTasks ? { pendingBackgroundTasks: [] } : {}),
          updatedAt: completedAt,
        };
        const runEventId = yield* allocateEventId();
        const nodeEventId = yield* allocateEventId();
        const providerThreadEventId = yield* allocateEventId();
        const checkpointCaptureCommandId = CommandId.make(
          `command:effect:checkpoint.capture:${input.run.id}`,
        );
        // Stopped runs capture rollback points for the next message; enqueue before later starts on this effect lane.
        const finalization = {
          effects:
            input.terminal.status === "completed" ||
            input.terminal.status === "interrupted" ||
            input.terminal.status === "cancelled"
              ? [
                  {
                    id: `effect:checkpoint.capture:${input.run.id}`,
                    commandId: checkpointCaptureCommandId,
                    threadId: input.run.threadId,
                    request: {
                      type: "checkpoint.capture" as const,
                      runId: input.run.id,
                      scopeId: input.checkpointScope.id,
                    },
                  },
                ]
              : [],
          events: [
            ...(input.recoveryReceipt ?? []),
            ...(input.backgroundSettlement ?? []),
            // Terminalize open run-owned subagent rows before the root run
            // settles so projections never keep a forever-running subagent card.
            ...cascadedSubagentEvents,
            ...(input.interruptedProviderTurn === undefined
              ? []
              : [
                  {
                    id: yield* allocateEventId(),
                    type: "provider-turn.updated" as const,
                    threadId: input.run.threadId,
                    runId: input.run.id,
                    nodeId: input.rootNode.id,
                    providerInstanceId: input.run.providerInstanceId,
                    occurredAt: completedAt,
                    payload: {
                      ...input.interruptedProviderTurn,
                      status: "interrupted" as const,
                      completedAt,
                    },
                  },
                ]),
            ...(finalizedAttempt === null
              ? []
              : [
                  {
                    id: yield* allocateEventId(),
                    type: "run-attempt.updated" as const,
                    threadId: input.run.threadId,
                    runId: input.run.id,
                    nodeId: input.rootNode.id,
                    providerInstanceId: input.run.providerInstanceId,
                    occurredAt: completedAt,
                    payload: finalizedAttempt,
                  },
                ]),
            ...(input.terminal.status === "interrupted"
              ? [
                  {
                    id: yield* allocateEventId(),
                    type: "turn-item.updated" as const,
                    threadId: input.run.threadId,
                    runId: input.run.id,
                    nodeId: input.rootNode.id,
                    providerInstanceId: input.run.providerInstanceId,
                    occurredAt: completedAt,
                    payload: makeInterruptResultTurnItem({
                      idAllocator,
                      run: input.run,
                      rootNode: input.rootNode,
                      providerThread: input.providerThread,
                      reason,
                      completedAt,
                    }),
                  },
                ]
              : []),
            ...(input.terminal.status === "failed" && !input.failureItemPersisted
              ? [
                  {
                    id: yield* allocateEventId(),
                    type: "turn-item.updated" as const,
                    threadId: input.run.threadId,
                    runId: input.run.id,
                    nodeId: input.rootNode.id,
                    providerInstanceId: input.run.providerInstanceId,
                    occurredAt: completedAt,
                    payload: makeProviderFailureTurnItem({
                      driver: input.terminal.driver,
                      threadId: input.run.threadId,
                      runId: input.run.id,
                      nodeId: input.rootNode.id,
                      providerThreadId: input.terminal.providerThreadId,
                      providerTurnId: input.terminal.providerTurnId,
                      itemOrdinal: input.terminal.failureItemOrdinal,
                      failure: input.terminal.failure,
                      occurredAt: completedAt,
                    }),
                  },
                ]
              : []),
            {
              id: runEventId,
              type: "run.updated",
              threadId: input.run.threadId,
              runId: input.run.id,
              nodeId: input.rootNode.id,
              providerInstanceId: input.run.providerInstanceId,
              occurredAt: completedAt,
              payload: finalizedRun,
            },
            {
              id: nodeEventId,
              type: "node.updated",
              threadId: input.run.threadId,
              runId: input.run.id,
              nodeId: input.rootNode.id,
              providerInstanceId: input.run.providerInstanceId,
              occurredAt: completedAt,
              payload: finalizedRootNode,
            },
            {
              id: providerThreadEventId,
              type: "provider-thread.updated",
              threadId: input.run.threadId,
              providerInstanceId: input.run.providerInstanceId,
              occurredAt: completedAt,
              payload: finalizedProviderThread,
            },
          ],
        } satisfies Parameters<typeof eventSink.writeWithEffects>[0];
        if (input.writeIfRunCurrent !== undefined) {
          const result = yield* eventSink.writeIfRunCurrent({
            threadId: input.run.threadId,
            runId: input.run.id,
            activeAttemptId: input.writeIfRunCurrent.activeAttemptId,
            expectedStatus: input.writeIfRunCurrent.expectedStatus,
            events: finalization.events,
            effects: finalization.effects,
            guardPendingUserInputCancellations: true,
            ...(input.backgroundSettlement === undefined ||
            input.backgroundProviderSessionId === undefined
              ? {}
              : {
                  guardRecoveredBackground: {
                    threadId: input.run.threadId,
                    runId: input.run.id,
                    providerThreadId: input.providerThread.id,
                    providerSessionId: input.backgroundProviderSessionId,
                    eventIds: [
                      ...input.backgroundSettlement.map((event) => event.id),
                      providerThreadEventId,
                    ],
                  },
                }),
          });
          if (!result.committed) {
            return;
          }
        } else {
          yield* eventSink.writeWithEffects(finalization);
        }
        yield* input.refreshAfterTurn;
      },
    );

    return RunExecutionServiceV2.of({
      startRootRun: Effect.fn("RunExecutionService.startRootRun")(function* (input) {
        const rootTurnOrigin: ProviderEventIngestor.ProviderTurnOrigin = {
          createdBy: input.message.createdBy,
          creationSource: input.message.creationSource,
          scheduled: input.message.scheduledTaskId !== undefined,
          subagent: input.appThread.lineage.relationshipToParent === "subagent",
        };
        return yield* guardEventReaderStartup(function* (startup) {
          // Startup failure and stream shutdown can report the same attempt.
          const refreshAfterTurn = yield* Effect.cached(
            finalizationObserver.refreshAfterTurn(input.appThread.projectId).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("failed to refresh pull requests after run termination", {
                  threadId: input.run.threadId,
                  runId: input.run.id,
                  cause,
                }),
              ),
            ),
          );
          const makeFailedTerminalEvent = (
            failure: OrchestrationV2ProviderFailure,
            failureItemOrdinal: number,
          ): ProviderTerminalEvent => ({
            type: "turn.terminal",
            driver: input.providerThread.driver,
            providerThreadId: input.providerThread.id,
            providerTurnId:
              input.attempt.providerTurnId ??
              idAllocator.derive.providerTurn({
                driver: input.providerThread.driver,
                nativeTurnId: `failed:${input.attempt.id}`,
              }),
            runOrdinal: input.run.ordinal,
            failureItemOrdinal,
            status: "failed",
            failure,
            threadDisposition: "reusable",
          });
          const responseStreamingMode = yield* Effect.gen(function* () {
            const responseStreamingMode = yield* serverSettings.getSettings.pipe(
              Effect.map(
                (settings) =>
                  resolveProjectSettings(settings, input.appThread.projectId).settings
                    .responseStreamingMode,
              ),
            );
            yield* checkpointService
              .captureBaseline({
                scope: input.checkpointScope,
                ordinalWithinScope: Math.max(0, input.run.ordinal - 1),
              })
              .pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.failCause(cause)
                    : Effect.logWarning(
                        "orchestration V2 checkpoint baseline capture failed; starting provider without a baseline",
                        { runId: input.run.id },
                      ),
                ),
              );
            if (
              input.shouldStartProviderTurn !== undefined &&
              !(yield* input.shouldStartProviderTurn())
            ) {
              yield* input.onMessageDelivery?.(false) ?? Effect.void;
              return null;
            }
            return responseStreamingMode;
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                if (Cause.hasInterruptsOnly(cause)) {
                  return yield* Effect.failCause(cause);
                }
                yield* Effect.logError("orchestration V2 run preparation failed", {
                  runId: input.run.id,
                  cause,
                });
                yield* input.onMessageDelivery?.(false) ?? Effect.void;
                yield* writeFinalRunEvents({
                  run: input.run,
                  rootNode: input.rootNode,
                  checkpointScope: input.checkpointScope,
                  providerThread: input.providerThread,
                  attempt: input.attempt,
                  terminal: makeFailedTerminalEvent(
                    makeProviderFailure({
                      cause: Cause.squash(cause),
                      message: "Run preparation failed.",
                      class: "unknown",
                    }),
                    input.providerTurnOrdinal * 100 + 1,
                  ),
                  failureItemPersisted: false,
                  refreshAfterTurn,
                  writeIfRunCurrent: {
                    activeAttemptId: input.attemptId,
                    expectedStatus: "running",
                  },
                });
                return null;
              }),
            ),
            Effect.mapError(
              (cause) =>
                new RunExecutionStartError({
                  commandId: input.commandId,
                  runId: input.run.id,
                  cause,
                }),
            ),
          );
          if (responseStreamingMode === null) {
            return;
          }
          const recoveryIdentity = {
            threadId: input.run.threadId,
            runId: input.run.id,
            attemptId: input.attempt.id,
          };
          const recoveryService =
            Option.isSome(recovery) && input.session.inspectTurn !== undefined
              ? recovery.value
              : undefined;
          const markSuspect =
            recoveryService
              ?.suspect(recoveryIdentity)
              .pipe(
                Effect.mapError(
                  (cause) => new RunExecutionIngestError({ runId: input.run.id, cause }),
                ),
              ) ?? Effect.void;
          const consumerStopped = yield* Ref.make(false);
          const terminalEvent = yield* Ref.make<ProviderTerminalEvent | null>(null);
          const latestTurnItemOrdinal = yield* Ref.make(input.providerTurnOrdinal * 100);
          const latestProviderThread = yield* Ref.make(input.providerThread);
          const latestRootProviderTurn = yield* Ref.make<OrchestrationV2ProviderTurn | null>(null);
          const routeIdentity: ProviderEventRouteIdentity = {
            threadId: input.run.threadId,
            runId: input.run.id,
            attemptId: input.attempt.id,
            providerThreadId: input.providerThread.id,
          };
          // The accepted run is already projected before this reader is acquired,
          // and provider start happens only after the consumer owns its lifetime.
          const eventSubscription =
            input.session.subscribeEvents === undefined
              ? { events: input.session.events, close: Effect.void }
              : yield* startup.acquire(input.session.subscribeEvents);
          const inheritedBackgroundTurnItems = yield* (
            input.loadInheritedBackgroundTurnItems?.() ?? Effect.succeed([])
          ).pipe(
            Effect.onError(() => eventSubscription.close),
            Effect.mapError(
              (cause) =>
                new RunExecutionStartError({
                  commandId: input.commandId,
                  runId: input.run.id,
                  cause,
                }),
            ),
          );
          const inheritedBackgroundTurnItemsById = new Map(
            inheritedBackgroundTurnItems.map((item) => [item.id, item.runId]),
          );
          const eventRouting = yield* Ref.make<ProviderEventRoutingState>(
            makeProviderEventRoutingState({
              identity: routeIdentity,
              inheritedBackgroundTurnItems,
              providerTurnId: input.attempt.providerTurnId,
              ...(input.relatedThreadIds === undefined
                ? {}
                : { relatedThreadIds: input.relatedThreadIds }),
              ...(input.relatedProviderThreadIds === undefined
                ? {}
                : { relatedProviderThreadIds: input.relatedProviderThreadIds }),
            }),
          );
          const rootTerminalSeen = yield* Ref.make(false);
          const rootRunFinalized = yield* Ref.make(false);
          const providerThreadOwnerLost = yield* Ref.make(false);
          const activeChildProviderTurns = yield* Ref.make<ReadonlySet<ProviderTurnId>>(new Set());
          const activeChildSubagents = yield* Ref.make<ReadonlyMap<NodeId, ThreadId>>(new Map());
          const activeBackgroundTurnItems = yield* Ref.make<
            ReadonlySet<OrchestrationV2TurnItem["id"]>
          >(new Set(inheritedBackgroundTurnItemsById.keys()));
          const openRunOwnedSubagents = yield* Ref.make(emptyOpenRunOwnedSubagentProjection());
          const openRootBackgroundTurnItems = yield* Ref.make<
            ReadonlyMap<TurnItemId, OrchestrationV2TurnItem>
          >(new Map());
          const recoveredBackgroundDrain = yield* Ref.make(false);
          const activeSubscription =
            yield* Ref.make<ProviderAdapter.ProviderAdapterV2EventSubscription>(eventSubscription);
          const drainRequested = yield* Ref.make(false);
          const drainObserved = yield* Ref.make<
            ProviderAdapter.ProviderBackgroundWorkObservation | "unobserved"
          >("unobserved");
          const hydrateBackgroundProjection = Effect.gen(function* () {
            {
              // Reload saved rows: recording can commit an item before its
              // lifecycle tracker fails, and a child can finish or be resumed
              // independently while this reader is stopped.
              const source = yield* projections.getThreadRecords(
                input.run.threadId,
                ["nodes", "subagents", "turnItems", "providerThreads"],
                { turnItemRunId: input.run.id },
              );
              let open = emptyOpenRunOwnedSubagentProjection();
              const rootItems = new Map<TurnItemId, OrchestrationV2TurnItem>();
              const parentNodeIds = new Set<NodeId>();
              const ownedThreadIds = new Set<ThreadId>();
              const ownedProviderThreadIds = new Set<ProviderThreadId>();
              for (const subagent of source.subagents) {
                if (
                  subagent.threadId !== input.run.threadId ||
                  subagent.runId !== input.run.id ||
                  subagent.origin !== "provider_native" ||
                  subagent.providerInstanceId !== input.run.providerInstanceId ||
                  (subagent.providerThreadId !== null &&
                    !source.providerThreads.some(
                      (thread) =>
                        thread.id === subagent.providerThreadId &&
                        thread.providerSessionId === input.providerSessionId,
                    ))
                )
                  continue;
                parentNodeIds.add(subagent.id);
                if (subagent.providerThreadId !== null)
                  ownedProviderThreadIds.add(subagent.providerThreadId);
                open = withLinkedChildThreadId(open, subagent.childThreadId);
                if (!isSettledSubagentStatus(subagent.status))
                  open = {
                    ...open,
                    subagents: new Map(open.subagents).set(subagent.id, subagent),
                  };
              }
              for (const item of source.turnItems) {
                if (item.threadId !== input.run.threadId || item.runId !== input.run.id) continue;
                if (item.type === "subagent") {
                  if (
                    item.origin !== "provider_native" ||
                    item.providerInstanceId !== input.run.providerInstanceId ||
                    (item.providerThreadId !== null &&
                      !source.providerThreads.some(
                        (thread) =>
                          thread.id === item.providerThreadId &&
                          thread.providerSessionId === input.providerSessionId,
                      )) ||
                    (source.subagents.some((subagent) => subagent.id === item.subagentId) &&
                      !parentNodeIds.has(item.subagentId))
                  )
                    continue;
                  parentNodeIds.add(item.subagentId);
                  open = withLinkedChildThreadId(open, item.childThreadId);
                  if (!isSettledTurnItemStatus(item.status))
                    open = {
                      ...open,
                      turnItems: new Map(open.turnItems).set(item.subagentId, item),
                    };
                } else if (
                  (item.type === "command_execution" || item.type === "dynamic_tool") &&
                  !isSettledTurnItemStatus(item.status)
                ) {
                  rootItems.set(item.id, item);
                }
              }
              for (const node of source.nodes) {
                if (
                  node.threadId === input.run.threadId &&
                  node.runId === input.run.id &&
                  node.kind === "subagent" &&
                  parentNodeIds.has(node.id) &&
                  isOpenExecutionNodeStatus(node.status)
                ) {
                  open = { ...open, nodes: new Map(open.nodes).set(node.id, node) };
                }
              }
              for (const childThreadId of open.linkedChildThreadIds) {
                const child = yield* projections.getThreadRecords(childThreadId, [
                  "runs",
                  "nodes",
                  "turnItems",
                  "providerThreads",
                ]);
                const hasIndependentRun = child.runs.some(
                  (run) => run.id !== input.run.id && run.startedAt !== null,
                );
                if (!hasIndependentRun) ownedThreadIds.add(childThreadId);
                const ownedNodeIds = new Set<NodeId>();
                const ownedProviderThread = (
                  providerThreadId: ProviderThreadId | null | undefined,
                ) =>
                  providerThreadId === null ||
                  providerThreadId === undefined ||
                  child.providerThreads.some(
                    (thread) =>
                      thread.id === providerThreadId &&
                      thread.providerSessionId === input.providerSessionId,
                  );
                for (const node of child.nodes) {
                  if (
                    node.threadId === childThreadId &&
                    ownedProviderThread(node.providerThreadId) &&
                    (node.runId === input.run.id ||
                      // Native child roots have no local parent node. Their
                      // durable native subagent link and session establish
                      // ownership; a separately started child run revokes it.
                      (!hasIndependentRun && node.runId === null))
                  ) {
                    ownedNodeIds.add(node.id);
                    if (node.providerThreadId !== null)
                      ownedProviderThreadIds.add(node.providerThreadId);
                    if (isOpenExecutionNodeStatus(node.status))
                      open = { ...open, nodes: new Map(open.nodes).set(node.id, node) };
                  }
                }
                for (const item of child.turnItems) {
                  if (
                    item.threadId === childThreadId &&
                    !isSettledTurnItemStatus(item.status) &&
                    ownedProviderThread(item.providerThreadId) &&
                    (item.runId === input.run.id ||
                      (!hasIndependentRun &&
                        item.runId === null &&
                        item.nodeId !== null &&
                        ownedNodeIds.has(item.nodeId)))
                  ) {
                    open = {
                      ...open,
                      childTurnItems: new Map(open.childTurnItems).set(item.id, item),
                    };
                  }
                }
              }
              yield* Ref.set(openRunOwnedSubagents, open);
              yield* Ref.set(openRootBackgroundTurnItems, rootItems);
              // A native child can commit before lifecycle tracking fails.
              // Restore only saved links from this session before consuming
              // its queued completion events; separately started children
              // keep their own readers.
              yield* Ref.update(eventRouting, (state) => ({
                ...state,
                ownedThreadIds: new Set([...state.ownedThreadIds, ...ownedThreadIds]),
                ownedProviderThreadIds: new Set([
                  ...state.ownedProviderThreadIds,
                  ...ownedProviderThreadIds,
                ]),
              }));
            }
          });
          const makeBackgroundSettlement = Effect.gen(function* () {
            yield* hydrateBackgroundProjection;
            const completedAt = yield* DateTime.now;
            const events = [
              ...(yield* cascadeTerminalizeRunOwnedSubagents({
                run: input.run,
                open: yield* Ref.get(openRunOwnedSubagents),
                // These outcomes were lost with the reader. Preserve the root's
                // confirmed result without inventing command or child results.
                status: "interrupted",
                completedAt,
                allocateEventId: () => idAllocator.allocate.event({ threadId: input.run.threadId }),
              })),
            ];
            for (const turnItem of (yield* Ref.get(openRootBackgroundTurnItems)).values()) {
              if (
                turnItem.threadId !== input.run.threadId ||
                turnItem.runId !== input.run.id ||
                isSettledTurnItemStatus(turnItem.status)
              ) {
                continue;
              }
              events.push({
                id: yield* idAllocator.allocate.event({ threadId: input.run.threadId }),
                type: "turn-item.updated",
                threadId: input.run.threadId,
                runId: input.run.id,
                ...(turnItem.nodeId === null ? {} : { nodeId: turnItem.nodeId }),
                providerInstanceId: input.run.providerInstanceId,
                occurredAt: completedAt,
                payload: {
                  ...turnItem,
                  status: "interrupted",
                  completedAt,
                  updatedAt: completedAt,
                },
              });
            }
            return events;
          });
          const forgetSettledBackground = Effect.gen(function* () {
            yield* Ref.set(openRunOwnedSubagents, emptyOpenRunOwnedSubagentProjection());
            yield* Ref.set(openRootBackgroundTurnItems, new Map());
            yield* Ref.set(activeChildProviderTurns, new Set());
            yield* Ref.set(activeChildSubagents, new Map());
            yield* Ref.update(
              activeBackgroundTurnItems,
              (current) =>
                new Set([...current].filter((id) => inheritedBackgroundTurnItemsById.has(id))),
            );
          });
          const inspectBackgroundWork = Effect.gen(function* () {
            const probe = input.session.hasPendingBackgroundWorkForThread;
            if (probe === undefined) return "unknown" as const;
            // A failed probe is unknown. Only an authoritative thread-scoped
            // negative can settle rows while the shared runtime is still live.
            return yield* probe(yield* Ref.get(latestProviderThread)).pipe(
              Effect.map((pending) => (pending ? ("pending" as const) : ("drained" as const))),
              Effect.catchCause(() => Effect.succeed("unknown" as const)),
            );
          });
          const settleRecoveredBackground = Effect.fn(
            "RunExecutionService.settleRecoveredBackground",
          )(function* (runtimeReleased = false, drainConfirmed = false) {
            if (!runtimeReleased && !drainConfirmed) return;
            const events = yield* makeBackgroundSettlement;
            const providerThread = yield* Ref.get(latestProviderThread);
            if (events.length === 0 && (providerThread.pendingBackgroundTasks?.length ?? 0) === 0) {
              yield* forgetSettledBackground;
              return;
            }
            const now = yield* DateTime.now;
            const clearedProviderThread = {
              ...providerThread,
              pendingBackgroundTasks: [],
              updatedAt: now,
            };
            const rosterEventId = yield* idAllocator.allocate.event({
              threadId: input.run.threadId,
            });
            const result = yield* eventSink.writeIfProviderThreadOwner({
              providerThreadId: input.providerThread.id,
              runId: input.run.id,
              activeAttemptId: input.attempt.id,
              expectedLastRunOrdinal: input.run.ordinal,
              guardRecoveredBackground: {
                threadId: input.run.threadId,
                runId: input.run.id,
                providerThreadId: input.providerThread.id,
                providerSessionId: input.providerSessionId,
                eventIds: [...events.map((event) => event.id), rosterEventId],
              },
              events: [
                ...events,
                {
                  id: rosterEventId,
                  type: "provider-thread.updated",
                  threadId: input.run.threadId,
                  providerInstanceId: input.run.providerInstanceId,
                  occurredAt: now,
                  payload: clearedProviderThread,
                },
              ],
            });
            if (result.committed) {
              yield* Ref.set(latestProviderThread, clearedProviderThread);
              yield* forgetSettledBackground;
            } else {
              yield* Ref.set(providerThreadOwnerLost, true);
            }
          });
          const finalizeRootRun = Effect.fn("RunExecutionService.finalizeRootRun")(function* (
            terminal: ProviderTerminalEvent,
            recoveryReceipt?: ReadonlyArray<OrchestrationV2DomainEvent>,
            settleBackground = false,
          ) {
            if (yield* Ref.get(rootRunFinalized)) {
              return;
            }
            const providerThread = yield* Ref.get(latestProviderThread);
            const deferBackgroundSettlement =
              !settleBackground && (yield* Ref.get(recoveredBackgroundDrain));
            if (deferBackgroundSettlement) yield* hydrateBackgroundProjection;
            const openSubagents = yield* Ref.get(openRunOwnedSubagents);
            yield* writeFinalRunEvents({
              run: input.run,
              rootNode: input.rootNode,
              checkpointScope: input.checkpointScope,
              providerThread,
              attempt: input.attempt,
              ...(input.shouldFinalizeRun === undefined
                ? {}
                : {
                    shouldFinalizeRun: input.shouldFinalizeRun,
                    // Stop may commit between the ownership read and this
                    // terminal write. Gate the events and checkpoint together.
                    writeIfRunCurrent: {
                      activeAttemptId: input.attempt.id,
                      expectedStatus: "running" as const,
                    },
                  }),
              ...(input.hasUnpairedRunInterruptRequest === undefined
                ? {}
                : {
                    hasUnpairedRunInterruptRequest: input.hasUnpairedRunInterruptRequest,
                  }),
              ...(input.loadRunInterruptReason === undefined
                ? {}
                : { loadRunInterruptReason: input.loadRunInterruptReason }),
              // A retained non-completed root can still own native work.
              // Record its truthful terminal now, then let the ordered
              // drain record actual results before settling missing ones.
              openRunOwnedSubagents: deferBackgroundSettlement
                ? emptyOpenRunOwnedSubagentProjection()
                : openSubagents,
              ...(settleBackground
                ? {
                    backgroundSettlement: yield* makeBackgroundSettlement,
                    backgroundProviderSessionId: input.providerSessionId,
                    clearPendingBackgroundTasks: true,
                  }
                : {}),
              terminal,
              failureItemPersisted: terminal.status === "failed",
              ...(recoveryReceipt !== undefined
                ? {
                    recoveryReceipt,
                    writeIfRunCurrent: {
                      activeAttemptId: input.attempt.id,
                      expectedStatus: "running" as const,
                    },
                  }
                : {}),
              refreshAfterTurn,
            }).pipe(
              Effect.mapError(
                (cause) => new RunExecutionIngestError({ runId: input.run.id, cause }),
              ),
            );
            if (
              !deferBackgroundSettlement &&
              isRunOwnedSubagentTerminalStatus(terminal.status) &&
              !childTurnsContinue(terminal)
            ) {
              yield* Ref.set(openRunOwnedSubagents, emptyOpenRunOwnedSubagentProjection());
            }
            if (settleBackground) {
              yield* Ref.update(latestProviderThread, (thread) => ({
                ...thread,
                pendingBackgroundTasks: [],
              }));
              yield* forgetSettledBackground;
            }
            yield* Ref.set(rootRunFinalized, true);
            // Persistence (or confirmed supersession) now owns this outcome.
            // Keep evidence when finalization fails, and acknowledge only this
            // exact turn so an older reader cannot discard a newer terminal.
            yield* (
              input.session.acknowledgeTurnTerminal?.({
                providerThreadId: terminal.providerThreadId,
                providerTurnId: terminal.providerTurnId,
              }) ?? Effect.void
            );
            yield* recoveryService?.completed(recoveryIdentity) ?? Effect.void;
          });
          // Runs for every provider event, including streamed text updates; avoid a per-event span.
          const trackChildLifecycle = Effect.fnUntraced(function* (
            event: ProviderAdapter.ProviderAdapterV2Event,
            deliverable: boolean,
          ) {
            const routing = yield* Ref.get(eventRouting);
            if (event.type === "provider_turn.updated") {
              const isRoot =
                event.providerTurn.runAttemptId === input.attempt.id ||
                event.providerTurn.id === routing.rootProviderTurnId;
              if (!isRoot) {
                yield* Ref.update(activeChildProviderTurns, (current) => {
                  const next = new Set(current);
                  if (isTerminalProviderTurnStatus(event.providerTurn.status)) {
                    next.delete(event.providerTurn.id);
                  } else {
                    next.add(event.providerTurn.id);
                  }
                  return next;
                });
              }
            }
            if (event.type === "subagent.updated") {
              const belongsToRootRun = event.subagent.runId === input.run.id;
              const belongsToOwnedChildThread =
                event.subagent.threadId !== input.run.threadId &&
                routing.ownedThreadIds.has(event.subagent.threadId);
              if (belongsToRootRun || belongsToOwnedChildThread) {
                yield* Ref.update(activeChildSubagents, (current) => {
                  const next = new Map(current);
                  if (isSettledSubagentStatus(event.subagent.status)) {
                    next.delete(event.subagent.id);
                  } else {
                    next.set(event.subagent.id, event.subagent.threadId);
                  }
                  return next;
                });
              }
              // Preserve childThreadId linkage for the root-run lifetime even after the subagent
              // row terminalizes, so open child-thread nodes can still be proven linked on a
              // later root interrupt. A provider records nested native subagents on the child
              // thread, runless; they die with this run too.
              if (
                belongsToRootRun ||
                (belongsToOwnedChildThread &&
                  event.subagent.runId === null &&
                  event.subagent.origin === "provider_native")
              ) {
                yield* Ref.update(openRunOwnedSubagents, (current) => {
                  const withLink = withLinkedChildThreadId(current, event.subagent.childThreadId);
                  const subagents = new Map(withLink.subagents);
                  if (isSettledSubagentStatus(event.subagent.status)) {
                    subagents.delete(event.subagent.id);
                  } else {
                    subagents.set(event.subagent.id, event.subagent);
                  }
                  return { ...withLink, subagents };
                });
              }
            }
            if (event.type === "node.updated") {
              const belongsToRootSubagent =
                event.node.kind === "subagent" && event.node.runId === input.run.id;
              const belongsToOwnedChildThread =
                event.node.threadId !== input.run.threadId &&
                routing.ownedThreadIds.has(event.node.threadId);
              if (
                !belongsToRootSubagent &&
                !(
                  belongsToOwnedChildThread &&
                  (event.node.runId === null || event.node.runId === input.run.id)
                )
              ) {
                return;
              }
              yield* Ref.update(openRunOwnedSubagents, (current) => {
                const nodes = new Map(current.nodes);
                if (isOpenExecutionNodeStatus(event.node.status)) {
                  nodes.set(event.node.id, event.node);
                } else {
                  nodes.delete(event.node.id);
                }
                return { ...current, nodes };
              });
            }
            if (event.type === "turn_item.updated") {
              const belongsToRootRun = event.turnItem.runId === input.run.id;
              const belongsToOwnedChildThread =
                event.turnItem.threadId !== input.run.threadId &&
                routing.ownedThreadIds.has(event.turnItem.threadId);
              const belongsToInheritedBackgroundItem =
                event.turnItem.threadId === input.run.threadId &&
                event.turnItem.runId !== null &&
                inheritedBackgroundTurnItemsById.get(event.turnItem.id) === event.turnItem.runId;
              if (
                belongsToRootRun &&
                event.turnItem.threadId === input.run.threadId &&
                (event.turnItem.type === "command_execution" ||
                  event.turnItem.type === "dynamic_tool")
              ) {
                yield* Ref.update(openRootBackgroundTurnItems, (current) => {
                  const next = new Map(current);
                  if (isSettledTurnItemStatus(event.turnItem.status)) {
                    next.delete(event.turnItem.id);
                  } else {
                    next.set(event.turnItem.id, event.turnItem);
                  }
                  return next;
                });
              }
              if (
                backgroundCapableTurnItemTypes.has(event.turnItem.type) &&
                (belongsToRootRun || belongsToOwnedChildThread || belongsToInheritedBackgroundItem)
              ) {
                yield* Ref.update(activeBackgroundTurnItems, (current) => {
                  const next = new Set(current);
                  if (isSettledTurnItemStatus(event.turnItem.status)) {
                    next.delete(event.turnItem.id);
                  } else {
                    next.add(event.turnItem.id);
                  }
                  return next;
                });
              }
              if (
                belongsToOwnedChildThread &&
                (event.turnItem.runId === null || belongsToRootRun) &&
                deliverable
              ) {
                yield* Ref.update(openRunOwnedSubagents, (current) => {
                  const childTurnItems = new Map(current.childTurnItems);
                  if (isSettledTurnItemStatus(event.turnItem.status)) {
                    childTurnItems.delete(event.turnItem.id);
                  } else {
                    childTurnItems.set(event.turnItem.id, event.turnItem);
                  }
                  return { ...current, childTurnItems };
                });
              }
              if (belongsToRootRun && event.turnItem.type === "subagent") {
                const subagentItem = event.turnItem;
                yield* Ref.update(openRunOwnedSubagents, (current) => {
                  const withLink = withLinkedChildThreadId(current, subagentItem.childThreadId);
                  const turnItems = new Map(withLink.turnItems);
                  if (isSettledTurnItemStatus(subagentItem.status)) {
                    turnItems.delete(subagentItem.subagentId);
                  } else {
                    turnItems.set(subagentItem.subagentId, subagentItem);
                  }
                  return { ...withLink, turnItems };
                });
              }
            }
          });
          const shouldStopProviderEventIngestion = Effect.gen(function* () {
            if (!(yield* Ref.get(rootTerminalSeen))) {
              return false;
            }
            if (yield* Ref.get(recoveredBackgroundDrain)) {
              const observation = yield* Ref.get(drainObserved);
              // Empty lifecycle refs cannot establish an outcome: a row can
              // commit before its tracker fails. Unknown keeps this reader.
              if (observation === "pending" || observation === "unknown") return false;
              if (observation === "unobserved") {
                const subscription = yield* Ref.get(activeSubscription);
                if (subscription.requestDrain !== undefined && !(yield* Ref.get(drainRequested))) {
                  yield* Ref.set(drainRequested, true);
                  yield* subscription.requestDrain({
                    observe: inspectBackgroundWork,
                    after: (captured) =>
                      Ref.set(drainObserved, captured).pipe(
                        Effect.andThen(Ref.set(drainRequested, false)),
                      ),
                  });
                }
                return false;
              }
              // The publication permit and fanout order this marker after completion and earlier ingestion.
              // A drained provider may publish nothing else; retry in consumer order, rereading rows and ownership.
              yield* Effect.gen(function* () {
                // Intentional shutdown leaves remaining work to startup recovery.
                if (yield* input.session.isShuttingDown ?? Effect.succeed(false)) return;
                const settlement = yield* Effect.exit(settleRecoveredBackground(false, true));
                if (Exit.isSuccess(settlement) || Cause.hasInterruptsOnly(settlement.cause))
                  return yield* settlement;
                yield* Effect.logWarning("Recovered background recording will be retried", {
                  runId: input.run.id,
                  cause: settlement.cause,
                });
                // SQL commit failures can be defects; retry every failure
                // except interruption, as provider-session release recording does.
                return yield* Effect.fail(settlement.cause);
              }).pipe(
                Effect.retry({
                  schedule: Schedule.exponential("1 second").pipe(
                    Schedule.modifyDelay(({ duration }) =>
                      Effect.succeed(Duration.min(duration, Duration.seconds(30))),
                    ),
                  ),
                }),
              );
              return true;
            }
            const terminal = yield* Ref.get(terminalEvent);
            if (
              terminal !== null &&
              terminal.status !== "completed" &&
              !childTurnsContinue(terminal)
            ) {
              return true;
            }
            const childProviderTurns = yield* Ref.get(activeChildProviderTurns);
            if (childProviderTurns.size > 0) {
              return false;
            }
            const childSubagents = yield* Ref.get(activeChildSubagents);
            if (childSubagents.size > 0) {
              return false;
            }
            // Newly owned items depend on adapters emitting a non-terminal event before the root
            // terminal. Owner loss (a newer run claimed lastRunOrdinal) must not close this stream
            // while these sets are non-empty: turn_item.updated writes are not ownership-gated, so
            // late completions still land.
            const backgroundItems = yield* Ref.get(activeBackgroundTurnItems);
            if (backgroundItems.size > 0) {
              return false;
            }
            if (yield* Ref.get(providerThreadOwnerLost)) {
              return true;
            }
            // Claude background Bash has no turn item; keep this root stream until its roster work clears.
            // Siblings and wake buffers must not pin it: use the thread-scoped probe here.
            // ProviderSessionManager still uses session-wide pending work for idle release.
            const latestProviderThreadSnapshot = yield* Ref.get(latestProviderThread);
            if (input.session.hasPendingBackgroundWorkForThread !== undefined) {
              const hasPendingWork = yield* input.session
                .hasPendingBackgroundWorkForThread(latestProviderThreadSnapshot)
                .pipe(Effect.catchCause(() => Effect.succeed(false)));
              if (hasPendingWork) {
                return false;
              }
            }
            return true;
          });
          const filterAssistantEvent = makeAssistantStreamingFilter(responseStreamingMode);
          // Held text writes nothing, so its item would take a position only
          // when finally written, behind every item that began after it.
          const reservedHeldTurnItemIds = new Set<TurnItemId>();
          if (recoveryService !== undefined) {
            yield* recoveryService.register({
              ...recoveryIdentity,
              inspect: Effect.gen(function* () {
                // A terminal buffered behind legitimate database work is not a stale run.
                // Only reconcile after this attempt's event consumer has stopped.
                if (!(yield* Ref.get(consumerStopped))) return { status: "active" as const };
                const turnId = (yield* Ref.get(eventRouting)).rootProviderTurnId;
                if (turnId === null) return { status: "unknown" as const };
                return yield* input.session.inspectTurn!({
                  providerThread: yield* Ref.get(latestProviderThread),
                  providerTurnId: turnId,
                });
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new ThreadRecoveryService.ThreadRecoveryError({
                      threadId: input.run.threadId,
                      cause,
                    }),
                ),
              ),
              finalize: (terminal, receipt, { runtimeReleased }) =>
                guardEventReaderStartup(function* (recoveredStartup) {
                  // Subscribe before probing/finalizing so recovery buffers completions for the retained drain.
                  // Recovery rechecks the running run under its command lock; the earlier shell snapshot
                  // already blocks readers acquired after admission's first runtime snapshot.
                  const resumedSubscription = !runtimeReleased
                    ? input.session.subscribeEvents === undefined
                      ? { events: input.session.events, close: Effect.void }
                      : yield* recoveredStartup.acquire(input.session.subscribeEvents)
                    : undefined;
                  const terminalEvents = yield* providerEventIngestor
                    .normalize({
                      providerSessionId: input.providerSessionId,
                      providerInstanceId: input.run.providerInstanceId,
                      threadId: input.run.threadId,
                      runId: input.run.id,
                      nodeId: input.rootNode.id,
                      event: terminal,
                    })
                    .pipe(Effect.onError(() => resumedSubscription?.close ?? Effect.void));
                  yield* Ref.update(
                    eventRouting,
                    (state) => routeProviderEvent(terminal, routeIdentity, state)[1],
                  );
                  yield* Ref.set(terminalEvent, terminal);
                  yield* Ref.set(rootTerminalSeen, true);
                  yield* Ref.set(recoveredBackgroundDrain, true);
                  yield* finalizeRootRun(
                    terminal,
                    [...receipt, ...terminalEvents],
                    runtimeReleased,
                  ).pipe(Effect.onError(() => resumedSubscription?.close ?? Effect.void));
                  if (resumedSubscription !== undefined) {
                    yield* Ref.set(activeSubscription, resumedSubscription);
                    yield* Ref.set(drainObserved, "unobserved");
                    yield* Ref.set(drainRequested, false);
                    yield* Ref.set(consumerStopped, false);
                    yield* recoveredStartup.fork(consumeProviderEvents(resumedSubscription));
                    // Recovery holds the source command lock. Queue the drain
                    // separately, without waiting for its ingestion under that
                    // same lock, and always start the buffered reader first.
                    yield* shouldStopProviderEventIngestion.pipe(Effect.forkDetach);
                  }
                }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ThreadRecoveryService.ThreadRecoveryError({
                        threadId: input.run.threadId,
                        cause,
                      }),
                  ),
                ),
            });
          }
          const consumeProviderEvents = (
            eventSubscription: ProviderAdapter.ProviderAdapterV2EventSubscription,
          ): Effect.Effect<void, RunExecutionIngestError> =>
            eventSubscription.events.pipe(
              Stream.mapEffect((event) =>
                Effect.gen(function* () {
                  const previous = yield* Ref.get(eventRouting);
                  const [accepted, routing] = routeProviderEvent(event, routeIdentity, previous);
                  yield* Ref.set(eventRouting, routing);
                  if (
                    event.type === "subagent.updated" &&
                    event.subagent.childThreadId !== null &&
                    previous.ownedThreadIds.has(event.subagent.childThreadId) &&
                    !routing.ownedThreadIds.has(event.subagent.childThreadId)
                  ) {
                    const moved = event.subagent;
                    const detached = yield* Ref.modify(openRunOwnedSubagents, (current) => {
                      const subagentIds = new Set([moved.id]);
                      for (const subagent of current.subagents.values()) {
                        if (subagent.threadId === moved.childThreadId) subagentIds.add(subagent.id);
                      }
                      const childTurnItems = new Map(
                        [...current.childTurnItems].filter(
                          ([, item]) => item.threadId !== moved.childThreadId,
                        ),
                      );
                      const turnItems = new Map(current.turnItems);
                      turnItems.delete(moved.id);
                      const detachedItems = new Set(
                        [...current.childTurnItems.values(), ...current.turnItems.values()]
                          .filter(
                            (item) =>
                              item.threadId === moved.childThreadId || item.nodeId === moved.id,
                          )
                          .map((item) => item.id),
                      );
                      return [
                        { itemIds: detachedItems, subagentIds },
                        {
                          subagents: new Map(
                            [...current.subagents].filter(([id]) => !subagentIds.has(id)),
                          ),
                          turnItems,
                          childTurnItems,
                          nodes: new Map(
                            [...current.nodes].filter(
                              ([id, node]) =>
                                id !== moved.id && node.threadId !== moved.childThreadId,
                            ),
                          ),
                          linkedChildThreadIds: new Set(
                            [...current.linkedChildThreadIds].filter(
                              (id) => id !== moved.childThreadId,
                            ),
                          ),
                        },
                      ];
                    });
                    yield* Ref.update(
                      activeChildSubagents,
                      (current) =>
                        new Map(
                          [...current].filter(
                            ([id, threadId]) =>
                              !detached.subagentIds.has(id) && threadId !== moved.childThreadId,
                          ),
                        ),
                    );
                    yield* Ref.update(
                      activeChildProviderTurns,
                      (current) =>
                        new Set([...current].filter((id) => routing.ownedProviderTurns.has(id))),
                    );
                    yield* Ref.update(
                      activeBackgroundTurnItems,
                      (current) => new Set([...current].filter((id) => !detached.itemIds.has(id))),
                    );
                  }
                  return { event, accepted };
                }),
              ),
              Stream.tap(({ event, accepted }) =>
                Effect.gen(function* () {
                  if (!accepted) return;
                  if (event.type === "events.barrier") {
                    yield* event.after;
                    return;
                  }
                  if (
                    event.type === "provider_turn.updated" &&
                    event.providerTurn.runAttemptId === input.attempt.id &&
                    event.providerTurn.providerThreadId === input.providerThread.id
                  ) {
                    yield* Ref.set(latestRootProviderTurn, event.providerTurn);
                  }
                  yield* Ref.set(drainObserved, "unobserved");
                  let storedEventCount = 0;
                  const deliveredEvent = filterAssistantEvent(
                    event,
                    DateTime.toEpochMillis(yield* DateTime.now),
                  );
                  if (deliveredEvent) {
                    // Root updates use writeIfRunCurrent before termination and writeIfProviderThreadOwner after it.
                    // Late roster clears must still own both the attempt and the run's lastRunOrdinal.
                    const rootTerminalAlreadySeen = yield* Ref.get(rootTerminalSeen);
                    const isRootProviderThreadUpdate =
                      event.type === "provider_thread.updated" &&
                      event.providerThread.id === input.providerThread.id;
                    const storedEvents = yield* providerEventIngestor.ingestNormalized({
                      analyticsContext: {
                        modelSelection: input.modelSelection,
                        runtimeMode: input.runtimePolicy.runtimeMode,
                        interactionMode: input.runtimePolicy.interactionMode,
                        origin:
                          event.type === "provider_turn.updated" &&
                          event.providerTurn.providerThreadId !== input.providerThread.id
                            ? NATIVE_SUBAGENT_TURN_ORIGIN
                            : rootTurnOrigin,
                      },
                      providerSessionId: input.providerSessionId,
                      providerInstanceId: input.run.providerInstanceId,
                      threadId: input.run.threadId,
                      runId: input.run.id,
                      nodeId: input.rootNode.id,
                      event: deliveredEvent,
                      ...(isRootProviderThreadUpdate
                        ? rootTerminalAlreadySeen
                          ? {
                              writeIfProviderThreadOwner: {
                                providerThreadId: input.providerThread.id,
                                runId: input.run.id,
                                activeAttemptId: input.attempt.id,
                                expectedLastRunOrdinal: input.run.ordinal,
                              },
                            }
                          : {
                              writeIfRunCurrent: {
                                runId: input.run.id,
                                activeAttemptId: input.attempt.id,
                                expectedStatus: "running" as const,
                              },
                            }
                        : {}),
                    });
                    storedEventCount = storedEvents.length;
                    if (
                      isRootProviderThreadUpdate &&
                      rootTerminalAlreadySeen &&
                      storedEventCount === 0
                    ) {
                      // Ownership lost (or thread row missing). Stop pinning the
                      // stream on this run's background probe.
                      yield* Ref.set(providerThreadOwnerLost, true);
                    }
                  } else if (
                    event.type === "turn_item.updated" &&
                    (event.turnItem.type === "assistant_message" ||
                      event.turnItem.type === "reasoning") &&
                    event.turnItem.streaming &&
                    !reservedHeldTurnItemIds.has(event.turnItem.id)
                  ) {
                    yield* turnItemPositions.allocate({
                      threadId: event.turnItem.threadId,
                      turnItemId: event.turnItem.id,
                      runId: event.turnItem.runId,
                    });
                    reservedHeldTurnItemIds.add(event.turnItem.id);
                  }
                  if (event.type === "provider_thread.updated") {
                    if (
                      event.providerThread.id === input.providerThread.id &&
                      storedEventCount > 0
                    ) {
                      yield* Ref.set(latestProviderThread, event.providerThread);
                    }
                  }
                  if (
                    event.type === "turn_item.updated" &&
                    event.turnItem.providerTurnId ===
                      (yield* Ref.get(eventRouting)).rootProviderTurnId
                  ) {
                    yield* Ref.update(latestTurnItemOrdinal, (current) =>
                      Math.max(current, event.turnItem.ordinal),
                    );
                  }
                  if (event.type === "turn.terminal") {
                    yield* Ref.set(terminalEvent, event);
                    yield* Ref.set(rootTerminalSeen, true);
                    yield* finalizeRootRun(event);
                  }
                  yield* trackChildLifecycle(event, deliveredEvent !== null);
                }).pipe(
                  Effect.catchCause((cause) =>
                    Ref.get(rootRunFinalized).pipe(
                      Effect.flatMap((finalized) =>
                        finalized && !Cause.hasInterruptsOnly(cause)
                          ? Effect.logWarning(
                              "Post-terminal background event could not be recorded; retaining its reader",
                              {
                                runId: input.run.id,
                                cause,
                              },
                            ).pipe(Effect.andThen(Ref.set(recoveredBackgroundDrain, true)))
                          : Effect.failCause(cause),
                      ),
                    ),
                  ),
                ),
              ),
              Stream.takeUntilEffect(() => shouldStopProviderEventIngestion),
              Stream.runDrain,
              Effect.flatMap(() =>
                Effect.gen(function* () {
                  const terminal = yield* Ref.get(terminalEvent);
                  if (terminal === null) {
                    if (recoveryService === undefined) {
                      return yield* new RunExecutionIngestError({
                        runId: input.run.id,
                        cause: new ProviderAdapter.ProviderAdapterEventStreamError({
                          driver: input.providerThread.driver,
                          providerSessionId: input.providerSessionId,
                          cause: "Provider event stream ended without a root terminal.",
                        }),
                      });
                    }
                    yield* Ref.set(consumerStopped, true);
                    yield* markSuspect;
                    return;
                  }
                  yield* finalizeRootRun(terminal);
                }),
              ),
              Effect.catchCauseIf(
                (cause) => recoveryService !== undefined || !Cause.hasInterruptsOnly(cause),
                (cause) =>
                  recoveryService !== undefined && Cause.hasInterruptsOnly(cause)
                    ? recoveryService.completed(recoveryIdentity)
                    : recoveryService !== undefined
                      ? Ref.get(rootRunFinalized).pipe(
                          Effect.flatMap((finalized) =>
                            finalized
                              ? Effect.logWarning("Post-terminal provider event ingestion failed", {
                                  runId: input.run.id,
                                  cause,
                                })
                              : Effect.logWarning(
                                  "Provider event recording stopped; retaining the attempt for recovery",
                                  { runId: input.run.id, cause },
                                ).pipe(
                                  Effect.andThen(Ref.set(consumerStopped, true)),
                                  Effect.andThen(markSuspect),
                                ),
                          ),
                        )
                      : Effect.gen(function* () {
                          const completedAt = yield* DateTime.now;
                          yield* Effect.logWarning(
                            "orchestration V2 provider event ingestion failed",
                            {
                              runId: input.run.id,
                              cause,
                            },
                          );
                          if (yield* Ref.get(rootRunFinalized)) return;
                          const providerThread = yield* Ref.get(latestProviderThread);
                          const routing = yield* Ref.get(eventRouting);
                          // Stop background work too; the failed consumer cannot persist terminal events.
                          const interruptedProviderTurn =
                            routing.rootProviderTurnId !== null && !routing.rootTurnEnded
                              ? yield* input.session
                                  .interruptTurn({
                                    providerThread,
                                    providerTurnId: routing.rootProviderTurnId,
                                    requestRuntimeRestart: true,
                                  })
                                  .pipe(
                                    Effect.as(yield* Ref.get(latestRootProviderTurn)),
                                    Effect.catchCauseIf(
                                      (interruptCause) => !Cause.hasInterruptsOnly(interruptCause),
                                      (interruptCause) =>
                                        Effect.logWarning(
                                          "orchestration V2 failed to interrupt turn after ingestion failure",
                                          { runId: input.run.id, cause: interruptCause },
                                        ).pipe(Effect.as(null)),
                                    ),
                                  )
                              : null;
                          const latestItemOrdinal = yield* Ref.get(latestTurnItemOrdinal);
                          const openSubagents = yield* Ref.get(openRunOwnedSubagents);
                          let nextRetryWarningAt = completedAt;
                          yield* writeFinalRunEvents({
                            run: input.run,
                            rootNode: input.rootNode,
                            checkpointScope: input.checkpointScope,
                            providerThread,
                            attempt: input.attempt,
                            // The failure may be the ownership
                            // read itself, so check in the write.
                            writeIfRunCurrent: {
                              activeAttemptId: input.attempt.id,
                              expectedStatus: "running",
                            },
                            openRunOwnedSubagents: openSubagents,
                            ...(interruptedProviderTurn === null
                              ? {}
                              : { interruptedProviderTurn }),
                            completedAt,
                            terminal: makeFailedTerminalEvent(
                              makeProviderFailure({ cause: Cause.squash(cause), class: "unknown" }),
                              latestItemOrdinal + 1,
                            ),
                            failureItemPersisted: false,
                            refreshAfterTurn,
                          }).pipe(
                            // Storage failures can be defects; retry both failure channels.
                            Effect.catchCause((writeCause) =>
                              Effect.gen(function* () {
                                if (Cause.hasInterruptsOnly(writeCause)) {
                                  return yield* Effect.failCause(writeCause);
                                }
                                const now = yield* DateTime.now;
                                if (DateTime.isGreaterThanOrEqualTo(now, nextRetryWarningAt)) {
                                  yield* Effect.logWarning(
                                    "orchestration V2 run failure finalization retry",
                                    {
                                      runId: input.run.id,
                                      attemptId: input.attempt.id,
                                      cause: writeCause,
                                    },
                                  );
                                  // Persistent storage failures must not flood the same disk.
                                  nextRetryWarningAt = DateTime.add(now, { minutes: 10 });
                                }
                                return yield* Effect.fail(writeCause);
                              }),
                            ),
                            Effect.retry({
                              schedule: Schedule.exponential("1 second").pipe(
                                Schedule.modifyDelay(({ duration }) =>
                                  Effect.succeed(Duration.min(duration, Duration.seconds(30))),
                                ),
                              ),
                            }),
                            // Startup may cancel the consumer and fail its own terminal
                            // write. Only service shutdown or the atomic gate ends recovery.
                            Effect.forkIn(scope),
                            Effect.flatMap(Fiber.join),
                          );
                        }).pipe(
                          Effect.mapError(
                            (cause) => new RunExecutionIngestError({ runId: input.run.id, cause }),
                          ),
                        ),
              ),
              Effect.ensuring(
                Effect.gen(function* () {
                  if (!(yield* Ref.get(rootRunFinalized))) return;
                  // Startup recovery owns intentional server shutdown: it
                  // cancels the saved work and records the next-turn note.
                  // A stale subscription ending normally after unexpected
                  // release still needs the guarded settlement below.
                  if (yield* input.session.isShuttingDown ?? Effect.succeed(false)) return;
                  const terminal = yield* Ref.get(terminalEvent);
                  if (terminal === null) return;
                  const inspection = yield* (
                    input.session.inspectTurn?.({
                      providerThread: yield* Ref.get(latestProviderThread),
                      providerTurnId: terminal.providerTurnId,
                    }) ?? Effect.succeed({ status: "unknown" as const })
                  ).pipe(Effect.catchCause(() => Effect.succeed({ status: "unknown" as const })));
                  yield* settleRecoveredBackground(
                    inspection.status === "released" ||
                      (inspection.status === "terminal" && inspection.runtimeReleased === true),
                  );
                }).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Recovered background projection could not settle", {
                      runId: input.run.id,
                      cause,
                    }),
                  ),
                ),
              ),
              Effect.ensuring(eventSubscription.close),
              Effect.mapError((cause) =>
                isRunExecutionIngestError(cause)
                  ? cause
                  : new RunExecutionIngestError({ runId: input.run.id, cause }),
              ),
            );
          const providerEventFiber = yield* startup.fork(consumeProviderEvents(eventSubscription));

          // A provider turn is a sign that the session is still alive. Keep
          // its already-issued MCP credential valid even when the agent goes
          // a long time between browser-tool calls.
          const touchMcpCredential = McpSessionRegistry.touchActiveMcpThread(
            input.run.threadId,
          ).pipe(
            Effect.ignoreCause({
              log: true,
              message: "Failed to refresh MCP credential liveness.",
            }),
          );
          yield* touchMcpCredential;
          const appContext = (yield* mcpAppModelContext
            .forThread(input.run.threadId)
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Failed to read MCP app model context.", { cause }).pipe(
                  Effect.as([]),
                ),
              ),
            )).map((entry) => ({
            // The item id alone is unique and needs no escaping; server and
            // tool names are free text that would break the tag Codex wraps
            // the context in.
            key: `mcp_app_${entry.itemId.replace(/[^\w.-]/g, "_")}`,
            text: entry.text,
          }));
          const turnInput = {
            appThread: input.appThread,
            threadId: input.run.threadId,
            runId: input.run.id,
            runOrdinal: input.run.ordinal,
            providerTurnOrdinal: input.providerTurnOrdinal,
            ...(input.nativeThreadHasTurns === undefined
              ? {}
              : { nativeThreadHasTurns: input.nativeThreadHasTurns }),
            ...(input.run.restartContinuationOfRunId === undefined
              ? {}
              : {
                  restartContinuationOfRunId: input.run.restartContinuationOfRunId,
                }),
            attemptId: input.attemptId,
            rootNodeId: input.rootNode.id,
            providerThread: input.providerThread,
            message: input.message,
            modelSelection: input.modelSelection,
            runtimePolicy: input.runtimePolicy,
            ...(appContext.length === 0 ? {} : { appContext }),
          };
          // Check after the context read: ingestion can settle the run while
          // it awaits. A failed ownership read fails the start below.
          const shouldStart =
            input.shouldStartProviderTurn === undefined
              ? Exit.succeed(true)
              : yield* Effect.exit(input.shouldStartProviderTurn());
          if (Exit.isSuccess(shouldStart) && !shouldStart.value) {
            yield* startup.stop;
            yield* input.onMessageDelivery?.(false) ?? Effect.void;
            return;
          }

          const compact =
            input.message.attachments.length === 0 &&
            input.message.text.trim().toLowerCase() === "/compact";
          const startTurn = compact
            ? (input.session.compactThread?.(turnInput) ??
              Effect.andThen(
                input.onMessageDelivery?.(false) ?? Effect.void,
                Effect.fail(
                  new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver: input.session.driver,
                    threadId: input.run.threadId,
                    providerThreadId: input.providerThread.id,
                    runId: input.run.id,
                    cause: "This provider does not support context compaction.",
                  }),
                ),
              ))
            : input.session.startTurn(turnInput);
          yield* Effect.andThen(
            shouldStart.pipe(
              Effect.tapError(() => input.onMessageDelivery?.(false) ?? Effect.void),
            ),
            startTurn.pipe(Effect.tap(() => input.onMessageDelivery?.(true) ?? Effect.void)),
          ).pipe(
            // Wait for acceptance so abandoned startup cannot leave a refresher
            // on the already-detached ingestion fiber.
            Effect.tap(() =>
              Fiber.await(providerEventFiber).pipe(
                Effect.raceFirst(touchMcpCredential.pipe(Effect.delay("1 hour"), Effect.forever)),
                Effect.forkDetach,
              ),
            ),
            Effect.catchCause((cause) =>
              Effect.logError("orchestration V2 provider turn start failed", {
                runId: input.run.id,
                cause,
              }).pipe(
                Effect.andThen(startup.stop),
                Effect.andThen(Ref.get(latestProviderThread)),
                Effect.flatMap((providerThread) =>
                  Ref.get(latestTurnItemOrdinal).pipe(
                    Effect.flatMap((latestItemOrdinal) =>
                      Ref.get(openRunOwnedSubagents).pipe(
                        Effect.flatMap((openSubagents) =>
                          writeFinalRunEvents({
                            run: input.run,
                            rootNode: input.rootNode,
                            checkpointScope: input.checkpointScope,
                            providerThread,
                            attempt: input.attempt,
                            writeIfRunCurrent: {
                              activeAttemptId: input.attempt.id,
                              expectedStatus: "running",
                            },
                            openRunOwnedSubagents: openSubagents,
                            terminal: makeFailedTerminalEvent(
                              makeProviderFailure({
                                cause: Cause.squash(cause),
                                class: Exit.isFailure(shouldStart) ? "unknown" : "provider_error",
                              }),
                              latestItemOrdinal + 1,
                            ),
                            failureItemPersisted: false,
                            refreshAfterTurn,
                          }),
                        ),
                      ),
                    ),
                  ),
                ),
                Effect.mapError(
                  (writeCause) =>
                    new RunExecutionStartError({
                      commandId: input.commandId,
                      runId: input.run.id,
                      cause: { start: cause, write: writeCause },
                    }),
                ),
              ),
            ),
          );
        });
      }),
    } satisfies RunExecutionServiceV2Shape);
  }),
);

/**
 * Clients send Stop without a reason; server callers acting for an agent
 * always set one, so a missing reason means a person stopped the run.
 */
export const USER_STOP_REASON = "Stopped by user";

// Acquisition and consumer handoff must install their failure cleanup before
// becoming interruptible. Successful startup transfers ownership to the reader;
// failed startup joins its interruption before releasing ingestion evidence.
function guardEventReaderStartup<Y extends Effect.Effect<unknown, unknown, unknown>, A>(
  start: (guard: {
    stop: Effect.Effect<void>;
    acquire: <E, R>(
      subscription: Effect.Effect<ProviderAdapter.ProviderAdapterV2EventSubscription, E, R>,
    ) => Effect.Effect<ProviderAdapter.ProviderAdapterV2EventSubscription, E, R>;
    fork: <E, R>(
      consumer: Effect.Effect<void, E, R>,
    ) => Effect.Effect<Fiber.Fiber<void, E>, never, R>;
  }) => Generator<Y, A, never>,
) {
  return Effect.suspend(() => {
    let close: Effect.Effect<void> = Effect.void;
    let interrupt: Effect.Effect<void> = Effect.void;
    // A fiber interrupted before its first evaluation never installs its own
    // ensuring(close), so startup must also close explicitly after joining it.
    const stop = Effect.suspend(() => interrupt.pipe(Effect.andThen(close)));
    return Effect.gen(() =>
      start({
        stop,
        acquire: (subscription) =>
          subscription.pipe(
            Effect.tap((reader) =>
              Effect.sync(() => {
                close = reader.close;
              }),
            ),
            Effect.uninterruptible,
          ),
        fork: (consumer) =>
          consumer.pipe(
            Effect.interruptible,
            Effect.forkDetach,
            Effect.tap((fiber) =>
              Effect.sync(() => {
                interrupt = Fiber.interrupt(fiber);
              }),
            ),
            Effect.uninterruptible,
          ),
      }),
    ).pipe(Effect.onError(() => stop));
  });
}

export function makeInterruptResultTurnItem(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly run: OrchestrationV2Run;
  readonly rootNode: OrchestrationV2ExecutionNode;
  readonly providerThread: OrchestrationV2ProviderThread;
  /** The Stop's own reason, from its run_interrupt_request item. */
  readonly reason: string | undefined;
  readonly completedAt: DateTime.Utc;
}): OrchestrationV2TurnItem {
  return {
    id: input.idAllocator.derive.runSignalTurnItem({
      runId: input.run.id,
      signal: "interrupt-result",
    }),
    threadId: input.run.threadId,
    runId: input.run.id,
    nodeId: input.rootNode.id,
    providerThreadId: input.providerThread.id,
    providerTurnId: input.rootNode.providerTurnId,
    nativeItemRef: null,
    parentItemId: input.idAllocator.derive.runSignalTurnItem({
      runId: input.run.id,
      signal: "interrupt-request",
    }),
    ordinal: input.run.ordinal * 100 + 98,
    status: "interrupted",
    title: "Interrupted",
    startedAt: input.completedAt,
    completedAt: input.completedAt,
    updatedAt: input.completedAt,
    type: "run_interrupt_result",
    message: input.reason ?? "Stopped by the provider",
  };
}
