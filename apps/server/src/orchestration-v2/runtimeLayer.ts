import * as EnvironmentPause from "../environment/EnvironmentPause.ts";
import * as EnvironmentPauseStore from "../environment/EnvironmentPauseStore.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as OrchestrationCommandReceipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as McpAppRequests from "../mcpApps/McpAppRequests.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "../project/AgentSessionScanner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as CheckpointCaptureService from "./CheckpointCaptureService.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as CommandPolicy from "./CommandPolicy.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/continuationRequests";
import * as ProviderContinuationService from "./ProviderContinuationService.ts";
import * as ThreadTitleRegenerationService from "./ThreadTitleRegenerationService.ts";
import * as IncomingMessageSummaryService from "./IncomingMessageSummaryService.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderRuntimeRecoveryService from "./ProviderRuntimeRecoveryService.ts";
import * as ProviderSwitchService from "./ProviderSwitchService.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "./ProviderTurnStartService.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadLifecycleService from "./ThreadLifecycleService.ts";
import * as ThreadForkService from "./ThreadForkService.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as UpdateDrain from "../updateDrain/UpdateDrain.ts";
import * as UpdateDrainAdmission from "../updateDrain/UpdateDrainAdmission.ts";
import * as ThreadWait from "../threadTools/ThreadWait.ts";
import * as ActionResume from "../actionResume/ActionResume.ts";
import * as ActionRunStore from "../actionResume/ActionRunStore.ts";
import * as UpdateDrainRepositoryPersistence from "../persistence/UpdateDrainRepository.ts";
import * as WorktreeCleanupService from "./WorktreeCleanupService.ts";
import * as SubagentPromotionService from "./SubagentPromotionService.ts";
import * as ThreadRecovery from "./ThreadRecoveryService.ts";
import * as ThreadRecoveryRepair from "./ThreadRecoveryRepairService.ts";

/** The shared application event log and its command receipts. */
export const layerEventInfrastructure = Layer.mergeAll(
  OrchestrationEventStore.layer,
  OrchestrationCommandReceipts.layer,
);

const layerRuntimePolicyProvided = RuntimePolicy.layerFromProjectStore.pipe(
  Layer.provide(ProjectStore.layer),
);

const layerEventStoreProvided = EventStore.layerFromOrchestrationEventStore.pipe(
  Layer.provide(layerEventInfrastructure),
);
const layerCommandReceiptStoreProvided = CommandReceiptStore.layerFromApplicationReceipts.pipe(
  Layer.provide(layerEventInfrastructure),
);

const layerStores = Layer.mergeAll(
  layerEventInfrastructure,
  layerEventStoreProvided,
  ProjectionStore.layer,
  ProjectStore.layer,
  layerCommandReceiptStoreProvided,
  EffectOutbox.layer,
  TurnItemPositionStore.layer,
);

export const layerEventSink = EventSink.layerFromStores.pipe(Layer.provide(layerStores));
const layerEventSinkProvided = layerEventSink;
const layerProjectionMaintenanceProvided = ProjectionMaintenance.layer.pipe(
  Layer.provide(layerStores),
);
const layerThreadWaitProvided = ThreadWait.layer.pipe(
  Layer.provide(Layer.merge(ProjectionStore.layer, layerEventSinkProvided)),
);

const layerLegacyV1ThreadImporterProvided = LegacyV1ThreadImporter.layer.pipe(
  Layer.provide(layerEventSinkProvided),
);

export const layerProjectService = ProjectService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectStore.layer,
      ProjectionStore.layer,
      layerEventSinkProvided,
      IdAllocator.layer,
      layerLegacyV1ThreadImporterProvided,
    ),
  ),
);

const layerProviderEventIngestorProvided = ProviderEventIngestor.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerEventSinkProvided,
      IdAllocator.layer,
      ProjectionStore.layer,
      ThreadCommandExecutor.layer,
    ),
  ),
);

