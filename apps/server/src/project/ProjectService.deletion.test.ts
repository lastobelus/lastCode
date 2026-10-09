import * as ServerSettings from "../serverSettings.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  UpdateDrainAdmissionError,
  UpdateDrainRequestId,
  UpdateDrainTargetVersion,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import * as UpdateDrain from "../updateDrain/UpdateDrain.ts";
import * as UpdateDrainAdmission from "../updateDrain/UpdateDrainAdmission.ts";
import * as UpdateDrainRepository from "../persistence/UpdateDrainRepository.ts";
import { OrchestrationEffectRequestV2 } from "../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import {
  DispatchModeLimit,
  type DispatchModeRefusal,
} from "../orchestration-v2/DispatchModeLimit.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import { planThreadDeletion } from "../orchestration-v2/ThreadDeletion.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as UpdateDrainAdmissionTestkit from "../updateDrain/UpdateDrainAdmission.testkit.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const isUpdateDrainAdmissionError = Schema.is(UpdateDrainAdmissionError);

const layerEventPersistence = EventSink.layer.pipe(
  Layer.provideMerge(Layer.merge(EventStore.layer, ProjectionStore.layer)),
);
const layerServices = Layer.mergeAll(
  ServerSettings.layerTest(),
  UpdateDrainAdmissionTestkit.layerOpen,
  LegacyV1ThreadImporter.layer.pipe(Layer.provideMerge(layerEventPersistence)),
  ProjectionMaintenance.layer.pipe(Layer.provide(layerEventPersistence)),
  ProjectStore.layer,
  IdAllocator.layer,
  ThreadCommandExecutor.layer,
  Layer.succeed(WorkspacePaths.WorkspacePaths, {
    normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
      Effect.succeed({ absolutePath: `${workspaceRoot}/${relativePath}`, relativePath }),
  }),
).pipe(
  Layer.provideMerge(
    ProjectEnrichmentService.layer.pipe(
      Layer.provide(
        Layer.merge(
          Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
            resolve: () => Effect.succeed(null),
          }),
          Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
            resolvePath: () => Effect.succeed(null),
          }),
        ),
      ),
    ),
  ),
);
const layerDatabase = SqlitePersistence.layerMemory.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "project-deletion-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
const decodeEffectRequest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationEffectRequestV2),
);

