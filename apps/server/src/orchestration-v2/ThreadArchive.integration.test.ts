import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  getThreadArchivePlan,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { DispatchModeLimit } from "./DispatchModeLimit.ts";
import * as EventSink from "./EventSink.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2 } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const importSessionId = ProviderSessionId.make("archive-child-session");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapterV2["Service"];
const database = SqlitePersistence.layerMemory;
// No effect worker: runs stay unstarted, so Stop ends them without a provider.
const testLayer = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      database,
      ProjectionStore.layer.pipe(Layer.provide(database)),
      EffectOutbox.layer.pipe(Layer.provide(database)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "thread-stop" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: database, runEffectWorker: false },
      ),
    ),
  ),
);

const pullRequest = (number: number) => ({
  host: "github.com",
  repository: "pingdotgg/t3code",
  number,
});

const createWatchingThread = (
  threadId: ThreadId,
  number: number,
  creatorThreadId?: ThreadId,
  projectId = ProjectId.make("project:thread-stop"),
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId,
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: creatorThreadId === undefined ? "user" : "agent",
      creationSource: creatorThreadId === undefined ? "web" : "mcp",
      ...(creatorThreadId === undefined ? {} : { creatorThreadId }),
    });
    yield* watch(threadId, number);
  });

const watch = (threadId: ThreadId, number: number) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make(`watch:${threadId}:${number}`),
      threadId,
      ...pullRequest(number),
      watching: true,
      link: { url: `https://github.com/pingdotgg/t3code/pull/${number}`, source: "agent" },
    });
  });

const send = (threadId: ThreadId, text: string, type: "start_immediately" | "queue_after_active") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type },
      createdBy: "user",
      creationSource: "web",
    });
  });

/** Delegates `task` from the parent's latest run and returns the child thread. */
const delegate = (parentThreadId: ThreadId, task: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make(`delegate:${task}`),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const projection = yield* orchestrator.getThreadProjection(parentThreadId);
    return projection.subagents.find((candidate) => candidate.prompt === task)!.childThreadId!;
  });

const family = Effect.gen(function* () {
  const parent = ThreadId.make("archive-parent");
  yield* createWatchingThread(parent, 1);
  yield* send(parent, "work", "start_immediately");
  const child = yield* delegate(parent, "child");
  const grandchild = yield* delegate(child, "grandchild");
  return { parent, child, grandchild };
});

const mixedFamily = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const parent = ThreadId.make("mixed-family:parent");
  const conversation = ThreadId.make("mixed-family:conversation");
  const finished = ThreadId.make("mixed-family:finished");
  const native = ThreadId.make("mixed-family:native");
  const separate = ThreadId.make("mixed-family:separate");
  const fork = ThreadId.make("mixed-family:fork");
  yield* createWatchingThread(parent, 10);
  yield* createWatchingThread(conversation, 11, parent);
  yield* send(conversation, "conversation-work", "start_immediately");
  const delegated = yield* delegate(conversation, "mixed-delegated");
  yield* createWatchingThread(finished, 12, delegated);
  yield* createWatchingThread(native, 15);
  const nativeThread = yield* projections.getThread(native);
  yield* projections.apply({
    type: "thread.metadata-updated",
    id: EventId.make("mixed-native-lineage"),
    threadId: native,
    occurredAt: yield* DateTime.now,
    payload: {
      ...nativeThread,
      createdBy: "agent",
      creationSource: "provider",
      lineage: { parentThreadId: finished, relationshipToParent: "subagent", rootThreadId: parent },
    },
  });
  yield* createWatchingThread(separate, 13, parent);
  yield* orchestrator.dispatch({
    type: "thread.metadata.update",
    commandId: CommandId.make("mixed-separate"),
    threadId: separate,
    creatorGrouping: "independent",
  });
  yield* createWatchingThread(fork, 14);
  const forkThread = yield* projections.getThread(fork);
  yield* projections.apply({
    type: "thread.metadata-updated",
    id: EventId.make("mixed-fork-lineage"),
    threadId: fork,
    occurredAt: yield* DateTime.now,
    payload: {
      ...forkThread,
      lineage: { parentThreadId: conversation, relationshipToParent: "fork", rootThreadId: parent },
    },
  });
  return { parent, conversation, delegated, finished, native, separate, fork };
});

it.effect("archives and restores grouped conversations and delegated descendants together", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const management = yield* ThreadManagementService.ThreadManagementService;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const ids = yield* mixedFamily;
    const inspected = yield* orchestrator.getThreadArchiveFamily(ids.parent);
    assert.sameMembers(
      [...inspected.childThreadIds],
      [ids.conversation, ids.delegated, ids.finished, ids.native],
    );
    assert.sameMembers([...inspected.activeThreadIds], [ids.conversation, ids.delegated]);
    assert.isFalse(inspected.canPromote);
    const sequence = (yield* orchestrator.getShellSnapshot()).snapshotSequence;
    const refused = yield* orchestrator
      .dispatch({
        ...archive(ids.parent, inspected.childThreadIds, "archive_after_review"),
      })
      .pipe(Effect.flip);
    assert.equal(refused._tag, "OrchestratorDispatchError");
    assert.equal((yield* orchestrator.getShellSnapshot()).snapshotSequence, sequence);
    const command = archive(ids.parent, inspected.childThreadIds);
    yield* orchestrator.dispatch(command);
    assert.equal(
      getThreadArchivePlan((yield* projections.getThread(ids.parent)).archivePending)
        ?.familyVersion,
      1,
    );
    yield* management.executeArchive({ threadId: ids.parent, requestId: command.commandId });
    for (const id of [ids.parent, ...inspected.childThreadIds]) {
      const thread = yield* projections.getThread(id);
      assert.isNotNull(thread.archivedAt);
      assert.equal(thread.archivedWith?.threadId, ids.parent);
    }
    for (const id of [ids.conversation, ids.finished])
      assert.equal((yield* projections.getThread(id)).creatorGrouping, "grouped");
    for (const id of [ids.separate, ids.fork])
      assert.isNull((yield* projections.getThread(id)).archivedAt);
    const blockedRestore = yield* orchestrator
      .dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("mixed-child-restore"),
        threadId: ids.finished,
      })
      .pipe(Effect.flip);
    assert.equal(blockedRestore._tag, "OrchestratorDispatchError");
    yield* orchestrator.dispatch({
      type: "thread.unarchive",
      commandId: CommandId.make("mixed-family-restore"),
      threadId: ids.parent,
    });
    for (const id of [ids.parent, ...inspected.childThreadIds])
      assert.isNull((yield* projections.getThread(id)).archivedAt);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "archives only displayed same-project created children and restores a foreign created conversation independently",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const management = yield* ThreadManagementService.ThreadManagementService;
      const parent = ThreadId.make("project-boundary:parent");
      const same = ThreadId.make("project-boundary:same");
      const foreign = ThreadId.make("project-boundary:foreign");
      yield* createWatchingThread(parent, 10);
      yield* createWatchingThread(same, 11, parent);
      yield* createWatchingThread(foreign, 12, parent, ProjectId.make("other-thread-stop-project"));
      for (const id of [parent, same, foreign]) {
        const thread = yield* projections.getThread(id);
        yield* projections.apply({
          type: "thread.metadata-updated",
          id: EventId.make(`project-boundary:mode:${id}`),
          threadId: id,
          occurredAt: yield* DateTime.now,
          payload: {
            ...thread,
            ...(id === foreign
              ? { persistent: true }
              : { runtimeMode: "approval-required" as const }),
          },
        });
      }
      yield* send(foreign, "foreign-work", "start_immediately");
      const foreignBefore = yield* orchestrator.getThreadProjection(foreign);
      const family = yield* orchestrator.getThreadArchiveFamily(parent);
      assert.deepEqual(family.childThreadIds, [same]);
      assert.deepEqual(family.activeThreadIds, []);
      assert.deepEqual(family.protectedChildThreadIds, []);
      const command = archive(parent, [same], "archive_if_idle");
      yield* orchestrator.dispatch(command).pipe(
        Effect.provideService(DispatchModeLimit, {
          runtimeMode: "approval-required",
          interactionMode: "default",
        }),
      );
      yield* management.executeArchive({ threadId: parent, requestId: command.commandId });
      assert.isNotNull((yield* projections.getThread(parent)).archivedAt);
      assert.isNotNull((yield* projections.getThread(same)).archivedAt);
      assert.deepEqual(yield* orchestrator.getThreadProjection(foreign), foreignBefore);
      const ownThread = yield* projections.getThread(foreign);
      yield* projections.apply({
        type: "thread.metadata-updated",
        id: EventId.make("project-boundary:unprotect-own"),
        threadId: foreign,
        occurredAt: yield* DateTime.now,
        payload: { ...ownThread, persistent: false },
      });
      const ownArchive = archive(foreign, [], "stop_and_archive");
      yield* orchestrator.dispatch(ownArchive);
      yield* management.executeArchive({ threadId: foreign, requestId: ownArchive.commandId });
      assert.equal((yield* projections.getThread(foreign)).archivedWith?.threadId, foreign);
      yield* orchestrator.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("project-boundary:restore-foreign"),
        threadId: foreign,
      });
      assert.isNull((yield* projections.getThread(foreign)).archivedAt);
      assert.isNotNull((yield* projections.getThread(parent)).archivedAt);
      assert.equal((yield* projections.getThread(foreign)).creatorGrouping, "grouped");
      yield* orchestrator.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("project-boundary:restore-family"),
        threadId: parent,
      });
      assert.isNull((yield* projections.getThread(same)).archivedAt);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "requires reviewing an unread finished grouped reply without consenting to new work",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const management = yield* ThreadManagementService.ThreadManagementService;
      const parent = ThreadId.make("unread-group:parent");
      const child = ThreadId.make("unread-group:child");
      yield* createWatchingThread(parent, 10);
      yield* createWatchingThread(child, 11, parent);
      const now = yield* DateTime.now;
      yield* projections.apply({
        type: "message.updated",
        id: EventId.make("unread-group:reply"),
        threadId: child,
        occurredAt: now,
        payload: {
          id: MessageId.make("unread-group:reply"),
          threadId: child,
          runId: null,
          nodeId: null,
          role: "assistant",
          text: "Finished response",
          attachments: [],
          streaming: false,
          createdBy: "agent",
          creationSource: "provider",
          createdAt: now,
          updatedAt: now,
        },
      });
      const inspection = yield* orchestrator.getThreadArchiveFamily(parent);
      assert.isEmpty(inspection.activeThreadIds);
      assert.deepEqual(inspection.unreadThreadIds, [child]);
      assert.isTrue(inspection.requiresConfirmation);
      const refused = yield* orchestrator
        .dispatch({
          ...archive(parent, [child]),
          commandId: CommandId.make("unread-idle-refusal"),
          childDisposition: "archive_if_idle",
        })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "OrchestratorDispatchError");
      const reviewed = archive(parent, [child], "archive_after_review");
      yield* orchestrator.dispatch(reviewed);
      yield* management.executeArchive({ threadId: parent, requestId: reviewed.commandId });
      assert.isNotNull((yield* projections.getThread(child)).archivedAt);
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each(["protection", "mode"] as const)(
  "checks grouped descendants' %s before stopping any family member",
  (guard) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const ids = yield* mixedFamily;
      const leaf = yield* projections.getThread(ids.finished);
      const root = yield* projections.getThread(ids.parent);
      const now = yield* DateTime.now;
      yield* projections.apply({
        type: "thread.metadata-updated",
        id: EventId.make(`mixed-guard:${guard}`),
        threadId: leaf.id,
        occurredAt: now,
        payload: { ...leaf, persistent: guard === "protection" },
      });
      if (guard === "mode") {
        for (const id of [ids.parent, ids.conversation, ids.delegated]) {
          const thread = yield* projections.getThread(id);
          yield* projections.apply({
            type: "thread.metadata-updated",
            id: EventId.make(`mixed-limit:${id}`),
            threadId: id,
            occurredAt: now,
            payload: { ...thread, runtimeMode: "approval-required" },
          });
        }
      }
      const command = archive(ids.parent, [
        ids.conversation,
        ids.delegated,
        ids.finished,
        ids.native,
      ]);
      const refusal = yield* orchestrator
        .dispatch(command)
        .pipe(
          Effect.provideService(
            DispatchModeLimit,
            guard === "mode"
              ? { runtimeMode: "approval-required", interactionMode: "default" }
              : undefined,
          ),
          Effect.flip,
        );
      assert.equal(
        refusal._tag,
        guard === "mode" ? "OrchestratorThreadAboveModeLimitError" : "OrchestratorDispatchError",
      );
      assert.isNull((yield* projections.getThread(root.id)).archivePending ?? null);
      assert.include(
        ["preparing", "starting"],
        (yield* orchestrator.getThreadProjection(ids.conversation)).runs[0]?.status,
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect("confirmed archive stops an active conversation with no descendants", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const management = yield* ThreadManagementService.ThreadManagementService;
    const id = ThreadId.make("confirmed-standalone");
    yield* createWatchingThread(id, 10);
    yield* send(id, "standalone-confirmed", "start_immediately");
    const command = archive(id, []);
    yield* orchestrator.dispatch(command);
    yield* management.executeArchive({ threadId: id, requestId: command.commandId });
    const after = yield* orchestrator.getThreadProjection(id);
    assert.isNotNull(after.thread.archivedAt);
    assert.equal(after.runs[0]?.status, "cancelled");
  }).pipe(Effect.provide(testLayer)),
);

