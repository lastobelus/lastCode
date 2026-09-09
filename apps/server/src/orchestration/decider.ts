import {
  EventId,
  SCRIPT_RUN_COMMAND_PATTERN,
  MessageId,
  ThreadLinkedPullRequest,
  UserInputRequestedPayload,
  isImportedAgentSessionMessageId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { compareDateTimeStrings } from "@t3tools/shared/dateTime";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Equal from "effect/Equal";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type * as PlatformError from "effect/PlatformError";

import {
  OrchestrationCommandInvariantError,
  OrchestrationThreadSettleBlockedError,
  type OrchestrationCommandRejection,
} from "./Errors.ts";
import {
  listThreadsByProjectId,
  requireActiveProjectWorkspaceRootAbsent,
  requireProject,
  requireProjectAbsent,
  requireThread,
  requireThreadArchived,
  requireThreadAbsent,
  requireThreadNotArchived,
} from "./commandInvariants.ts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { projectEvent } from "./projector.ts";
import { threadHasQueuedTurnStart } from "./ThreadSettlementPolicy.ts";

const isScriptRunCommand = Schema.is(SCRIPT_RUN_COMMAND_PATTERN);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const decodeUserInputRequestedPayload = Schema.decodeUnknownOption(UserInputRequestedPayload);
const threadPullRequestLinksEqual = Schema.toEquivalence(Schema.NullOr(ThreadLinkedPullRequest));

/**
 * Blocked-on-you work derived from the thread's retained activities: an
 * approval or user-input request with no later resolution for the same
 * requestId. The server-side twin of the shell's hasPendingApprovals /
 * hasPendingUserInput flags, which the decider read model does not carry.
 * The clearing rules MUST match ProjectionPipeline's pending accounting —
 * resolved activities always clear, respond.failed clears only when the
 * failure detail marks the request stale/unknown — or settle would be
 * rejected on threads whose shell flags read as clear.
 */
function isStaleRequestFailureDetail(payload: Record<string, unknown> | null): boolean {
  const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;
  if (detail === null) return false;
  return (
    detail.includes("stale pending approval request") ||
    detail.includes("unknown pending approval request") ||
    detail.includes("unknown pending permission request") ||
    detail.includes("stale pending user-input request") ||
    detail.includes("unknown pending user-input request") ||
    detail.includes("unknown pending user input request") ||
    detail.includes("unknown pending codex user input request")
  );
}

// Scans the read model's activities, which the projector caps at the most
// recent 500 plus pending async questions. Async questions remain actionable
// while the agent works, so they must not expire with the activity window.
function openRequests(thread: Pick<OrchestrationThread, "activities">) {
  const requests = new Map<string, OrchestrationThreadActivity>();
  for (const activity of thread.activities) {
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
    if (requestId === null) continue;
    if (activity.kind === "approval.requested" || activity.kind === "user-input.requested") {
      requests.set(requestId, activity);
    } else if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
      requests.delete(requestId);
    } else if (
      (activity.kind === "provider.approval.respond.failed" ||
        activity.kind === "provider.user-input.respond.failed") &&
      isStaleRequestFailureDetail(payload)
    ) {
      requests.delete(requestId);
    }
  }
  return requests;
}

/** Apply the shared shell-level rule to the detailed command read model. */
function hasQueuedTurnStartForThread(
  thread: Pick<OrchestrationThread, "messages" | "latestTurn" | "session">,
  now: string,
): boolean {
  let latestUserMessageAt: string | null = null;
  let latestUserMessageAtMs = Number.NEGATIVE_INFINITY;
  for (const message of thread.messages) {
    if (message.role !== "user" || isImportedAgentSessionMessageId(message.id)) continue;
    const messageAtMs = Date.parse(message.createdAt);
    latestUserMessageAtMs = Math.max(latestUserMessageAtMs, messageAtMs);
    if (messageAtMs === latestUserMessageAtMs) {
      latestUserMessageAt = message.createdAt;
    }
  }
  return threadHasQueuedTurnStart(
    {
      latestUserMessageAt: Number.isFinite(latestUserMessageAtMs) ? latestUserMessageAt : null,
      latestTurn: thread.latestTurn,
      session: thread.session,
    },
    now,
  );
}

function latestUserMessageId(thread: OrchestrationReadModel["threads"][number]) {
  return (
    thread.latestUserMessageId ??
    thread.messages
      .filter((message) => message.role === "user")
      .toSorted(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
      )[0]?.id
  );
}

function nextAnnotationAnchorMessageId(thread: OrchestrationReadModel["threads"][number]) {
  return latestUserMessageId(thread) ?? thread.annotation?.anchorMessageId;
}

function worktreeCleanupTimestamp(
  cleanup: NonNullable<OrchestrationReadModel["threads"][number]["worktreeCleanup"]>,
): string {
  switch (cleanup.status) {
    case "deleting":
      return cleanup.startedAt;
    case "queued":
      return cleanup.queuedAt;
    case "failed":
      return cleanup.failedAt;
  }
}

function findWorktreeCleanupBlocker(
  readModel: OrchestrationReadModel,
  repositoryKey: string,
  exceptThreadId?: string,
) {
  const normalizedKey = normalizeProjectPathForComparison(repositoryKey);
  return readModel.threads
    .filter((candidate) => {
      const cleanup = candidate.worktreeCleanup;
      return (
        candidate.id !== exceptThreadId &&
        cleanup != null &&
        cleanup.status !== "failed" &&
        normalizeProjectPathForComparison(cleanup.repositoryKey ?? cleanup.repositoryRoot) ===
          normalizedKey
      );
    })
    .toSorted((left, right) => {
      const leftCleanup = left.worktreeCleanup;
      const rightCleanup = right.worktreeCleanup;
      if (leftCleanup == null || rightCleanup == null) return 0;
      return (
        worktreeCleanupTimestamp(rightCleanup).localeCompare(
          worktreeCleanupTimestamp(leftCleanup),
        ) || right.id.localeCompare(left.id)
      );
    })[0];
}

function findWorktreeCleanupOwner(
  readModel: OrchestrationReadModel,
  worktreePath: string,
  exceptThreadId?: string,
) {
  const normalizedPath = normalizeProjectPathForComparison(worktreePath);
  return readModel.threads.find(
    (candidate) =>
      candidate.id !== exceptThreadId &&
      candidate.worktreeCleanup != null &&
      normalizeProjectPathForComparison(candidate.worktreeCleanup.worktreePath) === normalizedPath,
  );
}

