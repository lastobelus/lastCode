import type { MessageId } from "@t3tools/contracts";
import { resolveIncomingMessagePreview } from "@t3tools/client-runtime/user-message";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

export interface TimelineMinimapItem {
  readonly id: string;
  readonly messageId: MessageId;
  readonly rowIndex: number;
  readonly userText: string | null;
  readonly assistantText: string | null;
  readonly isIncoming: boolean;
  readonly summaryPending: boolean;
  readonly isSummary: boolean;
  readonly isShortOriginal: boolean;
}

/** Keep full source text untouched until a minimap preview is opened. */
export function deriveTimelineMinimapItems(
  rows: ReadonlyArray<MessagesTimelineRow>,
): TimelineMinimapItem[] {
  const items: TimelineMinimapItem[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message" || row.message.role !== "user") {
      continue;
    }

    const incoming = resolveIncomingMessagePreview(row.message);
    items.push({
      id: row.id,
      messageId: row.message.id,
      rowIndex: index,
      userText: incoming.isIncoming ? incoming.previewText : row.message.text,
      assistantText: resolveFinalAssistantTextForTurn(rows, index),
      isIncoming: incoming.isIncoming,
      summaryPending: incoming.pending,
      isSummary: incoming.isSummary,
      isShortOriginal: incoming.isIncoming && !incoming.canExpand,
    });
  }
  return items;
}

export function timelineMinimapPreviewUsesFullText(item: TimelineMinimapItem): boolean {
  return item.isIncoming && !item.summaryPending && (item.isSummary || item.isShortOriginal);
}

function resolveFinalAssistantTextForTurn(
  rows: ReadonlyArray<MessagesTimelineRow>,
  userRowIndex: number,
) {
  let finalAssistantText: string | null = null;
  for (let index = userRowIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message") {
      continue;
    }
    if (row.message.role === "user") {
      break;
    }
    if (row.message.role === "assistant") {
      finalAssistantText = row.message.text ?? null;
    }
  }
  return finalAssistantText;
}

function compactMinimapPreview(text: string | null | undefined) {
  const compact = text?.replace(/\s+/g, " ").trim() ?? "";
  return compact.length > 0 ? compact : null;
}

export function resolveTimelineMinimapPreview(
  item: TimelineMinimapItem | null,
): TimelineMinimapItem | null {
  return item === null
    ? null
    : {
        ...item,
        userText: item.isIncoming ? item.userText : compactMinimapPreview(item.userText),
        assistantText: compactMinimapPreview(item.assistantText),
      };
}