const installedArchive = (disposition: "promote" | "stop_and_archive") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const parent = ThreadId.make("legacy-promotion:parent");
    const created = ThreadId.make("legacy-promotion:created");
    yield* createWatchingThread(parent, 10);
    yield* send(parent, "legacy-parent-work", "start_immediately");
    const delegated = yield* delegate(parent, "legacy-promoted-delegate");
    yield* createWatchingThread(created, 11, parent);
    yield* send(created, "created-work", "start_immediately");
    const root = (yield* orchestrator.getThreadProjection(parent)).thread;
    const requestId = CommandId.make("legacy-promotion:installed-request");
    const now = yield* DateTime.now;
    // This persisted shape predates unified archive membership; no new command
    // can request it. The grouped conversation was outside its saved decision.
    yield* sink.write({
      events: [
        {
          type: "thread.metadata-updated",
          id: EventId.make("legacy-promotion:installed-plan"),
          threadId: parent,
          occurredAt: now,
          payload: {
            ...root,
            archivePending: {
              threadId: parent,
              commandId: requestId,
              status: "stopping",
              childDisposition: disposition,
              childThreadIds: [delegated],
              archiveThreadIds: disposition === "promote" ? [parent] : [parent, delegated],
              promoteThreadIds: disposition === "promote" ? [delegated] : [],
            },
          },
        },
      ],
    });
    if (disposition === "stop_and_archive") {
      const child = (yield* orchestrator.getThreadProjection(delegated)).thread;
      yield* sink.write({
        events: [
          {
            type: "thread.metadata-updated",
            id: EventId.make("legacy-archive:installed-participant"),
            threadId: delegated,
            occurredAt: now,
            payload: {
              ...child,
              archivePending: { threadId: parent, commandId: requestId, status: "stopping" },
            },
          },
        ],
      });
    }
    return { parent, delegated, created, requestId };
  });

it.effect(
  "an installed promotion finishes its original delegated plan without absorbing grouped conversations",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const management = yield* ThreadManagementService.ThreadManagementService;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const ids = yield* installedArchive("promote");
      const createdBefore = yield* orchestrator.getThreadProjection(ids.created);
      const delegatedBefore = yield* orchestrator.getThreadProjection(ids.delegated);
      yield* management.executeArchive({ threadId: ids.parent, requestId: ids.requestId });
      const root = yield* projections.getThread(ids.parent);
      assert.isNotNull(root.archivedAt);
      assert.isNull(root.archivePending);
      assert.isTrue((yield* projections.getThread(ids.delegated)).lineage.independent);
      assert.deepEqual(
        (yield* orchestrator.getThreadProjection(ids.delegated)).runs,
        delegatedBefore.runs,
      );
      assert.deepEqual(yield* orchestrator.getThreadProjection(ids.created), createdBefore);
      assert.equal(createdBefore.thread.creatorGrouping, "grouped");
      assert.isNull(createdBefore.thread.archivedAt);
      const currentFamily = yield* orchestrator.getThreadArchiveFamily(ids.parent);
      assert.deepEqual(currentFamily.childThreadIds, [ids.created]);
      assert.deepEqual(currentFamily.activeThreadIds, [ids.created]);
      const repair = yield* orchestrator
        .dispatch({
          ...archive(ids.parent, [ids.created], "archive_after_review"),
          commandId: CommandId.make("legacy-promotion:current-policy-repair"),
        })
        .pipe(Effect.flip);
      assert.equal(repair._tag, "OrchestratorDispatchError");
      yield* orchestrator.recoverDelegatedTasks;
      assert.deepEqual(yield* orchestrator.getThreadProjection(ids.created), createdBefore);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "an installed stop-and-archive finishes its original delegated plan without absorbing grouped conversations",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const management = yield* ThreadManagementService.ThreadManagementService;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const ids = yield* installedArchive("stop_and_archive");
      const createdBefore = yield* orchestrator.getThreadProjection(ids.created);
      assert.isUndefined(
        getThreadArchivePlan((yield* projections.getThread(ids.parent)).archivePending)
          ?.familyVersion,
      );
      yield* management.executeArchive({ threadId: ids.parent, requestId: ids.requestId });
      for (const id of [ids.parent, ids.delegated]) {
        const thread = yield* projections.getThread(id);
        assert.isNotNull(thread.archivedAt);
        assert.isNull(thread.archivePending);
        assert.equal(thread.archivedWith?.threadId, ids.parent);
      }
      assert.deepEqual(yield* orchestrator.getThreadProjection(ids.created), createdBefore);
      yield* orchestrator.recoverDelegatedTasks;
      assert.deepEqual(yield* orchestrator.getThreadProjection(ids.created), createdBefore);
      yield* orchestrator.dispatch({
        type: "thread.unarchive",
        threadId: ids.parent,
        commandId: CommandId.make("legacy-archive:restore-original-cohort"),
      });
      assert.isNull((yield* projections.getThread(ids.delegated)).archivedAt);
      assert.equal((yield* projections.getThread(ids.created)).creatorGrouping, "grouped");
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each(["promote", "stop_and_archive"] as const)(
  "an installed %s still refuses genuinely changed delegated ownership",
  (disposition) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const ids = yield* installedArchive(disposition);
      const added = ThreadId.make("legacy-promotion:late-delegate");
      yield* createWatchingThread(added, 12);
      const thread = yield* projections.getThread(added);
      yield* projections.apply({
        type: "thread.metadata-updated",
        id: EventId.make("legacy-promotion:late-lineage"),
        threadId: added,
        occurredAt: yield* DateTime.now,
        payload: {
          ...thread,
          lineage: {
            parentThreadId: ids.parent,
            relationshipToParent: "subagent",
            rootThreadId: ids.parent,
          },
        },
      });
      const refusal = yield* orchestrator
        .dispatch({
          type: "thread.archive.complete",
          commandId: CommandId.make("legacy-promotion:changed-completion"),
          threadId: ids.parent,
          requestId: ids.requestId,
        })
        .pipe(Effect.flip);
      assert.equal(refusal._tag, "OrchestratorDispatchError");
      assert.include(String(refusal.cause), "changed while stopping");
      assert.isNull((yield* projections.getThread(ids.parent)).archivedAt);
      assert.equal((yield* projections.getThread(ids.parent)).archivePending?.status, "stopping");
      assert.isUndefined((yield* projections.getThread(ids.delegated)).lineage.independent);
      assert.equal((yield* projections.getThread(ids.created)).creatorGrouping, "grouped");
    }).pipe(Effect.provide(testLayer)),
);

