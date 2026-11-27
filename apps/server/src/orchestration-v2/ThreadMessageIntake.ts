import { remapComposerContextAttachments } from "@t3tools/shared/composerContextReferences";
import { appendUserInputAttachmentPaths } from "../provider/userInputAttachments.ts";
import {
  AuthProvidersManageScope,
  UpdateDrainAdmissionError,
  UpdateDrainError,
  type ChatAttachment,
  type OrchestrationMessageContext,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import { rpcAuthorizationError } from "../auth/RpcAuthorization.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "./Orchestrator.ts";

import * as AttachmentClaims from "./AttachmentClaims.ts";
import { isProviderSignOutPrompt } from "./CommandPolicy.ts";
import {
  ThreadReadAuthorization,
  questionAnswerAuthorizationId,
  queuedEditAuthorizationId,
  referencedThreads,
} from "./ThreadReadAuthorization.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

// These failures precede commitCommand; generic dispatch errors can follow commits and remain ambiguous.
const isAdmissionError = Schema.is(UpdateDrainAdmissionError);
const isDrainError = Schema.is(UpdateDrainError);
function dispatchWasNotAccepted(
  error: Orchestrator.OrchestratorV2Error | ThreadManagement.ThreadManagementError,
) {
  switch (error._tag) {
    case "OrchestratorCommandRejectedError":
    case "OrchestratorThreadAlreadyExistsError":
    case "OrchestratorProjectionError":
    case "OrchestratorProviderAdapterError":
    case "OrchestratorCommandPreviouslyRejectedError":
    case "OrchestratorCommandIdConflictError":
    case "OrchestratorSubagentThreadReadOnlyError":
    case "OrchestratorThreadAboveModeLimitError":
    case "OrchestratorProviderSelectionBusyError":
    case "OrchestratorRuntimeModeAboveCeilingError":
    case "ThreadManagementProviderInstanceDisabledError":
    case "ThreadManagementWorktreeRestoreError":
    case "OrchestratorThreadArchivingError":
      return true;
    case "OrchestratorDispatchError":
      // Admission fails before dispatch starts. Other dispatch errors can occur
      // after a commit and must retain the provider's attachment copies.
      return isAdmissionError(error.cause) || isDrainError(error.cause);
    default:
      return false;
  }
}
const isOrchestratorError = Schema.is(Orchestrator.OrchestratorV2Error);
const isThreadManagementError = Schema.is(ThreadManagement.ThreadManagementError);

function adoptsWorkspace(command: OrchestrationV2Command): boolean {
  switch (command.type) {
    case "message.dispatch":
      return command.createdBy === "user";
    case "thread.metadata.update":
      return (
        command.workspaceUserAdopted === true ||
        command.title !== undefined ||
        command.regenerateTitle === true ||
        command.branch !== undefined ||
        command.worktreePath !== undefined
      );
    case "checkpoint.rollback":
      return command.restoreFiles !== false;
    case "queued-run.edit":
    case "runtime-request.respond":
    case "queue.resume":
    case "thread.annotation.upsert":
    case "thread.persistence.set":
    case "thread.runtime-mode.set":
    case "thread.interaction-mode.set":
    case "thread.model-selection.set":
    case "provider.switch":
    case "thread.fork":
    case "thread.merge_back":
      return true;
    default:
      return false;
  }
}

type DispatchSender = { readonly managesProviders: boolean };

export const dispatchUserCommand = Effect.fn("ThreadMessageIntake.dispatchUserCommand")(function* (
  command: OrchestrationV2Command,
  sender?: DispatchSender,
) {
  return yield* dispatchCommand(
    command,
    sender,
    adoptsWorkspace(command) ? { workspaceUserAdopted: true } : undefined,
  );
});

const releaseUnusedClaims = Effect.fn("ThreadMessageIntake.releaseUnusedClaims")(function* (
  claimedPaths: ReadonlyArray<string>,
  accepted: ReadonlyArray<ChatAttachment>,
) {
  if (claimedPaths.length === 0) return;
  const config = yield* ServerConfig.ServerConfig;
  const retained = new Set(
    accepted.flatMap((attachment) => {
      const path = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment,
      });
      return path ? [path, `${path}.txt`] : [];
    }),
  );
  yield* AttachmentClaims.releaseClaimedAttachments(
    claimedPaths.filter((path) => !retained.has(path)),
  );
});

