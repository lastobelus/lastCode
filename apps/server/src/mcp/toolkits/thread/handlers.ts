import * as ThreadRecovery from "../../../orchestration-v2/ThreadRecoveryService.ts";
import * as ThreadRecoveryRepair from "../../../orchestration-v2/ThreadRecoveryRepairService.ts";
import {
  CommandId,
  type RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type RunId,
  OrchestratorMcpFailure,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Struct from "effect/Struct";
import { modelSelectionCommandType } from "@t3tools/shared/model";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  assertFullAccess,
  dispatchFailure,
  newCommandId,
  readCaller,
  readThread,
  unavailable,
  resolveProjectId,
} from "../../threadAccess.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTasks from "../../../scheduledTasks/ScheduledTaskService.ts";
import { queuedRunsInDeliveryOrder } from "../../../orchestration-v2/QueuedRunOrder.ts";
import { ThreadToolkit } from "./tools.ts";

function queueEntry(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  runId: RunId,
  limit: number,
) {
  const run = projection.runs.find((run) => run.id === runId && run.status === "queued");
  const message = projection.messages.find((message) => message.id === run?.userMessageId);
  if (run === undefined || message === undefined) return undefined;
  const characters = Array.from(message.text);
  return {
    queuedRunId: run.id,
    text: characters.slice(0, limit).join(""),
    truncated: characters.length > limit,
  };
}
const dispatch = Effect.fn("mcp.dispatchThreadCommand")(function* (
  threadId: ThreadId | undefined,
  command: (common: { commandId: CommandId; threadId: ThreadId }) => OrchestrationV2Command,
) {
  const { threads, projection } = yield* readThread(threadId);
  const result = yield* threads
    .dispatch(command({ commandId: yield* newCommandId(), threadId: projection.thread.id }))
    .pipe(Effect.mapError(dispatchFailure));
  return { sequence: result.sequence };
});

const readQuestion = Effect.fn("mcp.readQuestion")(function* (input: {
  threadId?: ThreadId | undefined;
  requestId: RuntimeRequestId;
}) {
  const context = yield* readThread(input.threadId, ["runtimeRequests", "turnItems"]);
  const request = context.projection.runtimeRequests.find(
    (request) => request.id === input.requestId && request.kind === "user_input",
  );
  const item = context.projection.turnItems.find(
    (item) => item.type === "user_input_request" && item.requestId === input.requestId,
  );
  if (request === undefined || item?.type !== "user_input_request")
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "The pending user-input request was not found.",
    });
  if (request.status !== "pending")
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        request.status === "resolved"
          ? "The user-input request was already answered."
          : `The user-input request is no longer pending (${request.status}).`,
    });
  return { ...context, request, item };
});
/** A field the chosen action needs. `null` counts as given, as in `beforeRunId: null`. */
const required = <A>(value: A | undefined, name: string) =>
  value === undefined
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `This action needs \`${name}\`.`,
        }),
      )
    : Effect.succeed(value);

/** Failed participants inspect, retry, and dismiss the original archive owner's attempt. */
const readArchiveThread = Effect.fn("mcp.readArchiveThread")(function* (threadId?: ThreadId) {
  const context = yield* readThread(threadId);
  const thread = context.projection.thread;
  const failedArchive =
    thread.archivePending?.status === "failed" ? thread.archivePending : undefined;
  const ownerContext =
    failedArchive !== undefined && failedArchive.threadId !== thread.id
      ? yield* readThread(failedArchive.threadId)
      : context;
  return { ...ownerContext, observedArchiveCommandId: failedArchive?.commandId };
});
/** A tool that changes `threadId`, or the caller's own thread when it is omitted. */
const writesThread = <P extends { readonly threadId?: ThreadId | undefined }, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
) => McpToolAccess.writesThreads((params: P) => [params.threadId], handle);

