import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  getThreadArchivePlan,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectEnrichment from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UpdateDrainAdmissionTestkit from "../updateDrain/UpdateDrainAdmission.testkit.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as SuspensionRegistryTestkit from "../workspace/WorktreeSuspensionRegistry.testkit.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { ArchiveTemporaryProjects } from "./LastCodeArchiveTemporaryProjects.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const database = SqlitePersistence.layerMemory;
const baseLayer = Layer.mergeAll(
  ProviderReplayHarness.layerWithRegistry(
    { name: "thread-archive-family-query" },
    ProviderAdapterRegistry.layerFromAdapters([]),
    { databaseLayer: database, runEffectWorker: false },
  ),
  ProjectionStore.layer.pipe(Layer.provide(database)),
);

const testLayer = ThreadManagementService.layer.pipe(Layer.provideMerge(baseLayer));

const instanceId = ProviderInstanceId.make("codex");
const makeThread = (rootId: ThreadId, now: DateTime.Utc): OrchestrationV2AppThread => ({
  id: rootId,
  title: "Parent",
  projectId: ProjectId.make("archive-query:project"),
  createdBy: "user",
  creationSource: "web",
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "example-model" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: rootId, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledAt: null,
  settledOverride: null,
  lastVisitedAt: null,
  deletedAt: null,
});

