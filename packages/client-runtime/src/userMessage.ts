import type {
  ChatAttachment,
  ChatFileAttachment,
  OrchestrationMessageContext,
  OrchestrationV2UserMessageInputIntent,
  OrchestrationV2IdleCompaction,
  OrchestrationV2IncomingMessageSummary,
} from "@t3tools/contracts";
import {
  isAttachmentOnlyBootstrapPrompt,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import { filePreviewKind } from "@t3tools/shared/filePreview";
import { imageMimeType } from "@t3tools/shared/image";
import { videoMimeType } from "@t3tools/shared/video";
import {
  isIncomingUserMessage,
  isShortIncomingMessage,
  resolveUserMessagePresentation as resolveSharedUserMessagePresentation,
} from "@t3tools/shared/userMessage";

/** The working row while T3 Code's own compaction runs. */
export const IDLE_COMPACTING_LABELS = {
  beforeCacheExpires: "Compacting before the cache expires…",
  onReturn: "Compacting…",
} satisfies Record<OrchestrationV2IdleCompaction, string>;

/** Leads the finished compaction's token counts, in place of "Context compacted". */
export const IDLE_COMPACTION_TITLES = {
  beforeCacheExpires: "Context automatically compacted before cache expiry",
  onReturn: "Context compacted before sending",
} satisfies Record<OrchestrationV2IdleCompaction, string>;

export function resolveUserMessageFileCards(message: {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly context?: OrchestrationMessageContext | undefined;
}): ReadonlyArray<ChatFileAttachment> | null {
  const files = message.attachments.filter(
    (attachment): attachment is ChatFileAttachment =>
      attachment.type === "file" &&
      imageMimeType(attachment) === null &&
      videoMimeType(attachment) === null &&
      filePreviewKind(attachment) !== "audio",
  );
  if (files.length === 0 || files.length !== message.attachments.length) return null;
  const fileIds = new Set(files.map((file) => file.id));
  const remaining = replaceComposerContextReferences(message.text, (reference) => {
    const record = message.context?.records.find((item) => item.contextId === reference.contextId);
    return reference.kind === "file" &&
      record?.kind === "file" &&
      "attachmentId" in record &&
      fileIds.has(record.attachmentId)
      ? ""
      : reference.label || reference.kind;
  });
  return remaining.trim() === "" ? files : null;
}

export function resolveUserMessagePresentation(
  message: Parameters<typeof resolveSharedUserMessagePresentation>[0],
) {
  const presentation = resolveSharedUserMessagePresentation(message);
  // The agent needs words to start a turn; people sent only the attachments.
  return message.role === "user" &&
    presentation.attribution !== "guest" &&
    presentation.attribution !== "automation" &&
    isAttachmentOnlyBootstrapPrompt(message.text)
    ? { ...presentation, text: "" }
    : presentation;
}

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

type GroupableUserMessage = Parameters<typeof resolveUserMessagePresentation>[0] & {
  readonly inputIntent?: OrchestrationV2UserMessageInputIntent;
};

export function resolveUserMessageGrouping(
  message: GroupableUserMessage | undefined,
  previous: GroupableUserMessage | undefined,
  next: GroupableUserMessage | undefined,
) {
  const isOwnMessage = (value: GroupableUserMessage | undefined) =>
    value?.role === "user" && resolveUserMessagePresentation(value).attribution === null;
  const isSteer = (value: GroupableUserMessage | undefined) =>
    value?.inputIntent === "steer" || value?.inputIntent === "promoted_queued_to_steer";
  const groupedWithPrevious = isOwnMessage(message) && isOwnMessage(previous);
  return {
    groupedWithPrevious,
    groupedWithNext: isOwnMessage(message) && isOwnMessage(next),
    continuesSteer: groupedWithPrevious && isSteer(message) && isSteer(previous),
  };
}