const archive = (
  parent: ThreadId,
  ids: ReadonlyArray<ThreadId>,
  disposition: "archive_if_idle" | "stop_and_archive" | "archive_after_review" = "stop_and_archive",
) => ({
  type: "thread.archive" as const,
  commandId: CommandId.make(`archive:${parent}:${disposition}`),
  threadId: parent,
  childDisposition: disposition,
  expectedChildThreadIds: ids,
});

const archiveModeLimits = [
  { runtimeMode: "approval-required", interactionMode: "default", mode: "runtime" },
  { runtimeMode: "full-access", interactionMode: "plan", mode: "interaction" },
] as const;

const settleArchiveResults = Effect.fnUntraced(function* (command: ReturnType<typeof archive>) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  // Publish nested completion results before their owners, using the real
  // service under its locks rather than racing its terminal-event subscriber.
  for (const id of command.expectedChildThreadIds.toReversed()) {
    const run = (yield* orchestrator.getThreadProjection(id)).runs.at(-1);
    if (run !== undefined) yield* orchestrator.recoverDelegatedTask(id, run.id);
  }
});

const failArchive = Effect.fnUntraced(function* (command: ReturnType<typeof archive>) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch(command);
  yield* orchestrator.dispatch({
    type: "thread.archive.fail",
    commandId: CommandId.make(`${command.commandId}:failed`),
    threadId: command.threadId,
    requestId: command.commandId,
    error: "Isolated shutdown failed",
  });
  yield* settleArchiveResults(command);
});

const dismissArchive = (threadId: ThreadId, expectedArchiveCommandId: CommandId) => ({
  type: "thread.unarchive" as const,
  commandId: CommandId.make(`dismiss:${threadId}`),
  threadId,
  expectedArchiveCommandId,
});

/** An idle snapshot from real delegated history, with a nested runless native mirror. */
const idleArchiveFamily = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const ids = yield* family;
  const now = yield* DateTime.now;
  for (const id of [ids.parent, ids.child, ids.grandchild]) {
    const projection = yield* orchestrator.getThreadProjection(id);
    for (const run of projection.runs)
      yield* projections.apply({
        id: EventId.make(`idle-family-run:${run.id}`),
        type: "run.updated",
        threadId: id,
        occurredAt: now,
        payload: { ...run, status: "completed", completedAt: now },
      });
    for (const attempt of projection.attempts)
      yield* projections.apply({
        id: EventId.make(`idle-family-attempt:${attempt.id}`),
        type: "run-attempt.updated",
        threadId: id,
        occurredAt: now,
        payload: { ...attempt, status: "completed", completedAt: now },
      });
    for (const node of projection.nodes)
      yield* projections.apply({
        id: EventId.make(`idle-family-node:${node.id}`),
        type: "node.updated",
        threadId: id,
        occurredAt: now,
        payload: { ...node, status: "completed", completedAt: now },
      });
    for (const task of projection.subagents)
      yield* projections.apply({
        id: EventId.make(`idle-family-task:${task.id}`),
        type: "subagent.updated",
        threadId: id,
        occurredAt: now,
        payload: {
          ...task,
          status: "completed",
          result: "Published fixture result",
          completionDelivery: { state: "disposed", observedByRunId: null },
          completedAt: now,
          updatedAt: now,
        },
      });
    for (const item of projection.turnItems)
      yield* projections.apply({
        id: EventId.make(`idle-family-item:${item.id}`),
        type: "turn-item.updated",
        threadId: id,
        occurredAt: now,
        payload: { ...item, status: "completed", completedAt: now, updatedAt: now },
      });
  }
  yield* orchestrator.dispatch({
    type: "thread.pull-request.watch",
    commandId: CommandId.make("idle-family-end-watch"),
    threadId: ids.parent,
    ...pullRequest(1),
    watching: false,
  });
  const native = ThreadId.make("idle-family-runless-native");
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("idle-family-create-native"),
    threadId: native,
    projectId: ProjectId.make("project:thread-stop"),
    title: "Idle nested native mirror",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "agent",
    creationSource: "provider",
  });
  const thread = (yield* orchestrator.getThreadProjection(native)).thread;
  yield* projections.apply({
    id: EventId.make("idle-family-native-lineage"),
    type: "thread.metadata-updated",
    threadId: native,
    occurredAt: now,
    payload: {
      ...thread,
      lineage: {
        parentThreadId: ids.grandchild,
        relationshipToParent: "subagent",
        rootThreadId: ids.parent,
      },
    },
  });
  for (const id of [ids.parent, ids.child, ids.grandchild, native])
    yield* orchestrator.dispatch({
      type: "thread.visit",
      commandId: CommandId.make(`idle-family-visit:${id}`),
      threadId: id,
      visitedAt: DateTime.formatIso(now),
    });
  const decision = yield* orchestrator.getThreadArchiveFamily(ids.parent);
  assert.isFalse(decision.requiresConfirmation);
  assert.deepEqual(decision.keptThreadIds, []);
  assert.equal(decision.nativeStopCount, 1);
  const snapshot = decision.threads;
  assert.lengthOf(snapshot, 4);
  for (const shell of snapshot) {
    assert.include(["idle", "completed"], shell.status);
    assert.isNull(shell.pendingRuntimeRequest);
    assert.isFalse(shell.hasActionableProposedPlan);
    assert.isNull(shell.attention ?? null);
    assert.isEmpty(shell.pendingBackgroundTasks ?? []);
  }
  return { ...ids, native, snapshot };
});