export const layer = McpToolAccess.toLayer(ThreadToolkit, {
  t3_thread_group: McpToolAccess.writesThreads(
    (input) =>
      input.items.flatMap((item) => [
        item.threadId,
        ...(item.groupedUnderThreadId === null ? [] : [item.groupedUnderThreadId]),
      ]),
    (input) =>
      Effect.gen(function* () {
        const caller = yield* readCaller();
        const projectId = yield* resolveProjectId(caller, input.projectId);
        const namespace = caller.scope.requestNamespace;
        const items = input.items.map((item) => ({
          ...item,
          commandId: CommandId.make(
            `mcp:group:${encodeURIComponent(namespace)}:${encodeURIComponent(input.clientRequestId)}:${encodeURIComponent(item.threadId)}`,
          ),
        }));
        return {
          items: yield* caller.threads.setThreadParents({ projectId, items }),
          atomic: false as const,
        };
      }),
  ),
  t3_thread_recover: writesThread((input) =>
    Effect.gen(function* () {
      yield* readThread(input.threadId);
      const service = yield* ThreadRecovery.ThreadRecoveryService;
      yield* service
        .recover(input)
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorMcpFailure({ code: "orchestration_error", message: cause.message }),
          ),
        );
      return { ok: true as const };
    }),
  ),
  t3_thread_repair: writesThread((input) =>
    Effect.gen(function* () {
      yield* readCaller().pipe(
        Effect.tap((caller) =>
          assertFullAccess(
            caller,
            "Starting a repair agent requires a live full-access/default thread or a full-access client.",
          ),
        ),
      );
      yield* readThread(input.threadId);
      const service = yield* ThreadRecoveryRepair.ThreadRecoveryRepairService;
      return yield* service
        .launch(input)
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorMcpFailure({ code: "orchestration_error", message: cause.message }),
          ),
        );
    }),
  ),
  run_scheduled_task_now: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scheduler = yield* ScheduledTasks.ScheduledTaskService;
      const { tasks } = yield* scheduler.list().pipe(Effect.mapError(unavailable));
      if (!tasks.some((task) => task.id === input.taskId))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The scheduled task was not found.",
        });
      const { task, threadId } = yield* scheduler
        .runNow({ id: input.taskId })
        .pipe(Effect.mapError(unavailable));
      const scope = yield* McpInvocationContext.McpInvocationContext;
      return {
        taskId: task.id,
        threadId,
        ...(threadId === null
          ? {}
          : {
              link: McpInvocationContext.threadLinkFor(scope, threadId),
            }),
        lastRunStatus: task.lastRunStatus,
        runCount: task.runCount,
        nextRunAt: task.nextRunAt,
      };
    }),
  ),
  t3_thread_search: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { caller } = yield* readCaller();
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const threadSearch = yield* ThreadSearch.ThreadSearch;
      const { matches } = yield* threadSearch
        .searchThreads({ ...input, projectId: input.projectId ?? caller?.projectId })
        .pipe(Effect.mapError(unavailable));
      return {
        matches: matches.map((match) => ({
          ...match,
          link: McpInvocationContext.threadLinkFor(scope, match.threadId),
        })),
      };
    }),
  ),
  t3_thread_transfer: McpToolAccess.either(
    (input) => input.action === "status",
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const { projection } = yield* readThread(input.threadId, ["contextTransfers"]);
        return {
          transfers: projection.contextTransfers.map(
            ({ id, sourceThreadId, targetThreadId, status }) => ({
              id,
              sourceThreadId,
              targetThreadId,
              status,
            }),
          ),
        };
      }),
    ),
    McpToolAccess.writesThreads(
      (input) => [input.threadId, input.targetThreadId],
      (input) =>
        Effect.gen(function* () {
          const sourcePoint = input.sourcePoint ?? { type: "latest_stable" as const };
          const { threads, projection } = yield* readThread(input.threadId);
          const commandId = yield* newCommandId();
          if (input.action === "merge_back") {
            const targetThreadId = yield* required(input.targetThreadId, "targetThreadId");
            yield* readThread(targetThreadId);
            const result = yield* threads
              .dispatch({
                type: "thread.merge_back",
                commandId,
                sourceThreadId: projection.thread.id,
                targetThreadId,
                sourcePoint,
                createdBy: "agent",
                creationSource: "mcp",
              })
              .pipe(Effect.mapError(dispatchFailure));
            return { sequence: result.sequence, targetThreadId };
          }
          const targetThreadId = ThreadId.make(`${commandId}:fork`);
          const result = yield* threads
            .dispatch({
              type: "thread.fork",
              commandId,
              sourceThreadId: projection.thread.id,
              targetThreadId,
              sourcePoint,
              ...(input.title === undefined ? {} : { title: input.title }),
              createdBy: "agent",
              creationSource: "mcp",
            })
            .pipe(Effect.mapError(dispatchFailure));
          return { sequence: result.sequence, targetThreadId };
        }),
    ),
  ),
  t3_thread_configure: McpToolAccess.either(
    (input) => input.modelSelection === undefined,
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const {
          projection: { thread },
        } = yield* readThread(input.threadId);
        return {
          threadId: thread.id,
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
        };
      }),
    ),
    writesThread((input) =>
      Effect.gen(function* () {
        const modelSelection = yield* required(input.modelSelection, "modelSelection");
        const {
          threads,
          projection: { thread },
        } = yield* readThread(input.threadId);
        const type = modelSelectionCommandType(thread.providerInstanceId, modelSelection);
        const result = yield* threads
          .dispatch({ type, threadId: thread.id, commandId: yield* newCommandId(), modelSelection })
          .pipe(Effect.mapError(dispatchFailure));
        return { sequence: result.sequence };
      }),
    ),
  ),
  t3_pending_request: McpToolAccess.either(
    (input) => input.action !== "respond",
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        if (input.action === "list") {
          const { projection } = yield* readThread(input.threadId, ["runtimeRequests"]);
          return {
            requestIds: projection.runtimeRequests
              .filter((request) => request.kind === "user_input" && request.status === "pending")
              .map((request) => request.id),
          };
        }
        const requestId = yield* required(input.requestId, "requestId");
        const { item } = yield* readQuestion({ threadId: input.threadId, requestId });
        return { requestId, questions: item.questions };
      }),
    ),
    writesThread((input) =>
      Effect.gen(function* () {
        const requestId = yield* required(input.requestId, "requestId");
        const answers = yield* required(input.answers, "answers");
        const { threads, projection } = yield* readQuestion({
          threadId: input.threadId,
          requestId,
        });
        const result = yield* threads
          .dispatch({
            type: "runtime-request.respond",
            threadId: projection.thread.id,
            commandId: yield* newCommandId(),
            requestId,
            answers,
          })
          .pipe(Effect.mapError(dispatchFailure));
        return { sequence: result.sequence };
      }),
    ),
  ),
  t3_subagent_promote: writesThread((input) =>
    dispatch(input.threadId, ({ commandId, threadId }) => ({
      type: "subagent.promote.request",
      commandId,
      threadId,
      targetThreadId: ThreadId.make(`${commandId}:interactive`),
      createdBy: "agent",
      creationSource: "mcp",
    })),
  ),
  t3_subagent_promotion_cancel: writesThread((input) =>
    dispatch(input.threadId, ({ commandId, threadId }) => ({
      type: "subagent.promote.cancel",
      commandId,
      threadId,
      requestId: input.requestId,
    })),
  ),
  t3_subagent_promotion_status: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId);
      return { promotion: projection.thread.subagentPromotion ?? null };
    }),
  ),
  t3_thread_archive_family: writesThread((input) =>
    Effect.gen(function* () {
      const { threads, projection } = yield* readArchiveThread(input.threadId);
      const family = yield* threads
        .getThreadArchiveFamily(projection.thread.id)
        .pipe(Effect.mapError(unavailable));
      return Struct.omit(family, ["threads"]);
    }),
  ),
  t3_queue: McpToolAccess.either(
    (input) => input.action === "list" || input.action === "read",
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const { projection } = yield* readThread(input.threadId, ["runs", "messages"]);
        if (input.action === "list") {
          const runs = queuedRunsInDeliveryOrder(projection);
          const cursor = input.cursor ?? 0;
          const end = cursor + (input.limit ?? 20);
          return {
            items: runs.slice(cursor, end).flatMap((run) => {
              const entry = queueEntry(projection, run.id, 1000);
              return entry === undefined ? [] : [entry];
            }),
            nextCursor: end < runs.length ? end : null,
          };
        }
        const queuedRunId = yield* required(input.queuedRunId, "queuedRunId");
        return (
          queueEntry(projection, queuedRunId, 16000) ??
          (yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "The queued message was not found.",
          }))
        );
      }),
    ),
    writesThread((input) =>
      Effect.gen(function* () {
        const runId = yield* required(input.queuedRunId, "queuedRunId");
        switch (input.action) {
          case "edit": {
            const text = yield* required(input.text, "text");
            return yield* dispatch(input.threadId, (common) => ({
              ...common,
              type: "queued-run.edit",
              runId,
              text,
            }));
          }
          case "reorder": {
            const beforeRunId = yield* required(input.beforeRunId, "beforeRunId");
            return yield* dispatch(input.threadId, (common) => ({
              ...common,
              type: "queued-run.reorder",
              runId,
              beforeRunId,
            }));
          }
          case "promote_to_steer": {
            const targetRunId = yield* required(input.targetRunId, "targetRunId");
            return yield* dispatch(input.threadId, (common) => ({
              ...common,
              type: "queued-message.promote-to-steer",
              queuedRunId: runId,
              targetRunId,
            }));
          }
          default:
            return yield* dispatch(input.threadId, (common) => ({
              ...common,
              type: "queued-run.cancel",
              runId,
            }));
        }
      }),
    ),
  ),
  t3_thread_organize: writesThread((input) =>
    Effect.gen(function* () {
      const { threads, projection, caller, observedArchiveCommandId } = yield* input.action ===
        "archive" ||
      (input.action === "unarchive" && input.expectedArchiveCommandId !== undefined)
        ? readArchiveThread(input.threadId)
        : readThread(input.threadId).pipe(
            Effect.map((context) => ({ ...context, observedArchiveCommandId: undefined })),
          );
      const expectedArchiveCommandId = input.expectedArchiveCommandId ?? observedArchiveCommandId;
      const common = { commandId: yield* newCommandId(), threadId: projection.thread.id };
      if (input.action === "settle") {
        return yield* threads
          .settleThread({ ...common, byOwnAgent: caller?.id === projection.thread.id })
          .pipe(Effect.mapError(dispatchFailure));
      }
      let command: OrchestrationV2Command;
      switch (input.action) {
        case "archive":
          command = {
            ...common,
            type: "thread.archive",
            ...(input.childDisposition === undefined
              ? {}
              : { childDisposition: input.childDisposition }),
            ...(input.expectedChildThreadIds === undefined
              ? {}
              : { expectedChildThreadIds: input.expectedChildThreadIds }),
            ...(expectedArchiveCommandId === undefined ? {} : { expectedArchiveCommandId }),
          };
          break;
        case "unarchive":
          command = {
            ...common,
            type: "thread.unarchive",
            ...(input.expectedArchiveCommandId === undefined
              ? {}
              : { expectedArchiveCommandId: input.expectedArchiveCommandId }),
          };
          break;
        case "snooze":
          if (input.snoozedUntil === undefined) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "snooze requires snoozedUntil.",
            });
          }
          command = { ...common, type: "thread.snooze", snoozedUntil: input.snoozedUntil };
          break;
        case "unsnooze":
        case "unsettle":
          command = { ...common, type: `thread.${input.action}`, reason: "user" };
          break;
        case "mark_unread":
          command = { ...common, type: "thread.mark-unread" };
          break;
        default:
          command = { ...common, type: `thread.${input.action}` };
      }
      const result = yield* threads.dispatch(command).pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence };
    }),
  ),
});
