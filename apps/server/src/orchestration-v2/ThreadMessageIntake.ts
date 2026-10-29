import {
  collectComposerContextReferences,
  remapComposerContextAttachments,
} from "@t3tools/shared/composerContextReferences";
import { appendUserInputAttachmentPaths } from "../provider/userInputAttachments.ts";
import {
  UpdateDrainAdmissionError,
  UpdateDrainError,
  type ChatAttachment,
  type OrchestrationMessageContext,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "./Orchestrator.ts";

import * as AttachmentClaims from "./AttachmentClaims.ts";
import {
  ThreadReadAuthorization,
  questionAnswerAuthorizationId,
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
    case "ThreadManagementProviderInstanceDisabledError":
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
    case "subagent.promote.request":
    case "thread.fork":
    case "thread.merge_back":
      return true;
    default:
      return false;
  }
}

export const dispatchUserCommand = Effect.fn("ThreadMessageIntake.dispatchUserCommand")(function* (
  command: OrchestrationV2Command,
) {
  return yield* dispatchCommand(
    command,
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
      const ids = new Set(
        collectComposerContextReferences(answer)
          .filter((reference) => reference.kind === "thread")
          .map((reference) => reference.contextId),
      );
      const records = [
        ...new Map(context.records.map((record) => [record.contextId, record])).values(),
      ].filter((record) => record.kind === "thread" && ids.has(record.contextId));
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

export const dispatchCommand = Effect.fn("ThreadMessageIntake.dispatchCommand")(function* (
  incoming: OrchestrationV2Command,
  options?: Orchestrator.OrchestratorV2DispatchOptions,
) {
  const command =
    incoming.type === "message.dispatch"
      ? yield* withGuestAttachments(incoming)
      : incoming.type === "runtime-request.respond"
        ? withQuestionContext(incoming)
        : incoming;
  if (command.type === "runtime-request.respond" && command.contextsByQuestionId !== undefined) {
    const authorization = yield* ThreadReadAuthorization;
    yield* authorization.authorize(
      command.threadId,
      questionAnswerAuthorizationId(command.commandId),
    );
  }
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
      const answers = yield* appendUserInputAttachmentPaths({
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
        options,
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
    return yield* threads.dispatch(command, options);
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
      options,
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