it.effect.each([
  "child work",
  "owner work",
  "question",
  "approval",
  "native turn",
  "background",
] as const)(
  "automatic archive rechecks an idle snapshot before stopping newly pending %s",
  (change) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const { parent, child, grandchild, native, snapshot } = yield* idleArchiveFamily;
      const childIds = snapshot.filter((shell) => shell.id !== parent).map((shell) => shell.id);
      const now = yield* DateTime.now;
      if (change === "child work" || change === "owner work")
        yield* send(
          change === "child work" ? child : parent,
          "work-after-idle-snapshot",
          "start_immediately",
        );
      if (change === "question" || change === "approval") {
        const owner = yield* orchestrator.getThreadProjection(grandchild);
        yield* projections.apply({
          id: EventId.make("idle-snapshot-new-runtime-request"),
          type: "runtime-request.updated",
          threadId: native,
          occurredAt: now,
          payload: {
            id: RuntimeRequestId.make("idle-snapshot-new-runtime-request"),
            nodeId: owner.runs[0]!.rootNodeId!,
            providerTurnId: null,
            nativeRequestRef: null,
            kind: change === "question" ? "user_input" : "command",
            status: "pending",
            responseCapability: { type: "not_resumable", reason: "fixture request" },
            createdAt: now,
            resolvedAt: null,
          },
        });
      }
      if (change === "native turn") {
        const owner = yield* orchestrator.getThreadProjection(grandchild);
        const providerThreadId = ProviderThreadId.make("idle-snapshot-native-provider-thread");
        yield* projections.apply({
          id: EventId.make("idle-snapshot-native-provider-thread"),
          type: "provider-thread.updated",
          threadId: native,
          occurredAt: now,
          payload: {
            ...owner.providerThreads[0]!,
            id: providerThreadId,
            appThreadId: native,
            ownerNodeId: null,
            providerSessionId: null,
          },
        });
        yield* projections.apply({
          id: EventId.make("idle-snapshot-native-provider-turn"),
          type: "provider-turn.updated",
          threadId: native,
          occurredAt: now,
          payload: {
            id: ProviderTurnId.make("idle-snapshot-native-provider-turn"),
            providerThreadId,
            nodeId: owner.runs[0]!.rootNodeId!,
            runAttemptId: null,
            nativeTurnRef: null,
            ordinal: 1,
            status: "running",
            startedAt: now,
            completedAt: null,
          },
        });
      }
      if (change === "background") {
        const nested = yield* orchestrator.getThreadProjection(grandchild);
        yield* projections.apply({
          id: EventId.make("idle-snapshot-background-work"),
          type: "provider-thread.updated",
          threadId: grandchild,
          occurredAt: now,
          payload: {
            ...nested.providerThreads[0]!,
            pendingBackgroundTasks: [
              { taskId: "idle-snapshot-background-command", kind: "command" },
            ],
          },
        });
      }

      const decision = yield* orchestrator.getThreadArchiveFamily(parent);
      assert.deepEqual(decision.childThreadIds, childIds);
      assert.isTrue(decision.requiresConfirmation);
      assert.deepEqual(
        decision.activeChildThreadIds,
        change === "owner work"
          ? []
          : [change === "child work" ? child : change === "background" ? grandchild : native],
      );
      if (change === "question" || change === "approval" || change === "native turn")
        assert.isEmpty((yield* orchestrator.getThreadProjection(native)).runs);
      const before = yield* Effect.forEach(snapshot, (shell) =>
        orchestrator.getThreadProjection(shell.id),
      );
      const sequence = (yield* orchestrator.getShellSnapshot()).snapshotSequence;
      const refusal = yield* orchestrator
        .dispatch({
          ...archive(parent, childIds),
          commandId: CommandId.make("idle-snapshot-automatic-archive"),
          childDisposition: "archive_if_idle",
        })
        .pipe(Effect.flip);
      assert.equal(refusal._tag, "OrchestratorDispatchError");
      assert.include(String(refusal.cause), "Review the archive choices again");
      assert.equal((yield* orchestrator.getShellSnapshot()).snapshotSequence, sequence);
      assert.deepEqual(
        yield* Effect.forEach(snapshot, (shell) => orchestrator.getThreadProjection(shell.id)),
        before,
      );
      const explicit = archive(parent, childIds);
      yield* orchestrator.dispatch(explicit);
      yield* threads.executeArchive({ threadId: parent, requestId: explicit.commandId });
      for (const shell of snapshot) {
        const archived = yield* orchestrator.getThreadProjection(shell.id);
        assert.isNotNull(archived.thread.archivedAt);
        assert.isNull(archived.thread.archivePending);
        assert.isUndefined(archived.thread.lineage.independent);
      }
    }).pipe(Effect.provide(testLayer)),
);

it.effect("automatic archive accepts a genuinely idle recursive family", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const { parent, snapshot } = yield* idleArchiveFamily;
    const command = {
      ...archive(
        parent,
        snapshot.filter((shell) => shell.id !== parent).map((shell) => shell.id),
      ),
      commandId: CommandId.make("genuinely-idle-family-archive"),
      childDisposition: "archive_if_idle" as const,
    };
    yield* orchestrator.dispatch(command);
    yield* threads.executeArchive({ threadId: parent, requestId: command.commandId });
    for (const shell of snapshot) {
      const projection = yield* orchestrator.getThreadProjection(shell.id);
      assert.isNotNull(projection.thread.archivedAt);
      assert.isNull(projection.thread.archivePending);
      assert.isFalse(projection.turnItems.some((item) => item.type === "run_interrupt_request"));
    }
  }).pipe(Effect.provide(testLayer)),
);

it.effect.each(["preparing", "starting", "running", "waiting"] as const)(
  "ordinary standalone archive refuses %s work without stopping it",
  (status) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const standalone = ThreadId.make("standalone-active-archive");
      yield* createWatchingThread(standalone, 7);
      yield* send(standalone, "standalone-work", "start_immediately");
      const run = (yield* orchestrator.getThreadProjection(standalone)).runs[0]!;
      yield* projections.apply({
        id: EventId.make("standalone-run-state"),
        type: "run.updated",
        threadId: standalone,
        occurredAt: yield* DateTime.now,
        payload: { ...run, status },
      });
      const sequence = (yield* orchestrator.getShellSnapshot()).snapshotSequence;
      for (const childDisposition of [
        undefined,
        "archive_if_idle",
        "archive_after_review",
      ] as const) {
        const refused = yield* orchestrator
          .dispatch({
            type: "thread.archive",
            commandId: CommandId.make(`standalone-archive:${childDisposition ?? "ordinary"}`),
            threadId: standalone,
            ...(childDisposition ? { childDisposition, expectedChildThreadIds: [] } : {}),
          })
          .pipe(Effect.flip);
        assert.equal(refused._tag, "OrchestratorDispatchError");
        assert.include(
          String(refused.cause),
          childDisposition === undefined ? "unfinished work" : "work that needs attention",
        );
      }
      const after = yield* orchestrator.getThreadProjection(standalone);
      assert.equal((yield* orchestrator.getShellSnapshot()).snapshotSequence, sequence);
      assert.isNull(after.thread.archivedAt);
      assert.isNull(after.thread.archivePending ?? null);
      assert.equal(after.runs[0]?.status, status);
      assert.isTrue(after.thread.pullRequests?.[0]?.watch?.startedAt !== undefined);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("ordinary standalone archive preserves a pending question after its run stopped", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const standalone = ThreadId.make("standalone-question-archive");
    yield* createWatchingThread(standalone, 8);
    yield* send(standalone, "standalone-question", "start_immediately");
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("standalone-stop-before-question"),
      threadId: standalone,
    });
    const run = (yield* orchestrator.getThreadProjection(standalone)).runs[0]!;
    yield* projections.apply({
      id: EventId.make("standalone-pending-question"),
      type: "runtime-request.updated",
      threadId: standalone,
      occurredAt: yield* DateTime.now,
      payload: {
        id: RuntimeRequestId.make("standalone-question"),
        nodeId: run.rootNodeId!,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "not_resumable", reason: "fixture" },
        createdAt: yield* DateTime.now,
        resolvedAt: null,
      },
    });
    const sequence = (yield* orchestrator.getShellSnapshot()).snapshotSequence;
    const refused = yield* orchestrator
      .dispatch({
        type: "thread.archive",
        commandId: CommandId.make("standalone-archive-pending-question"),
        threadId: standalone,
      })
      .pipe(Effect.flip);
    assert.include(String(refused.cause), "unfinished work");
    assert.equal((yield* orchestrator.getShellSnapshot()).snapshotSequence, sequence);
    const after = yield* orchestrator.getThreadProjection(standalone);
    assert.equal(after.runtimeRequests[0]?.status, "pending");
    assert.isNull(after.thread.archivedAt);
    assert.isNull(after.thread.archivePending ?? null);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("ordinary standalone archive preserves runless owned provider execution", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const { parent } = yield* family;
    const owner = yield* orchestrator.getThreadProjection(parent);
    const standalone = ThreadId.make("standalone-runless-archive");
    yield* createWatchingThread(standalone, 9);
    const providerThreadId = ProviderThreadId.make("standalone-owned-provider");
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make("standalone-owned-provider"),
      type: "provider-thread.updated",
      threadId: standalone,
      occurredAt: now,
      payload: {
        ...owner.providerThreads[0]!,
        id: providerThreadId,
        appThreadId: standalone,
        providerSessionId: importSessionId,
      },
    });
    yield* projections.apply({
      id: EventId.make("standalone-owned-turn"),
      type: "provider-turn.updated",
      threadId: standalone,
      occurredAt: now,
      payload: {
        id: ProviderTurnId.make("standalone-owned-turn"),
        providerThreadId,
        nodeId: owner.runs[0]!.rootNodeId!,
        runAttemptId: null,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    });
    assert.lengthOf((yield* orchestrator.getThreadProjection(standalone)).runs, 0);
    const sequence = (yield* orchestrator.getShellSnapshot()).snapshotSequence;
    const refused = yield* orchestrator
      .dispatch({
        type: "thread.archive",
        commandId: CommandId.make("standalone-archive-owned-turn"),
        threadId: standalone,
      })
      .pipe(Effect.flip);
    assert.include(String(refused.cause), "unfinished work");
    assert.equal((yield* orchestrator.getShellSnapshot()).snapshotSequence, sequence);
    const after = yield* orchestrator.getThreadProjection(standalone);
    assert.equal(after.providerTurns[0]?.status, "running");
    assert.isNull(after.thread.archivedAt);
    assert.isNull(after.thread.archivePending ?? null);
  }).pipe(Effect.provide(testLayer)),
);