const layerCheckpointServiceProvided = CheckpointService.layer.pipe(
  Layer.provide(IdAllocator.layer),
);
const layerContextHandoffServiceProvided = ContextHandoffService.layer.pipe(
  Layer.provide(IdAllocator.layer),
);

const layerProviderAdapterRegistryProvided =
  ProviderAdapterRegistry.layerFromProviderInstanceRegistry;
const layerProviderSwitchServiceProvided = ProviderSwitchService.layer.pipe(
  Layer.provide(layerProviderAdapterRegistryProvided),
);

const layerProviderSessionManagerProvided = ProviderSessionManager.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerProviderAdapterRegistryProvided,
      layerEventSinkProvided,
      IdAllocator.layer,
      layerProviderEventIngestorProvided,
      ProjectionStore.layer,
    ),
  ),
);

// Share the admission lock between orchestration and maintenance RPCs.
export const layerUpdateDrainAdmission = UpdateDrainAdmission.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      EffectOutbox.layer,
      ProjectionStore.layer,
      layerProviderSessionManagerProvided,
      UpdateDrain.layer.pipe(Layer.provide(UpdateDrainRepositoryPersistence.layer)),
    ),
  ),
);
const layerProviderAuthServiceProvided = ProviderAuthService.layer.pipe(
  Layer.provide(Layer.merge(ProjectionStore.layer, layerProviderSessionManagerProvided)),
);

const layerThreadRecoveryProvided = ThreadRecovery.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectionStore.layer,
      layerEventSinkProvided,
      IdAllocator.layer,
      ThreadCommandExecutor.layer,
    ),
  ),
);

const layerRunExecutionServiceProvided = RunExecutionService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      McpAppModelContext.layer,
      layerCheckpointServiceProvided,
      layerEventSinkProvided,
      IdAllocator.layer,
      layerProviderEventIngestorProvided,
      layerThreadRecoveryProvided,
      ProjectionStore.layer,
    ),
  ),
);

const layerProviderTurnStartServiceProvided = ProviderTurnStartService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerContextHandoffServiceProvided,
      layerEventSinkProvided,
      IdAllocator.layer,
      ProjectionStore.layer,
      layerProviderSessionManagerProvided,
      layerProviderAuthServiceProvided,
      layerRunExecutionServiceProvided,
      layerRuntimePolicyProvided,
    ),
  ),
);

const layerProviderTurnControlServiceProvided = ProviderTurnControlService.layer.pipe(
  Layer.provide(Layer.merge(ProjectionStore.layer, layerProviderSessionManagerProvided)),
);
const layerRuntimeRequestServiceProvided = RuntimeRequestService.layer.pipe(
  Layer.provide(Layer.merge(ProjectionStore.layer, layerProviderSessionManagerProvided)),
);
const layerCheckpointRollbackServiceProvided = CheckpointRollbackService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectStore.layer,
      layerCheckpointServiceProvided,
      layerEventSinkProvided,
      IdAllocator.layer,
      ProjectionStore.layer,
      layerProviderSessionManagerProvided,
      ThreadCommandExecutor.layer,
      layerRuntimePolicyProvided,
    ),
  ),
);
const layerCheckpointCaptureServiceProvided = CheckpointCaptureService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerCheckpointServiceProvided,
      layerEventSinkProvided,
      IdAllocator.layer,
      ProjectionStore.layer,
    ),
  ),
);
const layerRunFinalizationServiceProvided = RunFinalizationService.layer.pipe(
  Layer.provide(Layer.merge(layerCheckpointCaptureServiceProvided, ProjectionStore.layer)),
);

const layerOrchestratorProvided = Orchestrator.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerCheckpointServiceProvided,
      CommandPolicy.layer,
      layerStores,
      layerEventSinkProvided,
      layerCommandReceiptStoreProvided,
      layerContextHandoffServiceProvided,
      IdAllocator.layer,
      ProjectStore.layer,
      layerProviderAdapterRegistryProvided,
      // Same layer reference as the continuation worker and the adapter
      // infrastructure so layer memoization yields one shared request queue.
      ProviderContinuationRequests.layer,
      layerProviderEventIngestorProvided,
      layerRuntimePolicyProvided,
      layerProviderSessionManagerProvided,
      layerProviderSwitchServiceProvided,
      layerRunExecutionServiceProvided,
      ThreadForkService.layer,
    ),
  ),
);