const seedProject = Effect.fn("ProjectDeletionTest.seedProject")(function* (projectId: ProjectId) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model_selection_json,
      scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      ${projectId}, 'Deletion test', ${`/work/${projectId}`}, NULL,
      '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
    )
  `;
});

function nativeThreadCreated(projectId: ProjectId, threadId: ThreadId) {
  const createdAt = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
  const providerInstanceId = ProviderInstanceId.make("codex");
  const payload: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: threadId,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  return {
    id: EventId.make(`created:${threadId}`),
    type: "thread.created" as const,
    threadId,
    providerInstanceId,
    occurredAt: createdAt,
    payload,
  };
}

function creatorGroupedThreadCreated(
  projectId: ProjectId,
  threadId: ThreadId,
  creatorThreadId: ThreadId,
  overrides: Partial<OrchestrationV2AppThread> = {},
) {
  const event = nativeThreadCreated(projectId, threadId);
  return {
    ...event,
    payload: {
      ...event.payload,
      createdBy: "agent" as const,
      creationSource: "mcp" as const,
      creatorThreadId,
      creatorGrouping: "grouped" as const,
      ...overrides,
    },
  };
}

it.effect("retries a partial project deletion without repeating child events or cleanup", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("project:partial-deletion");
    const survivorProjectId = ProjectId.make("project:partial-survivors");
    const threadIds = [ThreadId.make("thread:delete-a"), ThreadId.make("thread:delete-b")] as const;
    const survivorId = (creatorId: ThreadId) => ThreadId.make(`ordinary-survivor:${creatorId}`);
    const commandId = CommandId.make("command:partial-project-delete");
    yield* seedProject(projectId);
    yield* seedProject(survivorProjectId);
    yield* TestClock.setTime(Date.parse("2026-09-04T12:00:00.000Z"));

    yield* Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* eventSink.write({
        events: threadIds.flatMap((threadId) => [
          nativeThreadCreated(projectId, threadId),
          creatorGroupedThreadCreated(survivorProjectId, survivorId(threadId), threadId),
        ]),
      });
      const attempts: ThreadId[] = [];
      const failingEventSink = EventSink.EventSinkV2.of({
        ...eventSink,
        commitCommand: Effect.fn("ProjectDeletionTest.failSecondChild")(function* (
          input: Parameters<EventSink.EventSinkV2Shape["commitCommand"]>[0],
        ) {
          attempts.push(input.threadId);
          if (attempts.length === 2) {
            return yield* new EventSink.EventSinkWriteError({
              commandId: input.commandId,
              eventCount: input.events.length,
              cause: new Error("Injected failure for the second child"),
            });
          }
          return yield* eventSink.commitCommand(input);
        }),
      });
      const service = yield* ProjectService.make.pipe(
        Effect.provideService(EventSink.EventSinkV2, failingEventSink),
      );
      const input = { commandId, projectId, force: true };
      const failure = yield* service.delete(input).pipe(Effect.flip);
      assert.instanceOf(failure, ProjectService.ProjectOperationError);
      if (failure._tag !== "ProjectOperationError") return assert.fail("Expected a child failure");
      assert.equal(failure.operation, "delete-thread");
      assert.lengthOf(attempts, 2);
      const firstThreadId = attempts[0] ?? assert.fail("The first child was not attempted");
      const failedThreadId = attempts[1] ?? assert.fail("The second child was not attempted");
      assert.notEqual(firstThreadId, failedThreadId);
      assert.isTrue(Option.isSome(yield* service.getById(projectId)));
      assert.isNotNull((yield* projections.getThreadProjection(firstThreadId)).thread.deletedAt);
      assert.isNull((yield* projections.getThreadProjection(failedThreadId)).thread.deletedAt);
      assert.equal(
        (yield* projections.getThread(survivorId(firstThreadId))).creatorGrouping,
        "independent",
      );
      assert.equal(
        (yield* projections.getThread(survivorId(failedThreadId))).creatorGrouping,
        "grouped",
      );

      const readDeletions = sql<{
        readonly sequence: number;
        readonly stream_id: string;
        readonly command_id: string;
        readonly event_type: string;
      }>`
        SELECT sequence, stream_id, command_id, event_type
        FROM orchestration_events
        WHERE event_type IN ('thread.deleted', 'project.deleted')
          AND stream_id IN (${threadIds[0]}, ${threadIds[1]}, ${projectId})
        ORDER BY sequence ASC
      `;
      const readCleanup = sql<{
        readonly effect_id: string;
        readonly thread_id: string;
        readonly command_id: string;
        readonly effect_type: string;
      }>`
        SELECT effect_id, thread_id, command_id, effect_type
        FROM orchestration_v2_effect_outbox
        WHERE thread_id IN (${threadIds[0]}, ${threadIds[1]})
        ORDER BY effect_id ASC
      `;
      const readReleases = sql<{
        readonly sequence: number;
        readonly stream_id: string;
        readonly command_id: string;
      }>`
        SELECT sequence, stream_id, command_id FROM orchestration_events
        WHERE event_type = 'thread.metadata-updated'
          AND stream_id IN (${survivorId(threadIds[0])}, ${survivorId(threadIds[1])})
        ORDER BY sequence ASC
      `;
      const partialReleases = yield* readReleases;
      assert.lengthOf(partialReleases, 1);
      assert.equal(partialReleases[0]?.stream_id, survivorId(firstThreadId));
      assert.equal(partialReleases[0]?.command_id, `${commandId}:delete-thread:${firstThreadId}`);
      const partialEvents = yield* readDeletions;
      const partialCleanup = yield* readCleanup;
      assert.lengthOf(partialEvents, 1);
      assert.equal(partialEvents[0]?.stream_id, firstThreadId);
      assert.equal(partialEvents[0]?.event_type, "thread.deleted");
      assert.deepEqual(
        partialCleanup.map((effect) => [effect.thread_id, effect.effect_type]),
        [
          [firstThreadId, "preview.cleanup"],
          [firstThreadId, "terminal.cleanup"],
        ],
      );

      const deletedProject = yield* service.delete(input);
      assert.isNotNull(deletedProject.deletedAt);
      assert.isTrue(Option.isNone(yield* service.getById(projectId)));
      assert.deepEqual(attempts, [firstThreadId, failedThreadId, failedThreadId]);
      for (const threadId of threadIds) {
        assert.isNotNull((yield* projections.getThreadProjection(threadId)).thread.deletedAt);
        const survivor = yield* projections.getThread(survivorId(threadId));
        assert.isNull(survivor.deletedAt);
        assert.equal(survivor.creatorGrouping, "independent");
      }
      const finalReleases = yield* readReleases;
      assert.lengthOf(finalReleases, 2);
      assert.deepEqual(finalReleases[0], partialReleases[0]);
      yield* service.delete(input);
      assert.deepEqual(yield* readReleases, finalReleases);
      const finalEvents = yield* readDeletions;
      assert.deepEqual(
        finalEvents.map((event) => [event.stream_id, event.event_type]),
        [
          [firstThreadId, "thread.deleted"],
          [failedThreadId, "thread.deleted"],
          [projectId, "project.deleted"],
        ],
      );
      assert.deepEqual(finalEvents[0], partialEvents[0]);
      assert.equal(finalEvents[2]?.command_id, commandId);
      const finalCleanup = yield* readCleanup;
      assert.lengthOf(finalCleanup, 4);
      assert.deepEqual(
        finalCleanup.filter((effect) => effect.thread_id === firstThreadId),
        partialCleanup,
      );
      for (const threadId of threadIds) {
        const expectedCommandId = `${commandId}:delete-thread:${threadId}`;
        assert.deepEqual(
          finalCleanup.filter((effect) => effect.thread_id === threadId),
          [
            {
              effect_id: `effect:${expectedCommandId}:preview.cleanup:${threadId}`,
              thread_id: threadId,
              command_id: expectedCommandId,
              effect_type: "preview.cleanup",
            },
            {
              effect_id: `effect:${expectedCommandId}:terminal.cleanup:${threadId}`,
              thread_id: threadId,
              command_id: expectedCommandId,
              effect_type: "terminal.cleanup",
            },
          ],
        );
      }
    }).pipe(Effect.provide(layerServices));
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("releases cross-project creator grouping while preserving ongoing ordinary work", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("project:creator-delete");
    const survivorProjectId = ProjectId.make("project:ordinary-survivors");
    const creatorId = ThreadId.make("thread:deleted-creator");
    const ordinaryId = ThreadId.make("thread:ongoing-ordinary");
    const archivedId = ThreadId.make("thread:archived-ordinary");
    const commandId = CommandId.make("command:delete-creator-project");
    yield* seedProject(projectId);
    yield* seedProject(survivorProjectId);
    yield* TestClock.setTime(Date.parse("2026-09-04T12:00:00.000Z"));
    yield* Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const eventStore = yield* EventStore.EventStoreV2;
      const service = yield* ProjectService.make;
      const now = yield* DateTime.now;
      const runId = RunId.make("run:ongoing-ordinary");
      const nodeId = NodeId.make("node:ordinary-user-input");
      const requestId = RuntimeRequestId.make("request:ordinary-user-input");
      const continuationCommand = CommandId.make("command:ordinary-continuation");
      yield* sink.writeWithEffects({
        commandId: continuationCommand,
        events: [
          nativeThreadCreated(projectId, creatorId),
          creatorGroupedThreadCreated(survivorProjectId, ordinaryId, creatorId, {
            persistent: true,
            pinnedAt: now,
            pinOrderKey: "a0",
            activeOrderKey: "a1",
          }),
          creatorGroupedThreadCreated(survivorProjectId, archivedId, creatorId, {
            archivedAt: now,
            archivedWith: {
              threadId: archivedId,
              commandId: CommandId.make("command:ordinary-own-archive"),
            },
          }),
          {
            id: EventId.make("event:ordinary-run"),
            type: "run.updated",
            threadId: ordinaryId,
            runId,
            occurredAt: now,
            payload: {
              id: runId,
              threadId: ordinaryId,
              ordinal: 1,
              providerInstanceId: ProviderInstanceId.make("codex"),
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
              providerThreadId: null,
              userMessageId: MessageId.make("message:ordinary-user"),
              rootNodeId: null,
              activeAttemptId: null,
              status: "running",
              requestedAt: now,
              startedAt: now,
              completedAt: null,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
          {
            id: EventId.make("event:ordinary-user-input-node"),
            type: "node.updated",
            threadId: ordinaryId,
            nodeId,
            occurredAt: now,
            payload: {
              id: nodeId,
              threadId: ordinaryId,
              runId: null,
              parentNodeId: null,
              rootNodeId: nodeId,
              kind: "user_input_request",
              status: "waiting",
              countsForRun: false,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              runtimeRequestId: requestId,
              checkpointScopeId: null,
              startedAt: now,
              completedAt: null,
            },
          },
          {
            id: EventId.make("event:ordinary-user-input-request"),
            type: "runtime-request.updated",
            threadId: ordinaryId,
            nodeId,
            occurredAt: now,
            payload: {
              id: requestId,
              nodeId,
              providerTurnId: null,
              nativeRequestRef: null,
              kind: "user_input",
              status: "pending",
              responseCapability: { type: "message" },
              createdAt: now,
              resolvedAt: null,
            },
          },
        ],
        effects: [
          {
            id: "effect:ordinary-continuation",
            commandId: continuationCommand,
            threadId: ordinaryId,
            request: { type: "provider-runtime.continue", sourceRunId: runId },
          },
        ],
      });
      const originals = yield* Effect.forEach([ordinaryId, archivedId], (id) =>
        projections.getThreadProjection(id),
      );
      const readSurvivorEffects = sql<{
        readonly effect_id: string;
        readonly status: string;
        readonly effect_type: string;
      }>`
        SELECT effect_id, status, effect_type FROM orchestration_v2_effect_outbox
        WHERE thread_id IN (${ordinaryId}, ${archivedId})
        ORDER BY effect_id
      `;
      const effectsBefore = yield* readSurvivorEffects;
      const deleted = yield* service.delete({ commandId, projectId, force: true });
      assert.isNotNull(deleted.deletedAt);
      for (const original of originals) {
        const released = yield* projections.getThreadProjection(original.thread.id);
        assert.deepEqual(released, {
          ...original,
          thread: {
            ...original.thread,
            creatorGrouping: "independent",
            pinnedAt: null,
            pinOrderKey: null,
            activeOrderKey: null,
            updatedAt: now,
          },
          updatedAt: now,
        });
      }
      assert.deepEqual(yield* readSurvivorEffects, effectsBefore);
      assert.isTrue(Option.isSome(yield* service.getById(survivorProjectId)));
      const deletionCommand = `${commandId}:delete-thread:${creatorId}`;
      const events = yield* sql<{ readonly stream_id: string; readonly event_type: string }>`
        SELECT stream_id, event_type FROM orchestration_events
        WHERE command_id = ${deletionCommand}
        ORDER BY sequence
      `;
      assert.deepEqual(
        events.map((event) => [event.stream_id, event.event_type]),
        [
          [creatorId, "thread.deleted"],
          ...[ordinaryId, archivedId].toSorted().map((id) => [id, "thread.metadata-updated"]),
        ],
      );
      const cleanup = yield* sql<{ readonly thread_id: string; readonly effect_type: string }>`
        SELECT thread_id, effect_type FROM orchestration_v2_effect_outbox
        WHERE command_id = ${deletionCommand}
      `;
      assert.sameDeepMembers(
        [...cleanup],
        [
          { thread_id: creatorId, effect_type: "terminal.cleanup" },
          { thread_id: creatorId, effect_type: "preview.cleanup" },
        ],
      );
      const beforeRetry = yield* eventStore.latestSequence();
      const refused = yield* Ref.make<DispatchModeRefusal | undefined>(undefined);
      assert.deepEqual(
        yield* service.delete({ commandId, projectId, force: true }).pipe(
          Effect.provideService(DispatchModeLimit, {
            runtimeMode: "approval-required",
            interactionMode: "plan",
            refused,
          }),
        ),
        deleted,
      );
      assert.isUndefined(yield* Ref.get(refused));
      assert.equal(yield* eventStore.latestSequence(), beforeRetry);
      assert.deepEqual(yield* readSurvivorEffects, effectsBefore);
    }).pipe(Effect.provide(layerServices));
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect.each(["runtime", "interaction"] as const)(
  "checks the %s ceiling of actual creator-grouped release targets before deleting a project",
  (mode) =>
    Effect.gen(function* () {
      const projectId = ProjectId.make(`project:limited-creator-delete:${mode}`);
      const survivorProjectId = ProjectId.make(`project:limited-survivors:${mode}`);
      const creatorId = ThreadId.make(`thread:limited-creator:${mode}`);
      const ordinaryId = ThreadId.make(`thread:broader-ordinary:${mode}`);
      const independentId = ThreadId.make(`thread:broader-independent:${mode}`);
      const commandId = CommandId.make(`command:limited-project-delete:${mode}`);
      yield* seedProject(projectId);
      yield* seedProject(survivorProjectId);
      yield* Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const eventStore = yield* EventStore.EventStoreV2;
        const service = yield* ProjectService.make;
        const creatorEvent = nativeThreadCreated(projectId, creatorId);
        yield* sink.write({
          events: [
            {
              ...creatorEvent,
              payload: {
                ...creatorEvent.payload,
                runtimeMode: "approval-required",
                interactionMode: "plan",
              },
            },
            creatorGroupedThreadCreated(survivorProjectId, ordinaryId, creatorId, {
              runtimeMode: mode === "runtime" ? "full-access" : "approval-required",
              interactionMode: mode === "interaction" ? "default" : "plan",
            }),
            creatorGroupedThreadCreated(survivorProjectId, independentId, creatorId, {
              creatorGrouping: "independent",
              persistent: true,
            }),
          ],
        });
        const creatorBefore = yield* store.getThread(creatorId);
        const ordinaryBefore = yield* store.getThread(ordinaryId);
        const independentBefore = yield* store.getThread(independentId);
        const sequenceBefore = yield* eventStore.latestSequence();
        const refused = yield* Ref.make<DispatchModeRefusal | undefined>(undefined);
        const limit = {
          runtimeMode: "approval-required",
          interactionMode: "plan",
          refused,
        } as const;
        const failure = yield* service
          .delete({ commandId, projectId, force: true })
          .pipe(Effect.provideService(DispatchModeLimit, limit), Effect.flip);
        assert.equal(failure._tag, "ProjectOperationError");
        assert.deepEqual(yield* Ref.get(refused), {
          threadId: ordinaryId,
          mode,
          runtimeMode: ordinaryBefore.runtimeMode,
          interactionMode: ordinaryBefore.interactionMode,
        });
        assert.equal(yield* eventStore.latestSequence(), sequenceBefore);
        assert.deepEqual(yield* store.getThread(creatorId), creatorBefore);
        assert.deepEqual(yield* store.getThread(ordinaryId), ordinaryBefore);
        assert.deepEqual(yield* store.getThread(independentId), independentBefore);
        assert.isTrue(Option.isSome(yield* service.getById(projectId)));
        const independentOrdinary = { ...ordinaryBefore, creatorGrouping: "independent" as const };
        yield* sink.write({
          events: [
            {
              id: EventId.make(`event:detach-broader-ordinary:${mode}`),
              type: "thread.metadata-updated",
              threadId: ordinaryId,
              occurredAt: yield* DateTime.now,
              payload: independentOrdinary,
            },
          ],
        });
        yield* Ref.set(refused, undefined);
        const deleted = yield* service
          .delete({ commandId, projectId, force: true })
          .pipe(Effect.provideService(DispatchModeLimit, limit));
        assert.isNotNull(deleted.deletedAt);
        assert.isUndefined(yield* Ref.get(refused));
        assert.deepEqual(yield* store.getThread(ordinaryId), independentOrdinary);
        assert.deepEqual(yield* store.getThread(independentId), independentBefore);
      }).pipe(Effect.provide(layerServices));
    }).pipe(Effect.provide(layerDatabase)),
);

it.effect(
  "hydrates a migrated transcript before deleting its project and cleaning attachments",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project:legacy-deletion");
      const threadId = ThreadId.make("thread:legacy-deletion");
      const commandId = CommandId.make("command:legacy-project-delete");
      yield* seedProject(projectId);
      yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json,
        runtime_mode, interaction_mode, branch, worktree_path, latest_turn_id,
        created_at, updated_at, archived_at, deleted_at
      ) VALUES (
        ${threadId}, ${projectId}, 'Legacy thread', '{"instanceId":"codex","model":"gpt-5.4"}',
        'full-access', 'default', NULL, NULL, NULL,
        '2026-01-01T00:00:00.000Z', '2026-01-04T00:00:00.000Z', NULL, NULL
      )
    `;
      yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, attachments_json,
        is_streaming, created_at, updated_at
      ) VALUES
        (
          'message:legacy-delete:1', ${threadId}, NULL, 'user', 'First question with screenshot',
          '[{"type":"image","id":"legacy_screenshot","name":"screenshot.png","mimeType":"image/png","sizeBytes":128}]',
          0, '2026-01-01T01:00:00.000Z', '2026-01-01T01:00:00.000Z'
        ),
        (
          'message:legacy-delete:2', ${threadId}, NULL, 'assistant', 'First answer', '[]',
          0, '2026-01-02T01:00:00.000Z', '2026-01-02T01:00:00.000Z'
        ),
        (
          'message:legacy-delete:3', ${threadId}, NULL, 'user', 'Follow-up question', '[]',
          0, '2026-01-03T01:00:00.000Z', '2026-01-03T01:00:00.000Z'
        ),
        (
          'message:legacy-delete:4', ${threadId}, NULL, 'assistant', 'Follow-up answer', '[]',
          0, '2026-01-04T01:00:00.000Z', '2026-01-04T01:00:00.000Z'
        )
    `;
      yield* TestClock.setTime(Date.parse("2026-09-04T12:00:00.000Z"));

      // Build the engine after seeding the legacy database, as on a real restart.
      yield* Effect.gen(function* () {
        const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const service = yield* ProjectService.make;
        assert.deepEqual(yield* importer.reconcileShells, {
          importedThreadCount: 1,
          importedMessageCount: 2,
        });
        assert.equal(yield* importer.pendingThreadCount, 1);
        assert.isTrue((yield* maintenance.rebuild).valid);
        const shellProjection = yield* projections.getThreadProjection(threadId);
        assert.deepEqual(
          shellProjection.messages.map((message) => message.id),
          ["message:legacy-delete:3", "message:legacy-delete:4"],
        );
        assert.deepEqual(
          shellProjection.messages.flatMap((message) => message.attachments),
          [],
        );

        const deletedProject = yield* service.delete({ commandId, projectId, force: true });
        assert.isNotNull(deletedProject.deletedAt);
        assert.isTrue(Option.isNone(yield* service.getById(projectId)));
        const projection = yield* projections.getThreadProjection(threadId);
        assert.isNotNull(projection.thread.deletedAt);
        assert.lengthOf(projection.messages, 4);
        assert.equal(yield* importer.pendingThreadCount, 0);
        const rows = yield* sql<{
          readonly v2_deleted_at: string | null;
          readonly project_deleted_at: string | null;
        }>`
        SELECT v2.deleted_at AS v2_deleted_at,
          project.deleted_at AS project_deleted_at
        FROM orchestration_v2_projection_threads AS v2
        JOIN projection_projects AS project ON project.project_id = v2.project_id
        WHERE v2.thread_id = ${threadId}
      `;
        assert.lengthOf(rows, 1);
        assert.isNotNull(rows[0]?.v2_deleted_at);
        assert.isNotNull(rows[0]?.project_deleted_at);
        // The legacy V1 row is only an import source; deletion writes V2 events only.
        const legacyEvents = yield* sql`
          SELECT sequence FROM orchestration_events
          WHERE application_event_version = 1 AND stream_id = ${threadId}
        `;
        assert.deepEqual(legacyEvents, []);

        const cleanup = yield* sql<{
          readonly command_id: string;
          readonly payload_json: string;
          readonly status: string;
        }>`
        SELECT command_id, payload_json, status
        FROM orchestration_v2_effect_outbox
        WHERE thread_id = ${threadId} AND effect_type = 'attachment.cleanup'
      `;
        assert.lengthOf(cleanup, 1);
        assert.equal(cleanup[0]?.command_id, `${commandId}:delete-thread:${threadId}`);
        assert.equal(cleanup[0]?.status, "pending");
        const request = yield* decodeEffectRequest(cleanup[0]?.payload_json);
        assert.deepEqual(request, {
          type: "attachment.cleanup",
          attachmentIds: ["legacy_screenshot"],
        });
      }).pipe(Effect.provide(layerServices));
    }).pipe(Effect.provide(layerDatabase)),
);

it.effect("rejects a child deletion command ID already accepted for an unrelated thread", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("project:receipt-collision");
    const otherProjectId = ProjectId.make("project:unrelated-receipt");
    const threadId = ThreadId.make("thread:receipt-collision");
    const otherThreadId = ThreadId.make("thread:unrelated-receipt");
    const commandId = CommandId.make("command:collision-project-delete");
    yield* seedProject(projectId);
    yield* seedProject(otherProjectId);

    yield* Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const service = yield* ProjectService.make;
      yield* eventSink.write({ events: [nativeThreadCreated(projectId, threadId)] });
      const accepted = yield* eventSink.commitCommand({
        commandId: CommandId.make(`${commandId}:delete-thread:${threadId}`),
        commandType: "thread.create",
        threadId: otherThreadId,
        acceptedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
        events: [nativeThreadCreated(otherProjectId, otherThreadId)],
        effects: [],
      });
      assert.equal(accepted.receipt.status, "accepted");

      const failure = yield* service
        .delete({ commandId, projectId, force: true })
        .pipe(Effect.flip);
      assert.instanceOf(failure, ProjectService.ProjectOperationError);
      if (failure._tag !== "ProjectOperationError") return assert.fail("Expected a child failure");
      assert.equal(failure.operation, "delete-thread");
      assert.isTrue(Option.isSome(yield* service.getById(projectId)));
      assert.isNull((yield* projections.getThreadProjection(threadId)).thread.deletedAt);
      assert.isNull((yield* projections.getThreadProjection(otherThreadId)).thread.deletedAt);
      const deletions = yield* sql`
        SELECT sequence FROM orchestration_events
        WHERE event_type IN ('thread.deleted', 'project.deleted')
          AND stream_id IN (${threadId}, ${otherThreadId}, ${projectId})
      `;
      assert.deepEqual(deletions, []);
      const cleanup = yield* sql`
        SELECT effect_id FROM orchestration_v2_effect_outbox
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(cleanup, []);
    }).pipe(Effect.provide(layerServices));
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("deletes a project without force once its imported threads were deleted in V2", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("project:imported-emptied");
    const threadId = ThreadId.make("thread:imported-emptied");
    yield* seedProject(projectId);
    // V2 never writes the V1 thread table, so this row stays live there.
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json,
        runtime_mode, interaction_mode, branch, worktree_path, latest_turn_id,
        created_at, updated_at, archived_at, deleted_at
      ) VALUES (
        ${threadId}, ${projectId}, 'Imported thread', '{"instanceId":"codex","model":"gpt-5.4"}',
        'full-access', 'default', NULL, NULL, NULL,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, NULL
      )
    `;
    yield* TestClock.setTime(Date.parse("2026-09-04T12:00:00.000Z"));

    yield* Effect.gen(function* () {
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const service = yield* ProjectService.make;
      yield* importer.reconcileShells;
      const early = yield* service
        .delete({ commandId: CommandId.make("command:emptied:early"), projectId })
        .pipe(Effect.flip);
      assert.equal(early._tag, "ProjectNotEmptyError");

      // Delete the imported thread the way thread.delete does.
      yield* importer.ensureTranscript(threadId);
      const command = {
        type: "thread.delete" as const,
        commandId: CommandId.make("command:emptied:thread-delete"),
        threadId,
      };
      const now = yield* DateTime.now;
      const plan = yield* planThreadDeletion({
        command,
        projection: yield* projections.getThreadRecords(threadId, [
          "runs",
          "attempts",
          "nodes",
          "runtimeRequests",
          "subagents",
          "providerSessions",
          "providerThreads",
        ]),
        attachmentIds: [],
        now,
        idAllocator,
      });
      yield* eventSink.commitCommand({
        commandId: command.commandId,
        commandType: command.type,
        threadId,
        acceptedAt: now,
        events: plan.events,
        effects: plan.effects,
      });
      const legacy = yield* sql<{ readonly deleted_at: string | null }>`
        SELECT deleted_at FROM projection_threads WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(legacy, [{ deleted_at: null }]);

      const deleted = yield* service.delete({
        commandId: CommandId.make("command:emptied:project-delete"),
        projectId,
      });
      assert.isNotNull(deleted.deletedAt);
      assert.isTrue(Option.isNone(yield* service.getById(projectId)));
    }).pipe(Effect.provide(layerServices));
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect(
  "orders direct project child deletion before drain and refuses a new cascade after claim",
  () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project:admitted-delete");
      const otherProjectId = ProjectId.make("project:claimed-delete");
      const threadId = ThreadId.make("thread:admitted-delete");
      const otherThreadId = ThreadId.make("thread:claimed-delete");
      yield* seedProject(projectId);
      yield* seedProject(otherProjectId);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const admission = yield* UpdateDrainAdmission.makeUpdateDrainAdmission();
        const service = yield* ProjectService.make.pipe(
          Effect.provideService(UpdateDrainAdmission.UpdateDrainAdmission, {
            ...admission,
            admit: (kind, effect) =>
              admission.admit(
                kind,
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(effect),
                ),
              ),
          }),
        );
        yield* sink.write({
          events: [
            nativeThreadCreated(projectId, threadId),
            nativeThreadCreated(otherProjectId, otherThreadId),
          ],
        });
        const commandId = CommandId.make("project-delete-before-drain");
        const deleting = yield* service
          .delete({ commandId, projectId, force: true })
          .pipe(Effect.forkChild);
        assert.isTrue(
          yield* Effect.race(
            Deferred.await(entered).pipe(Effect.as(true)),
            Fiber.await(deleting).pipe(Effect.as(false)),
          ),
        );
        const requestId = UpdateDrainRequestId.make("project-delete-update");
        const draining = yield* admission
          .dispatch({
            type: "update-drain.start",
            commandId: CommandId.make("project-delete-drain"),
            requestId,
            targetVersion: UpdateDrainTargetVersion.make("1.2.3"),
            createdAt: DateTime.formatIso(yield* DateTime.now),
          })
          .pipe(Effect.forkChild);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(deleting);
        yield* Fiber.join(draining);
        assert.deepEqual((yield* admission.status).blockers, [
          { type: "thread-cleanup", threadId },
        ]);
        assert.equal(
          (yield* admission.claimActivation({ requestId }).pipe(Effect.result))._tag,
          "Failure",
        );
        const completedCleanupTypes: string[] = [];
        for (let index = 0; index < 2; index++) {
          const cleanup = Option.getOrThrow(
            yield* outbox.claimNext({ workerId: "project-cleanup", leaseDurationMs: 60000 }),
          );
          completedCleanupTypes.push(cleanup.request.type);
          yield* outbox.succeed({ effectId: cleanup.id, workerId: "project-cleanup" });
          if (index === 0)
            assert.equal(
              (yield* admission.claimActivation({ requestId }).pipe(Effect.result))._tag,
              "Failure",
            );
        }
        assert.sameMembers(completedCleanupTypes, ["preview.cleanup", "terminal.cleanup"]);
        yield* admission.claimActivation({ requestId });
        yield* service.delete({ commandId, projectId, force: true });
        const before = yield* projections.getThreadProjection(otherThreadId);
        const failure = yield* service
          .delete({
            commandId: CommandId.make("project-delete-after-claim"),
            projectId: otherProjectId,
            force: true,
          })
          .pipe(Effect.flip);
        assert.equal(failure._tag, "ProjectOperationError");
        if (failure._tag === "ProjectOperationError")
          assert.equal((failure.cause as { _tag: string })._tag, "UpdateDrainAdmissionError");
        assert.deepEqual(yield* projections.getThreadProjection(otherThreadId), before);
        assert.isNull(Option.getOrThrow(yield* service.getById(otherProjectId)).deletedAt);
        assert.isEmpty(yield* outbox.pendingCleanup);
      }).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined)),
        Effect.provide(
          Layer.mergeAll(
            layerServices,
            EffectOutbox.layer,
            UpdateDrain.layer.pipe(Layer.provide(UpdateDrainRepository.layer)),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              pendingExecution: Effect.succeed([]),
            }),
            Layer.mock(TerminalManager)({ refreshMetadata: Effect.succeed([]) }),
          ),
        ),
      );
    }).pipe(Effect.provide(layerDatabase)),
);

