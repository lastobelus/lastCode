import { assert, it } from "@effect/vitest";
import {
  EventId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const sqlLayer = ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory));

const seedThread = Effect.fn("ownership.seedThread")(function* (
  id: string,
  options: {
    parentId?: string;
    independent?: boolean;
    relationship?: "subagent" | "fork";
    archived?: boolean;
    deleted?: boolean;
    creatorId?: string;
    overrides?: Partial<OrchestrationV2AppThread>;
  } = {},
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(id);
  const instanceId = ProviderInstanceId.make("codex");
  const thread: OrchestrationV2AppThread = {
    id: threadId,
    projectId: ProjectId.make("ownership:project"),
    title: id,
    createdBy: "agent",
    creationSource: "mcp",
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "example-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: options.parentId === undefined ? null : ThreadId.make(options.parentId),
      relationshipToParent:
        options.parentId === undefined ? null : (options.relationship ?? "subagent"),
      rootThreadId: ThreadId.make("ownership:root"),
      ...(options.independent === undefined ? {} : { independent: options.independent }),
    },
    ...(options.creatorId === undefined
      ? {}
      : { creatorThreadId: ThreadId.make(options.creatorId), creatorGrouping: "grouped" }),
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: options.archived === true ? now : null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: options.deleted === true ? now : null,
    ...options.overrides,
  };
  yield* projections.apply({
    id: EventId.make(`create:${threadId}`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: thread,
  });
  return thread;
});

const storageCases = [
  { name: "SQL", layer: sqlLayer },
  { name: "memory", layer: ProjectionStore.layerMemory },
] as const;

it.effect.each(storageCases)(
  "$name: cuts promoted subtrees while traversing archived and deleted owned intermediates",
  ({ layer }) =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* seedThread("ownership:root");
      yield* seedThread("archived", { parentId: "ownership:root", archived: true });
      yield* seedThread("deleted", { parentId: "archived", deleted: true, independent: false });
      yield* seedThread("owned-leaf", { parentId: "deleted" });
      const promoted = yield* seedThread("promoted", {
        parentId: "ownership:root",
        independent: true,
      });
      yield* seedThread("promoted-leaf", { parentId: "promoted" });
      yield* seedThread("nested-promoted", { parentId: "archived", independent: true });
      yield* seedThread("nested-promoted-leaf", { parentId: "nested-promoted" });
      yield* seedThread("fork", { parentId: "ownership:root", relationship: "fork" });
      yield* seedThread("fork-leaf", { parentId: "fork" });
      yield* seedThread("created", { creatorId: "ownership:root" });

      assert.deepEqual(
        (yield* projections.getOwnedThreadIds(ThreadId.make("ownership:root"))).toSorted(),
        ["ownership:root", "archived", "deleted", "owned-leaf"].toSorted(),
      );
      assert.deepEqual(
        (yield* projections.getOwnedThreadIds(promoted.id)).toSorted(),
        ["promoted", "promoted-leaf"].toSorted(),
      );
      assert.deepEqual((yield* projections.getThread(promoted.id)).lineage, promoted.lineage);
    }).pipe(Effect.provide(layer)),
);

it.effect.each(storageCases)(
  "$name: finds ordinary grouped conversations and repairs unavailable creator placement",
  ({ layer }) =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* seedThread("creator:active");
      yield* seedThread("creator:archived", { archived: true });
      yield* seedThread("creator:deleted", { deleted: true });
      for (const creator of ["active", "archived", "deleted", "missing"]) {
        yield* seedThread(`grouped:${creator}`, { creatorId: `creator:${creator}` });
      }
      yield* seedThread("grouped:archived-child", {
        creatorId: "creator:archived",
        archived: true,
      });
      yield* seedThread("excluded:deleted-child", {
        creatorId: "creator:archived",
        deleted: true,
      });
      yield* seedThread("excluded:independent", {
        creatorId: "creator:archived",
        overrides: { creatorGrouping: "independent" },
      });
      yield* seedThread("excluded:user", {
        creatorId: "creator:archived",
        overrides: { createdBy: "user" },
      });
      yield* seedThread("excluded:subagent", {
        creatorId: "creator:archived",
        parentId: "creator:archived",
      });
      yield* seedThread("excluded:fork", {
        creatorId: "creator:archived",
        parentId: "creator:archived",
        relationship: "fork",
      });
      yield* seedThread("excluded:fork-origin", {
        creatorId: "creator:archived",
        overrides: { forkedFrom: { type: "node", nodeId: NodeId.make("source:node") } },
      });
      yield* seedThread("excluded:unknown-creator");
      assert.deepEqual(yield* projections.getGroupedCreatorThreadIds([]), []);
      assert.deepEqual(
        yield* projections.getGroupedCreatorThreadIds([
          ThreadId.make("creator:active"),
          ThreadId.make("creator:archived"),
          ThreadId.make("creator:archived"),
        ]),
        ["grouped:active", "grouped:archived", "grouped:archived-child"].map((id) =>
          ThreadId.make(id),
        ),
      );
      assert.deepEqual((yield* projections.getRecoveryThreadIds("creator-grouping")).toSorted(), [
        "grouped:archived",
        "grouped:archived-child",
        "grouped:deleted",
        "grouped:missing",
      ]);
      const thread = yield* projections.getThread(ThreadId.make("grouped:missing"));
      yield* projections.apply({
        id: EventId.make("release:missing"),
        type: "thread.metadata-updated",
        threadId: thread.id,
        occurredAt: thread.updatedAt,
        payload: { ...thread, creatorGrouping: "independent" },
      });
      assert.notInclude(yield* projections.getRecoveryThreadIds("creator-grouping"), thread.id);
      assert.equal((yield* projections.getThread(thread.id)).creatorThreadId, "creator:missing");
    }).pipe(Effect.provide(layer)),
);

it.effect.each(storageCases)(
  "$name: repairs only owned archive/delete edges and keeps independent roots' own families",
  ({ layer }) =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      for (const state of ["archived", "deleted"] as const) {
        const formerOwner = `released-owner:${state}`;
        yield* seedThread(formerOwner, { [state]: true });
        yield* seedThread(`released:${state}`, { parentId: formerOwner, independent: true });
        yield* seedThread(`released-leaf:${state}`, { parentId: `released:${state}` });
        yield* seedThread(`fork:${state}`, { parentId: formerOwner, relationship: "fork" });
        yield* seedThread(`created:${state}`, { creatorId: formerOwner });

        const owner = `owned-owner:${state}`;
        yield* seedThread(owner, { [state]: true });
        yield* seedThread(`owned:${state}`, { parentId: owner, independent: false });
      }
      yield* seedThread("independent-owner", {
        parentId: "released-owner:archived",
        independent: true,
        archived: true,
      });
      yield* seedThread("independent-owned-child", { parentId: "independent-owner" });

      assert.deepEqual(
        (yield* projections.getRecoveryThreadIds("thread-families")).toSorted(),
        ["owned-owner:archived", "owned-owner:deleted", "independent-owner"].toSorted(),
      );
    }).pipe(Effect.provide(layer)),
);
