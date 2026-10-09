import { type OrchestrationV2Actor, ScheduledTaskId } from "@t3tools/contracts";

const LEGACY_AUTOMATION_PREFIX = /^\[Triggered by schedule task: [^\r\n]+\]\r?\n\r?\n/;
const LEGACY_AUTOMATION_MESSAGE_ID = /^scheduled-task-message:(.+):\d+:(?:scheduled|manual)$/;

/** Older scheduled messages stored their attribution in the prompt itself. */
export function resolveUserMessagePresentation(message: {
  readonly id?: string;
  readonly role: string;
  readonly text: string;
  readonly createdBy?: OrchestrationV2Actor;
  readonly scheduledTaskId?: ScheduledTaskId | undefined;
  readonly notification?: unknown;
}) {
  if (message.role !== "user") {
    return { text: message.text, isAutomation: false, scheduledTaskId: undefined };
  }
  if (message.scheduledTaskId !== undefined) {
    return { text: message.text, isAutomation: true, scheduledTaskId: message.scheduledTaskId };
  }
  const legacyPrefix = LEGACY_AUTOMATION_PREFIX.exec(message.text);
  const legacyTaskId = legacyPrefix
    ? LEGACY_AUTOMATION_MESSAGE_ID.exec(message.id ?? "")?.[1]
    : undefined;
  const isAutomation =
    legacyPrefix !== null && (legacyTaskId !== undefined || message.createdBy === "agent");
  return {
    text: isAutomation ? message.text.slice(legacyPrefix[0].length) : message.text,
    isAutomation,
    scheduledTaskId: legacyTaskId === undefined ? undefined : ScheduledTaskId.make(legacyTaskId),
  };
}

/** Only persisted sender/schedule attribution identifies an incoming message. */
export function isIncomingUserMessage(
  message: Parameters<typeof resolveUserMessagePresentation>[0],
) {
  return (
    message.role === "user" &&
    message.notification === undefined &&
    (message.createdBy === "agent" || resolveUserMessagePresentation(message).isAutomation)
  );
}

export function isShortIncomingMessage(text: string) {
  return text.length <= 90 && !/[\r\n]/u.test(text);
}
