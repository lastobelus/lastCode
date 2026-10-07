import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
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

it.effect.each(["archived", "deleted"] as const)(
  "includes a live descendant through its %s owner without unrelated families",
  (state) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const now = yield* DateTime.now;
      const rootId = ThreadId.make("archive-query:root");
      const instanceId = ProviderInstanceId.make("codex");
      const root: OrchestrationV2AppThread = {
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
      };
      const intermediateId = ThreadId.make("archive-query:intermediate");
      const childId = ThreadId.make("archive-query:child");
      for (const thread of [
        root,
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
      assert.deepEqual(
        family.map(({ id }) => id).toSorted(),
        [rootId, intermediateId, childId].toSorted(),
      );
      assert.equal(family.find(({ id }) => id === childId)?.attention?.kind, "question");
      assert.isNotNull(
        family.find(({ id }) => id === intermediateId)?.[
          state === "archived" ? "archivedAt" : "deletedAt"
        ],
      );
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(threads.getThreadArchiveFamily(ThreadId.make("missing"))),
        ),
      );
    }).pipe(Effect.provide(testLayer)),
);
