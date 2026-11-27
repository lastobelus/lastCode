import {
  assistantCitationsToPlainText,
  splitsSurrogatePair,
} from "@t3tools/shared/assistantCitations";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import {
  isAttachmentOnlyBootstrapPrompt,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import type { Nodes } from "hast";

import { markdownTree } from "~/markdown/wordsHast";

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
      userText: isAttachmentOnlyBootstrapPrompt(row.message.text)
        ? ""
        : incoming.isIncoming
          ? incoming.previewText
          : row.message.text,
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

// Elements whose children run together; every other element is separated by a space.
// A tight list item holds its text bare, without the paragraph a loose one wraps it in.
const INLINE_PARENTS = new Set([
  "p",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "td",
  "th",
  "em",
  "strong",
  "del",
  "a",
  "code",
  "span",
  "sup",
  "sub",
]);

function markdownNodeText(node: Nodes): string {
  if (node.type === "text") return node.value;
  if (node.type === "element" && node.tagName === "br") return " ";
  if (node.type === "element" && node.tagName === "img") return String(node.properties.alt ?? "");
  if (node.type !== "element" && node.type !== "root") return "";
  const separator = node.type === "element" && INLINE_PARENTS.has(node.tagName) ? "" : " ";
  const text = node.children.map(markdownNodeText).join(separator);
  // A thread autolink's only text is its URL.
  return node.type === "element" && node.tagName === "a" && parseThreadLinkHref(text) !== null
    ? "a thread"
    : text;
}

/** Markdown as one line of the text it renders, without markup or link targets. */
export function markdownPlainText(markdown: string): string {
  return markdownNodeText(markdownTree(markdown)).replace(/\s+/g, " ").trim();
}

// The tooltip shows a few lines; bound parsing work for long messages and streaming responses.
function markdownMinimapPreview(markdown: string | null) {
  if (markdown === null) return null;
  const compact = markdownPlainText(
    markdown.slice(0, splitsSurrogatePair(markdown, 1_500) ? 1_499 : 1_500),
  );
  return compact.length > 0 ? compact : null;
}

export function resolveTimelineMinimapPreview(
  item: TimelineMinimapItem | null,
): TimelineMinimapItem | null {
  return item === null
    ? null
    : {
        ...item,
        // Incoming previews are already display text. Expand authored citations before parsing
        // their Markdown, which would otherwise reduce them to "Assistant quote".
        userText: item.isIncoming
          ? item.userText
          : markdownMinimapPreview(
              item.userText === null
                ? null
                : assistantCitationsToPlainText(
                    replaceComposerContextReferences(item.userText, (reference) => reference.label),
                  ),
            ),
        assistantText: markdownMinimapPreview(item.assistantText),
      };
}
