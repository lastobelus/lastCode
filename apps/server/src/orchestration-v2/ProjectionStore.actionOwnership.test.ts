import { assert, it } from "@effect/vitest";
import {
  EventId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const now = DateTime.makeUnsafe("2026-10-01T10:00:00.000Z");
const parentId = ThreadId.make("action-owner");
const childId = ThreadId.make("native-child");
const projectId = ProjectId.make("action-ownership");
const providerInstanceId = ProviderInstanceId.make("codex");
const actionResume = {
  runId: "action:quick-ci",
  threadId: parentId,
  projectId,
  actionId: "quick-ci",
  actionName: "Run Quick CI",
  terminalId: "terminal:quick-ci",
  outcome: "running" as const,
  delivery: "armed" as const,
  startedAt: DateTime.formatIso(now),
  finishedAt: null,
  exitCode: null,
  exitSignal: null,
};

function thread(id: ThreadId): OrchestrationV2AppThread {
  return {
    id,
    projectId,
    title: id,
    createdBy: id === parentId ? "user" : "agent",
    creationSource: id === parentId ? "web" : "provider",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: id === parentId ? null : parentId,
      relationshipToParent: id === parentId ? null : "subagent",
      rootThreadId: parentId,
    },
    forkedFrom: null,
    actionResume,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

for (const [name, layer] of [
  [
    "saved SQL projections",
    ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
  ],
  ["event replay", ProjectionStore.layerMemory],
] as const) {
  it.layer(layer)(name, (it) => {
    it.effect("only exposes Project Actions on their owning thread", () =>
      Effect.gen(function* () {
        const store = yield* ProjectionStore.ProjectionStoreV2;
        for (const id of [parentId, childId]) {
          yield* store.apply({
            id: EventId.make(`create:${id}`),
            type: "thread.created",
            threadId: id,
            occurredAt: now,
            payload: thread(id),
          });
        }

        const assertOwner = Effect.gen(function* () {
          const child = yield* store.getThreadProjection(childId);
          assert.isNull(child.thread.actionResume);
          assert.isNull((yield* store.getThread(childId)).actionResume);
          assert.isNull((yield* store.getThreadShell(childId))?.actionResume);
          assert.isNull(ProjectionStore.threadShellFromProjection(child).actionResume);
          assert.isNull(
            (yield* store.getShellSnapshot()).threads.find((row) => row.id === childId)
              ?.actionResume,
          );
          assert.deepEqual((yield* store.getThread(parentId)).actionResume, actionResume);
        });
        yield* assertOwner;

        // A late metadata or visit event must not revive the inherited Action.
        for (const type of ["thread.metadata-updated", "thread.visited"] as const) {
          yield* store.apply({
            id: EventId.make(type),
            type,
            threadId: childId,
            occurredAt: now,
            payload: thread(childId),
          });
          yield* assertOwner;
        }

        // A child can own its own Action; ownership, not lineage, is the rule.
        const childAction = { ...actionResume, runId: "action:child-ci", threadId: childId };
        yield* store.apply({
          id: EventId.make("child-action"),
          type: "thread.metadata-updated",
          threadId: childId,
          occurredAt: now,
          payload: { ...thread(childId), actionResume: childAction },
        });
        assert.deepEqual(
          (yield* store.getThreadProjection(childId)).thread.actionResume,
          childAction,
        );
        assert.deepEqual((yield* store.getThreadShell(childId))?.actionResume, childAction);
      }),
    );
  });
}