function withEventBase(
  input: Pick<OrchestrationCommand, "commandId"> & {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: OrchestrationEvent["aggregateId"];
    readonly occurredAt: string;
    readonly metadata?: OrchestrationEvent["metadata"];
  },
): Effect.Effect<
  Omit<OrchestrationEvent, "sequence" | "type" | "payload">,
  PlatformError.PlatformError,
  Crypto.Crypto
> {
  return Crypto.Crypto.pipe(
    Effect.flatMap((crypto) =>
      crypto.randomUUIDv4.pipe(
        Effect.map((eventId) => ({
          eventId: EventId.make(eventId),
          aggregateKind: input.aggregateKind,
          aggregateId: input.aggregateId,
          occurredAt: input.occurredAt,
          commandId: input.commandId,
          causationEventId: null,
          correlationId: input.commandId,
          metadata: input.metadata ?? {},
        })),
      ),
    ),
  );
}

type PlannedOrchestrationEvent = Omit<OrchestrationEvent, "sequence">;

type DecideOrchestrationCommandResult =
  | PlannedOrchestrationEvent
  | ReadonlyArray<PlannedOrchestrationEvent>;

const decideCommandSequence = Effect.fn("decideCommandSequence")(function* ({
  commands,
  readModel,
}: {
  readonly commands: ReadonlyArray<OrchestrationCommand>;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  ReadonlyArray<PlannedOrchestrationEvent>,
  OrchestrationCommandRejection | PlatformError.PlatformError,
  Crypto.Crypto
> {
  let nextReadModel = readModel;
  let nextSequence = readModel.snapshotSequence;
  const plannedEvents: PlannedOrchestrationEvent[] = [];

  for (const nextCommand of commands) {
    const decided = yield* decideOrchestrationCommand({
      command: nextCommand,
      readModel: nextReadModel,
    });
    const nextEvents = Array.isArray(decided) ? decided : [decided];
    for (const nextEvent of nextEvents) {
      plannedEvents.push(nextEvent);
      nextSequence += 1;
      nextReadModel = yield* projectEvent(nextReadModel, {
        ...nextEvent,
        sequence: nextSequence,
      }).pipe(Effect.orDie);
    }
  }

  return plannedEvents;
});

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
  userInputActivity,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
  readonly userInputActivity?: OrchestrationThreadActivity;
}): Effect.fn.Return<
  DecideOrchestrationCommandResult,
  OrchestrationCommandRejection | PlatformError.PlatformError,
  Crypto.Crypto
