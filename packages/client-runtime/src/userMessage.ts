import type {
  OrchestrationV2IdleCompaction,
  OrchestrationV2IncomingMessageSummary,
} from "@t3tools/contracts";
import {
  isIncomingUserMessage,
  isShortIncomingMessage,
  resolveUserMessagePresentation,
} from "@t3tools/shared/userMessage";

/** The working row while T3 Code's own compaction runs. */
export const IDLE_COMPACTING_LABELS = {
  beforeCacheExpires: "Compacting before the cache expires…",
  onReturn: "Compacting after being idle…",
} satisfies Record<OrchestrationV2IdleCompaction, string>;

/** Leads the finished compaction's token counts, in place of "Context compacted". */
export const IDLE_COMPACTION_TITLES = {
  beforeCacheExpires: "Context automatically compacted before cache expiry",
  onReturn: "Context compacted after being idle",
} satisfies Record<OrchestrationV2IdleCompaction, string>;

export { resolveUserMessagePresentation };

/** Shared preview semantics for chat, mobile, and the minimap. */
export function resolveIncomingMessagePreview(
  message: Parameters<typeof resolveUserMessagePresentation>[0] & {
    readonly incomingSummary?: OrchestrationV2IncomingMessageSummary | undefined;
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