const layerAgentSessionImporterProvided = AgentSessionImporter.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      AgentSessionScanner.layer,
      layerProjectService,
      layerOrchestratorProvided,
      layerEventSinkProvided,
      IdAllocator.layer,
      ProviderSessionRuntime.layer,
    ),
  ),
);

const layerThreadManagementProvided = ThreadManagementService.layerWithLegacyImporter.pipe(
  Layer.provide(Layer.merge(layerOrchestratorProvided, layerLegacyV1ThreadImporterProvided)),
);
const layerActionResumeProvided = ActionResume.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerThreadManagementProvided,
      ProjectStore.layer,
      layerCommandReceiptStoreProvided,
      ActionRunStore.layer,
    ),
  ),
  Layer.provide(layerUpdateDrainAdmission),
);
const layerWorktreeCleanupProvided = WorktreeCleanupService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerThreadManagementProvided,
      ProjectionStore.layer,
      ProjectStore.layer,
      layerProviderSessionManagerProvided,
      layerLegacyV1ThreadImporterProvided,
      layerEventInfrastructure,
    ),
  ),
);
const layerWorktreeCleanupWorkerProvided = Layer.effectDiscard(
  Effect.flatMap(WorktreeCleanupService.WorktreeCleanupService, (service) => service.start()),
).pipe(Layer.provideMerge(layerWorktreeCleanupProvided));
export const layerProjectSetupScriptRunner = ProjectSetupScriptRunner.layer.pipe(
  Layer.provide(layerProjectService),
  Layer.provide(layerUpdateDrainAdmission),
);
const layerManagedProjectFoldersProvided = ManagedProjectFolders.layer.pipe(
  Layer.provide(layerProjectService),
);
const layerThreadLaunchProvided = ThreadLaunchService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerProjectService,
      layerProjectSetupScriptRunner,
      layerManagedProjectFoldersProvided,
      layerThreadManagementProvided,
      layerCommandReceiptStoreProvided,
      IdAllocator.layer,
    ),
  ),
);
const layerThreadLifecycleProvided = ThreadLifecycleService.layer.pipe(
  Layer.provide(layerThreadManagementProvided),
);
const layerSecretRequestsProvided = SecretRequests.layer.pipe(
  Layer.provide(layerThreadManagementProvided),
);
const layerThreadRecoveryRepairProvided = ThreadRecoveryRepair.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerThreadManagementProvided,
      ProjectionStore.layer,
      layerCommandReceiptStoreProvided,
      ProjectStore.layer,
      layerThreadLaunchProvided,
      layerThreadRecoveryProvided,
    ),
  ),
);

const layerScheduledTaskProvided = ScheduledTaskService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerThreadLaunchProvided,
      layerThreadManagementProvided,
      layerSecretRequestsProvided,
    ),
  ),
);
const layerProviderContinuationWorkerProvided = ProviderContinuationService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProviderContinuationRequests.layer,
      layerThreadManagementProvided,
      IdAllocator.layer,
    ),
  ),
);
const layerThreadTitleRegenerationProvided = ThreadTitleRegenerationService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(layerThreadManagementProvided, ProjectStore.layer, TextGeneration.layer),
  ),
);
const layerIncomingMessageSummaryProvided = IncomingMessageSummaryService.layer.pipe(
  Layer.provide(Layer.mergeAll(layerThreadManagementProvided, TextGeneration.layer)),
);
const layerSubagentPromotionProvided = SubagentPromotionService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectionStore.layer,
      layerProviderAdapterRegistryProvided,
      layerRuntimePolicyProvided,
      layerOrchestratorProvided,
    ),
  ),
);