/**
 * A guest message goes out with the files the guest attached, never ones a client names. They
 * are already the thread's attachments. A message no longer waiting gets none; the orchestrator
 * then refuses or replays the send.
 */
const withGuestAttachments = Effect.fn("ThreadMessageIntake.withGuestAttachments")(function* (
  command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
) {
  if (command.guestMessageId === undefined) return command;
  const threads = yield* ThreadManagement.ThreadManagementService;
  // Only the thread record is needed; the window keeps the read small.
  const { projection } = yield* threads
    .getThreadSnapshotWindow(command.threadId, { rowLimit: 1 })
    .pipe(
      Effect.mapError(
        (cause) =>
          new AttachmentClaims.AttachmentClaimError({
            message: "Failed to read the guest message.",
            cause,
          }),
      ),
    );
  const message = projection.thread.guestShare?.messages.find(
    (candidate) => candidate.id === command.guestMessageId && candidate.status === "pending",
  );
  return { ...command, attachments: message?.attachments ?? [] };
});

/**
 * For a caller without `providers:manage`. An edit that omits `attachments` keeps the queued
 * ones, so `/logout` signs out only when the queued message has none. The edit goes on with
 * the files read here, so an edit racing this one cannot strip them afterwards.
 */
export const withQueuedAttachmentsOnSignOutText = Effect.fn(
  "ThreadMessageIntake.withQueuedAttachmentsOnSignOutText",
)(function* (command: Extract<OrchestrationV2Command, { readonly type: "queued-run.edit" }>) {
  if (
    command.attachments !== undefined ||
    !isProviderSignOutPrompt({ text: command.text, attachments: [] })
  ) {
    return command;
  }
  const threads = yield* ThreadManagement.ThreadManagementService;
  // A retry of an accepted edit replays its receipt, even after its run left the queue.
  if (yield* threads.hasReceipt(command.commandId)) return command;
  const { runs } = yield* threads.getThreadRecords(command.threadId, ["runs"], {
    runIds: [command.runId],
  });
  const queuedRun = runs.find((run) => run.id === command.runId && run.status === "queued");
  const attachments =
    queuedRun === undefined
      ? []
      : ((yield* threads.getMessagesById(command.threadId, [queuedRun.userMessageId])).get(
          queuedRun.userMessageId,
        )?.attachments ?? []);
  if (attachments.length === 0) return yield* rpcAuthorizationError(AuthProvidersManageScope);
  return { ...command, attachments };
});

function withQuestionContext(
  command: Extract<OrchestrationV2Command, { type: "runtime-request.respond" }>,
): typeof command {
  if (command.contextsByQuestionId === undefined) return command;
  const contexts: Array<[string, OrchestrationMessageContext]> = [];
  const supplied = new Map(Object.entries(command.contextsByQuestionId));
  const answers = Object.fromEntries(
    Object.entries(command.answers ?? {}).map(([questionId, answer]) => {
      const context = supplied.get(questionId);
      if (typeof answer !== "string" || context === undefined) return [questionId, answer];
      const records = referencedThreads(answer, context);
      if (records.length === 0) return [questionId, answer];
      contexts.push([questionId, { version: 1, records }]);
      return [questionId, answer];
    }),
  );
  const { contextsByQuestionId: _contexts, ...rest } = command;
  return {
    ...rest,
    answers,
    ...(contexts.length > 0 ? { contextsByQuestionId: Object.fromEntries(contexts) } : {}),
  };
}

function sendsProviderSignOut(command: OrchestrationV2Command): boolean {
  switch (command.type) {
    case "message.dispatch":
      // The orchestrator prefixes guest text before sending it to the provider.
      return command.guestMessageId === undefined && isProviderSignOutPrompt(command);
    case "thread.create":
      return (
        command.initialMessage !== undefined && isProviderSignOutPrompt(command.initialMessage)
      );
    case "queued-run.edit":
      return (
        command.attachments !== undefined &&
        isProviderSignOutPrompt({ text: command.text, attachments: command.attachments })
      );
    case "delegated_task.request":
      return isProviderSignOutPrompt({ text: command.task, attachments: [] });
    default:
      return false;
  }
}