it.effect.each([false, true])(
  "includes protected recursive participants and refuses archive (protected native=%s)",
  (protectedNative) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const service = yield* ThreadManagementService.ThreadManagementService;
      const now = yield* DateTime.now;
      const rootId = ThreadId.make("choices:root");
      const appId = ThreadId.make("choices:app");
      const interactiveId = ThreadId.make("choices:interactive");
      const nestedId = ThreadId.make("choices:nested-native");
      const nativeId = ThreadId.make("choices:native");
      const root = makeThread(rootId, now);
      for (const thread of [
        root,
        {
          ...root,
          id: interactiveId,
          createdBy: "agent" as const,
          creationSource: "mcp" as const,
          creatorThreadId: rootId,
          creatorGrouping: "grouped" as const,
        },
        {
          ...root,
          id: appId,
          lineage: {
            ...root.lineage,
            parentThreadId: interactiveId,
            relationshipToParent: "subagent" as const,
          },
        },
        {
          ...root,
          id: nestedId,
          creationSource: "provider" as const,
          persistent: true,
          lineage: {
            ...root.lineage,
            parentThreadId: appId,
            relationshipToParent: "subagent" as const,
          },
        },
        {
          ...root,
          id: nativeId,
          creationSource: "provider" as const,
          persistent: protectedNative,
          lineage: {
            ...root.lineage,
            parentThreadId: rootId,
            relationshipToParent: "subagent" as const,
          },
        },
        {
          ...root,
          id: ThreadId.make("choices:fork"),
          persistent: true,
          lineage: {
            ...root.lineage,
            parentThreadId: rootId,
            relationshipToParent: "fork" as const,
          },
        },
        {
          ...root,
          id: ThreadId.make("choices:independent"),
          createdBy: "agent" as const,
          creatorThreadId: rootId,
          creatorGrouping: "independent" as const,
        },
        {
          ...root,
          id: ThreadId.make("choices:foreign"),
          projectId: ProjectId.make("choices:other-project"),
          createdBy: "agent" as const,
          creatorThreadId: rootId,
          creatorGrouping: "grouped" as const,
        },
      ]) {
        yield* store.apply({
          id: EventId.make(`create:${thread.id}`),
          type: "thread.created",
          threadId: thread.id,
          occurredAt: now,
          payload: thread,
        });
      }
      const result = yield* service.getThreadArchiveFamily(rootId);
      assert.deepEqual(
        result.threads.map(({ id }) => id).toSorted(),
        [rootId, interactiveId, appId, nestedId, nativeId].toSorted(),
      );
      assert.sameMembers([...result.childThreadIds], [interactiveId, appId, nestedId, nativeId]);
      assert.deepEqual(result.promotableChildThreadIds, []);
      assert.deepEqual(result.keptThreadIds, []);
      assert.sameMembers(
        [...result.protectedChildThreadIds],
        protectedNative ? [nestedId, nativeId] : [nestedId],
      );
      assert.deepEqual(result.activeThreadIds, []);
      assert.deepEqual(result.unreadThreadIds, []);
      assert.deepEqual(result.activeChildThreadIds, []);
      assert.equal(result.nativeStopCount, 2);
      assert.isTrue(result.requiresConfirmation);
      assert.isFalse(result.canPromote);
      assert.isFalse(result.canStopAndArchive);
      const refused = yield* service
        .dispatch({
          type: "thread.archive",
          commandId: CommandId.make("choices:protected-archive"),
          threadId: rootId,
          childDisposition: "stop_and_archive",
          expectedChildThreadIds: result.childThreadIds,
        })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "OrchestratorDispatchError");
      assert.include(String(refused.cause), "protected conversation");
      for (const { id } of result.threads) {
        const thread = yield* store.getThread(id);
        assert.isNull(thread.archivedAt);
        assert.isNull(thread.archivePending ?? null);
      }
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each([
  "none",
  "recovered",
  "suspect",
  "stale",
  "recovering",
  "failed",
  "running-action",
  "finished-action",
  "unknown-running",
  "queued-work",
  "owner-work",
] as const)("decides consent from durable %s state without an active provider", (state) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const service = yield* ThreadManagementService.ThreadManagementService;
    const now = yield* DateTime.now;
    const rootId = ThreadId.make("consent:root");
    const childId = ThreadId.make("consent:child");
    const root = makeThread(rootId, now);
    const child: OrchestrationV2AppThread = {
      ...root,
      id: childId,
      lineage: { ...root.lineage, parentThreadId: rootId, relationshipToParent: "subagent" },
      ...(["recovered", "suspect", "stale", "recovering", "failed"].includes(state)
        ? {
            recovery: {
              runId: RunId.make("previous-run"),
              attemptId: RunAttemptId.make("previous-attempt"),
              status: state as "recovered" | "suspect" | "stale" | "recovering" | "failed",
              detail: "Provider recovery",
              updatedAt: now,
            },
          }
        : {}),
      ...(state === "running-action" || state === "finished-action"
        ? {
            actionResume: {
              runId: "action-run",
              threadId: childId,
              projectId: root.projectId,
              actionId: "wait-for-pr",
              actionName: "Wait for PR",
              terminalId: "action-terminal",
              outcome: state === "running-action" ? "running" : "succeeded",
              delivery: "pending",
              startedAt: DateTime.formatIso(now),
              finishedAt: state === "running-action" ? null : DateTime.formatIso(now),
              exitCode: null,
              exitSignal: null,
            },
          }
        : {}),
    };
    for (const thread of [root, child])
      yield* store.apply({
        id: EventId.make(`create:${thread.id}`),
        type: "thread.created",
        threadId: thread.id,
        occurredAt: now,
        payload: thread,
      });
    if (["unknown-running", "queued-work", "owner-work"].includes(state)) {
      const threadId = state === "owner-work" ? rootId : childId;
      const runId = RunId.make(`consent:${state}:run`);
      yield* store.apply({
        id: EventId.make(`consent:${state}:run`),
        type: "run.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId: instanceId,
          modelSelection: root.modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make(`consent:${state}:input`),
          rootNodeId: null,
          activeAttemptId: state === "queued-work" ? null : RunAttemptId.make("unknown-attempt"),
          status: state === "queued-work" ? "queued" : "running",
          requestedAt: now,
          startedAt: state === "queued-work" ? null : now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
    }
    const result = yield* service.getThreadArchiveFamily(rootId);
    const needsConsent = [
      "running-action",
      "unknown-running",
      "queued-work",
      "owner-work",
    ].includes(state);
    assert.equal(result.requiresConfirmation, needsConsent);
    assert.deepEqual(
      result.activeThreadIds,
      needsConsent ? [state === "owner-work" ? rootId : childId] : [],
    );
    assert.deepEqual(result.unreadThreadIds, []);
    assert.deepEqual(
      result.activeChildThreadIds,
      needsConsent && state !== "owner-work" ? [childId] : [],
    );
    assert.isFalse(result.canPromote);
    assert.deepEqual(result.promotableChildThreadIds, []);
    assert.deepEqual(result.keptThreadIds, []);
    assert.isTrue(result.canStopAndArchive);
  }).pipe(Effect.provide(testLayer)),
);
it.effect.each(["archived", "deleted"] as const)(
  "returns the archived owner and live descendants through %s ancestors",
  (state) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const now = yield* DateTime.now;
      const rootId = ThreadId.make("archive-query:root");
      const root = makeThread(rootId, now);
      const intermediateId = ThreadId.make("archive-query:intermediate");
      const childId = ThreadId.make("archive-query:child");
      for (const thread of [
        { ...root, archivedAt: now },
        {
          ...root,
          id: intermediateId,
          lineage: {
            ...root.lineage,
            parentThreadId: rootId,
            relationshipToParent: "subagent" as const,
          },
          [state === "archived" ? "archivedAt" : "deletedAt"]: now,
        },
        {
          ...root,
          id: childId,
          lineage: {
            ...root.lineage,
            parentThreadId: intermediateId,
            relationshipToParent: "subagent" as const,
          },
        },
        {
          ...root,
          id: ThreadId.make("archive-query:released"),
          lineage: {
            ...root.lineage,
            parentThreadId: rootId,
            relationshipToParent: "subagent" as const,
            independent: true,
          },
        },
        { ...root, id: ThreadId.make("archive-query:other") },
      ]) {
        yield* store.apply({
          id: EventId.make(`create:${thread.id}`),
          type: "thread.created",
          threadId: thread.id,
          occurredAt: now,
          payload: thread,
        });
      }
      const family = yield* threads.getThreadArchiveFamily(rootId);
      assert.deepEqual(family.threads.map(({ id }) => id).toSorted(), [rootId, childId].toSorted());
      assert.deepEqual(family.childThreadIds, [childId]);
      assert.deepEqual(family.activeThreadIds, []);
      assert.deepEqual(family.activeChildThreadIds, []);
      assert.deepEqual(family.unreadThreadIds, []);
      assert.deepEqual(family.promotableChildThreadIds, []);
      assert.deepEqual(family.keptThreadIds, []);
      assert.isFalse(family.requiresConfirmation);
      assert.isFalse(family.canPromote);
      assert.isTrue(family.canStopAndArchive);
      assert.isFalse("attention" in family.threads.find(({ id }) => id === childId)!);
      assert.isNotNull(family.threads.find(({ id }) => id === rootId)?.archivedAt);
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(threads.getThreadArchiveFamily(ThreadId.make("missing"))),
        ),
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each([
  { target: "owner", visit: "never" },
  { target: "owner", visit: "before" },
  { target: "owner", visit: "after" },
  { target: "child", visit: "never" },
  { target: "child", visit: "before" },
  { target: "child", visit: "after" },
] as const)(
  "uses the latest reply and visit for $target unread state (visit=$visit)",
  ({ target, visit }) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const service = yield* ThreadManagementService.ThreadManagementService;
      const repliedAt = DateTime.makeUnsafe("2026-10-01T10:00:00Z");
      const metadataAt = DateTime.makeUnsafe("2026-10-01T12:00:00Z");
      const visitedAt =
        visit === "never"
          ? null
          : DateTime.makeUnsafe(
              visit === "before" ? "2026-10-01T09:00:00Z" : "2026-10-01T11:00:00Z",
            );
      const rootId = ThreadId.make("reply-query:owner");
      const childId = ThreadId.make("reply-query:child");
      const replyThreadId = target === "owner" ? rootId : childId;
      const root = makeThread(rootId, repliedAt);
      for (const thread of [
        root,
        {
          ...root,
          id: childId,
          createdBy: "agent" as const,
          creationSource: "mcp" as const,
          creatorThreadId: rootId,
          creatorGrouping: "grouped" as const,
        },
      ])
        yield* store.apply({
          id: EventId.make(`reply-query:create:${thread.id}`),
          type: "thread.created",
          threadId: thread.id,
          occurredAt: repliedAt,
          payload: {
            ...thread,
            updatedAt: metadataAt,
            ...(thread.id === replyThreadId ? { lastVisitedAt: visitedAt } : {}),
          },
        });
      yield* store.apply({
        id: EventId.make("reply-query:response"),
        type: "message.updated",
        threadId: replyThreadId,
        occurredAt: repliedAt,
        payload: {
          id: MessageId.make("reply-query:response"),
          threadId: replyThreadId,
          runId: null,
          nodeId: null,
          role: "assistant",
          text: "Finished response",
          attachments: [],
          streaming: false,
          createdBy: "agent",
          creationSource: "provider",
          createdAt: repliedAt,
          updatedAt: repliedAt,
        },
      });
      const result = yield* service.getThreadArchiveFamily(rootId);
      assert.deepEqual(result.childThreadIds, [childId]);
      assert.deepEqual(result.activeThreadIds, []);
      assert.deepEqual(result.unreadThreadIds, visit === "after" ? [] : [replyThreadId]);
      assert.equal(result.requiresConfirmation, visit !== "after");
      assert.isTrue(result.canStopAndArchive);
    }).pipe(Effect.provide(testLayer)),
);

