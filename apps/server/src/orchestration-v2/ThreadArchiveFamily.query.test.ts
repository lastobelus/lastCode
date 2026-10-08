import { assert, it } from "@effect/vitest";
import {
  EventId,
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
  "offers protected app branches but refuses a protected native owner=%s",
  (protectedNative) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const service = yield* ThreadManagementService.ThreadManagementService;
      const now = yield* DateTime.now;
      const rootId = ThreadId.make("choices:root");
      const appId = ThreadId.make("choices:app");
      const nestedId = ThreadId.make("choices:nested-native");
      const nativeId = ThreadId.make("choices:native");
      const root = makeThread(rootId, now);
      for (const thread of [
        root,
        {
          ...root,
          id: appId,
          lineage: {
            ...root.lineage,
            parentThreadId: rootId,
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
        [rootId, appId, nestedId, nativeId].toSorted(),
      );
      assert.deepEqual(result.childThreadIds, [appId, nestedId, nativeId]);
      assert.deepEqual(result.promotableChildThreadIds, [appId]);
      assert.deepEqual(result.keptThreadIds, [appId, nestedId]);
      assert.deepEqual(
        result.protectedChildThreadIds,
        protectedNative ? [nestedId, nativeId] : [nestedId],
      );
      assert.deepEqual(result.activeChildThreadIds, []);
      assert.equal(result.nativeStopCount, 1);
      assert.isTrue(result.requiresConfirmation);
      assert.equal(result.canPromote, !protectedNative);
      assert.isFalse(result.canStopAndArchive);
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
    const result = yield* service.getThreadArchiveFamily(rootId);
    const needsConsent = !["none", "recovered", "finished-action"].includes(state);
    assert.equal(result.requiresConfirmation, needsConsent);
    assert.deepEqual(
      result.activeChildThreadIds,
      needsConsent && state !== "owner-attention" ? [childId] : [],
    );
    assert.isTrue(result.canPromote);
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
      assert.deepEqual(family.activeChildThreadIds, [childId]);
      assert.deepEqual(family.promotableChildThreadIds, []);
      assert.deepEqual(family.keptThreadIds, []);
      assert.isTrue(family.requiresConfirmation);
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