it.effect("replays a forced project delete queued behind its commit and a closing drain", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:duplicate-delete");
    const otherProjectId = ProjectId.make("project:duplicate-other");
    const activeProjectId = ProjectId.make("project:duplicate-active");
    const threadId = ThreadId.make("thread:duplicate-delete");
    const activeThreadId = ThreadId.make("thread:duplicate-active");
    for (const id of [projectId, otherProjectId, activeProjectId]) yield* seedProject(id);
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const admissionRequests = yield* Queue.unbounded<void>();
    const drainRequests = yield* Queue.unbounded<void>();
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const sink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const admission = yield* UpdateDrainAdmission.makeUpdateDrainAdmission();
      const commandId = CommandId.make("project-delete:duplicate");
      const wrappedAdmission = UpdateDrainAdmission.UpdateDrainAdmission.of({
        ...admission,
        admit: (kind, effect) =>
          Queue.offer(admissionRequests, undefined).pipe(
            Effect.andThen(admission.admit(kind, effect)),
          ),
        dispatch: (command) =>
          Queue.offer(drainRequests, undefined).pipe(Effect.andThen(admission.dispatch(command))),
      });
      const gatedSink = EventSink.EventSinkV2.of({
        ...sink,
        commitProjectCommand: (input) =>
          input.commandId === commandId
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(sink.commitProjectCommand(input)),
              )
            : sink.commitProjectCommand(input),
      });
      const service = yield* ProjectService.make.pipe(
        Effect.provideService(UpdateDrainAdmission.UpdateDrainAdmission, wrappedAdmission),
        Effect.provideService(EventSink.EventSinkV2, gatedSink),
      );
      // A second deleted project exercises the existing receipt identity guard.
      yield* service.delete({
        commandId: CommandId.make("project-delete:other"),
        projectId: otherProjectId,
      });
      yield* Queue.take(admissionRequests);
      yield* sink.write({
        events: [
          nativeThreadCreated(projectId, threadId),
          nativeThreadCreated(activeProjectId, activeThreadId),
        ],
      });
      const input = { commandId, projectId, force: true };
      const original = yield* service
        .delete(input)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(entered);
      yield* Queue.take(admissionRequests);
      const cleanupBefore = yield* outbox.listByCommandId(
        CommandId.make(`${commandId}:delete-thread:${threadId}`),
      );
      assert.sameMembers(
        cleanupBefore.map((effect) => effect.request.type),
        ["preview.cleanup", "terminal.cleanup"],
      );
      const draining = yield* wrappedAdmission
        .dispatch({
          type: "update-drain.start",
          commandId: CommandId.make("project-delete:drain"),
          requestId: UpdateDrainRequestId.make("project-delete:request"),
          targetVersion: UpdateDrainTargetVersion.make("1.2.3"),
          createdAt: DateTime.formatIso(yield* DateTime.now),
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Queue.take(drainRequests);
      const duplicate = yield* service
        .delete(input)
        .pipe(Effect.forkChild({ startImmediately: true }));
      // This marker is offered only after the duplicate read the still-active row.
      yield* Queue.take(admissionRequests);
      yield* Deferred.succeed(release, undefined);
      const deleted = yield* Fiber.join(original);
      yield* Fiber.join(draining);
      assert.deepEqual(yield* Fiber.join(duplicate), deleted);
      assert.isNotNull(deleted.deletedAt);
      assert.equal((yield* admission.status).intent?.status, "draining");
      const events = yield* sql<{
        event_id: string;
        sequence: number;
        command_id: string;
        event_type: string;
      }>`
        SELECT event_id, sequence, command_id, event_type FROM orchestration_events
        WHERE stream_id IN (${projectId}, ${threadId}) AND event_type IN ('project.deleted', 'thread.deleted')
        ORDER BY sequence
      `;
      assert.deepEqual(
        events.map((event) => [event.command_id, event.event_type]),
        [
          [`${commandId}:delete-thread:${threadId}`, "thread.deleted"],
          [commandId, "project.deleted"],
        ],
      );
      const receipts = yield* sql<{
        command_id: string;
        stream_id: string;
        command_type: string;
        status: string;
        result_sequence: number;
      }>`
        SELECT command_id, aggregate_id AS stream_id, command_type, status, result_sequence FROM orchestration_command_receipts
        WHERE command_id IN (${commandId}, ${`${commandId}:delete-thread:${threadId}`})
        ORDER BY result_sequence
      `;
      assert.deepEqual(
        receipts.map((receipt) => [
          receipt.command_id,
          receipt.stream_id,
          receipt.command_type,
          receipt.status,
          receipt.result_sequence,
        ]),
        [
          [
            `${commandId}:delete-thread:${threadId}`,
            threadId,
            "thread.delete",
            "accepted",
            events[0]!.sequence,
          ],
          [commandId, projectId, "project.delete", "accepted", events[1]!.sequence],
        ],
      );
      assert.deepEqual(
        yield* outbox.listByCommandId(CommandId.make(`${commandId}:delete-thread:${threadId}`)),
        cleanupBefore,
      );
      const conflict = yield* service
        .delete({ ...input, projectId: otherProjectId })
        .pipe(Effect.flip);
      assert.equal(conflict._tag, "ProjectOperationError");
      if (conflict._tag === "ProjectOperationError")
        assert.equal(conflict.operation, "dispatch-project-command");
      const fresh = yield* service
        .delete({ ...input, commandId: CommandId.make("project-delete:fresh") })
        .pipe(Effect.flip);
      assert.equal(fresh._tag, "ProjectNotFoundError");
      const activeBefore = yield* projections.getThreadProjection(activeThreadId);
      const activeFailure = yield* service
        .delete({ ...input, projectId: activeProjectId })
        .pipe(Effect.flip);
      assert.equal(activeFailure._tag, "ProjectOperationError");
      if (activeFailure._tag === "ProjectOperationError")
        assert.isTrue(isUpdateDrainAdmissionError(activeFailure.cause));
      assert.deepEqual(yield* projections.getThreadProjection(activeThreadId), activeBefore);
      assert.isNull(Option.getOrThrow(yield* service.getById(activeProjectId)).deletedAt);
      assert.deepEqual(yield* outbox.pendingCleanup, [{ threadId }]);
    }).pipe(
      Effect.ensuring(Deferred.succeed(release, undefined)),
      Effect.provide(
        Layer.mergeAll(
          layerServices,
          EffectOutbox.layer,
          UpdateDrain.layer.pipe(Layer.provide(UpdateDrainRepository.layer)),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            pendingExecution: Effect.succeed([]),
          }),
          Layer.mock(TerminalManager)({ refreshMetadata: Effect.succeed([]) }),
        ),
      ),
    );
  }).pipe(Effect.provide(layerDatabase)),
);