> {
  switch (command.type) {
    case "project.create": {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireActiveProjectWorkspaceRootAbsent({
        readModel,
        command,
        workspaceRoot: command.workspaceRoot,
        exceptProjectId: command.projectId,
      });
      const cleanupOwner = findWorktreeCleanupOwner(readModel, command.workspaceRoot);
      if (cleanupOwner !== undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Workspace root '${command.workspaceRoot}' is still being cleaned up by thread '${cleanupOwner.id}'.`,
        });
      }

      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          // Project creation has no user model choice. Older clients sent an
          // automatic seed here, but only a metadata update records an
          // explicit project default.
          defaultModelSelection: null,
          faviconPath: null,
          projectIcon: null,
          scripts: [],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "project.meta.update": {
      const project = yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      if (command.scripts !== undefined) {
        // Persisted IDs predate shortcut validation. Let users edit or remove them
        // without allowing another invalid ID to enter the project.
        const existingIds = new Set(project.scripts.map((script) => script.id));
        for (const script of command.scripts) {
          if (!existingIds.has(script.id) && !isScriptRunCommand(`script.${script.id}.run`)) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `Script ID '${script.id}' must be non-empty and trimmed.`,
            });
          }
        }
      }
      if (command.workspaceRoot !== undefined) {
        yield* requireActiveProjectWorkspaceRootAbsent({
          readModel,
          command,
          workspaceRoot: command.workspaceRoot,
          exceptProjectId: command.projectId,
        });
        const cleanupOwner = findWorktreeCleanupOwner(readModel, command.workspaceRoot);
        if (cleanupOwner !== undefined) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Workspace root '${command.workspaceRoot}' is still being cleaned up by thread '${cleanupOwner.id}'.`,
          });
        }
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.workspaceRoot !== undefined ? { workspaceRoot: command.workspaceRoot } : {}),
          ...(command.defaultModelSelection !== undefined
            ? { defaultModelSelection: command.defaultModelSelection }
            : {}),
          ...(command.defaultThreadEnvMode !== undefined
            ? { defaultThreadEnvMode: command.defaultThreadEnvMode }
            : {}),
          ...(command.autoPull !== undefined ? { autoPull: command.autoPull } : {}),
          ...(command.faviconPath !== undefined ? { faviconPath: command.faviconPath } : {}),
          ...(command.projectIcon !== undefined ? { projectIcon: command.projectIcon } : {}),
          ...(command.scripts !== undefined ? { scripts: command.scripts } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "project.scripts.reconcile": {
      const project = yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      if (!Equal.equals(command.expectedScripts, project.scripts)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project '${command.projectId}' scripts changed before the update could be applied.`,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          scripts: command.scripts,
          updatedAt: occurredAt,
        },
      };
    }

    case "project.delete": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const projectThreads = listThreadsByProjectId(readModel, command.projectId);
      const cleanupThread = projectThreads.find((thread) => thread.worktreeCleanup != null);
      if (cleanupThread !== undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project '${command.projectId}' cannot be deleted while thread '${cleanupThread.id}' is cleaning up its worktree. Wait for cleanup to finish or keep the worktree first.`,
        });
      }
      const activeThreads = projectThreads.filter((thread) => thread.deletedAt === null);
      const persistentThread = activeThreads.find((thread) => thread.persistent);
      if (persistentThread !== undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project '${command.projectId}' cannot be deleted while thread '${persistentThread.id}' is persistent. Disable persistence or move it to another thread first.`,
        });
      }
      if (activeThreads.length > 0 && command.force !== true) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project '${command.projectId}' is not empty and cannot be deleted without force=true.`,
        });
      }
      if (activeThreads.length > 0) {
        return yield* decideCommandSequence({
          readModel,
          commands: [
            ...activeThreads.map(
              (thread): Extract<OrchestrationCommand, { type: "thread.delete" }> => ({
                type: "thread.delete",
                commandId: command.commandId,
                threadId: thread.id,
                ...(command.repositoryKey === undefined
                  ? {}
                  : { repositoryKey: command.repositoryKey }),
              }),
            ),
            {
              type: "project.delete",
              commandId: command.commandId,
              projectId: command.projectId,
            },
          ],
        });
      }

      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.deleted" as const,
        payload: {
          projectId: command.projectId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (command.worktreePath !== null) {
        const cleanupOwner = findWorktreeCleanupOwner(readModel, command.worktreePath);
        if (cleanupOwner !== undefined) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Worktree '${command.worktreePath}' is still being cleaned up by thread '${cleanupOwner.id}'.`,
          });
        }
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(command.historyImport === true ? { metadata: { historyImport: true } } : {}),
        })),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.delete": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (thread.persistent) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Persistent thread '${thread.id}' cannot be deleted until persistence is disabled or moved to another thread.`,
        });
      }
      const occurredAt = yield* nowIso;

      // Deletion commands can be retried after the first deleted event has
      // already been projected. Preserve the tombstone, especially its
      // durable worktree-cleanup state, rather than allowing a retry that
      // omits deleteWorktree to clear an in-flight cleanup.
      if (thread.deletedAt !== null) {
        return {
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.deleted",
          payload: {
            threadId: command.threadId,
            deletedAt: thread.deletedAt,
            ...(thread.worktreeCleanup === null ? {} : { worktreeCleanup: thread.worktreeCleanup }),
          },
        };
      }

      let worktreeCleanup: NonNullable<
        OrchestrationReadModel["threads"][number]["worktreeCleanup"]
      > | null = null;
      if (command.deleteWorktree === true) {
        if (thread.worktreePath === null) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Thread '${thread.id}' does not own a worktree to delete.`,
          });
        }
        const project = yield* requireProject({
          readModel,
          command,
          projectId: thread.projectId,
        });
        const normalizedWorktreePath = normalizeProjectPathForComparison(thread.worktreePath);
        const sharedProject = readModel.projects.find(
          (candidate) =>
            candidate.deletedAt === null &&
            normalizeProjectPathForComparison(candidate.workspaceRoot) === normalizedWorktreePath,
        );
        if (sharedProject !== undefined) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Worktree '${thread.worktreePath}' is still used as the workspace root of project '${sharedProject.id}'.`,
          });
        }
        const sharedThread = readModel.threads.find(
          (candidate) =>
            candidate.id !== thread.id &&
            candidate.deletedAt === null &&
            candidate.worktreePath !== null &&
            normalizeProjectPathForComparison(candidate.worktreePath) === normalizedWorktreePath,
        );
        if (sharedThread !== undefined) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Worktree '${thread.worktreePath}' is still used by thread '${sharedThread.id}'.`,
          });
        }
        const repositoryKey = command.repositoryKey;
        const blocker = findWorktreeCleanupBlocker(
          readModel,
          repositoryKey ?? project.workspaceRoot,
          thread.id,
        );
        worktreeCleanup =
          blocker === undefined
            ? {
                status: "deleting",
                repositoryRoot: project.workspaceRoot,
                ...(repositoryKey === undefined ? {} : { repositoryKey }),
                worktreePath: thread.worktreePath,
                startedAt: occurredAt,
              }
            : {
                status: "queued",
                repositoryRoot: project.workspaceRoot,
                ...(repositoryKey === undefined ? {} : { repositoryKey }),
                worktreePath: thread.worktreePath,
                queuedAt: occurredAt,
                blockedByThreadId: blocker.id,
              };
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.deleted",
        payload: {
          threadId: command.threadId,
          deletedAt: occurredAt,
          ...(worktreeCleanup === null ? {} : { worktreeCleanup }),
        },
      };
    }

    case "thread.worktree-cleanup.retry": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      const cleanup = thread.worktreeCleanup;
      if (thread.deletedAt === null || cleanup == null || cleanup.status !== "failed") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${thread.id}' does not have a failed worktree cleanup to retry.`,
        });
      }
      const occurredAt = yield* nowIso;
      const repositoryKey = cleanup.repositoryKey;
      const blocker = findWorktreeCleanupBlocker(
        readModel,
        repositoryKey ?? cleanup.repositoryRoot,
        thread.id,
      );
      const nextCleanup =
        blocker === undefined
          ? {
              status: "deleting" as const,
              repositoryRoot: cleanup.repositoryRoot,
              ...(repositoryKey === undefined ? {} : { repositoryKey }),
              worktreePath: cleanup.worktreePath,
              startedAt: occurredAt,
            }
          : {
              status: "queued" as const,
              repositoryRoot: cleanup.repositoryRoot,
              ...(repositoryKey === undefined ? {} : { repositoryKey }),
              worktreePath: cleanup.worktreePath,
              queuedAt: occurredAt,
              blockedByThreadId: blocker.id,
            };
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: thread.id,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.worktree-cleanup-updated",
        payload: { threadId: thread.id, cleanup: nextCleanup, updatedAt: occurredAt },
      };
    }

    case "thread.worktree-cleanup.abandon": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      if (
        thread.deletedAt === null ||
        thread.worktreeCleanup == null ||
        thread.worktreeCleanup.status !== "failed"
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${thread.id}' does not have failed worktree cleanup to abandon.`,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: thread.id,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.worktree-cleanup-updated",
        payload: { threadId: thread.id, cleanup: null, updatedAt: occurredAt },
      };
    }

    case "thread.worktree-cleanup.update": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      const current = thread.worktreeCleanup;
      if (thread.deletedAt === null || current == null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${thread.id}' no longer has active worktree cleanup.`,
        });
      }
      if (
        command.cleanup !== null &&
        (command.cleanup.repositoryRoot !== current.repositoryRoot ||
          command.cleanup.worktreePath !== current.worktreePath)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${thread.id}' cleanup paths cannot change during processing.`,
        });
      }
      const validTransition =
        (current.status === "queued" &&
          (command.cleanup?.status === "deleting" || command.cleanup?.status === "failed")) ||
        (current.status === "deleting" &&
          (command.cleanup === null ||
            command.cleanup.status === "deleting" ||
            command.cleanup.status === "failed"));
      if (!validTransition) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Invalid worktree cleanup transition from '${current.status}' to '${command.cleanup?.status ?? "complete"}'.`,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: thread.id,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.worktree-cleanup-updated",
        payload: { threadId: thread.id, cleanup: command.cleanup, updatedAt: occurredAt },
      };
    }

    case "thread.archive": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (thread.persistent) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Persistent thread '${thread.id}' cannot be archived until persistence is disabled or moved to another thread.`,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.archived",
        payload: {
          threadId: command.threadId,
          archivedAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.unarchive": {
      yield* requireThreadArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unarchived",
        payload: {
          threadId: command.threadId,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.persistence.set": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      if (thread.archivedAt !== null || thread.deletedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Only an active thread can be marked persistent.`,
        });
      }
      const current = readModel.threads.find(
        (candidate) => candidate.deletedAt === null && candidate.persistent,
      );
      if (!command.persistent && current?.id !== thread.id) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${thread.id}' is not the persistent thread.`,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.persistence-changed",
        payload: {
          threadId: command.threadId,
          persistentThreadId: command.persistent ? command.threadId : null,
          replacedThreadId: current?.id ?? null,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.settle":
    case "thread.auto-settle": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (command.type === "thread.auto-settle" && thread.settledOverride !== null) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} changed before automatic settlement`,
          }),
        );
      }
      if (command.type === "thread.auto-settle" && thread.attention != null) {
        return yield* new OrchestrationThreadSettleBlockedError({ threadId: command.threadId });
      }
      // The server owns settle eligibility. A stale command must not settle
      // a thread whose session is coming alive or working.
      if (thread.session?.status === "starting" || thread.session?.status === "running") {
        return yield* new OrchestrationThreadSettleBlockedError({ threadId: command.threadId });
      }
      const pendingRequests = openRequests(thread);
      // Manual settlement dismisses async questions without answering them.
      // Native callbacks and approvals still need a response or interruption.
      if (
        Array.from(pendingRequests.values()).some(
          (activity) =>
            command.type === "thread.auto-settle" ||
            activity.kind !== "user-input.requested" ||
            !Predicate.isObject(activity.payload) ||
            activity.payload.responseMode !== "message",
        )
      ) {
        return yield* new OrchestrationThreadSettleBlockedError({ threadId: command.threadId });
      }
      const occurredAt = yield* nowIso;
      // Settling inside the adoption window would hide just-requested work.
      if (hasQueuedTurnStartForThread(thread, occurredAt)) {
        return yield* new OrchestrationThreadSettleBlockedError({
          threadId: command.threadId,
        });
      }
      // Settling an already-settled thread re-emits with the original
      // settledAt: the engine rejects zero-event commands, and bulk-settle /
      // double-click must stay silent no-ops rather than surface errors.
      const alreadySettled = thread.settledOverride === "settled" && thread.settledAt !== null;
      const settledEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.settled" as const,
        payload: {
          threadId: command.threadId,
          settledAt: alreadySettled
            ? thread.settledAt
            : command.type === "thread.auto-settle"
              ? command.settledAt
              : occurredAt,
          // A re-emission is a projected no-op: keep the existing updatedAt
          // so duplicate settles neither rewind nor churn ordering. A fresh
          // settle stamps the command time.
          updatedAt: alreadySettled ? thread.updatedAt : occurredAt,
        },
      };
      // Settling is "I'm done with this": clear states that would keep the
      // row pinned or snoozed instead of showing the new settled state.
      const companionEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
      for (const [requestId, request] of pendingRequests) {
        companionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.activity-appended",
          payload: {
            threadId: command.threadId,
            activity: {
              id: EventId.make(`settle:${command.commandId}:${requestId}`),
              kind: "user-input.resolved",
              summary: "User input dismissed",
              tone: "info",
              turnId: request.turnId,
              createdAt: occurredAt,
              payload: { requestId, responseMode: "message" },
            },
          },
        });
      }
      if (thread.pinnedAt != null) {
        companionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unpinned" as const,
          payload: {
            threadId: command.threadId,
            updatedAt: occurredAt,
          },
        });
      }
      if (thread.snoozedUntil != null) {
        companionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "user",
            updatedAt: occurredAt,
          },
        });
      }
      if (thread.attention != null) {
        companionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.attention-cleared",
          payload: {
            threadId: command.threadId,
            updatedAt: occurredAt,
          },
        });
      }
      return companionEvents.length > 0 ? [settledEvent, ...companionEvents] : settledEvent;
    }

    case "thread.unsettle": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent by re-emission (see thread.settle): reducing the event a
      // second time lands on the same override state. A re-emission keeps
      // the existing updatedAt so duplicates do not churn ordering.
      const alreadyPinnedActive = thread.settledOverride === "active";
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unsettled",
        payload: {
          threadId: command.threadId,
          reason: command.reason,
          updatedAt: alreadyPinnedActive ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.snooze": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      // A wake time in the past would create a thread that is snoozed and
      // woken at once — the row would never leave the inbox but still carry
      // snooze state. Reject instead of silently normalizing. The negated
      // comparison also catches unparseable wake times (IsoDateTime is
      // structurally just a string): NaN fails every comparison, and an
      // unparseable snoozedUntil must never persist.
      if (!(Date.parse(command.snoozedUntil) > Date.parse(occurredAt))) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} snooze wake time ${command.snoozedUntil} is not in the future`,
          }),
        );
      }
      // Blocked-on-you work must not be snoozed away: a pending approval or
      // user-input request is the agent waiting on the user, and hiding it
      // defeats the request. (A running session IS snoozable — snooze only
      // affects visibility, never the agent.)
      if (openRequests(thread).size > 0 || thread.attention != null) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} needs user attention and cannot be snoozed`,
          }),
        );
      }
      // A queued turn start — a user message no turn has adopted yet — is
      // invisible pending work: no session, no pending flags. Snoozing in
      // that window would hide a just-requested turn exactly the way settle
      // would.
      if (hasQueuedTurnStartForThread(thread, occurredAt)) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has a queued turn start and cannot be snoozed`,
          }),
        );
      }
      // Re-snoozing an already-snoozed thread to the SAME wake time is a
      // duplicate (double-click, raced clients): re-emit with the original
      // timestamps so the projection is a no-op. A different wake time is a
      // real change and stamps fresh.
      const existingSnoozedAt =
        thread.snoozedUntil === command.snoozedUntil && thread.snoozedAt != null
          ? thread.snoozedAt
          : null;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.snoozed",
        payload: {
          threadId: command.threadId,
          snoozedUntil: command.snoozedUntil,
          snoozedAt: existingSnoozedAt ?? occurredAt,
          updatedAt: existingSnoozedAt !== null ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.unsnooze": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent by re-emission (see thread.settle): waking a thread that
      // is not snoozed lands on the same null state without churning
      // updatedAt.
      const alreadyAwake = thread.snoozedUntil == null;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unsnoozed",
        payload: {
          threadId: command.threadId,
          reason: command.reason,
          updatedAt: alreadyAwake ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.pin": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      // Re-pinning an already-pinned thread is a duplicate (double-click,
      // raced clients): re-emit with the original timestamps so the
      // projection is a no-op. Pinning has no lifecycle invariants — a pin
      // only ever promotes visibility, so it can never hide pending work.
      const existingPinnedAt = thread.pinnedAt ?? null;
      const pinnedEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.pinned" as const,
        payload: {
          threadId: command.threadId,
          pinnedAt: existingPinnedAt ?? occurredAt,
          // A fresh pin takes the client's slot in the arranged order; on a
          // re-pin the existing key wins so raced duplicates cannot move a
          // thread the user already placed.
          ...(existingPinnedAt === null && command.orderKey !== undefined
            ? { pinOrderKey: command.orderKey }
            : {}),
          updatedAt: existingPinnedAt !== null ? thread.updatedAt : occurredAt,
        },
      };
      // Pinning is a promotion: it clears the parked states rather than
      // silently outranking them. An explicit settle un-settles (reason
      // "user", same override the un-settle button stamps), and a snooze's
      // return ticket is spent — the thread is on top NOW, not on Tuesday.
      const promotionEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
      if (thread.settledOverride === "settled") {
        promotionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unsettled",
          payload: {
            threadId: command.threadId,
            reason: "user",
            updatedAt: occurredAt,
          },
        });
      }
      if (thread.snoozedUntil != null) {
        promotionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "user",
            updatedAt: occurredAt,
          },
        });
      }
      return promotionEvents.length > 0 ? [pinnedEvent, ...promotionEvents] : pinnedEvent;
    }

    case "thread.unpin": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent by re-emission (see thread.settle): unpinning a thread
      // that is not pinned lands on the same null state without churning
      // updatedAt.
      const alreadyUnpinned = thread.pinnedAt == null;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unpinned",
        payload: {
          threadId: command.threadId,
          updatedAt: alreadyUnpinned ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.pin.reorder": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Only pinned threads have a slot in the arranged order. Rejecting
      // (rather than silently pinning) keeps a raced reorder-after-unpin
      // from resurrecting a pin the user just cleared.
      if (thread.pinnedAt == null) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} is not pinned and cannot be reordered`,
          }),
        );
      }
      // Idempotent by re-emission (see thread.settle): a duplicate drop on
      // the same slot keeps the existing updatedAt so it projects as a no-op.
      const keyUnchanged = thread.pinOrderKey === command.orderKey;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.pin-reordered",
        payload: {
          threadId: command.threadId,
          orderKey: command.orderKey,
          updatedAt: keyUnchanged ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.active.reorder": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      // Snooze retains this slot. Changing it cannot wake the thread, and
      // accepting it handles races with snooze and retained wake timestamps.
      if (
        thread.deletedAt !== null ||
        thread.pinnedAt != null ||
        thread.settledOverride === "settled"
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${command.threadId} is not active and cannot be reordered`,
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          activeOrderKey: command.orderKey,
          // Arranging the list is not thread activity or a lifecycle transition.
          updatedAt: thread.updatedAt,
        },
      };
    }

    case "thread.annotation.upsert": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const anchorMessageId = nextAnnotationAnchorMessageId(thread);
      if (anchorMessageId === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${command.threadId} has no user message to anchor an annotation`,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.annotation-upserted",
        payload: {
          threadId: command.threadId,
          annotation: {
            body: command.body,
            anchorMessageId,
            createdAt: thread.annotation?.createdAt ?? occurredAt,
            updatedAt: occurredAt,
            resolvedAt: thread.annotation?.resolvedAt ?? null,
          },
        },
      };
    }

    case "thread.annotation.resolve": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (thread.annotation == null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${command.threadId} has no annotation to resolve`,
        });
      }
      const anchorMessageId = nextAnnotationAnchorMessageId(thread);
      if (anchorMessageId === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${command.threadId} has no user message to anchor an annotation`,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.annotation-resolved",
        payload: {
          threadId: command.threadId,
          annotation: {
            ...thread.annotation,
            anchorMessageId,
            updatedAt: occurredAt,
            resolvedAt: occurredAt,
          },
        },
      };
    }

    case "thread.annotation.reopen": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (thread.annotation == null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${command.threadId} has no annotation to reopen`,
        });
      }
      const anchorMessageId = nextAnnotationAnchorMessageId(thread);
      if (anchorMessageId === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${command.threadId} has no user message to anchor an annotation`,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.annotation-reopened",
        payload: {
          threadId: command.threadId,
          annotation: {
            ...thread.annotation,
            anchorMessageId,
            updatedAt: occurredAt,
            resolvedAt: null,
          },
        },
      };
    }

    case "thread.meta.update": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const branch =
        command.branch !== undefined &&
        command.expectedBranch !== undefined &&
        thread.branch !== command.expectedBranch
          ? thread.branch
          : command.branch;
      if (command.worktreePath != null) {
        const cleanupOwner = findWorktreeCleanupOwner(
          readModel,
          command.worktreePath,
          command.threadId,
        );
        if (cleanupOwner !== undefined) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Worktree '${command.worktreePath}' is still being cleaned up by thread '${cleanupOwner.id}'.`,
          });
        }
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.regenerateTitle === true
            ? {
                regenerateTitle: true as const,
                previousTitle: thread.title,
                titleRegeneration: {
                  requestId: command.commandId,
                  startedAt: occurredAt,
                },
              }
            : {}),
          ...(command.title !== undefined && thread.titleRegeneration != null
            ? { titleRegeneration: null }
            : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(branch !== undefined ? { branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
          ...(command.linkedPullRequest !== undefined
            ? { linkedPullRequest: command.linkedPullRequest }
            : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.pull-request.sync": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (thread.deletedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${command.threadId} was deleted before pull request discovery`,
        });
      }
      if (
        thread.projectId !== command.projectId ||
        thread.branch !== command.expected.branch ||
        thread.worktreePath !== command.expected.worktreePath ||
        !threadPullRequestLinksEqual(
          thread.linkedPullRequest ?? null,
          command.expected.linkedPullRequest,
        ) ||
        !threadPullRequestLinksEqual(
          thread.branchPullRequest ?? null,
          command.expected.branchPullRequest,
        )
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `thread ${command.threadId} changed before pull request discovery`,
        });
      }
      const project = yield* requireProject({ readModel, command, projectId: command.projectId });
      if (project.deletedAt !== null || project.workspaceRoot !== command.expected.workspaceRoot) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `project ${command.projectId} changed before pull request discovery`,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          branchPullRequest: command.branchPullRequest,
          ...(command.linkedPullRequest !== undefined
            ? { linkedPullRequest: command.linkedPullRequest }
            : {}),
          updatedAt: thread.updatedAt,
        },
      };
    }

    case "thread.title.regeneration.complete": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestIsCurrent = thread.titleRegeneration?.requestId === command.requestId;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(requestIsCurrent && command.title !== undefined ? { title: command.title } : {}),
          ...(requestIsCurrent ? { titleRegeneration: null } : {}),
          updatedAt: requestIsCurrent ? occurredAt : thread.updatedAt,
        },
      };
    }

    case "thread.runtime-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.runtime-mode-set",
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.interaction-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.interaction-mode-set",
        payload: {
          threadId: command.threadId,
          interactionMode: command.interactionMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.turn.start": {
      if (isImportedAgentSessionMessageId(command.message.messageId)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Message id '${command.message.messageId}' uses the reserved imported-session namespace.`,
        });
      }
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (command.sourceThreadId === command.threadId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "A cross-thread message source must differ from its target thread.",
        });
      }
      if (command.sourceThreadId !== undefined) {
        yield* requireThread({
          readModel,
          command,
          threadId: command.sourceThreadId,
        });
      }
      const sourceProposedPlan = command.sourceProposedPlan;
      const sourceThread = sourceProposedPlan
        ? yield* requireThread({
            readModel,
            command,
            threadId: sourceProposedPlan.threadId,
          })
        : null;
      const sourcePlan =
        sourceProposedPlan && sourceThread
          ? sourceThread.proposedPlans.find((entry) => entry.id === sourceProposedPlan.planId)
          : null;
      if (sourceProposedPlan && !sourcePlan) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan.planId}' does not exist on thread '${sourceProposedPlan.threadId}'.`,
        });
      }
      if (sourceThread && sourceThread.projectId !== targetThread.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan?.planId}' belongs to thread '${sourceThread.id}' in a different project.`,
        });
      }
      const turnMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: command.message.role,
          text: command.message.text,
          attachments: command.message.attachments,
          ...(command.sourceThreadId !== undefined
            ? { sourceThreadId: command.sourceThreadId }
            : {}),
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const turnStartRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: turnMessageEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.titleSeed !== undefined ? { titleSeed: command.titleSeed } : {}),
          runtimeMode: targetThread.runtimeMode,
          interactionMode: targetThread.interactionMode,
          ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
          ...(command.trackRequestCorrelation === true ? { trackRequestCorrelation: true } : {}),
          createdAt: command.createdAt,
        },
      };
      // Real activity resets ANY override: it wakes an explicitly settled
      // thread, and it clears a keep-active pin back to neutral so the
      // thread can auto-settle again after this burst of work goes stale.
      // A snooze clears the same way — sending a message to a snoozed
      // thread is the user re-engaging, so the return ticket is spent.
      const lifecycleResetEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
      if (targetThread.settledOverride !== null) {
        lifecycleResetEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.unsettled",
          payload: {
            threadId: command.threadId,
            reason: "activity",
            updatedAt: command.createdAt,
          },
        });
      }
      if (targetThread.snoozedUntil != null) {
        lifecycleResetEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "activity",
            updatedAt: command.createdAt,
          },
        });
      }
      const attentionClearedEvent: Omit<OrchestrationEvent, "sequence"> | null =
        targetThread.attention == null
          ? null
          : {
              ...(yield* withEventBase({
                aggregateKind: "thread",
                aggregateId: command.threadId,
                occurredAt: command.createdAt,
                commandId: command.commandId,
              })),
              type: "thread.attention-cleared",
              payload: {
                threadId: command.threadId,
                updatedAt: command.createdAt,
              },
            };
      return [
        ...lifecycleResetEvents,
        turnMessageEvent,
        ...(attentionClearedEvent === null ? [] : [attentionClearedEvent]),
        turnStartRequestedEvent,
      ];
    }

    case "thread.turn.interrupt": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const interruptRequestedEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: command.threadId,
          ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
          createdAt: command.createdAt,
        },
      } as const;
      if (thread.attention == null) {
        return interruptRequestedEvent;
      }
      return [
        interruptRequestedEvent,
        {
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.attention-cleared",
          payload: {
            threadId: command.threadId,
            updatedAt: command.createdAt,
          },
        },
      ];
    }

    case "thread.approval.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        })),
        type: "thread.approval-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          decision: command.decision,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.user-input.respond": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const request = userInputActivity;
      const attachments = Object.values(command.attachmentsByQuestionId ?? {}).flat();
      let questionTextById: Record<string, string> = {};
      if (attachments.length > 0) {
        const payload =
          request?.kind === "user-input.requested"
            ? decodeUserInputRequestedPayload(request.payload)
            : Option.none();
        if (Option.isNone(payload)) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail:
              request?.kind === "user-input.resolved"
                ? "This question has already been answered."
                : "This question is no longer pending.",
          });
        }
        questionTextById = Object.fromEntries(
          payload.value.questions.map((question) => [question.id, question.question]),
        );
        for (const questionId of Object.keys(command.attachmentsByQuestionId ?? {})) {
          const question = payload.value.questions.find((question) => question.id === questionId);
          if (!question || question.allowCustomAnswer === false) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "This question does not accept file references.",
            });
          }
        }
      }
      if (
        request &&
        Predicate.isObject(request.payload) &&
        request.payload.responseMode === "message"
      ) {
        const payload = decodeUserInputRequestedPayload(request.payload);
        if (request.kind !== "user-input.requested" || Option.isNone(payload)) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "This question has already been answered.",
          });
        }
        const replies: string[] = [];
        for (const question of payload.value.questions) {
          const answer = command.answers[question.id];
          if (
            typeof answer !== "string" ||
            (answer.trim().length === 0 && !command.attachmentsByQuestionId?.[question.id]?.length)
          ) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "Answer each question before sending.",
            });
          }
          const questionAttachments = command.attachmentsByQuestionId?.[question.id] ?? [];
          const attachmentLabels = questionAttachments
            .map((attachment) => `Attached file: ${attachment.name} (${attachment.id})`)
            .join("\n");
          replies.push(
            [`${question.question}\n${answer.trim()}`, attachmentLabels].filter(Boolean).join("\n"),
          );
        }
        // Commit the answer and its message together. The normal turn path
        // steers a running agent or resumes an idle session.
        return yield* decideCommandSequence({
          readModel,
          commands: [
            {
              type: "thread.activity.append",
              commandId: command.commandId,
              threadId: command.threadId,
              createdAt: command.createdAt,
              activity: {
                id: EventId.make(`async-answer:${command.requestId}`),
                kind: "user-input.resolved",
                summary: "User input submitted",
                tone: "info",
                turnId: request.turnId,
                createdAt: command.createdAt,
                payload: {
                  requestId: command.requestId,
                  responseMode: "message",
                  answers: command.answers,
                  ...(command.attachmentsByQuestionId
                    ? { attachmentsByQuestionId: command.attachmentsByQuestionId }
                    : {}),
                },
              },
            },
            {
              type: "thread.turn.start",
              commandId: command.commandId,
              threadId: command.threadId,
              createdAt: command.createdAt,
              runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode,
              message: {
                messageId: MessageId.make(`async-answer:${command.requestId}`),
                role: "user",
                text: replies.join("\n\n"),
                attachments,
              },
            },
          ],
        });
      }
      const responseEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: { requestId: command.requestId },
        })),
        type: "thread.user-input-response-requested" as const,
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          answers: command.answers,
          ...(command.attachmentsByQuestionId
            ? { attachmentsByQuestionId: command.attachmentsByQuestionId }
            : {}),
          createdAt: command.createdAt,
        },
      };
      if (attachments.length === 0) return responseEvent;
      const historyEvent = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.activity.append",
          commandId: command.commandId,
          threadId: command.threadId,
          createdAt: command.createdAt,
          activity: {
            id: EventId.make(`question-answer:${command.commandId}`),
            kind: "user-input.answer-submitted",
            summary: "Question answer submitted",
            tone: "info",
            turnId: request?.turnId ?? null,
            createdAt: command.createdAt,
            payload: {
              requestId: command.requestId,
              answers: command.answers,
              questionTextById,
              attachmentsByQuestionId: command.attachmentsByQuestionId,
              detail: attachments.map((attachment) => attachment.name).join("\n"),
            },
          },
        },
      });
      return [...(Array.isArray(historyEvent) ? historyEvent : [historyEvent]), responseEvent];
    }

    case "thread.user-input.dismiss": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const request = userInputActivity;
      if (request === undefined || request.kind !== "user-input.requested") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "This question has already been answered.",
        });
      }
      // Only async questions can be dropped silently. A native callback
      // question leaves the provider blocked until it gets a reply, so it
      // still needs an answer or an interrupted turn.
      if (!Predicate.isObject(request.payload) || request.payload.responseMode !== "message") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "This question needs an answer. Answer it or stop the turn.",
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: {
            id: EventId.make(`async-dismiss:${command.requestId}`),
            kind: "user-input.resolved",
            summary: "User input dismissed",
            tone: "info",
            turnId: request.turnId,
            createdAt: command.createdAt,
            payload: { requestId: command.requestId, responseMode: "message" },
          },
        },
      };
    }

    case "thread.checkpoint.revert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.checkpoint-revert-requested",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.stop": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Settle-cleanup stops are conditional: between the settle landing and
      // this command, another client may have re-engaged the thread (a turn
      // start unsettles it and brings the session alive). Commands are
      // decided serially against this read model, so checking here — not in
      // the dispatcher's pre-settle snapshot — closes that race.
      if (command.onlyIfSettled === true) {
        const sessionComingAlive =
          thread.session?.status === "starting" || thread.session?.status === "running";
        if (
          thread.settledOverride !== "settled" ||
          sessionComingAlive ||
          hasQueuedTurnStartForThread(thread, command.createdAt)
        ) {
          return yield* Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `thread ${command.threadId} was re-engaged after settle; skipping session stop`,
            }),
          );
        }
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.session-stop-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.turn-request.resolve": {
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-request-resolved",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          outcome: command.outcome,
        },
      };
    }

    case "thread.turn-assistant.finalize": {
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-assistant-finalized",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          finalizedAt: command.createdAt,
        },
      };
    }

    case "thread.session.set": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const previousSession = thread.session;
      const sameProvider = previousSession?.providerName === command.session.providerName;
      const sameBinding =
        sameProvider &&
        (command.session.providerInstanceId === undefined ||
          command.session.providerInstanceId === previousSession?.providerInstanceId);
      const providerThreadIdWasSupplied = Object.hasOwn(command.session, "providerThreadId");
      const session = {
        ...command.session,
        ...(sameProvider &&
        command.session.providerInstanceId === undefined &&
        previousSession?.providerInstanceId !== undefined
          ? { providerInstanceId: previousSession.providerInstanceId }
          : {}),
        providerThreadId: providerThreadIdWasSupplied
          ? (command.session.providerThreadId ?? null)
          : sameBinding
            ? (previousSession?.providerThreadId ?? null)
            : null,
      };
      const sessionSetEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        })),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session,
        },
      };
      const terminalAttentionClearEvent: Omit<OrchestrationEvent, "sequence"> | null =
        thread.attention != null &&
        (command.session.status === "error" || command.session.status === "interrupted")
          ? {
              ...(yield* withEventBase({
                aggregateKind: "thread",
                aggregateId: command.threadId,
                occurredAt: command.createdAt,
                commandId: command.commandId,
              })),
              type: "thread.attention-cleared",
              payload: {
                threadId: command.threadId,
                updatedAt: command.createdAt,
              },
            }
          : null;
      // Only a session coming alive is activity worth waking a settled thread
      // for — status writes like ready/stopped/error arrive after the fact and
      // must not fight a user's explicit settle. Snooze is deliberately NOT
      // cleared here: snooze never pauses the agent, so its session starting
      // or erroring is not the user re-engaging. Blocked/failed work still
      // surfaces immediately — effectiveSnoozed refuses to classify a thread
      // with a raised hand (approval / input / failure / fresh completion)
      // as snoozed, without spending the return ticket.
      const isSessionActivity =
        command.session.status === "starting" || command.session.status === "running";
      // Real activity resets ANY override (settled wakes, active unpins).
      if (thread.settledOverride === null || !isSessionActivity) {
        return terminalAttentionClearEvent === null
          ? sessionSetEvent
          : [sessionSetEvent, terminalAttentionClearEvent];
      }
      const unsettledEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.unsettled",
        payload: {
          threadId: command.threadId,
          reason: "activity",
          updatedAt: command.createdAt,
        },
      };
      return [unsettledEvent, sessionSetEvent];
    }

    case "thread.message.assistant.delta": {
      if (isImportedAgentSessionMessageId(command.messageId)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Message id '${command.messageId}' uses the reserved imported-session namespace.`,
        });
      }
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: command.delta,
          turnId: command.turnId ?? null,
          streaming: true,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.complete": {
      if (isImportedAgentSessionMessageId(command.messageId)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Message id '${command.messageId}' uses the reserved imported-session namespace.`,
        });
      }
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: "",
          turnId: command.turnId ?? null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.history.import": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (
        thread.deletedAt !== null ||
        thread.archivedAt !== null ||
        thread.messages.length > 0 ||
        thread.latestTurn !== null ||
        thread.session !== null ||
        openRequests(thread).size > 0
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' must be active and empty before history can be imported.`,
        });
      }
      const firstMessage = command.messages[0];
      if (firstMessage === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Thread history imports require at least one message.",
        });
      }

      const events: Array<PlannedOrchestrationEvent> = [];
      for (const message of command.messages) {
        events.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: message.createdAt,
            commandId: command.commandId,
            metadata: { historyImport: true },
          })),
          type: "thread.message-sent",
          payload: {
            threadId: command.threadId,
            messageId: message.messageId,
            role: message.role,
            text: message.text,
            turnId: null,
            streaming: false,
            createdAt: message.createdAt,
            updatedAt: message.createdAt,
          },
        });
      }
      const settledAt = command.messages.reduce(
        (latest, message) =>
          compareDateTimeStrings(message.createdAt, latest) > 0 ? message.createdAt : latest,
        firstMessage.createdAt,
      );
      events.push({
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: settledAt,
          commandId: command.commandId,
          metadata: { historyImport: true },
        })),
        type: "thread.settled",
        payload: {
          threadId: command.threadId,
          settledAt,
          updatedAt: settledAt,
        },
      });
      return events;
    }

    case "thread.proposed-plan.upsert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: command.threadId,
          proposedPlan: command.proposedPlan,
        },
      };
    }

    case "thread.turn.diff.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          checkpointTurnCount: command.checkpointTurnCount,
          checkpointRef: command.checkpointRef,
          status: command.status,
          files: command.files,
          assistantMessageId: command.assistantMessageId ?? null,
          completedAt: command.completedAt,
        },
      };
    }

    case "thread.revert.complete": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const revertedEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.reverted",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
        },
      } as const;
      if (thread.attention == null) {
        return revertedEvent;
      }
      return [
        revertedEvent,
        {
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.attention-cleared",
          payload: {
            threadId: command.threadId,
            updatedAt: command.createdAt,
          },
        },
      ];
    }

    case "thread.activity.append": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestId =
        typeof command.activity.payload === "object" &&
        command.activity.payload !== null &&
        "requestId" in command.activity.payload &&
        typeof (command.activity.payload as { requestId?: unknown }).requestId === "string"
          ? ((command.activity.payload as { requestId: string })
              .requestId as OrchestrationEvent["metadata"]["requestId"])
          : undefined;
      const activityAppendedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(requestId !== undefined ? { metadata: { requestId } } : {}),
        })),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: command.activity,
        },
      };
      // An approval or user-input request is blocked-on-you work — it must
      // never stay hidden inside a settled slim row.
      const wakesSettledThread =
        command.activity.kind === "approval.requested" ||
        command.activity.kind === "user-input.requested";
      // Real activity resets ANY override (settled wakes, active unpins).
      if (thread.settledOverride === null || !wakesSettledThread) {
        return activityAppendedEvent;
      }
      const unsettledEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.unsettled",
        payload: {
          threadId: command.threadId,
          reason: "activity",
          updatedAt: command.createdAt,
        },
      };
      return [unsettledEvent, activityAppendedEvent];
    }

    case "thread.attention.set": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const unchanged = thread.attention?.kind === command.attention.kind;
      const unchangedAndVisible =
        unchanged && thread.settledOverride === null && thread.snoozedUntil == null;
      const attentionSetEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.attention-set",
        payload: {
          threadId: command.threadId,
          attention: unchanged ? thread.attention! : command.attention,
          updatedAt: unchangedAndVisible ? thread.updatedAt : command.createdAt,
        },
      };
      const wakeEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
      if (thread.settledOverride !== null) {
        wakeEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.unsettled",
          payload: {
            threadId: command.threadId,
            reason: "activity",
            updatedAt: command.createdAt,
          },
        });
      }
      if (thread.snoozedUntil != null) {
        wakeEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "activity",
            updatedAt: command.createdAt,
          },
        });
      }
      return [...wakeEvents, attentionSetEvent];
    }

    case "thread.attention.clear": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.attention-cleared",
        payload: {
          threadId: command.threadId,
          updatedAt: thread.attention == null ? thread.updatedAt : command.createdAt,
        },
      };
    }

    default: {
      command satisfies never;
      const fallback = command as never as { type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unknown command type: ${fallback.type}`,
      });
    }
  }
});