const layerEffectExecutorProvided = EffectWorker.layerExecutor.pipe(
  Layer.provide(
    Layer.mergeAll(
      EffectOutbox.layer,
      layerRunFinalizationServiceProvided,
      layerCheckpointRollbackServiceProvided,
      layerProviderSessionManagerProvided,
      layerProviderTurnControlServiceProvided,
      layerProviderTurnStartServiceProvided,
      layerRuntimeRequestServiceProvided,
      layerThreadTitleRegenerationProvided,
      layerIncomingMessageSummaryProvided,
      layerThreadManagementProvided,
      layerSubagentPromotionProvided,
    ),
  ),
);
const layerEffectWorkerProvided = EffectWorker.layer.pipe(
  Layer.provide(Layer.merge(layerStores, layerEffectExecutorProvided)),
);
const layerProviderRuntimeRecoveryProvided = ProviderRuntimeRecoveryService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerEffectWorkerProvided,
      layerStores,
      layerEventSinkProvided,
      IdAllocator.layer,
      ProjectionStore.layer,
    ),
  ),
);

const layerMcpAppRequestsProvided = McpAppRequests.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      McpAppModelContext.layer,
      layerOrchestratorProvided,
      layerThreadManagementProvided,
      layerProviderSessionManagerProvided,
    ),
  ),
);

export const layer = Layer.mergeAll(
  layerThreadRecoveryProvided,
  layerEventSinkProvided,
  layerOrchestratorProvided,
  layerMcpAppRequestsProvided,
  layerThreadManagementProvided,
  layerEffectWorkerProvided,
  layerProviderSessionManagerProvided,
  layerProviderAuthServiceProvided,
  layerProviderRuntimeRecoveryProvided,
  layerProjectionMaintenanceProvided,
  layerLegacyV1ThreadImporterProvided,
);

const layerEnvironmentPauseProvided = EnvironmentPause.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      EnvironmentPauseStore.layer,
      layerThreadManagementProvided,
      ProjectionStore.layer,
      EffectOutbox.layer,
      layerProviderSessionManagerProvided,
    ),
  ),
);

const layerEnvironmentAutomationResume = Layer.effectDiscard(
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Scheduler;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const actions = yield* ActionResume.ActionResume;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    // Durable sources make missed transitions and restart recovery harmless.
    // Scheduler holds this source while paused; no connectivity signal releases it.
    yield* scheduler.register(
      "environment-pause-resume",
      Effect.gen(function* () {
        yield* actions.retryPendingFollowUps;
        yield* orchestrator.resumeQueuedRuns;
        yield* outbox.notifyAvailable();
      }),
    );
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(layerOrchestratorProvided, layerActionResumeProvided, EffectOutbox.layer),
  ),
);

export const layerProduction = Layer.mergeAll(
  layerEnvironmentAutomationResume,
  layerEnvironmentPauseProvided,
  layerThreadRecoveryRepairProvided,
  layerThreadWaitProvided,
  layerActionResumeProvided,
  layerWorktreeCleanupWorkerProvided,
  layer.pipe(Layer.provide(Layer.merge(layerProjectService, EnvironmentPauseStore.layer))),
  layerProjectService,
  layerManagedProjectFoldersProvided,
  layerThreadLaunchProvided,
  layerThreadLifecycleProvided,
  layerScheduledTaskProvided,
  layerSecretRequestsProvided,
  UsageLimitRecoveryWorker.layer.pipe(
    Layer.provide(Layer.mergeAll(ProjectionStore.layer, layerThreadManagementProvided)),
  ),
  layerProviderContinuationWorkerProvided,
  layerAgentSessionImporterProvided,
  EffectOutbox.layerPruneWorker.pipe(Layer.provide(EffectOutbox.layer)),
).pipe(
  Layer.provideMerge(layerUpdateDrainAdmission),
  Layer.provide(Scheduler.layer),
  Layer.provideMerge(EnvironmentPauseStore.layer),
  Layer.provideMerge(layerEventInfrastructure),
);
