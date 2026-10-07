import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
  type ThreadWorktreeCleanup,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const sqlLayer = ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory));

for (const [name, layer] of [
  ["SQL", sqlLayer],
  ["memory", ProjectionStore.layerMemory],
] as const) {
  it.layer(layer)(`${name} cleanup shell visibility`, (it) => {
    it.effect("puts pending cleanup in active recovery without rewriting archive history", () =>
      Effect.gen(function* () {
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const paths = {
          repositoryRoot: "/example/repository",
          worktreePath: "/example/worktree",
        };
        const cleanups: ReadonlyArray<ThreadWorktreeCleanup> = [
          {
            ...paths,
            status: "queued",
            queuedAt: DateTime.formatIso(now),
            blockedByThreadId: ThreadId.make("cleanup:other"),
          },
          { ...paths, status: "deleting", startedAt: DateTime.formatIso(now) },
          {
            ...paths,
            status: "failed",
            startedAt: DateTime.formatIso(now),
            failedAt: DateTime.formatIso(now),
            error: "Busy worktree",
          },
        ];
        for (const archived of [false, true]) {
          const threadId = ThreadId.make(`cleanup:${name}:${archived}`);
          const instanceId = ProviderInstanceId.make("codex");
          const thread: OrchestrationV2AppThread = {
            id: threadId,
            projectId: ProjectId.make("cleanup:project"),
            title: "Pending cleanup",
            createdBy: "user",
            creationSource: "web",
            providerInstanceId: instanceId,
            modelSelection: { instanceId, model: "example-model" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: paths.worktreePath,
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: archived ? now : null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          };
          yield* projections.apply({
            id: EventId.make(`create:${threadId}`),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: thread,
          });
          for (const cleanup of cleanups) {
            yield* projections.apply({
              id: EventId.make(`${threadId}:${cleanup.status}`),
              type: "thread.deleted",
              threadId,
              occurredAt: now,
              payload: { ...thread, deletedAt: now, worktreeCleanup: cleanup },
            });
            assert.equal(
              (yield* projections.getThreadShell(threadId))?.worktreeCleanup?.status,
              cleanup.status,
            );
            const shell = yield* projections.getShellSnapshot({ location: "active" });
            const visible = shell.threads;
            assert.equal(
              visible.find(({ id }) => id === threadId)?.worktreeCleanup?.status,
              cleanup.status,
            );
            assert.deepStrictEqual(
              visible.find(({ id }) => id === threadId)?.archivedAt,
              thread.archivedAt,
            );
            const archive = yield* projections.getShellSnapshot({ location: "archive" });
            assert.notInclude(
              archive.archivedThreads.map(({ id }) => id),
              threadId,
            );
            const all = yield* projections.getShellSnapshot();
            assert.include(
              all.threads.map(({ id }) => id),
              threadId,
            );
            assert.notInclude(
              all.archivedThreads.map(({ id }) => id),
              threadId,
            );
          }
          yield* projections.apply({
            id: EventId.make(`${threadId}:completed`),
            type: "thread.metadata-updated",
            threadId,
            occurredAt: now,
            payload: { ...thread, deletedAt: now, worktreeCleanup: null },
          });
          assert.isNull(yield* projections.getThreadShell(threadId));
          const hidden = yield* projections.getShellSnapshot();
          assert.notInclude(
            [...hidden.threads, ...hidden.archivedThreads].map(({ id }) => id),
            threadId,
          );
        }
      }),
    );
  });
}