export const dispatchCommand = Effect.fn("ThreadMessageIntake.dispatchCommand")(function* (
  incoming: OrchestrationV2Command,
  sender: DispatchSender = { managesProviders: false },
  options?: Orchestrator.OrchestratorV2DispatchOptions,
) {
  const command =
    incoming.type === "message.dispatch"
      ? yield* withGuestAttachments(incoming)
      : incoming.type === "runtime-request.respond"
        ? withQuestionContext(incoming)
        : incoming.type === "queued-run.edit" && !sender.managesProviders
          ? yield* withQueuedAttachmentsOnSignOutText(incoming)
          : incoming;
  if (!sender.managesProviders && sendsProviderSignOut(command)) {
    return yield* rpcAuthorizationError(AuthProvidersManageScope);
  }
  const authorization = yield* ThreadReadAuthorization;
  const inputId =
    command.type === "runtime-request.respond"
      ? questionAnswerAuthorizationId(command.commandId)
      : command.type === "queued-run.edit"
        ? queuedEditAuthorizationId(command.commandId)
        : command.type === "message.dispatch"
          ? command.messageId
          : command.type === "thread.create"
            ? command.initialMessage?.messageId
            : undefined;
  const threadReadIntent =
    inputId === undefined || !("threadId" in command)
      ? undefined
      : yield* authorization.authorize(command.threadId, inputId);
  const dispatchOptions =
    threadReadIntent === undefined ? options : { ...options, threadReadIntent };
  const threads = yield* ThreadManagement.ThreadManagementService;
  if (command.type === "runtime-request.respond" && command.attachmentsByQuestionId) {
    const config = yield* ServerConfig.ServerConfig;
    const incomingByQuestionId = command.attachmentsByQuestionId;
    yield* AttachmentClaims.validateAttachmentLimits(Object.values(incomingByQuestionId).flat());
    const claimedPaths: string[] = [];
    const prepared = yield* Effect.gen(function* () {
      const attachmentsByQuestionId: import("@t3tools/contracts").UserInputAttachments = {};
      for (const [questionId, attachments] of Object.entries(incomingByQuestionId)) {
        const claimed = yield* AttachmentClaims.claimPendingAttachments({
          threadId: command.threadId,
          attachments,
        });
        claimedPaths.push(...claimed.claimedPaths);
        Object.defineProperty(attachmentsByQuestionId, questionId, {
          value: claimed.attachments,
          enumerable: true,
        });
      }
      // An answer by message carries its files as message attachments, not paths in its text.
      const { runtimeRequests } = yield* threads
        .getThreadRecords(command.threadId, ["runtimeRequests"], {
          runtimeRequestStatuses: ["pending"],
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new AttachmentClaims.AttachmentClaimError({
                message: "Failed to read the question.",
                cause,
              }),
          ),
        );
      const answersByMessage =
        runtimeRequests.find((request) => request.id === command.requestId)?.responseCapability
          .type === "message";
      const answers = answersByMessage
        ? (command.answers ?? {})
        : yield* appendUserInputAttachmentPaths({
            answers: command.answers ?? {},
            attachmentsByQuestionId,
            attachmentsDir: config.attachmentsDir,
          }).pipe(
            Effect.mapError(
              (cause) => new AttachmentClaims.AttachmentClaimError({ message: cause.issue }),
            ),
          );
      return { answers, attachmentsByQuestionId };
    }).pipe(Effect.onError(() => AttachmentClaims.releaseClaimedAttachments(claimedPaths)));
    return yield* threads
      .dispatch(
        {
          ...command,
          answers: prepared.answers,
          attachmentsByQuestionId: prepared.attachmentsByQuestionId,
        },
        dispatchOptions,
      )
      .pipe(
        Effect.tap((result) => {
          // Replayed receipts refer to the first answer; release this attempt's unused copies only with a resolved item.
          // Missing questionAnswer means no accepted attachments; missing resolution leaves delivery ambiguous.
          const answeredItems = result.storedEvents.flatMap(({ event }) =>
            event.type === "turn-item.updated" &&
            event.payload.type === "user_input_request" &&
            event.payload.requestId === command.requestId
              ? [event.payload]
              : [],
          );
          return answeredItems.length > 0
            ? releaseUnusedClaims(
                claimedPaths,
                answeredItems.flatMap((item) =>
                  item.questionAnswer === undefined
                    ? []
                    : Object.values(item.questionAnswer.attachmentsByQuestionId).flat(),
                ),
              )
            : Effect.void;
        }),
        Effect.tapError((error) =>
          dispatchWasNotAccepted(error)
            ? AttachmentClaims.releaseClaimedAttachments(claimedPaths)
            : Effect.void,
        ),
      );
  }
  if (
    command.type !== "message.dispatch" &&
    (command.type !== "queued-run.edit" || command.attachments === undefined)
  )
    return yield* threads.dispatch(command, dispatchOptions);
  // An accepted edit's retry replays its receipt even if a later cleanup removed its files.
  if (command.type === "queued-run.edit" && !(yield* threads.hasReceipt(command.commandId))) {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    // A stale view can keep a file that another client's edit dropped and deleted.
    for (const attachment of command.attachments ?? []) {
      if (AttachmentClaims.attachmentIsPendingUpload(attachment)) continue;
      const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
      if (
        path !== null &&
        !(yield* fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false)))
      ) {
        return yield* new AttachmentClaims.AttachmentClaimError({
          message: `Attachment '${attachment.name}' cannot be sent: attachment not found.`,
        });
      }
    }
  }
  const claimed = yield* AttachmentClaims.claimPendingAttachments({
    threadId: command.threadId,
    attachments: command.attachments ?? [],
  });
  return yield* threads
    .dispatch(
      {
        ...command,
        attachments: claimed.attachments,
        ...(command.context
          ? {
              context: remapComposerContextAttachments(
                command.context,
                command.attachments ?? [],
                claimed.attachments,
              ),
            }
          : {}),
      },
      dispatchOptions,
    )
    .pipe(
      Effect.tap((result) =>
        releaseUnusedClaims(
          claimed.claimedPaths,
          result.storedEvents.flatMap(({ event }) =>
            event.type === "message.updated" ? event.payload.attachments : [],
          ),
        ),
      ),
      Effect.tapError((error) =>
        dispatchWasNotAccepted(error)
          ? AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths)
          : Effect.void,
      ),
    );
});

