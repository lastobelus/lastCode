import * as EffectOutbox from "./EffectOutbox.ts";
import * as CommandReceipts from "./CommandReceiptStore.ts";
import * as ActionRunStore from "../actionResume/ActionRunStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as SuspensionRegistryTestkit from "../workspace/WorktreeSuspensionRegistry.testkit.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { EnvironmentId } from "@t3tools/contracts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as UpdateDrainAdmissionTestkit from "../updateDrain/UpdateDrainAdmission.testkit.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as EnvironmentPauseStore from "../environment/EnvironmentPauseStore.ts";
import { makePausedEnvironment } from "./EnvironmentAutomation.testkit.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderInstallationGate from "../provider/ProviderInstallationGate.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { loadSubscriberShellSnapshot } from "./ShellStream.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectionReplay from "./testkit/ProjectionReplay.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderTurnStartServiceTestkit from "./ProviderTurnStartService.testkit.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";

const layerPlatformTest = Layer.merge(
  Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-orchestration-v2-delegated-completion-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const layerVcsDriverRegistryTest = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(layerServerConfig),
  Layer.provide(layerPlatformTest),
);

const layerCheckpointStoreTest = CheckpointStore.layer.pipe(
  Layer.provide(layerVcsDriverRegistryTest),
);

const driver = ProviderDriverKind.make("codex");
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not used by delegated completion tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:test",
  },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const layerTestProviderInstanceRegistry = Layer.succeed(
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  {
    getInstance: (instanceId) =>
      Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
    listInstances: Effect.succeed([providerInstance]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  },
);

const layerTest = Layer.mergeAll(
  ActionRunStore.layer,
  ProjectionStore.layer,
  ProjectionReplay.layer.pipe(Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer))),
  EffectOutbox.layer,
  CommandReceipts.layer,
  ProjectStore.layer,
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  ThreadCommandExecutor.layer,
  EffectOutbox.layer,
).pipe(
  Layer.provideMerge(RuntimeLayer.layerProjectService),
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(ProviderTurnStartServiceTestkit.layer),
  Layer.provide(
    Layer.succeed(ProjectEnrichmentService.ProjectEnrichmentService, {
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      request: () => Effect.void,
      readRepositoryIdentity: () => Effect.succeed(null),
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      invalidate: () => Effect.void,
      refreshRepositoryIdentity: () => Effect.void,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("local-test")),
    }),
  ),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provideMerge(UpdateDrainAdmissionTestkit.layerOpen),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(ModelManifest.layerTest),
  Layer.provide(ProviderInstallationGate.layer),
  Layer.provide(SuspensionRegistryTestkit.layer),
  Layer.provideMerge(layerPlatformTest),
);