it.effect.each(
  archiveModeLimits.flatMap((limit) =>
    (["stop_and_archive"] as const).map((disposition) => ({ limit, disposition })),
  ),
)(
  "refuses family $disposition above the caller's $limit.mode mode before stopping",
  ({ limit, disposition }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const { parent, child, grandchild } = yield* family;
      const root = (yield* orchestrator.getThreadProjection(parent)).thread;
      yield* projections.apply({
        id: EventId.make("limited-parent-mode"),
        type: "thread.metadata-updated",
        threadId: parent,
        occurredAt: yield* DateTime.now,
        payload: {
          ...root,
          runtimeMode: limit.runtimeMode,
          interactionMode: limit.interactionMode,
        },
      });
      const sequence = (yield* orchestrator.getShellSnapshot()).snapshotSequence;
      const refusal = yield* orchestrator
        .dispatch(archive(parent, [child, grandchild], disposition))
        .pipe(Effect.provideService(DispatchModeLimit, limit), Effect.flip);
      assert.ok(refusal._tag === "OrchestratorThreadAboveModeLimitError");
      assert.equal(refusal.threadId, child);
      assert.equal(refusal.mode, limit.mode);
      assert.equal((yield* orchestrator.getShellSnapshot()).snapshotSequence, sequence);
      for (const id of [parent, child, grandchild]) {
        const projection = yield* orchestrator.getThreadProjection(id);
        assert.isNull(projection.thread.archivedAt);
        assert.isUndefined(projection.thread.archivePending);
        assert.isUndefined(projection.thread.lineage.independent);
        assert.equal(projection.runs[0]?.status, "starting");
      }
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "requires an explicit family choice and rejects stale consent before cancelling work",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { parent, child, grandchild } = yield* family;
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            orchestrator.dispatch({
              type: "thread.archive",
              commandId: CommandId.make("archive:no-choice"),
              threadId: parent,
            }),
          ),
        ),
      );
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(orchestrator.dispatch(archive(parent, [child])))),
      );
      for (const id of [parent, child, grandchild]) {
        const projection = yield* orchestrator.getThreadProjection(id);
        assert.isNull(projection.thread.archivedAt);
        assert.isUndefined(projection.thread.archivePending);
        assert.equal(projection.runs[0]?.status, "starting");
      }
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "archives and restores exactly the requested recursive family without restarting work",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const { parent, child, grandchild } = yield* family;
      yield* send(child, "queued", "queue_after_active");
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const childProjection = yield* orchestrator.getThreadProjection(child);
      yield* projections.apply({
        id: EventId.make("archive-pending-input"),
        type: "runtime-request.updated",
        threadId: child,
        occurredAt: now,
        payload: {
          id: RuntimeRequestId.make("pending-input"),
          nodeId: childProjection.runs[0]!.rootNodeId!,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "not_resumable", reason: "fixture" },
          createdAt: now,
          resolvedAt: null,
        },
      });
      const alreadyArchived = ThreadId.make("already-archived-child");
      yield* createWatchingThread(alreadyArchived, 2);
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("separate-archive"),
        threadId: alreadyArchived,
      });
      const separate = (yield* orchestrator.getThreadProjection(alreadyArchived)).thread;
      yield* projections.apply({
        id: EventId.make("separate-child-lineage"),
        type: "thread.metadata-updated",
        threadId: alreadyArchived,
        occurredAt: now,
        payload: {
          ...separate,
          lineage: {
            parentThreadId: parent,
            relationshipToParent: "subagent",
            rootThreadId: parent,
          },
        },
      });
      const command = archive(parent, [child, grandchild]);
      const result = yield* orchestrator.dispatch(command);
      for (const id of [parent, child, grandchild]) {
        const projection = yield* orchestrator.getThreadProjection(id);
        assert.isNull(projection.thread.archivedAt);
        assert.equal(projection.thread.archivePending?.status, "stopping");
        assert.isTrue(projection.runs.every((run) => run.status === "cancelled"));
      }
      yield* threads.executeArchive({ threadId: parent, requestId: command.commandId }).pipe(
        Effect.provide(
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            teardownThread: () => Effect.void,
          }),
        ),
      );
      for (const id of [parent, child, grandchild]) {
        const projection = yield* orchestrator.getThreadProjection(id);
        assert.isNotNull(projection.thread.archivedAt);
        assert.equal(projection.thread.archivedWith?.commandId, command.commandId);
      }
      for (const id of [child, grandchild]) {
        const error = yield* Effect.flip(
          orchestrator.dispatch({
            type: "thread.unarchive",
            commandId: CommandId.make(`restore-child:${id}`),
            threadId: id,
          }),
        );
        assert.instanceOf(error, Orchestrator.OrchestratorDispatchError);
        assert.equal(error.cause, "Restore the parent thread to reopen this family");
      }
      for (const id of [parent, child, grandchild])
        assert.isNotNull((yield* orchestrator.getThreadProjection(id)).thread.archivedAt);
      yield* orchestrator.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("restore-family"),
        threadId: parent,
      });
      for (const id of [parent, child, grandchild]) {
        const projection = yield* orchestrator.getThreadProjection(id);
        assert.isNull(projection.thread.archivedAt);
        assert.isTrue(projection.runs.every((run) => run.status === "cancelled"));
      }
      assert.equal(
        (yield* orchestrator.getThreadProjection(child)).runtimeRequests[0]?.status,
        "cancelled",
      );
      assert.isNotNull(
        (yield* orchestrator.getThreadProjection(alreadyArchived)).thread.archivedAt,
      );
      assert.isAbove(result.sequence, 0);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "restores a surviving legacy branch independently after its archived owner was deleted",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const { parent, child, grandchild } = yield* family;
      const sibling = yield* delegate(parent, "sibling");
      const separate = ThreadId.make("separately-archived-descendant");
      yield* createWatchingThread(separate, 6);
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("separate-descendant-archive"),
        threadId: separate,
      });
      const separateThread = (yield* orchestrator.getThreadProjection(separate)).thread;
      const now = yield* DateTime.now;
      yield* projections.apply({
        id: EventId.make("legacy-inherited-placement"),
        type: "thread.metadata-updated",
        threadId: child,
        occurredAt: now,
        payload: {
          ...(yield* orchestrator.getThreadProjection(child)).thread,
          pinnedAt: now,
          pinOrderKey: "m",
          activeOrderKey: "m",
        },
      });
      yield* projections.apply({
        id: EventId.make("separate-descendant-lineage"),
        type: "thread.metadata-updated",
        threadId: separate,
        occurredAt: now,
        payload: {
          ...separateThread,
          lineage: {
            parentThreadId: child,
            relationshipToParent: "subagent",
            rootThreadId: parent,
          },
        },
      });
      const command = archive(parent, [child, grandchild, sibling]);
      yield* orchestrator.dispatch(command);
      yield* threads.executeArchive({ threadId: parent, requestId: command.commandId }).pipe(
        Effect.provide(
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            teardownThread: () => Effect.void,
          }),
        ),
      );
      // Earlier servers deleted only the owner. New family deletion must not
      // leave survivors, but existing archived branches still need recovery.
      const archivedOwner = (yield* orchestrator.getThreadProjection(parent)).thread;
      yield* projections.apply({
        id: EventId.make("legacy-owner-deleted"),
        type: "thread.deleted",
        threadId: parent,
        occurredAt: now,
        payload: { ...archivedOwner, deletedAt: now },
      });
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            orchestrator.dispatch({
              type: "thread.unarchive",
              commandId: CommandId.make("cannot-restore-deleted-owner"),
              threadId: parent,
            }),
          ),
        ),
      );
      yield* orchestrator.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("restore-surviving-branch"),
        threadId: child,
      });
      const restoredChild = (yield* orchestrator.getThreadProjection(child)).thread;
      assert.isTrue(restoredChild.lineage.independent);
      assert.equal(restoredChild.lineage.parentThreadId, parent);
      assert.equal(restoredChild.lineage.rootThreadId, parent);
      assert.isNull(restoredChild.pinnedAt);
      assert.isNull(restoredChild.pinOrderKey);
      assert.isNull(restoredChild.activeOrderKey);
      for (const id of [child, grandchild]) {
        const projection = yield* orchestrator.getThreadProjection(id);
        assert.isNull(projection.thread.archivedAt);
        assert.isNull(projection.thread.archivedWith);
        assert.isTrue(projection.runs.every((run) => run.status === "cancelled"));
      }
      const deletedOwner = (yield* orchestrator.getThreadProjection(parent)).thread;
      assert.isNotNull(deletedOwner.deletedAt);
      assert.isNotNull(deletedOwner.archivedAt);
      for (const id of [sibling, separate])
        assert.isNotNull((yield* orchestrator.getThreadProjection(id)).thread.archivedAt);
      assert.isUndefined(
        (yield* orchestrator.getThreadProjection(grandchild)).thread.lineage.independent,
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect("archive RPC stays pending and returns a visible failure when shutdown fails", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const { parent, child, grandchild } = yield* family;
    const childProjection = yield* orchestrator.getThreadProjection(child);
    const providerThread = childProjection.providerThreads[0]!;
    yield* projections.apply({
      id: EventId.make("child-session"),
      type: "provider-thread.updated",
      threadId: child,
      occurredAt: yield* DateTime.now,
      payload: { ...providerThread, providerSessionId: importSessionId },
    });
    const command = archive(parent, [child, grandchild]);
    const sequence = (yield* orchestrator.getShellSnapshot()).snapshotSequence;
    const waiting = yield* threads.dispatch(command).pipe(Effect.result, Effect.forkChild);
    yield* orchestrator.streamStoredEventsFrom({ threadId: parent, afterSequence: sequence }).pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "thread.metadata-updated" &&
          stored.event.payload.archivePending?.status === "stopping",
      ),
      Stream.runHead,
    );
    assert.isUndefined(waiting.pollUnsafe());
    yield* threads.executeArchive({ threadId: parent, requestId: command.commandId }).pipe(
      Effect.provide(
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          teardownThread: () =>
            Effect.fail(
              new ProviderSessionManager.ProviderSessionReleaseError({
                providerSessionId: importSessionId,
                reason: "manual_shutdown",
                cause: "provider refuses shutdown",
              }),
            ),
        }),
      ),
    );
    for (const id of [parent, child, grandchild]) {
      const projection = yield* orchestrator.getThreadProjection(id);
      assert.isNull(projection.thread.archivedAt);
      assert.equal(projection.thread.archivePending?.status, "failed");
      assert.isTrue(projection.runs.every((run) => run.status === "cancelled"));
    }
    yield* threads.dispatch(dismissArchive(parent, command.commandId));
    assert.equal((yield* Fiber.join(waiting))._tag, "Failure");
    const replayedFailure = yield* threads.dispatch(command).pipe(Effect.flip);
    assert.equal(replayedFailure._tag, "OrchestratorDispatchError");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("dismisses a failed archive without changing execution or replaying shutdown", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const { parent, child, grandchild } = yield* family;
    const command = archive(parent, [child, grandchild]);
    yield* failArchive(command);
    // Work may resume after failure. Dismissing its notice must leave it alone.
    yield* send(child, "continued work", "start_immediately");
    const before = yield* Effect.forEach([parent, child, grandchild], (id) =>
      orchestrator.getThreadProjection(id),
    );
    const dismissal = dismissArchive(parent, command.commandId);
    const result = yield* threads.dispatch(dismissal);
    assert.deepEqual(
      result.storedEvents.map((stored) => stored.event.threadId).toSorted(),
      [parent, child, grandchild].toSorted(),
    );
    assert.isTrue(
      result.storedEvents.every((stored) => stored.event.type === "thread.metadata-updated"),
    );
    assert.isEmpty(yield* outbox.listByCommandId(dismissal.commandId));
    for (const previous of before) {
      const current = yield* orchestrator.getThreadProjection(previous.thread.id);
      assert.deepEqual(current.thread, {
        ...previous.thread,
        archivePending: null,
        updatedAt: current.thread.updatedAt,
      });
      assert.deepEqual({ ...current, thread: previous.thread }, previous);
    }
    yield* threads.executeArchive({ threadId: parent, requestId: command.commandId }).pipe(
      Effect.provide(
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          teardownThread: () => Effect.die("A dismissed archive must not shut down providers"),
        }),
      ),
    );
    for (const type of ["thread.archive.complete", "thread.archive.fail"] as const) {
      const stale = yield* orchestrator.dispatch({
        type,
        commandId: CommandId.make(`${command.commandId}:late:${type}`),
        threadId: parent,
        requestId: command.commandId,
        error: "Late shutdown failure",
      });
      assert.isEmpty(
        yield* outbox.listByCommandId(CommandId.make(`${command.commandId}:late:${type}`)),
      );
      assert.isTrue(
        stale.storedEvents.every((stored) => stored.event.type === "thread.metadata-updated"),
      );
    }
    for (const previous of before) {
      const current = yield* orchestrator.getThreadProjection(previous.thread.id);
      assert.isNull(current.thread.archivedAt);
      assert.isNull(current.thread.archivePending);
      assert.deepEqual({ ...current, thread: previous.thread }, previous);
    }
    const original = yield* threads.dispatch(command).pipe(Effect.flip);
    assert.equal(original._tag, "OrchestratorDispatchError");
    if (original._tag === "OrchestratorDispatchError")
      assert.equal(original.cause, "Isolated shutdown failed");
  }).pipe(Effect.provide(testLayer)),
);

