import {
  latestProviderTurnForAttempt,
  type MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ThreadProjection,
  type RunId,
} from "@t3tools/contracts";

export const ENVIRONMENT_PAUSE_MESSAGE_PREFIX = "environment-pause:";

export function isEnvironmentPauseMessageId(messageId: MessageId): boolean {
  return messageId.startsWith(ENVIRONMENT_PAUSE_MESSAGE_PREFIX);
}

/** Explicit environment fanout is allowed while automatic follow-ups wait. */
export function isAutomaticWakeMessage(
  message: Pick<
    OrchestrationV2ConversationMessage,
    | "id"
    | "createdBy"
    | "creationSource"
    | "notification"
    | "delegatedCompletion"
    | "scheduledTaskId"
  > & {
    readonly restartContinuationOfRunId?: RunId | undefined;
    readonly usageLimitContinuationOfRunId?: RunId | undefined;
  },
): boolean {
  return (
    !isEnvironmentPauseMessageId(message.id) &&
    (message.notification !== undefined ||
      message.delegatedCompletion !== undefined ||
      message.scheduledTaskId !== undefined ||
      message.restartContinuationOfRunId !== undefined ||
      message.usageLimitContinuationOfRunId !== undefined ||
      message.id.startsWith("message:restart-continuation:") ||
      message.id.startsWith("limit-resume:") ||
      (message.createdBy === "system" && message.creationSource === "server"))
  );
}

/**
 * A persisted steer without an acceptance receipt can be retried as a continuation.
 * Delivery is at least once: provider acceptance and our receipt cannot commit
 * atomically. Reusing the message ID keeps recovery from duplicating timeline items.
 */
export function isUndeliveredMailboxSteer(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "runs" | "providerTurns">,
  messageId: MessageId,
): boolean {
  const message = projection.messages.find((candidate) => candidate.id === messageId);
  if (message?.delegatedCompletion === undefined) return false;
  const run = projection.runs.find((candidate) => candidate.id === message.runId);
  return (
    run !== undefined &&
    run.userMessageId !== message.id &&
    (["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(run.status) ||
      latestProviderTurnForAttempt(projection.providerTurns, run.activeAttemptId)?.status ===
        "completed")
  );
}