const seedParentWithTerminalTask = (input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly runId: RunId;
  readonly rootNodeId: NodeId;
  readonly taskId: NodeId;
  readonly deliveryState: "pending" | "delivered" | "claimed" | "acknowledged" | "disposed";
  readonly completionWake?: "always" | "settled_only";
  readonly deliveryTaskIds?: ReadonlyArray<NodeId>;
  readonly parentRunStatus?: "running" | "completed";
  readonly siblingTasks?: ReadonlyArray<{
    readonly id: NodeId;
    readonly deliveryState: "delivered" | "claimed";
  }>;
  readonly now: DateTime.Utc;
}) =>
  Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const providerThreadId = ProviderThreadId.make(
      `provider-thread:${String(input.threadId).replace("thread:", "")}`,
    );

    yield* projects.create({
      commandId: CommandId.make(`command:seed-project:${input.threadId}`),
      projectId: input.projectId,
      title: "Delegated completion delivery",
      workspaceRoot: `/workspace/${input.projectId}`,
    });

    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:seed-create:${input.threadId}`),
      threadId: input.threadId,
      projectId: input.projectId,
      title: "Delegated completion delivery",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });

    yield* eventSink.write({
      commandId: CommandId.make(`command:seed-projection:${input.threadId}`),
      events: [
        {
          id: EventId.make(`event:seed-provider-thread:${input.threadId}`),
          type: "provider-thread.updated",
          threadId: input.threadId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerSessionId: null,
            appThreadId: input.threadId,
            ownerNodeId: input.rootNodeId,
            nativeThreadRef: {
              driver,
              nativeId: `native:${input.threadId}`,
              strength: "strong",
            },
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: input.now,
            updatedAt: input.now,
          },
        },
        {
          id: EventId.make(`event:seed-run:${input.threadId}`),
          type: "run.updated",
          threadId: input.threadId,
          runId: input.runId,
          nodeId: input.rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: input.runId,
            threadId: input.threadId,
            ordinal: 1,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: MessageId.make(`message:seed-user:${input.threadId}`),
            rootNodeId: input.rootNodeId,
            activeAttemptId: null,
            status: input.parentRunStatus ?? "running",
            requestedAt: input.now,
            startedAt: input.now,
            completedAt: input.parentRunStatus === "completed" ? input.now : null,
            checkpointId: null,
            contextHandoffId: null,
            delegatedCompletion: {
              disposition: "open",
              nextGeneration: 2,
              delivery:
                input.deliveryTaskIds === undefined
                  ? null
                  : {
                      generation: 1,
                      messageId: MessageId.make(`message:delegated-delivery:${input.threadId}`),
                      taskIds: input.deliveryTaskIds,
                    },
            },
          },
        },
        ...[
          { id: input.taskId, deliveryState: input.deliveryState },
          ...(input.siblingTasks ?? []),
        ].map((task) => ({
          id: EventId.make(`event:seed-task:${input.threadId}:${task.id}`),
          type: "subagent.updated" as const,
          threadId: input.threadId,
          runId: input.runId,
          nodeId: task.id,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: task.id,
            threadId: input.threadId,
            runId: input.runId,
            parentNodeId: input.rootNodeId,
            origin: "app_owned" as const,
            createdBy: "agent" as const,
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerThreadId: null,
            childThreadId: null,
            nativeTaskRef: null,
            prompt: "Inspect the delivered ownership edge.",
            title: null,
            model: null,
            completionWake: input.completionWake ?? "settled_only",
            completionDelivery: {
              state: task.deliveryState,
              observedByRunId: task.deliveryState === "acknowledged" ? input.runId : null,
            },
            status: "completed" as const,
            result: "child finished",
            startedAt: input.now,
            completedAt: input.now,
            updatedAt: input.now,
          },
        })),
      ],
    });
  });

const reconcileCommandId = (name: string) => CommandId.make(`command:runtime-reconcile:${name}`);

const runEvent = (input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly ordinal: number;
  readonly status: OrchestrationV2Run["status"];
  readonly now: DateTime.Utc;
  readonly providerThreadId?: ProviderThreadId;
  readonly userMessageId?: MessageId;
  readonly delegatedCompletion?: OrchestrationV2Run["delegatedCompletion"];
}) => ({
  id: EventId.make(`event:${input.runId}:${input.status}`),
  type: "run.updated" as const,
  threadId: input.threadId,
  runId: input.runId,
  providerInstanceId: modelSelection.instanceId,
  occurredAt: input.now,
  payload: {
    id: input.runId,
    threadId: input.threadId,
    ordinal: input.ordinal,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    providerThreadId: input.providerThreadId ?? null,
    userMessageId: input.userMessageId ?? MessageId.make(`message:${input.runId}`),
    rootNodeId: null,
    activeAttemptId: null,
    status: input.status,
    requestedAt: input.now,
    startedAt: input.now,
    completedAt: input.status === "running" ? null : input.now,
    checkpointId: null,
    contextHandoffId: null,
    ...(input.delegatedCompletion === undefined
      ? {}
      : { delegatedCompletion: input.delegatedCompletion }),
  },
});

const seedRestartCancelledChild = (input: {
  readonly parentThreadId: ThreadId;
  readonly projectId: ProjectId;
  readonly parentRunId: RunId;
  readonly rootNodeId: NodeId;
  readonly name: string;
  readonly completionWake: "always" | "settled_only";
  readonly continuationPending: boolean;
  readonly runStatus?: "cancelled" | "completed" | "running";
  readonly lostWork?: OrchestrationV2Run["restartCancelledBackgroundWork"];
  readonly now: DateTime.Utc;
}) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const taskId = NodeId.make(`node:${input.name}`);
    const childThreadId = ThreadId.make(`thread:${input.name}`);
    const childRunId = RunId.make(`run:${input.name}:1`);
    yield* eventSink.write({
      commandId: CommandId.make(`command:seed-child:${input.name}`),
      events: [
        {
          id: EventId.make(`event:${input.name}:thread`),
          type: "thread.created",
          threadId: childThreadId,
          occurredAt: input.now,
          payload: {
            createdBy: "agent",
            creationSource: "server",
            id: childThreadId,
            projectId: input.projectId,
            title: input.name,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: {
              parentThreadId: input.parentThreadId,
              relationshipToParent: "subagent",
              rootThreadId: input.parentThreadId,
            },
            forkedFrom: { type: "node", nodeId: taskId },
            createdAt: input.now,
            updatedAt: input.now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        },
        {
          id: EventId.make(`event:${input.name}:task`),
          type: "subagent.updated",
          threadId: input.parentThreadId,
          runId: input.parentRunId,
          nodeId: taskId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: taskId,
            threadId: input.parentThreadId,
            runId: input.parentRunId,
            parentNodeId: input.rootNodeId,
            origin: "app_owned",
            createdBy: "agent",
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerThreadId: null,
            childThreadId,
            nativeTaskRef: null,
            prompt: `Run ${input.name}.`,
            title: null,
            model: null,
            completionWake: input.completionWake,
            status: "running",
            result: null,
            startedAt: input.now,
            completedAt: null,
            updatedAt: input.now,
          },
        },
      ],
    });
    const childRun = runEvent({
      threadId: childThreadId,
      runId: childRunId,
      ordinal: 1,
      status: input.runStatus ?? "cancelled",
      now: input.now,
    });
    yield* eventSink.writeWithEffects({
      commandId: reconcileCommandId(input.name),
      events: [
        input.lostWork === undefined
          ? childRun
          : {
              ...childRun,
              payload: { ...childRun.payload, restartCancelledBackgroundWork: input.lostWork },
            },
      ],
      effects: input.continuationPending
        ? [
            {
              id: `effect:restart-continuation:${childRunId}`,
              commandId: reconcileCommandId(input.name),
              threadId: childThreadId,
              request: { type: "provider-runtime.continue", sourceRunId: childRunId },
            },
          ]
        : [],
    });
    return { taskId, childThreadId, childRunId };
  });

const layerFollowups = Layer.merge(layerTest, ProviderContinuationRequests.layer).pipe(
  Layer.provideMerge(
    Layer.unwrap(
      makePausedEnvironment.pipe(
        Effect.tap((pause) => pause.resume),
        Effect.map((pause) => pause.layer),
      ),
    ),
  ),
);

it.layer(layerFollowups)("delegated background wakes", (it) => {
  it.effect("refuses return that would put a launched child under its own descendant", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projects = yield* ProjectService.ProjectService;
      const projectId = ProjectId.make("project:return-cycle");
      const ownerId = ThreadId.make("return-cycle-owner");
      const childId = ThreadId.make("return-cycle-child");
      yield* projects.create({
        commandId: CommandId.make("project:return-cycle"),
        projectId,
        title: "Return cycle",
        workspaceRoot: "/workspace/return-cycle",
      });
      const create = {
        type: "thread.create" as const,
        projectId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
      };
      yield* orchestrator.dispatch({
        ...create,
        commandId: CommandId.make("cycle:owner"),
        threadId: ownerId,
        title: "Owner",
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        ...create,
        commandId: CommandId.make("cycle:child"),
        threadId: childId,
        title: "Child",
        createdBy: "agent",
        creationSource: "mcp",
        creatorThreadId: ownerId,
        creatorOrigin: {
          kind: "thread_launch",
          threadId: ownerId,
          environmentId: EnvironmentId.make("local-test"),
          owned: true,
        },
      });
      yield* orchestrator.dispatch({
        type: "thread.ownership.change",
        commandId: CommandId.make("cycle:promote"),
        threadId: childId,
        action: "promote",
      });
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("cycle:group"),
        threadId: ownerId,
        groupedUnderThreadId: childId,
      });
      const refusal = yield* Effect.flip(
        orchestrator.dispatch({
          type: "thread.ownership.change",
          commandId: CommandId.make("cycle:return"),
          threadId: childId,
          action: "return_to_owner",
        }),
      );
      assert.include(JSON.stringify(refusal), "descendants");
      assert.isTrue((yield* orchestrator.getThreadProjection(childId)).thread.lineage.independent);
    }),
  );
  it.effect("refuses a new remote task association while the destination thread is promoted", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projects = yield* ProjectService.ProjectService;
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:remote-promotion");
      const threadId = ThreadId.make("thread:remote-promotion");
      const owner = {
        environmentId: EnvironmentId.make("requester"),
        threadId: ThreadId.make("owner"),
        title: "Requester",
      };
      yield* projects.create({
        commandId: CommandId.make("project:remote-promotion"),
        projectId,
        title: "Remote promotion",
        workspaceRoot: "/workspace/remote-promotion",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create:remote-promotion"),
        threadId,
        projectId,
        title: "Delegate",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "agent",
        creationSource: "mcp",
        delegatedFrom: owner,
        linkOrigin: { sessionId: "owner-link", label: "Requester", access: "full-access" },
      });
      const before = (yield* orchestrator.getThreadProjection(threadId)).thread;
      const original = {
        parentEnvironmentId: owner.environmentId,
        parentThreadId: owner.threadId,
        sourceTaskId: NodeId.make("original-task"),
        delegationId: "original-delegation",
        linkSessionId: "owner-link",
        stage: "disposed" as const,
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make("seed:disposed-delegation"),
            type: "thread.metadata-updated",
            threadId,
            occurredAt: now,
            payload: { ...before, remoteDelegations: [original] },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "thread.ownership.change",
        commandId: CommandId.make("promote:remote"),
        threadId,
        action: "promote",
      });
      const prepare = {
        type: "remote_delegation.prepare" as const,
        commandId: CommandId.make("prepare:released"),
        threadId,
        association: {
          ...original,
          sourceTaskId: NodeId.make("new-task"),
          delegationId: "new-delegation",
          stage: "prepared" as const,
        },
      };
      const refusal = yield* Effect.flip(orchestrator.dispatch(prepare));
      assert.include(refusal.message, "Return to owner");
      assert.deepEqual(
        (yield* orchestrator.getThreadProjection(threadId)).thread.remoteDelegations,
        [original],
      );

      yield* orchestrator.dispatch({
        type: "thread.ownership.change",
        commandId: CommandId.make("return:remote"),
        threadId,
        action: "return_to_owner",
      });
      yield* orchestrator.dispatch({ ...prepare, commandId: CommandId.make("prepare:returned") });
      assert.deepEqual(
        (yield* orchestrator.getThreadProjection(threadId)).thread.remoteDelegations,
        [original, prepare.association],
      );
    }),
  );
  it.effect(
    "promotes a local delegate after its requester observes the result and can return it",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const now = yield* DateTime.now;
        const parentThreadId = ThreadId.make("thread:promotion-parent");
        const projectId = ProjectId.make("project:promotion");
        const parentRunId = RunId.make("run:promotion-parent");
        const rootNodeId = NodeId.make("node:promotion-parent");
        yield* seedParentWithTerminalTask({
          threadId: parentThreadId,
          projectId,
          runId: parentRunId,
          rootNodeId,
          taskId: NodeId.make("node:promotion-seed"),
          deliveryState: "acknowledged",
          now,
        });
        const child = yield* seedRestartCancelledChild({
          parentThreadId,
          projectId,
          parentRunId,
          rootNodeId,
          name: "promotion-child",
          completionWake: "always",
          continuationPending: false,
          runStatus: "completed",
          now,
        });
        const command = {
          type: "thread.ownership.change" as const,
          commandId: CommandId.make("command:promote-child"),
          threadId: child.childThreadId,
          action: "promote" as const,
        };
        const before = (yield* orchestrator.getThreadProjection(child.childThreadId)).thread;
        yield* orchestrator.recoverDelegatedTasks;
        const availability = yield* orchestrator.getThreadOwnershipAvailability(
          child.childThreadId,
        );
        assert.strictEqual(availability?.refusal, "in_flight");
        const refusal = yield* Effect.flip(
          orchestrator.dispatch({
            ...command,
            commandId: CommandId.make("command:promote-child-before-ack"),
          }),
        );
        assert.include(JSON.stringify(refusal), "task_cancel");
        assert.deepEqual(
          (yield* orchestrator.getThreadProjection(child.childThreadId)).thread,
          before,
        );

        yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make("command:ack-promoted-child"),
          parentThreadId,
          taskId: child.taskId,
          observedByRunId: parentRunId,
        });
        const result = yield* orchestrator.dispatch(command);
        const promoted = (yield* orchestrator.getThreadProjection(child.childThreadId)).thread;
        assert.deepEqual(promoted.lineage, { ...before.lineage, independent: true });
        assert.isNull(promoted.groupedUnderThreadId);
        assert.deepEqual(promoted.forkedFrom, before.forkedFrom);
        assert.strictEqual((yield* orchestrator.dispatch(command)).sequence, result.sequence);

        const sql = yield* SqlClient.SqlClient;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const { snapshot } = yield* loadSubscriberShellSnapshot({
          sql,
          listShellIndex: store.listActiveShellIndex(),
          readThreads: (threadIds) =>
            store.readShellSnapshot({
              location: "active",
              ...(threadIds === undefined ? {} : { threadIds }),
            }),
          listProjects: Effect.succeed([]),
          latestSequence: Effect.succeed(result.sequence),
          options: { omitIdleSubagents: true, omitOlderSettled: true },
        });
        assert.isTrue(snapshot.threads.some((thread) => thread.id === child.childThreadId));

        const projects = yield* ProjectService.ProjectService;
        const sink = yield* EventSink.EventSinkV2;
        const movedProject = ProjectId.make("project:promotion-moved");
        yield* projects.create({
          commandId: CommandId.make("project:promotion-moved"),
          projectId: movedProject,
          title: "Moved owner",
          workspaceRoot: "/workspace/promotion-moved",
        });
        const owner = (yield* orchestrator.getThreadProjection(parentThreadId)).thread;
        const placeOwner = (projectId: ProjectId) =>
          sink.write({
            events: [
              {
                type: "thread.metadata-updated",
                id: EventId.make(`event:promotion-owner:${projectId}`),
                threadId: parentThreadId,
                occurredAt: now,
                payload: { ...owner, projectId },
              },
            ],
          });
        yield* placeOwner(movedProject);
        const invalidParent = yield* Effect.flip(
          orchestrator.dispatch({
            ...command,
            action: "return_to_owner",
            commandId: CommandId.make("command:return-with-moved-owner"),
          }),
        );
        assert.include(JSON.stringify(invalidParent), "in this project");
        assert.isTrue(
          (yield* orchestrator.getThreadProjection(child.childThreadId)).thread.lineage.independent,
        );
        yield* placeOwner(projectId);

        yield* orchestrator.dispatch({
          ...command,
          action: "return_to_owner",
          commandId: CommandId.make("command:return-child"),
        });
        const returned = (yield* orchestrator.getThreadProjection(child.childThreadId)).thread;
        assert.deepEqual(returned.lineage, before.lineage);
        assert.isNull(returned.groupedUnderThreadId);
      }),
  );
  it.effect(
    "delivers the awaited Codex command result once the original child's wake finishes",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const parentThreadId = ThreadId.make("thread:codex-awaited-parent");
        const parentRunId = RunId.make("run:codex-awaited-parent");
        const rootNodeId = NodeId.make("node:codex-awaited-parent");
        const projectId = ProjectId.make("project:codex-awaited");
        yield* seedParentWithTerminalTask({
          threadId: parentThreadId,
          projectId,
          runId: parentRunId,
          rootNodeId,
          taskId: NodeId.make("node:codex-awaited-seed"),
          deliveryState: "acknowledged",
          now,
        });
        const { childThreadId, childRunId, taskId } = yield* seedRestartCancelledChild({
          parentThreadId,
          parentRunId,
          rootNodeId,
          projectId,
          name: "codex-awaited-child",
          completionWake: "always",
          continuationPending: false,
          runStatus: "running",
          now,
        });
        const parent = yield* orchestrator.getThreadProjection(parentThreadId);
        const providerThread = {
          ...parent.providerThreads[0]!,
          id: ProviderThreadId.make("provider-thread:codex-awaited-child"),
          appThreadId: childThreadId,
        };
        const commandTaskId = "codex-command";
        const rosterEvent = (
          stage: string,
          roster: Pick<typeof providerThread, "pendingBackgroundTasks" | "owedBackgroundResults">,
        ) => ({
          id: EventId.make(`event:codex-awaited-roster:${stage}`),
          type: "provider-thread.updated" as const,
          threadId: childThreadId,
          runId: childRunId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: { ...providerThread, ...roster },
        });
        const answer = (runId: RunId, text: string) => ({
          id: EventId.make(`event:codex-awaited-answer:${runId}`),
          type: "message.updated" as const,
          threadId: childThreadId,
          runId,
          occurredAt: now,
          payload: {
            id: MessageId.make(`message:codex-awaited-answer:${runId}`),
            threadId: childThreadId,
            runId,
            nodeId: null,
            role: "assistant" as const,
            text,
            attachments: [],
            streaming: false,
            createdBy: "agent" as const,
            creationSource: "server" as const,
            createdAt: now,
            updatedAt: now,
          },
        });
        const initialRun = runEvent({
          threadId: childThreadId,
          runId: childRunId,
          providerThreadId: providerThread.id,
          ordinal: 1,
          status: "completed",
          now,
        });
        yield* eventSink.write({
          events: [
            rosterEvent("running", {
              pendingBackgroundTasks: [{ taskId: commandTaskId, kind: "command", awaited: true }],
            }),
            answer(childRunId, "Still running."),
            { ...initialRun, payload: { ...initialRun.payload, delegatedTaskId: taskId } },
          ],
        });
        const task = () =>
          orchestrator
            .getThreadProjection(parentThreadId)
            .pipe(
              Effect.map((projection) => projection.subagents.find((row) => row.id === taskId)!),
            );
        yield* orchestrator.recoverDelegatedTasks;
        assert.isNull((yield* task()).result);

        yield* eventSink.write({
          events: [
            rosterEvent("owed", {
              pendingBackgroundTasks: [],
              owedBackgroundResults: [{ taskId: commandTaskId, originRunId: childRunId }],
            }),
          ],
        });
        yield* orchestrator.recoverDelegatedTasks;
        assert.isNull((yield* task()).result);

        const wakeMessageId = MessageId.make("message:codex-awaited-wake");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("command:codex-awaited-wake"),
          threadId: childThreadId,
          messageId: wakeMessageId,
          text: "The awaited command exited with code 3.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
          notification: {
            source: { kind: "command" },
            outcome: "failed",
            summary: "The awaited command exited with code 3.",
          },
          backgroundResultContinuation: {
            providerThreadId: providerThread.id,
            originRunId: childRunId,
            taskIds: [commandTaskId],
          },
        });
        const wakeRun = (yield* orchestrator.getThreadProjection(childThreadId)).runs.find(
          (run) => run.userMessageId === wakeMessageId,
        )!;
        assert.equal(wakeRun.delegatedTaskId, taskId);
        yield* eventSink.write({
          events: [
            rosterEvent("claimed", { pendingBackgroundTasks: [], owedBackgroundResults: [] }),
          ],
        });
        yield* orchestrator.recoverDelegatedTasks;
        assert.isNull((yield* task()).result);

        yield* eventSink.write({
          events: [
            answer(wakeRun.id, "Exit code 3."),
            {
              id: EventId.make("event:codex-awaited-wake-completed"),
              type: "run.updated",
              threadId: childThreadId,
              runId: wakeRun.id,
              occurredAt: now,
              payload: { ...wakeRun, status: "completed", startedAt: now, completedAt: now },
            },
          ],
        });
        yield* orchestrator.recoverDelegatedTasks;
        yield* orchestrator.recoverDelegatedTasks;
        const completed = yield* task();
        assert.equal(completed.status, "completed");
        assert.equal(completed.result, "Exit code 3.");
        const finished = yield* orchestrator.getThreadProjection(parentThreadId);
        assert.deepEqual(
          finished.runs.find((run) => run.id === parentRunId)?.delegatedCompletion?.delivery
            ?.taskIds,
          [taskId],
        );
        assert.lengthOf(
          finished.contextTransfers.filter(
            (transfer) =>
              transfer.type === "subagent_result" && transfer.sourceThreadId === childThreadId,
          ),
          1,
        );
      }),
  );
  it.effect.each(["active", "paused", "released", "independent"] as const)(
    "handles a background command's wake after the original result while %s",
    (state) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        const now = yield* DateTime.now;
        const parentThreadId = ThreadId.make(`thread:background-wake-parent-${state}`);
        const projectId = ProjectId.make(`project:background-wake-${state}`);
        const parentRunId = RunId.make(`run:background-wake-parent-${state}`);
        const rootNodeId = NodeId.make(`node:background-wake-parent-${state}`);
        yield* seedParentWithTerminalTask({
          threadId: parentThreadId,
          projectId,
          runId: parentRunId,
          rootNodeId,
          taskId: NodeId.make(`node:background-wake-seed-${state}`),
          deliveryState: "acknowledged",
          now,
        });
        const child = yield* seedRestartCancelledChild({
          parentThreadId,
          projectId,
          parentRunId,
          rootNodeId,
          name: `background-wake-child-${state}`,
          completionWake: "always",
          continuationPending: false,
          runStatus: "completed",
          now,
        });
        yield* orchestrator.recoverDelegatedTasks;
        let firstWake = yield* requests.take;
        while (firstWake.threadId !== parentThreadId) firstWake = yield* requests.take;
        yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make(`command:background-wake-ack-${state}`),
          parentThreadId,
          taskId: child.taskId,
          observedByRunId: parentRunId,
        });
        const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.find(
          (run) => run.id === parentRunId,
        )!;
        yield* eventSink.write({
          commandId: reconcileCommandId(`background-wake-parent-finished-${state}`),
          events: [
            {
              id: EventId.make(`event:background-wake-parent-finished-${state}`),
              type: "run.updated",
              threadId: parentThreadId,
              runId: parentRunId,
              occurredAt: now,
              payload: { ...parentRun, status: "completed", completedAt: now },
            },
          ],
        });

        const originalParent = yield* orchestrator.getThreadProjection(parentThreadId);
        const originalTask = originalParent.subagents.find((task) => task.id === child.taskId)!;
        if (state === "released" || state === "independent") {
          const childThread = (yield* orchestrator.getThreadProjection(child.childThreadId)).thread;
          yield* eventSink.write({
            events: [
              state === "released"
                ? {
                    id: EventId.make(`event:background-wake-released-${state}`),
                    type: "subagent.updated",
                    threadId: parentThreadId,
                    occurredAt: now,
                    payload: {
                      ...originalTask,
                      ownershipReleased: true,
                      completionDelivery: { state: "disposed", observedByRunId: null },
                    },
                  }
                : {
                    id: EventId.make(`event:background-wake-independent-${state}`),
                    type: "thread.metadata-updated",
                    threadId: child.childThreadId,
                    occurredAt: now,
                    payload: {
                      ...childThread,
                      lineage: { ...childThread.lineage, independent: true },
                    },
                  },
            ],
          });
        }
        const pauseStore = yield* EnvironmentPauseStore.EnvironmentPauseStore;
        if (state === "paused")
          yield* pauseStore.update((session) => ({ ...session!, phase: "paused" }));
        const wakeMessageId = MessageId.make(`message:background-wake-${state}`);
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "agent",
          creationSource: "provider",
          commandId: CommandId.make(`command:background-wake-${state}`),
          threadId: child.childThreadId,
          messageId: wakeMessageId,
          text: "Background activity updated",
          notification: {
            source: { kind: "command" },
            outcome: "completed",
            summary: 'Command "build" finished',
          },
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
        });
        let run = (yield* orchestrator.getThreadProjection(child.childThreadId)).runs.find(
          (row) => row.userMessageId === wakeMessageId,
        )!;
        if (state === "released" || state === "independent") {
          assert.isUndefined(run.delegatedTaskId);
          const parent = yield* orchestrator.getThreadProjection(parentThreadId);
          assert.equal(parent.subagents.length, originalParent.subagents.length);
          assert.deepEqual(parent.runs, originalParent.runs);
          return;
        }
        assert.isDefined(run.delegatedTaskId);
        if (state === "paused") {
          assert.equal(run.status, "queued");
          assert.isNull(
            (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
              (task) => task.id === run.delegatedTaskId,
            )!.result,
          );
          yield* pauseStore.update((session) => ({ ...session!, phase: "resuming" }));
          yield* orchestrator.resumeQueuedRuns;
          run = (yield* orchestrator.getThreadProjection(child.childThreadId)).runs.find(
            (row) => row.userMessageId === wakeMessageId,
          )!;
          assert.notEqual(run.status, "queued");
        }
        yield* eventSink.write({
          commandId: reconcileCommandId(`background-wake-finished-${state}`),
          events: [
            {
              id: EventId.make(`event:background-wake-result-${state}`),
              type: "message.updated",
              threadId: child.childThreadId,
              runId: run.id,
              occurredAt: now,
              payload: {
                id: MessageId.make(`message:background-wake-result-${state}`),
                threadId: child.childThreadId,
                runId: run.id,
                nodeId: null,
                role: "assistant",
                text: "The background command finished cleanly.",
                attachments: [],
                streaming: false,
                createdBy: "agent",
                creationSource: "server",
                createdAt: now,
                updatedAt: now,
              },
            },
            {
              id: EventId.make(`event:background-wake-finished-${state}`),
              type: "run.updated",
              threadId: child.childThreadId,
              runId: run.id,
              occurredAt: now,
              payload: { ...run, status: "completed", startedAt: now, completedAt: now },
            },
          ],
        });
        yield* orchestrator.recoverDelegatedTasks;
        const followup = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
          (task) => task.id === run.delegatedTaskId,
        )!;
        assert.equal(followup.status, "completed");
        assert.equal(followup.result, "The background command finished cleanly.");
        assert.equal(followup.completionDelivery?.state, "claimed");
        let wake = yield* requests.take;
        while (
          wake.threadId !== parentThreadId ||
          wake.delegatedCompletion?.messageId === firstWake.delegatedCompletion?.messageId
        ) {
          wake = yield* requests.take;
        }
        assert.equal(wake.delegatedCompletion?.parentRunId, parentRunId);
        const delivered = yield* orchestrator.getThreadProjection(parentThreadId);
        const delivery = delivered.runs.find((row) => row.id === parentRunId)!.delegatedCompletion!
          .delivery!;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "agent",
          creationSource: "server",
          commandId: CommandId.make(`command:background-wake-delivery-${state}`),
          threadId: parentThreadId,
          messageId: delivery.messageId,
          text: "Child background work finished",
          attachments: [],
          delegatedCompletion: {
            parentRunId,
            generation: delivery.generation,
            taskIds: delivery.taskIds,
          },
          dispatchMode: { type: "queue_after_active" },
        });
        yield* orchestrator.recoverDelegatedTasks;
        yield* orchestrator.recoverDelegatedTasks;
        const recovered = yield* orchestrator.getThreadProjection(parentThreadId);
        assert.equal(
          recovered.subagents.filter((task) => task.id === run.delegatedTaskId).length,
          1,
        );
        assert.equal(
          recovered.contextTransfers.filter(
            (transfer) =>
              transfer.type === "subagent_result" &&
              transfer.sourceThreadId === child.childThreadId,
          ).length,
          2,
        );
        assert.equal(
          recovered.runs.filter((row) => row.userMessageId === delivery.messageId).length,
          1,
        );
      }),
  );
});