it.effect.each([
  "dismissed",
  "restored",
  "newer-failed",
  "stopping",
  "compact-owner",
  "different-owner",
  "direct-child",
  "deleted",
] as const)(
  "refuses a retry of an observed failure after %s without changing the family",
  (state) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const { parent, child, grandchild } = yield* family;
      const command = archive(parent, [child, grandchild]);
      yield* failArchive(command);
      const observed = (yield* orchestrator.getThreadProjection(child)).thread.archivePending!;
      const owner = (yield* orchestrator.getThreadProjection(observed.threadId)).thread;
      assert.equal(observed.commandId, owner.archivePending?.commandId);
      assert.equal(observed.status, "failed");
      if (state === "dismissed")
        yield* threads.dispatch(dismissArchive(parent, observed.commandId));
      if (state === "restored") {
        const completed = { ...command, commandId: CommandId.make("completed-before-stale-retry") };
        yield* orchestrator.dispatch(completed);
        yield* orchestrator.dispatch({
          type: "thread.archive.complete",
          commandId: CommandId.make(`${completed.commandId}:complete`),
          threadId: parent,
          requestId: completed.commandId,
        });
        yield* settleArchiveResults(completed);
        yield* threads.dispatch({
          type: "thread.unarchive",
          commandId: CommandId.make("restore-before-stale-retry"),
          threadId: parent,
        });
      }
      if (state === "newer-failed")
        yield* failArchive({
          ...command,
          commandId: CommandId.make("failure-after-observed-attempt"),
        });
      if (
        state === "stopping" ||
        state === "compact-owner" ||
        state === "different-owner" ||
        state === "deleted"
      ) {
        yield* projections.apply({
          id: EventId.make(`retry-changed-owner:${state}`),
          type: "thread.metadata-updated",
          threadId: parent,
          occurredAt: yield* DateTime.now,
          payload: {
            ...owner,
            ...(state === "deleted" ? { deletedAt: yield* DateTime.now } : {}),
            archivePending:
              state === "compact-owner"
                ? { threadId: parent, commandId: observed.commandId, status: "failed" }
                : {
                    ...getThreadArchivePlan(owner.archivePending)!,
                    ...(state === "stopping" ? { status: "stopping" as const } : {}),
                    ...(state === "different-owner" ? { threadId: child } : {}),
                  },
          },
        });
      }
      const before = yield* Effect.forEach([parent, child, grandchild], (id) =>
        orchestrator.getThreadProjection(id),
      );
      const archiveCommandIds = [
        command.commandId,
        CommandId.make("completed-before-stale-retry"),
        CommandId.make("failure-after-observed-attempt"),
      ];
      const effectsBefore = yield* Effect.forEach(archiveCommandIds, (id) =>
        outbox.listByCommandId(id),
      );
      const sequence = (yield* orchestrator.getShellSnapshot()).snapshotSequence;
      const retry = {
        ...command,
        commandId: CommandId.make(`stale-retry:${state}`),
        threadId: state === "direct-child" ? child : observed.threadId,
        expectedArchiveCommandId: observed.commandId,
      };
      const refusal = yield* threads.dispatch(retry).pipe(Effect.flip);
      if (state === "stopping") {
        assert.equal(refusal._tag, "OrchestratorThreadArchivingError");
        assert.equal(
          refusal.message,
          "This conversation is stopping before it is archived. Wait for the archive to finish.",
        );
      } else {
        assert.equal(refusal._tag, "OrchestratorDispatchError");
        if (refusal._tag === "OrchestratorDispatchError")
          assert.equal(
            refusal.cause,
            "This failed archive changed. Review the conversation before retrying it.",
          );
      }
      assert.equal((yield* orchestrator.getShellSnapshot()).snapshotSequence, sequence);
      assert.isEmpty(yield* outbox.listByCommandId(retry.commandId));
      assert.deepEqual(
        yield* Effect.forEach(archiveCommandIds, (id) => outbox.listByCommandId(id)),
        effectsBefore,
      );
      for (const previous of before)
        assert.deepEqual(yield* orchestrator.getThreadProjection(previous.thread.id), previous);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("retries the matching failed archive attempt on its original owner", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const { parent, child, grandchild } = yield* family;
    const command = archive(parent, [child, grandchild]);
    yield* failArchive(command);
    const observed = (yield* orchestrator.getThreadProjection(child)).thread.archivePending!;
    const retry = {
      ...command,
      commandId: CommandId.make("retry-matching-failed-archive"),
      threadId: observed.threadId,
      expectedArchiveCommandId: observed.commandId,
    };
    yield* orchestrator.dispatch(retry);
    for (const id of [parent, child, grandchild]) {
      const current = (yield* orchestrator.getThreadProjection(id)).thread;
      assert.equal(current.archivePending?.commandId, retry.commandId);
      assert.equal(current.archivePending?.status, "stopping");
      assert.isNull(current.archivedAt);
    }
    assert.lengthOf(yield* outbox.listByCommandId(retry.commandId), 1);
    yield* threads.executeArchive({ threadId: parent, requestId: retry.commandId }).pipe(
      Effect.provide(
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          teardownThread: () => Effect.void,
        }),
      ),
    );
    for (const id of [parent, child, grandchild]) {
      const current = (yield* orchestrator.getThreadProjection(id)).thread;
      assert.isNotNull(current.archivedAt);
      assert.isNull(current.archivePending);
      assert.equal(current.archivedWith?.threadId, parent);
      assert.equal(current.archivedWith?.commandId, retry.commandId);
    }
  }).pipe(Effect.provide(testLayer)),
);