const archiveEnvironment = EnvironmentId.make("archive-query:environment");

const archiveProjectsTestLayer = Layer.effect(
  ProjectService.ProjectService,
  ProjectService.make,
).pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectStore.layer,
      EventSink.layer.pipe(Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer))),
      ProjectionStore.layer,
      IdAllocator.layer,
      ThreadCommandExecutor.layer,
      ServerSettings.layerTest(),
      ServerConfig.layerTest(process.cwd(), { prefix: "temporary-wrap-up-test-" }),
      UpdateDrainAdmissionTestkit.layerOpen,
      SuspensionRegistryTestkit.layer,
      Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({
        getAvailable: () =>
          Effect.succeed({
            repositoryIdentity: null,
            faviconPath: null,
            repositoryIdentityResolved: true,
          }),
        peek: () =>
          Effect.succeed({
            repositoryIdentity: null,
            faviconPath: null,
            repositoryIdentityResolved: true,
          }),
        readRepositoryIdentity: () => Effect.succeed(null),
        invalidate: () => Effect.void,
      }),
      Layer.mock(WorkspacePaths.WorkspacePaths)({
        normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
      }),
      Layer.mock(LegacyV1ThreadImporter.LegacyV1ThreadImporter)({
        reconcileShells: Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 }),
        ensureTranscript: () => Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 }),
      }),
    ),
  ),
  Layer.provide(database),
  Layer.provide(NodeServices.layer),
);

