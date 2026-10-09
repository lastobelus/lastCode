import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
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
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
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
  "owner-attention",
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
    for (const thread of [
      state === "owner-attention"
        ? { ...root, attention: { kind: "question" as const, raisedAt: DateTime.formatIso(now) } }
        : root,
      child,
    ])
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
          attention: { kind: "question" as const, raisedAt: DateTime.formatIso(now) },
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
      assert.equal(family.threads.find(({ id }) => id === childId)?.attention?.kind, "question");
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