it.effect.each(["different-owner", "newer-attempt", "archived", "deleted", "independent"] as const)(
  "dismissal preserves a descendant with %s metadata",
  (state) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const { parent, child, grandchild } = yield* family;
      const command = archive(parent, [child, grandchild]);
      yield* failArchive(command);
      const previous = (yield* orchestrator.getThreadProjection(grandchild)).thread;
      const now = yield* DateTime.now;
      const retained = {
        ...previous,
        ...(state === "different-owner"
          ? { archivePending: { ...previous.archivePending!, threadId: grandchild } }
          : state === "newer-attempt"
            ? {
                archivePending: {
                  ...previous.archivePending!,
                  commandId: CommandId.make("newer-archive"),
                },
              }
            : state === "archived"
              ? {
                  archivedAt: now,
                  archivedWith: {
                    threadId: grandchild,
                    commandId: CommandId.make("separate-cohort"),
                  },
                }
              : state === "deleted"
                ? { deletedAt: now }
                : { lineage: { ...previous.lineage, independent: true } }),
      };
      yield* projections.apply({
        id: EventId.make(`dismissal-retained:${state}`),
        type: "thread.metadata-updated",
        threadId: grandchild,
        occurredAt: now,
        payload: retained,
      });
      yield* orchestrator.dispatch(dismissArchive(parent, command.commandId));
      for (const id of [parent, child])
        assert.isNull((yield* orchestrator.getThreadProjection(id)).thread.archivePending);
      assert.deepEqual((yield* orchestrator.getThreadProjection(grandchild)).thread, retained);
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each([
  "active",
  "stopping",
  "newer-failed",
  "completed",
  "deleted",
  "direct-child",
  "compact-owner",
  "restore-active",
] as const)("refuses dismissal against %s without changing the family", (state) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const { parent, child, grandchild } = yield* family;
    const command = archive(parent, [child, grandchild]);
    if (state === "stopping" || state === "completed") {
      yield* orchestrator.dispatch(command);
      if (state === "completed") {
        yield* orchestrator.dispatch({
          type: "thread.archive.complete",
          commandId: CommandId.make(`${command.commandId}:complete`),
          threadId: parent,
          requestId: command.commandId,
        });
        yield* settleArchiveResults(command);
      }
    } else if (state !== "active") yield* failArchive(command);
    if (state === "newer-failed")
      yield* failArchive({ ...command, commandId: CommandId.make("newer-failed-archive") });
    if (state === "deleted" || state === "compact-owner") {
      const thread = (yield* orchestrator.getThreadProjection(parent)).thread;
      yield* projections.apply({
        id: EventId.make(`dismissal-refused:${state}`),
        type: "thread.metadata-updated",
        threadId: parent,
        occurredAt: yield* DateTime.now,
        payload:
          state === "deleted"
            ? { ...thread, deletedAt: yield* DateTime.now }
            : {
                ...thread,
                archivePending: {
                  threadId: parent,
                  commandId: command.commandId,
                  status: "failed",
                },
              },
      });
    }
    const before = yield* Effect.forEach([parent, child, grandchild], (id) =>
      orchestrator.getThreadProjection(id),
    );
    const sequence = (yield* orchestrator.getShellSnapshot()).snapshotSequence;
    const dismissal =
      state === "restore-active"
        ? {
            type: "thread.unarchive" as const,
            commandId: CommandId.make("restore-active"),
            threadId: parent,
          }
        : dismissArchive(state === "direct-child" ? child : parent, command.commandId);
    const refusal = yield* orchestrator.dispatch(dismissal).pipe(Effect.flip);
    assert.equal(
      refusal._tag,
      state === "stopping" ? "OrchestratorThreadArchivingError" : "OrchestratorDispatchError",
    );
    assert.equal((yield* orchestrator.getShellSnapshot()).snapshotSequence, sequence);
    assert.isEmpty(yield* outbox.listByCommandId(dismissal.commandId));
    for (const previous of before)
      assert.deepEqual(yield* orchestrator.getThreadProjection(previous.thread.id), previous);
  }).pipe(Effect.provide(testLayer)),
);