export const sendToThread = Effect.fn("ThreadMessageIntake.sendToThread")(function* (
  input: ThreadManagement.ThreadManagementSendInput,
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const claimed = yield* AttachmentClaims.claimPendingAttachments(input);
  return yield* threads.sendToThread({ ...input, attachments: claimed.attachments }).pipe(
    Effect.tap((result) => releaseUnusedClaims(claimed.claimedPaths, result.message.attachments)),
    Effect.tapError((error) =>
      dispatchWasNotAccepted(error)
        ? AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths)
        : Effect.void,
    ),
  );
});

export const launchThread = Effect.fn("ThreadMessageIntake.launchThread")(function* (
  input: ThreadLaunch.ThreadLaunchInput,
) {
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  yield* AttachmentClaims.validateAttachmentLimits(input.initialMessage?.attachments ?? []);
  if (!input.initialMessage?.attachments.some(AttachmentClaims.attachmentIsPendingUpload)) {
    return yield* launches.launch(input);
  }
  if (input.threadId === undefined) {
    return yield* new AttachmentClaims.AttachmentClaimError({
      message: "Uploaded attachments need a thread id at launch.",
    });
  }
  const claimed = yield* AttachmentClaims.claimPendingAttachments({
    threadId: input.threadId,
    attachments: input.initialMessage.attachments,
  });
  return yield* launches
    .launch({
      ...input,
      initialMessage: {
        ...input.initialMessage,
        attachments: claimed.attachments,
        ...(input.initialMessage.context
          ? {
              context: remapComposerContextAttachments(
                input.initialMessage.context,
                input.initialMessage.attachments,
                claimed.attachments,
              ),
            }
          : {}),
      },
    })
    .pipe(
      Effect.tap((result) =>
        releaseUnusedClaims(
          claimed.claimedPaths,
          result.projection.messages.flatMap((message) => message.attachments),
        ),
      ),
      Effect.tapError((error) => {
        if (error._tag === "ThreadManagementProviderInstanceDisabledError") {
          return AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths);
        }
        // Project/receipt reads precede dispatch; create-thread errors can wrap post-message reads and prove nothing alone.
        const notAccepted =
          error.operation === "resolve-project" ||
          error.operation === "read-receipt" ||
          ((error.operation === "create-thread" || error.operation === "dispatch-message") &&
            (isOrchestratorError(error.cause) || isThreadManagementError(error.cause)) &&
            // Projection errors under create-thread can occur after the message commit.
            (error.operation !== "create-thread" ||
              error.cause._tag !== "OrchestratorProjectionError") &&
            dispatchWasNotAccepted(error.cause));
        return notAccepted
          ? AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths)
          : Effect.void;
      }),
    );
});