const archiveWrapUpTestLayer = baseLayer.pipe(
  Layer.provideMerge(
    Layer.merge(
      Layer.succeed(ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(archiveEnvironment),
      }),
      Layer.effect(ArchiveTemporaryProjects, ProjectService.ProjectService).pipe(
        Layer.provideMerge(archiveProjectsTestLayer),
      ),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.effect.each([
  "remove",
  "keep",
  "new-thread",
  "written-in",
  "stale-preview",
  "restored",
] as const)("archives before removing a confirmed temporary project (%s)", (scenario) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const projects = yield* ProjectService.ProjectService;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const now = yield* DateTime.now;
    const root = makeThread(ThreadId.make("cleanup:root"), now);
    const owner = { environmentId: archiveEnvironment, threadId: root.id };
    const folder = yield* fs.makeTempDirectoryScoped({ prefix: "temporary-wrap-up-" });
    const createProject = (name: string) =>
      Effect.gen(function* () {
        const projectId = ProjectId.make(`cleanup:${name}`);
        const workspaceRoot = path.join(folder, name);
        yield* fs.makeDirectory(workspaceRoot);
        yield* projects.create(
          {
            projectId,
            commandId: CommandId.make(`register:${projectId}`),
            title: name,
            workspaceRoot,
          },
          { temporary: true, owner },
        );
        return { id: projectId, workspaceRoot };
      });
    const scratch = yield* createProject("Scratch");
    const occupied = yield* createProject("Occupied");
    const marker = path.join(scratch.workspaceRoot, "keep.txt");
    yield* fs.writeFileString(marker, "Workspace files stay on disk.");
    const task = {
      ...makeThread(ThreadId.make("cleanup:task"), now),
      projectId: scratch.id,
      createdBy: "agent" as const,
      creationSource: "mcp" as const,
      creatorOrigin: { kind: "thread_launch" as const, ...owner, owned: true },
      ...(scenario === "restored" ? { archivedAt: now } : {}),
    };
    const unrelated = {
      ...makeThread(ThreadId.make("cleanup:unrelated"), now),
      projectId: occupied.id,
    };
    const seedThread = (thread: OrchestrationV2AppThread) =>
      store.apply({
        id: EventId.make(`create:${thread.id}`),
        type: "thread.created",
        threadId: thread.id,
        occurredAt: now,
        payload: thread,
      });
    for (const thread of [root, task, unrelated]) yield* seedThread(thread);
    const keepWrittenIn = scenario === "written-in";
    if (keepWrittenIn)
      yield* store.apply({
        id: EventId.make("cleanup:user-message"),
        type: "message.updated",
        threadId: task.id,
        occurredAt: now,
        payload: {
          id: MessageId.make("cleanup:user-message"),
          threadId: task.id,
          runId: null,
          nodeId: null,
          role: "user",
          text: "Keep working here",
          attachments: [],
          streaming: false,
          createdBy: "user",
          creationSource: "web",
          createdAt: now,
          updatedAt: now,
        },
      });
    const preview = yield* orchestrator.getThreadArchiveFamily(root.id);
    assert.isTrue(preview.requiresConfirmation);
    assert.deepEqual(preview.archivePreview?.temporaryProjects, [
      {
        projectId: scratch.id,
        title: "Scratch",
        requiresTypedIn: keepWrittenIn,
        threadIds: [task.id],
      },
    ]);
    const request = {
      type: "thread.archive" as const,
      threadId: root.id,
      childDisposition: "archive_after_review" as const,
      expectedChildThreadIds: preview.childThreadIds,
      expectedArchiveThreadIds:
        keepWrittenIn || scenario === "restored" ? [root.id] : [root.id, task.id],
    };
    const selectedProject = { projectId: scratch.id, threadIds: [task.id] };
    if (scenario === "stale-preview") {
      yield* seedThread({
        ...makeThread(ThreadId.make("cleanup:already-archived"), now),
        projectId: scratch.id,
        archivedAt: now,
      });
    }
    const keepProject = keepWrittenIn || scenario === "stale-preview";
    if (keepProject) {
      const error = yield* orchestrator
        .dispatch({
          ...request,
          commandId: CommandId.make("cleanup:stale-confirmation"),
          expectedTemporaryProjects: [selectedProject],
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "OrchestratorDispatchError");
      assert.include(String(error.cause), "The temporary projects or their thread history changed");
      assert.isNull((yield* store.getThread(root.id)).archivedAt);
    }
    const commandId = CommandId.make("cleanup:confirmed");
    const confirmation = {
      ...request,
      commandId,
      ...(keepProject ? {} : { expectedTemporaryProjects: [selectedProject] }),
    };
    yield* orchestrator.dispatch(confirmation);
    assert.isTrue(Option.isSome(yield* projects.getById(scratch.id)));
    assert.equal((yield* store.getThread(task.id)).archivedAt !== null, scenario === "restored");
    if (scenario === "keep")
      yield* projects.update({
        projectId: scratch.id,
        commandId: CommandId.make("cleanup:keep"),
        keepTemporary: true,
      });
    if (scenario === "new-thread")
      yield* seedThread({
        ...makeThread(ThreadId.make("cleanup:new"), now),
        projectId: scratch.id,
      });
    if (scenario === "restored") {
      yield* orchestrator.dispatch({
        type: "thread.archive.complete",
        commandId: CommandId.make(`${commandId}:complete`),
        threadId: root.id,
        requestId: commandId,
      });
      yield* orchestrator.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("cleanup:early-restore"),
        threadId: root.id,
      });
      const refused = yield* projects
        .delete({
          projectId: scratch.id,
          commandId: CommandId.make("cleanup:stale-removal"),
          force: true,
          wrappedProject: {
            owner,
            requestId: commandId,
            expectedArchivedThreadIds: [task.id],
            allowedOwnerThreadIds: [root.id],
          },
        })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "WrappedProjectChanged");
    }
    yield* worker.drain();
    const reported = yield* threads.dispatch(confirmation).pipe(Effect.result);
    if (scenario === "keep" || scenario === "new-thread" || scenario === "restored") {
      assert.equal(reported._tag, "Failure");
      if (reported._tag === "Failure" && reported.failure._tag === "OrchestratorDispatchError")
        assert.include(
          String(reported.failure.cause),
          "without removing these temporary projects: Scratch",
        );
    } else assert.equal(reported._tag, "Success");
    assert.equal((yield* store.getThread(root.id)).archivedAt !== null, scenario !== "restored");
    assert.equal((yield* store.getThread(task.id)).archivedAt !== null, !keepWrittenIn);
    assert.equal(Option.isNone(yield* projects.getById(scratch.id)), scenario === "remove");
    assert.equal((yield* store.getThread(task.id)).deletedAt !== null, scenario === "remove");
    assert.isTrue(Option.isSome(yield* projects.getById(occupied.id)));
    assert.isNull((yield* store.getThread(unrelated.id)).archivedAt);
    assert.equal(yield* fs.readFileString(marker), "Workspace files stay on disk.");
    if (scenario === "remove") {
      yield* orchestrator.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("cleanup:restore"),
        threadId: root.id,
      });
      assert.isNull((yield* store.getThread(root.id)).archivedAt);
      assert.isTrue(Option.isNone(yield* projects.getById(scratch.id)));
      assert.isNotNull((yield* store.getThread(task.id)).deletedAt);
    }
  }).pipe(Effect.provide(archiveWrapUpTestLayer)),
);