it.effect.each(
  archiveModeLimits.flatMap((limit) => [false, true].map((unrelated) => ({ ...limit, unrelated }))),
)(
  "dismissal respects the $mode ceiling only for changed participants (unrelated=$unrelated)",
  (limit) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const { parent, child, grandchild } = yield* family;
      const command = archive(parent, [child, grandchild]);
      yield* failArchive(command);
      for (const id of [parent, child]) {
        const thread = (yield* orchestrator.getThreadProjection(id)).thread;
        yield* projections.apply({
          id: EventId.make(`dismissal-limited:${id}`),
          type: "thread.metadata-updated",
          threadId: id,
          occurredAt: yield* DateTime.now,
          payload: {
            ...thread,
            runtimeMode: limit.runtimeMode,
            interactionMode: limit.interactionMode,
          },
        });
      }
      const nested = (yield* orchestrator.getThreadProjection(grandchild)).thread;
      if (limit.unrelated)
        yield* projections.apply({
          id: EventId.make("dismissal-unrelated-limit"),
          type: "thread.metadata-updated",
          threadId: grandchild,
          occurredAt: yield* DateTime.now,
          payload: {
            ...nested,
            archivePending: { ...nested.archivePending!, threadId: grandchild },
          },
        });
      const dismissal = dismissArchive(parent, command.commandId);
      if (!limit.unrelated) {
        const before = yield* Effect.forEach([parent, child, grandchild], (id) =>
          orchestrator.getThreadProjection(id),
        );
        const sequence = (yield* orchestrator.getShellSnapshot()).snapshotSequence;
        const refusal = yield* orchestrator
          .dispatch(dismissal)
          .pipe(Effect.provideService(DispatchModeLimit, limit), Effect.flip);
        assert.equal(refusal._tag, "OrchestratorThreadAboveModeLimitError");
        assert.equal((yield* orchestrator.getShellSnapshot()).snapshotSequence, sequence);
        for (const previous of before)
          assert.deepEqual(yield* orchestrator.getThreadProjection(previous.thread.id), previous);
        yield* projections.apply({
          id: EventId.make("dismissal-lower-limit"),
          type: "thread.metadata-updated",
          threadId: grandchild,
          occurredAt: yield* DateTime.now,
          payload: {
            ...nested,
            runtimeMode: limit.runtimeMode,
            interactionMode: limit.interactionMode,
          },
        });
      }
      yield* orchestrator.dispatch(dismissal).pipe(Effect.provideService(DispatchModeLimit, limit));
      for (const id of [parent, child])
        assert.isNull((yield* orchestrator.getThreadProjection(id)).thread.archivePending);
      assert.equal(
        (yield* orchestrator.getThreadProjection(grandchild)).thread.archivePending == null,
        !limit.unrelated,
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect("shows runless native task activity and requires archiving its runtime owner", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const { parent, child, grandchild } = yield* family;
    const nativeId = ThreadId.make("runless-native-child");
    yield* createWatchingThread(nativeId, 5);
    const native = (yield* orchestrator.getThreadProjection(nativeId)).thread;
    const parentProjection = yield* orchestrator.getThreadProjection(parent);
    const now = yield* DateTime.now;
    const mirror = {
      ...native,
      creationSource: "provider" as const,
      pullRequests: [],
      lineage: {
        parentThreadId: parent,
        relationshipToParent: "subagent" as const,
        rootThreadId: parent,
      },
    };
    const nativeEvent = {
      id: EventId.make("runless-native-lineage"),
      type: "thread.metadata-updated" as const,
      threadId: nativeId,
      occurredAt: now,
      payload: mirror,
    };
    const taskEvent = {
      id: EventId.make("runless-native-task"),
      type: "subagent.updated" as const,
      threadId: parent,
      occurredAt: now,
      payload: {
        ...parentProjection.subagents[0]!,
        id: NodeId.make("runless-native-task"),
        origin: "provider_native" as const,
        driver: ProviderDriverKind.make("claudeAgent"),
        childThreadId: nativeId,
        providerThreadId: null,
        status: "running" as const,
        startedAt: now,
      },
    };
    yield* projections.apply(nativeEvent);
    yield* projections.apply(taskEvent);
    const projection = yield* orchestrator.getThreadProjection(nativeId);
    assert.lengthOf(projection.runs, 0);
    assert.lengthOf(projection.providerThreads, 0);
    assert.lengthOf(projection.providerTurns, 0);
    for (const shell of [
      yield* projections.getThreadShell(nativeId),
      (yield* projections.getShellSnapshot()).threads.find((thread) => thread.id === nativeId),
    ]) {
      assert.equal(shell?.status, "running");
      assert.isNull(shell?.latestRunId);
      assert.isNull(shell?.activeRunId);
    }
    const replayShell = yield* Effect.gen(function* () {
      const replay = yield* ProjectionStore.ProjectionStoreV2;
      yield* replay.apply({
        id: EventId.make("native-parent-replay"),
        type: "thread.created",
        threadId: parent,
        occurredAt: now,
        payload: parentProjection.thread,
      });
      yield* replay.apply({ ...nativeEvent, type: "thread.created" });
      yield* replay.apply(taskEvent);
      return yield* replay.getThreadShell(nativeId);
    }).pipe(Effect.provide(ProjectionStore.layerMemory));
    assert.equal(replayShell?.status, "running");
    assert.isNull(replayShell?.latestRunId);
    const rejection = yield* Effect.flip(orchestrator.dispatch(archive(nativeId, [])));
    assert.equal(
      rejection.cause,
      "Archive the parent thread to stop and archive this running native subagent.",
    );
    assert.isNull((yield* projections.getThreadShell(nativeId))?.archivedAt);
    assert.equal((yield* orchestrator.getThreadProjection(parent)).runs[0]?.status, "starting");
    const missingChoice = yield* Effect.exit(
      orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("runless-native-no-consent"),
        threadId: parent,
      }),
    );
    assert.isTrue(Exit.isFailure(missingChoice));
    yield* projections.apply({
      ...taskEvent,
      id: EventId.make("runless-native-completed"),
      payload: { ...taskEvent.payload, status: "completed", completedAt: now },
    });
    assert.equal((yield* projections.getThreadShell(nativeId))?.status, "completed");
    // A completed child still shares a runtime with its working owner.
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(
          orchestrator.dispatch({
            ...archive(nativeId, []),
            commandId: CommandId.make("runless-native-owner-still-active"),
          }),
        ),
      ),
    );
    yield* orchestrator.dispatch(archive(parent, [child, grandchild, nativeId]));
    assert.equal((yield* projections.getThreadShell(nativeId))?.archivePending?.status, "stopping");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("keeps an idle native mirror visible when its unbound session cannot unload", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const { parent, child, grandchild } = yield* family;
    for (const threadId of [parent, child, grandchild])
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make(`stop-before-native-archive:${threadId}`),
        threadId,
      });
    const native = yield* orchestrator.getThreadProjection(grandchild);
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make("idle-native-mirror"),
      type: "thread.metadata-updated",
      threadId: grandchild,
      occurredAt: now,
      payload: { ...native.thread, creationSource: "provider" },
    });
    yield* projections.apply({
      id: EventId.make("idle-native-unbound-session"),
      type: "provider-thread.updated",
      threadId: grandchild,
      occurredAt: now,
      payload: { ...native.providerThreads[0]!, providerSessionId: importSessionId },
    });
    assert.lengthOf((yield* orchestrator.getThreadProjection(grandchild)).providerSessions, 0);
    const command = archive(grandchild, []);
    yield* orchestrator.dispatch(command);
    const stopping = (yield* orchestrator.getThreadProjection(grandchild)).thread;
    assert.isNull(stopping.archivedAt);
    assert.equal(stopping.archivePending?.status, "stopping");
    const shutdownCalls: Array<ThreadId> = [];
    yield* threads.executeArchive({ threadId: grandchild, requestId: command.commandId }).pipe(
      Effect.provide(
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          teardownThread: (input) => {
            shutdownCalls.push(input.threadId);
            return Effect.fail(
              new ProviderSessionManager.ProviderSessionReleaseError({
                providerSessionId: input.providerSessionId,
                reason: "manual_shutdown",
                cause: "native unload refused",
              }),
            );
          },
        }),
      ),
    );
    assert.deepEqual(shutdownCalls, [grandchild]);
    const failed = (yield* orchestrator.getThreadProjection(grandchild)).thread;
    assert.isNull(failed.archivedAt);
    assert.equal(failed.archivePending?.status, "failed");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects deleting an ancestor while a descendant archive is stopping", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { parent, child, grandchild } = yield* family;
    const command = archive(child, [grandchild]);
    yield* orchestrator.dispatch(command);
    const sequence = (yield* orchestrator.getShellSnapshot()).snapshotSequence;
    const rejection = yield* orchestrator
      .dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete-ancestor-during-archive"),
        threadId: parent,
      })
      .pipe(Effect.flip);
    assert.equal(rejection._tag, "OrchestratorDispatchError");
    assert.equal((yield* orchestrator.getShellSnapshot()).snapshotSequence, sequence);
    yield* orchestrator.dispatch({
      type: "thread.archive.fail",
      commandId: CommandId.make("child-archive-shutdown-failed"),
      threadId: child,
      requestId: command.commandId,
      error: "Shutdown could not be confirmed.",
    });
    for (const id of [parent, child, grandchild]) {
      const thread = (yield* orchestrator.getThreadProjection(id)).thread;
      assert.isNull(thread.deletedAt);
      assert.isNull(thread.archivedAt);
    }
    assert.equal(
      (yield* orchestrator.getThreadProjection(child)).thread.archivePending?.status,
      "failed",
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "keeps a stranded native child visible when archived-family repair cannot unload it",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const { parent, child, grandchild } = yield* family;
      for (const threadId of [parent, child, grandchild])
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make(`stop-before-repair:${threadId}`),
          threadId,
        });
      const now = yield* DateTime.now;
      const original = {
        threadId: parent,
        commandId: CommandId.make("original-family-archive"),
      };
      const owner = (yield* orchestrator.getThreadProjection(parent)).thread;
      yield* projections.apply({
        id: EventId.make("legacy-archived-owner"),
        type: "thread.metadata-updated",
        threadId: parent,
        occurredAt: now,
        payload: { ...owner, archivedAt: now, archivedWith: original },
      });
      const native = yield* orchestrator.getThreadProjection(grandchild);
      yield* projections.apply({
        id: EventId.make("stranded-native-mirror"),
        type: "thread.metadata-updated",
        threadId: grandchild,
        occurredAt: now,
        payload: { ...native.thread, creationSource: "provider" },
      });
      yield* projections.apply({
        id: EventId.make("stranded-native-session"),
        type: "provider-thread.updated",
        threadId: grandchild,
        occurredAt: now,
        payload: { ...native.providerThreads[0]!, providerSessionId: importSessionId },
      });
      const command = {
        type: "thread.archive" as const,
        commandId: CommandId.make("repair-stranded-family"),
        threadId: parent,
      };
      const result = yield* orchestrator.dispatch(command);
      assert.isFalse(result.storedEvents.some((stored) => stored.event.type === "thread.archived"));
      for (const id of [child, grandchild]) {
        const thread = (yield* orchestrator.getThreadProjection(id)).thread;
        assert.isNull(thread.archivedAt);
        assert.equal(thread.archivePending?.status, "stopping");
      }
      yield* threads.executeArchive({ threadId: parent, requestId: command.commandId }).pipe(
        Effect.provide(
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            teardownThread: (input) =>
              Effect.fail(
                new ProviderSessionManager.ProviderSessionReleaseError({
                  providerSessionId: input.providerSessionId,
                  reason: "manual_shutdown",
                  cause: "native unload refused",
                }),
              ),
          }),
        ),
      );
      for (const id of [child, grandchild]) {
        const failed = (yield* orchestrator.getThreadProjection(id)).thread;
        assert.isNull(failed.archivedAt);
        assert.equal(failed.archivePending?.status, "failed");
      }
      const root = (yield* orchestrator.getThreadProjection(parent)).thread;
      assert.deepEqual(root.archivedAt, now);
      assert.deepEqual(root.archivedWith, original);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("stores a single family plan through shutdown failure and completion", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { parent, child, grandchild } = yield* family;
    const command = archive(parent, [child, grandchild]);
    yield* orchestrator.dispatch(command);
    for (const status of ["stopping", "failed"] as const) {
      const { threads: shells } = yield* orchestrator.getThreadArchiveFamily(parent);
      const plans = shells.flatMap((shell) => {
        const pending = getThreadArchivePlan(shell.archivePending);
        return pending === null ? [] : [pending];
      });
      assert.lengthOf(plans, 1);
      assert.deepEqual(plans[0]?.archiveThreadIds, [parent, child, grandchild]);
      for (const shell of shells) {
        assert.equal(shell.archivePending?.status, status);
        assert.equal(shell.archivePending?.threadId, parent);
        assert.equal(shell.archivePending?.commandId, command.commandId);
      }
      if (status === "stopping")
        yield* orchestrator.dispatch({
          type: "thread.archive.fail",
          commandId: CommandId.make("compact-plan-failure"),
          threadId: parent,
          requestId: command.commandId,
          error: "Synthetic shutdown failure",
        });
    }
    const retry = { ...command, commandId: CommandId.make("compact-plan-retry") };
    yield* orchestrator.dispatch(retry);
    yield* orchestrator.dispatch({
      type: "thread.archive.complete",
      commandId: CommandId.make("compact-plan-complete"),
      threadId: parent,
      requestId: retry.commandId,
    });
    for (const id of [parent, child, grandchild]) {
      const projection = yield* orchestrator.getThreadProjection(id);
      assert.isNull(projection.thread.archivePending);
      assert.isNotNull(projection.thread.archivedAt);
    }
  }).pipe(Effect.provide(testLayer)),
);
