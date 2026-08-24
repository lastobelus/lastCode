import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);

const seedReadModel = Effect.gen(function* () {
  const now = "2026-01-01T00:00:00.000Z";
  const initial = createEmptyReadModel(now);
  const withProject = yield* projectEvent(initial, {
    sequence: 1,
    eventId: asEventId("evt-project-create"),
    aggregateKind: "project",
    aggregateId: asProjectId("project-delete"),
    type: "project.created",
    occurredAt: now,
    commandId: asCommandId("cmd-project-create"),
    causationEventId: null,
    correlationId: asCommandId("cmd-project-create"),
    metadata: {},
    payload: {
      projectId: asProjectId("project-delete"),
      title: "Project Delete",
      workspaceRoot: "/tmp/project-delete",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });

  const withFirstThread = yield* projectEvent(withProject, {
    sequence: 2,
    eventId: asEventId("evt-thread-create-1"),
    aggregateKind: "thread",
    aggregateId: asThreadId("thread-delete-1"),
    type: "thread.created",
    occurredAt: now,
    commandId: asCommandId("cmd-thread-create-1"),
    causationEventId: null,
    correlationId: asCommandId("cmd-thread-create-1"),
    metadata: {},
    payload: {
      threadId: asThreadId("thread-delete-1"),
      projectId: asProjectId("project-delete"),
      title: "Thread Delete 1",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });

  return yield* projectEvent(withFirstThread, {
    sequence: 3,
    eventId: asEventId("evt-thread-create-2"),
    aggregateKind: "thread",
    aggregateId: asThreadId("thread-delete-2"),
    type: "thread.created",
    occurredAt: now,
    commandId: asCommandId("cmd-thread-create-2"),
    causationEventId: null,
    correlationId: asCommandId("cmd-thread-create-2"),
    metadata: {},
    payload: {
      threadId: asThreadId("thread-delete-2"),
      projectId: asProjectId("project-delete"),
      title: "Thread Delete 2",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });
});

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;
type PlannedThreadDeletedEvent = Omit<
  Extract<OrchestrationEvent, { type: "thread.deleted" }>,
  "sequence"
>;

function normalizeDeleteEvent(event: PlannedEvent | ReadonlyArray<PlannedEvent>) {
  const events = Array.isArray(event) ? event : [event];
  return events.map((entry) => {
    switch (entry.type) {
      case "thread.deleted":
        return {
          type: entry.type,
          aggregateKind: entry.aggregateKind,
          aggregateId: entry.aggregateId,
          commandId: entry.commandId,
          correlationId: entry.correlationId,
          payload: {
            threadId: entry.payload.threadId,
          },
        };
      case "project.deleted":
        return {
          type: entry.type,
          aggregateKind: entry.aggregateKind,
          aggregateId: entry.aggregateId,
          commandId: entry.commandId,
          correlationId: entry.correlationId,
          payload: {
            projectId: entry.payload.projectId,
          },
        };
      default:
        return entry;
    }
  });
}

it.layer(NodeServices.layer)("decider deletion flows", (it) => {
  it.effect("persists cleanup and queues later deletions from the same repository", () =>
    Effect.gen(function* () {
      const seeded = yield* seedReadModel;
      const readModel = {
        ...seeded,
        threads: seeded.threads.map((thread, index) => ({
          ...thread,
          branch: `cleanup-${index + 1}`,
          worktreePath: `/tmp/project-delete-worktrees/cleanup-${index + 1}`,
        })),
      };

      const first = yield* decideOrchestrationCommand({
        command: {
          type: "thread.delete",
          commandId: asCommandId("cmd-thread-delete-worktree-1"),
          threadId: asThreadId("thread-delete-1"),
          deleteWorktree: true,
        },
        readModel,
      });
      const firstEvent = (Array.isArray(first) ? first[0] : first) as PlannedThreadDeletedEvent;
      expect(firstEvent.type).toBe("thread.deleted");
      if (firstEvent.type !== "thread.deleted") return;
      expect(firstEvent.payload.worktreeCleanup).toMatchObject({
        status: "deleting",
        repositoryRoot: "/tmp/project-delete",
        worktreePath: "/tmp/project-delete-worktrees/cleanup-1",
      });

      const afterFirst = yield* projectEvent(readModel, { ...firstEvent, sequence: 4 });
      const repeated = yield* decideOrchestrationCommand({
        command: {
          type: "thread.delete",
          commandId: asCommandId("cmd-thread-delete-worktree-1-repeat"),
          threadId: asThreadId("thread-delete-1"),
        },
        readModel: afterFirst,
      });
      const repeatedEvent = (
        Array.isArray(repeated) ? repeated[0] : repeated
      ) as PlannedThreadDeletedEvent;
      expect(repeatedEvent.type).toBe("thread.deleted");
      if (repeatedEvent.type !== "thread.deleted") return;
      expect(repeatedEvent.payload.worktreeCleanup).toEqual(firstEvent.payload.worktreeCleanup);
      const afterRepeat = yield* projectEvent(afterFirst, { ...repeatedEvent, sequence: 5 });
      expect(
        afterRepeat.threads.find((thread) => thread.id === asThreadId("thread-delete-1"))
          ?.worktreeCleanup,
      ).toEqual(firstEvent.payload.worktreeCleanup);

      const second = yield* decideOrchestrationCommand({
        command: {
          type: "thread.delete",
          commandId: asCommandId("cmd-thread-delete-worktree-2"),
          threadId: asThreadId("thread-delete-2"),
          deleteWorktree: true,
        },
        readModel: afterFirst,
      });
      const secondEvent = (Array.isArray(second) ? second[0] : second) as PlannedThreadDeletedEvent;
      expect(secondEvent.type).toBe("thread.deleted");
      if (secondEvent.type !== "thread.deleted") return;
      expect(secondEvent.payload.worktreeCleanup).toMatchObject({
        status: "queued",
        repositoryRoot: "/tmp/project-delete",
        worktreePath: "/tmp/project-delete-worktrees/cleanup-2",
        blockedByThreadId: asThreadId("thread-delete-1"),
      });
    }),
  );

  it.effect("queues cleanups from different checkouts that share a Git common directory", () =>
    Effect.gen(function* () {
      const seeded = yield* seedReadModel;
      const firstReadModel = {
        ...seeded,
        threads: seeded.threads.map((thread, index) => ({
          ...thread,
          projectId: index === 1 ? asProjectId("project-delete-sibling") : thread.projectId,
          branch: `sibling-cleanup-${index + 1}`,
          worktreePath: `/tmp/sibling-worktrees/cleanup-${index + 1}`,
        })),
        projects: [
          ...seeded.projects,
          {
            ...seeded.projects[0]!,
            id: asProjectId("project-delete-sibling"),
            workspaceRoot: "/tmp/project-delete-sibling",
          },
        ],
      };

      const first = yield* decideOrchestrationCommand({
        command: {
          type: "thread.delete",
          commandId: asCommandId("cmd-sibling-delete-1"),
          threadId: asThreadId("thread-delete-1"),
          deleteWorktree: true,
          repositoryKey: "/tmp/shared-repository/.git",
        },
        readModel: firstReadModel,
      });
      const firstEvent = (Array.isArray(first) ? first[0] : first) as PlannedThreadDeletedEvent;
      const afterFirst = yield* projectEvent(firstReadModel, { ...firstEvent, sequence: 4 });

      const second = yield* decideOrchestrationCommand({
        command: {
          type: "thread.delete",
          commandId: asCommandId("cmd-sibling-delete-2"),
          threadId: asThreadId("thread-delete-2"),
          deleteWorktree: true,
          repositoryKey: "/tmp/shared-repository/.git",
        },
        readModel: afterFirst,
      });
      const secondEvent = (Array.isArray(second) ? second[0] : second) as PlannedThreadDeletedEvent;

      expect(firstEvent.payload.worktreeCleanup).toMatchObject({
        status: "deleting",
        repositoryRoot: "/tmp/project-delete",
        repositoryKey: "/tmp/shared-repository/.git",
      });
      expect(secondEvent.payload.worktreeCleanup).toMatchObject({
        status: "queued",
        repositoryRoot: "/tmp/project-delete-sibling",
        repositoryKey: "/tmp/shared-repository/.git",
        blockedByThreadId: asThreadId("thread-delete-1"),
      });
    }),
  );

  it.effect("rejects deleting a worktree registered as an active project root", () =>
    Effect.gen(function* () {
      const seeded = yield* seedReadModel;
      const worktreePath = "/tmp/project-delete-worktrees/active-project";
      const readModel = {
        ...seeded,
        threads: seeded.threads.map((thread) =>
          thread.id === asThreadId("thread-delete-1")
            ? { ...thread, branch: "active-project", worktreePath }
            : thread,
        ),
        projects: [
          ...seeded.projects,
          {
            ...seeded.projects[0]!,
            id: asProjectId("project-active-worktree"),
            workspaceRoot: worktreePath,
          },
        ],
      };

      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.delete",
            commandId: asCommandId("cmd-delete-active-project-worktree"),
            threadId: asThreadId("thread-delete-1"),
            deleteWorktree: true,
          },
          readModel,
        }),
      );

      expect(error.message).toContain("project-active-worktree");
      expect(error.message).toContain("workspace root");
    }),
  );

  it.effect("refuses to delete a worktree still owned by another live thread", () =>
    Effect.gen(function* () {
      const seeded = yield* seedReadModel;
      const readModel = {
        ...seeded,
        threads: seeded.threads.map((thread) => ({
          ...thread,
          branch: "shared-cleanup",
          worktreePath: "/tmp/project-delete-worktrees/shared-cleanup",
        })),
      };

      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.delete",
            commandId: asCommandId("cmd-thread-delete-shared-worktree"),
            threadId: asThreadId("thread-delete-1"),
            deleteWorktree: true,
          },
          readModel,
        }),
      );
      expect(error.message).toContain("is still used by thread 'thread-delete-2'");
    }),
  );

  it.effect("retries or abandons a persisted cleanup failure", () =>
    Effect.gen(function* () {
      const seeded = yield* seedReadModel;
      const readModel = {
        ...seeded,
        threads: seeded.threads.map((thread) =>
          thread.id === asThreadId("thread-delete-1")
            ? {
                ...thread,
                branch: "cleanup-retry",
                worktreePath: "/tmp/project-delete-worktrees/cleanup-retry",
              }
            : thread,
        ),
      };
      const deleted = (yield* decideOrchestrationCommand({
        command: {
          type: "thread.delete",
          commandId: asCommandId("cmd-cleanup-retry-delete"),
          threadId: asThreadId("thread-delete-1"),
          deleteWorktree: true,
        },
        readModel,
      })) as PlannedThreadDeletedEvent;
      const afterDelete = yield* projectEvent(readModel, { ...deleted, sequence: 4 });

      const earlyAbandonError = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.worktree-cleanup.abandon",
            commandId: asCommandId("cmd-cleanup-abandon-early"),
            threadId: asThreadId("thread-delete-1"),
          },
          readModel: afterDelete,
        }),
      );
      expect(earlyAbandonError.message).toContain("does not have failed worktree cleanup");

      const pathReuseError = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.meta.update",
            commandId: asCommandId("cmd-cleanup-path-reuse"),
            threadId: asThreadId("thread-delete-2"),
            worktreePath: "/tmp/project-delete-worktrees/cleanup-retry",
          },
          readModel: afterDelete,
        }),
      );
      expect(pathReuseError.message).toContain("is still being cleaned up by thread");

      const projectCreateReuseError = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "project.create",
            commandId: asCommandId("cmd-cleanup-project-create-reuse"),
            projectId: asProjectId("project-cleanup-reuse"),
            title: "Cleanup reuse",
            workspaceRoot: "/tmp/project-delete-worktrees/cleanup-retry",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          readModel: afterDelete,
        }),
      );
      expect(projectCreateReuseError.message).toContain(
        "is still being cleaned up by thread 'thread-delete-1'",
      );

      const projectUpdateReuseError = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "project.meta.update",
            commandId: asCommandId("cmd-cleanup-project-update-reuse"),
            projectId: asProjectId("project-delete"),
            workspaceRoot: "/tmp/project-delete-worktrees/cleanup-retry",
          },
          readModel: afterDelete,
        }),
      );
      expect(projectUpdateReuseError.message).toContain(
        "is still being cleaned up by thread 'thread-delete-1'",
      );

      const failed = yield* decideOrchestrationCommand({
        command: {
          type: "thread.worktree-cleanup.update",
          commandId: asCommandId("cmd-cleanup-failed"),
          threadId: asThreadId("thread-delete-1"),
          cleanup: {
            status: "failed",
            repositoryRoot: "/tmp/project-delete",
            worktreePath: "/tmp/project-delete-worktrees/cleanup-retry",
            startedAt: "2026-01-01T00:00:00.000Z",
            failedAt: "2026-01-01T00:00:01.000Z",
            error: "permission denied",
          },
        },
        readModel: afterDelete,
      });
      const failedEvent = (Array.isArray(failed) ? failed[0] : failed) as Extract<
        OrchestrationEvent,
        { type: "thread.worktree-cleanup-updated" }
      >;
      const afterFailure = yield* projectEvent(afterDelete, { ...failedEvent, sequence: 5 });

      const retry = yield* decideOrchestrationCommand({
        command: {
          type: "thread.worktree-cleanup.retry",
          commandId: asCommandId("cmd-cleanup-retry"),
          threadId: asThreadId("thread-delete-1"),
        },
        readModel: afterFailure,
      });
      const retryEvent = (Array.isArray(retry) ? retry[0] : retry) as Extract<
        OrchestrationEvent,
        { type: "thread.worktree-cleanup-updated" }
      >;
      expect(retryEvent.payload.cleanup?.status).toBe("deleting");

      const abandon = yield* decideOrchestrationCommand({
        command: {
          type: "thread.worktree-cleanup.abandon",
          commandId: asCommandId("cmd-cleanup-abandon"),
          threadId: asThreadId("thread-delete-1"),
        },
        readModel: afterFailure,
      });
      const abandonEvent = (Array.isArray(abandon) ? abandon[0] : abandon) as Extract<
        OrchestrationEvent,
        { type: "thread.worktree-cleanup-updated" }
      >;
      expect(abandonEvent.payload.cleanup).toBeNull();
    }),
  );

  it.effect("rejects deleting a non-empty project without force", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "project.delete",
            commandId: asCommandId("cmd-project-delete-no-force"),
            projectId: asProjectId("project-delete"),
          },
          readModel,
        }),
      );
      expect(error.message).toContain("cannot be deleted without force=true");
    }),
  );

  it.effect("rejects project deletion while a deleted thread is cleaning up its worktree", () =>
    Effect.gen(function* () {
      const seeded = yield* seedReadModel;
      const readModel = {
        ...seeded,
        threads: seeded.threads.map((thread) =>
          thread.id === asThreadId("thread-delete-1")
            ? {
                ...thread,
                deletedAt: "2026-01-01T00:00:01.000Z",
                worktreeCleanup: {
                  status: "deleting" as const,
                  repositoryRoot: "/tmp/project-delete",
                  worktreePath: "/tmp/project-delete-worktrees/cleanup-1",
                  startedAt: "2026-01-01T00:00:01.000Z",
                },
              }
            : { ...thread, deletedAt: "2026-01-01T00:00:01.000Z" },
        ),
      };

      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "project.delete",
            commandId: asCommandId("cmd-project-delete-during-cleanup"),
            projectId: asProjectId("project-delete"),
            force: true,
          },
          readModel,
        }),
      );

      expect(error.message).toContain("thread-delete-1");
      expect(error.message).toContain("Wait for cleanup to finish or keep the worktree first");
    }),
  );

  it.effect("reuses thread.delete semantics when force-deleting a non-empty project", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const projectDeleteCommand: Extract<OrchestrationCommand, { type: "project.delete" }> = {
        type: "project.delete",
        commandId: asCommandId("cmd-project-delete-force"),
        projectId: asProjectId("project-delete"),
        force: true,
      };

      const forcedResult = yield* decideOrchestrationCommand({
        command: projectDeleteCommand,
        readModel,
      });
      const forcedEvents = Array.isArray(forcedResult) ? forcedResult : [forcedResult];

      expect(forcedEvents.map((event) => event.type)).toEqual([
        "thread.deleted",
        "thread.deleted",
        "project.deleted",
      ]);

      let sequentialReadModel = readModel;
      let nextSequence = readModel.snapshotSequence;
      const sequentialEvents: PlannedEvent[] = [];
      for (const nextCommand of [
        {
          type: "thread.delete",
          commandId: projectDeleteCommand.commandId,
          threadId: asThreadId("thread-delete-1"),
        },
        {
          type: "thread.delete",
          commandId: projectDeleteCommand.commandId,
          threadId: asThreadId("thread-delete-2"),
        },
        {
          type: "project.delete",
          commandId: projectDeleteCommand.commandId,
          projectId: asProjectId("project-delete"),
        },
      ] satisfies ReadonlyArray<OrchestrationCommand>) {
        const decided = yield* decideOrchestrationCommand({
          command: nextCommand,
          readModel: sequentialReadModel,
        });
        const nextEvents = Array.isArray(decided) ? decided : [decided];
        sequentialEvents.push(...nextEvents);
        for (const nextEvent of nextEvents) {
          nextSequence += 1;
          sequentialReadModel = yield* projectEvent(sequentialReadModel, {
            ...nextEvent,
            sequence: nextSequence,
          });
        }
      }

      expect(normalizeDeleteEvent(forcedResult)).toEqual(normalizeDeleteEvent(sequentialEvents));
    }),
  );
});