const ownedArchiveCases = [
  { includeTypedIn: false, groupIsOwned: false },
  { includeTypedIn: false, groupIsOwned: true },
  { includeTypedIn: true, groupIsOwned: true },
  { includeTypedIn: true, groupIsOwned: true, groupIsUsed: true },
  { includeTypedIn: false, groupIsOwned: false, typedIsArchived: true },
  { includeTypedIn: true, groupIsOwned: false, typedIsArchived: true },
  { includeTypedIn: false, groupIsOwned: false, legacyBelowOwned: true },
  { includeTypedIn: true, groupIsOwned: true, groupRanAction: true },
];

it.effect.each(ownedArchiveCases)(
  "archives the observed cross-project targets (%j)",
  ({
    includeTypedIn,
    groupIsOwned,
    groupIsUsed,
    typedIsArchived,
    legacyBelowOwned,
    groupRanAction,
  }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const service = yield* ThreadManagementService.ThreadManagementService;
      const now = yield* DateTime.now;
      const rootId = ThreadId.make("owned-archive:root");
      const childId = ThreadId.make("owned-archive:child");
      const groupId = ThreadId.make("owned-archive:group");
      const typedId = ThreadId.make("owned-archive:typed");
      const grandchildId = ThreadId.make("owned-archive:grandchild");
      const root = makeThread(rootId, now);
      const legacyOwner = ThreadId.make("owned-archive:archived-intermediate");
      const legacyChild = ThreadId.make("owned-archive:legacy-child");
      const legacyCohort = {
        threadId: legacyOwner,
        commandId: CommandId.make("independent-archive"),
      };
      const launch = (id: ThreadId, parent: ThreadId): OrchestrationV2AppThread => ({
        ...root,
        id,
        projectId: ProjectId.make("owned-archive:another-project"),
        createdBy: "agent",
        creationSource: "mcp",
        lineage: { ...root.lineage, rootThreadId: id },
        creatorOrigin: {
          kind: "thread_launch",
          environmentId: archiveEnvironment,
          threadId: parent,
          owned: true,
        },
      });
      const crossProjectId = launch(childId, rootId).projectId;
      const legacyProjectId = legacyBelowOwned ? crossProjectId : root.projectId;
      const groupStaysOpen = groupIsUsed || groupRanAction;
      const historical = launch(ThreadId.make("owned-archive:historical"), rootId);
      const remote = launch(ThreadId.make("owned-archive:wrong-environment"), rootId);
      const released = launch(ThreadId.make("owned-archive:released"), rootId);
      for (const thread of [
        root,
        {
          ...(groupIsOwned ? launch(groupId, rootId) : { ...root, id: groupId }),
          projectId: crossProjectId,
          groupThread: true as const,
          ...(groupIsUsed ? { workspaceUserAdopted: true } : {}),
          ...(groupRanAction
            ? {
                actionResume: {
                  runId: "group-action",
                  threadId: groupId,
                  projectId: crossProjectId,
                  actionId: "group-action",
                  actionName: "Group action",
                  terminalId: "group-action-terminal",
                  outcome: "succeeded" as const,
                  delivery: "delivered" as const,
                  startedAt: DateTime.formatIso(now),
                  finishedAt: DateTime.formatIso(now),
                  exitCode: 0,
                  exitSignal: null,
                },
              }
            : {}),
        },
        { ...launch(childId, rootId), workspaceUserAdopted: true, groupedUnderThreadId: groupId },
        {
          ...launch(typedId, childId),
          ...(typedIsArchived ? { archivedAt: now } : {}),
          ...(groupIsOwned ? { groupedUnderThreadId: groupId } : {}),
        },
        {
          ...root,
          id: legacyOwner,
          projectId: legacyProjectId,
          groupedUnderThreadId: legacyBelowOwned ? childId : rootId,
          archivedAt: now,
          archivedWith: legacyCohort,
        },
        { ...root, id: legacyChild, projectId: legacyProjectId, groupedUnderThreadId: legacyOwner },
        launch(grandchildId, typedId),
        {
          ...historical,
          creatorOrigin: {
            kind: "thread_launch" as const,
            environmentId: archiveEnvironment,
            threadId: rootId,
          },
        },
        {
          ...remote,
          creatorOrigin: {
            kind: "thread_launch" as const,
            environmentId: EnvironmentId.make("other"),
            threadId: rootId,
            owned: true,
          },
        },
        { ...released, lineage: { ...released.lineage, independent: true as const } },
      ]) {
        yield* store.apply({
          id: EventId.make(`create:${thread.id}`),
          type: "thread.created",
          threadId: thread.id,
          occurredAt: now,
          payload: thread,
        });
      }
      for (const [threadId, createdBy] of [
        [childId, "agent"],
        [typedId, "user"],
      ] as const) {
        yield* store.apply({
          id: EventId.make(`message:${threadId}`),
          type: "message.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: MessageId.make(`message:${threadId}`),
            threadId,
            runId: null,
            nodeId: null,
            role: "user",
            text: "Follow up",
            attachments: [],
            streaming: false,
            createdBy,
            creationSource: createdBy === "user" ? "web" : "mcp",
            createdAt: now,
            updatedAt: now,
          },
        });
      }
      const family = yield* service.getThreadArchiveFamily(rootId);
      const allIds = [
        rootId,
        childId,
        groupId,
        grandchildId,
        legacyChild,
        ...(typedIsArchived ? [] : [typedId]),
      ];
      const kept = allIds.filter(
        (id) => id === typedId || id === grandchildId || (groupIsOwned && id === groupId),
      );
      const selected = includeTypedIn
        ? allIds.filter((id) => !groupStaysOpen || id !== groupId)
        : allIds.filter((id) => !kept.includes(id));
      assert.sameMembers([...family.childThreadIds], allIds.slice(1));
      assert.sameMembers([...family.keptThreadIds], kept);
      assert.deepEqual(family.archivePreview?.typedInThreadIds, [typedId]);
      assert.deepEqual(
        family.archivePreview?.keptWithTypedInThreadIds,
        groupStaysOpen ? [groupId] : undefined,
      );
      assert.isTrue(family.requiresConfirmation);

      const request = {
        type: "thread.archive" as const,
        threadId: rootId,
        childDisposition: "archive_after_review" as const,
        expectedChildThreadIds: family.childThreadIds,
      };
      for (const [suffix, fields] of [
        ["old-client", {}],
        ["missing-typed-consent", { expectedArchiveThreadIds: allIds }],
        [
          "stale-typed-consent",
          { expectedArchiveThreadIds: allIds, includeTypedInThreadIds: [grandchildId] },
        ],
      ] as const) {
        const result = yield* Effect.exit(
          orchestrator.dispatch({
            ...request,
            ...fields,
            commandId: CommandId.make(suffix),
          }),
        );
        assert.isTrue(Exit.isFailure(result));
      }
      const begin = {
        ...request,
        commandId: CommandId.make("owned-archive:begin"),
        expectedArchiveThreadIds: selected,
        ...(includeTypedIn ? { includeTypedInThreadIds: [typedId] } : {}),
      };
      yield* orchestrator.dispatch(begin);
      assert.sameMembers(
        [
          ...getThreadArchivePlan((yield* store.getThread(rootId)).archivePending)!
            .archiveThreadIds,
        ],
        selected,
      );
      yield* orchestrator.dispatch({
        type: "thread.archive.fail",
        commandId: CommandId.make("owned-archive:failure"),
        threadId: rootId,
        requestId: begin.commandId,
        error: "Provider shutdown failed",
      });
      for (const id of selected)
        assert.equal((yield* store.getThread(id)).archivePending?.status, "failed");
      const retryId = CommandId.make("owned-archive:retry");
      const beforeRetry = (yield* orchestrator.getShellSnapshot()).snapshotSequence;
      const retry = yield* service
        .dispatch({
          ...begin,
          commandId: retryId,
          expectedArchiveCommandId: begin.commandId,
        })
        .pipe(Effect.forkChild);
      yield* orchestrator
        .streamStoredEventsFrom({ threadId: rootId, afterSequence: beforeRetry })
        .pipe(
          Stream.filter(
            ({ commandId, event }) =>
              commandId === retryId &&
              event.type === "thread.metadata-updated" &&
              event.payload.archivePending?.status === "stopping",
          ),
          Stream.runHead,
        );
      assert.isUndefined(retry.pollUnsafe());
      yield* orchestrator.dispatch({
        type: "thread.archive.complete",
        commandId: CommandId.make(`${retryId}:complete`),
        threadId: rootId,
        requestId: retryId,
      });
      const receipt = yield* Fiber.join(retry);
      assert.deepEqual(
        receipt.storedEvents.map(({ event }) => event.type),
        ["thread.archived"],
      );
      for (const id of selected) {
        assert.deepEqual(
          (yield* store.getThread(id)).archivedWith,
          id === legacyChild ? legacyCohort : { threadId: rootId, commandId: retryId },
        );
      }
      for (const id of [
        ...allIds.filter((id) => !selected.includes(id)),
        historical.id,
        remote.id,
        released.id,
      ]) {
        const thread = yield* store.getThread(id);
        assert.isNull(thread.archivedAt);
        assert.notExists(thread.archivePending);
      }
      const { creatorOrigin: _formerOwner, ...child } = yield* store.getThread(childId);
      yield* store.apply({
        id: EventId.make("owned-archive:placement-changed"),
        type: "thread.metadata-updated",
        threadId: childId,
        occurredAt: now,
        payload: { ...child, groupedUnderThreadId: null },
      });
      yield* orchestrator.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("owned-archive:restore"),
        threadId: rootId,
      });
      for (const id of selected.filter((id) => id !== legacyChild))
        assert.isNull((yield* store.getThread(id)).archivedAt);
      assert.isNotNull((yield* store.getThread(legacyChild)).archivedAt);
      if (typedIsArchived) assert.isNotNull((yield* store.getThread(typedId)).archivedAt);
      assert.deepEqual(
        (yield* store.getThread(typedId)).creatorOrigin,
        launch(typedId, childId).creatorOrigin,
      );
    }).pipe(
      Effect.provide(
        ThreadManagementService.layer.pipe(
          Layer.provideMerge(
            baseLayer.pipe(
              Layer.provide(
                Layer.succeed(ServerEnvironmentIdentity, {
                  getEnvironmentId: Effect.succeed(archiveEnvironment),
                }),
              ),
            ),
          ),
        ),
      ),
    ),
);
