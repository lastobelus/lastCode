import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  OrchestrationV2AppThreadJson,
  OrchestrationV2ThreadShellJson,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const encodeThread = Schema.encodeSync(OrchestrationV2AppThreadJson);
const decodeThread = Schema.decodeSync(OrchestrationV2AppThreadJson);
const encodeShell = Schema.encodeSync(OrchestrationV2ThreadShellJson);
const decodeShell = Schema.decodeSync(OrchestrationV2ThreadShellJson);

const TestLayer = ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

it.effect(
  "retains promotion across persisted projections, shell queries and JSON round trips",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
      const threadId = ThreadId.make("native-subagent");
      const providerInstanceId = ProviderInstanceId.make("provider-instance");
      const thread = {
        createdBy: "agent" as const,
        creationSource: "provider" as const,
        id: threadId,
        projectId: ProjectId.make("project"),
        title: "Native subagent",
        providerInstanceId,
        modelSelection: { instanceId: providerInstanceId, model: "model" },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: ThreadId.make("parent"),
          relationshipToParent: "subagent" as const,
          rootThreadId: ThreadId.make("parent"),
        },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      yield* store.apply({
        id: EventId.make("created"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      });
      const promotion = {
        createdBy: "user" as const,
        creationSource: "web" as const,
        requestId: CommandId.make("promotion"),
        targetThreadId: ThreadId.make("interactive"),
        status: "waiting" as const,
        error: null,
        requestedAt: now,
        updatedAt: now,
      };
      for (const subagentPromotion of [
        promotion,
        { ...promotion, status: "promoted" as const },
        null,
      ]) {
        yield* store.apply({
          id: EventId.make(`promotion-${subagentPromotion?.status ?? "cleared"}`),
          type: "thread.metadata-updated",
          threadId,
          occurredAt: now,
          payload: { ...thread, subagentPromotion },
        });
        const projection = yield* store.getThreadProjection(threadId);
        const json = encodeThread(projection.thread);
        const decoded = decodeThread(json);
        assert.deepEqual(decoded.subagentPromotion, subagentPromotion);
        const sqlShell = (yield* store.getShellSnapshot()).threads.find(
          (item) => item.id === threadId,
        )!;
        const memoryShell = ProjectionStore.threadShellFromProjection(projection);
        for (const shell of [sqlShell, memoryShell]) {
          assert.deepEqual(shell.subagentPromotion, subagentPromotion);
          const encoded = encodeShell(shell);
          assert.deepEqual(decodeShell(encoded).subagentPromotion, subagentPromotion);
        }
      }
    }).pipe(Effect.provide(TestLayer)),
);
