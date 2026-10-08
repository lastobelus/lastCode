import type { OrchestrationV2IncomingMessageSummary } from "@t3tools/contracts";
import {
  isIncomingUserMessage,
  isShortIncomingMessage,
  resolveUserMessagePresentation,
} from "@t3tools/shared/userMessage";

export { resolveUserMessagePresentation };

/** Shared preview semantics for chat, mobile, and the minimap. */
export function resolveIncomingMessagePreview(
  message: Parameters<typeof resolveUserMessagePresentation>[0] & {
    readonly incomingSummary?: OrchestrationV2IncomingMessageSummary;
  },
) {
  const { text } = resolveUserMessagePresentation(message);
  const isIncoming = isIncomingUserMessage(message);
  const summary = isIncoming ? message.incomingSummary : undefined;
  const isSummary = summary?.status === "ready";
  const pending = summary?.status === "pending";
  const firstLineEnd = isSummary ? -1 : text.search(/\r?\n/u);
  return {
    isIncoming,
    previewText: isSummary ? summary.text : firstLineEnd < 0 ? text : text.slice(0, firstLineEnd),
    pending,
    isSummary,
    canExpand: isIncoming && (!isShortIncomingMessage(text) || isSummary || pending),
  };
}
