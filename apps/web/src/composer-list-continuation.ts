import { splitPromptIntoComposerSegments } from "./composer-editor-mentions";

/**
 * Shared source edits keep continuation and indentation identical in both composer modes.
 * Shift+Enter continues or exits lists/quotes; Tab indents literal Markdown.
 */

export interface ComposerListEdit {
  /** Expanded (plain string) offsets into the prompt. */
  start: number;
  end: number;
  replacement: string;
  /** Expanded caret offset after the edit is applied. */
  cursorAfter: number;
}

type ListMarker =
  | { kind: "ordered"; indent: string; numberText: string; delimiter: "." | ")"; space: string }
  | { kind: "task"; indent: string; space: string }
  | { kind: "bullet"; indent: string; bullet: string; space: string };

function parseListMarker(line: string): { marker: ListMarker; markerEnd: number } | null {
  const indent = line.match(/^[ \t]*/)?.[0] ?? "";
  const rest = line.slice(indent.length);
  const ordered = rest.match(/^(\d+)([.)])((?:[ \t]+)|\s*$)/);
  if (ordered && ordered[1] !== undefined && ordered[2] !== undefined) {
    return {
      marker: {
        kind: "ordered",
        indent,
        numberText: ordered[1],
        delimiter: ordered[2] === ")" ? ")" : ".",
        space: ordered[3] ?? "",
      },
      markerEnd: indent.length + ordered[0].length,
    };
  }
  const task = rest.match(/^-\s\[[ xX]\]((?:[ \t]+)|\s*$)/);
  if (task) {
    return {
      marker: { kind: "task", indent, space: task[1] ?? "" },
      markerEnd: indent.length + task[0].length,
    };
  }
  const bullet = rest.match(/^([-*+])((?:[ \t]+)|\s*$)/);
  if (bullet && bullet[1] !== undefined) {
    return {
      marker: { kind: "bullet", indent, bullet: bullet[1], space: bullet[2] ?? "" },
      markerEnd: indent.length + bullet[0].length,
    };
  }
  return null;
}

/** Keep every typed quote marker and its spacing, including nested prefixes. */
function quotePrefix(line: string): string | null {
  return /^ {0,3}(?:>[ \t]*)+/.exec(line)?.[0] ?? null;
}

/**
 * The ordered marker that follows `3.` or `09)`: one higher, same delimiter,
 * zero padding kept, and a number too large to count left as typed. Shared
 * with the rich editor's native split so both modes count the same way.
 */
export function nextOrderedMarkerText(marker: string): string {
  const numberText = marker.slice(0, -1);
  const delimiter = marker.slice(-1);
  const number = Number.parseInt(numberText, 10);
  const next = Number.isSafeInteger(number)
    ? String(number + 1).padStart(numberText.length, "0")
    : numberText;
  return `${next}${delimiter}`;
}

function nextMarkerText(marker: ListMarker): string {
  if (marker.kind === "ordered") {
    return `${marker.indent}${nextOrderedMarkerText(`${marker.numberText}${marker.delimiter}`)} `;
  }
  if (marker.kind === "task") {
    return `${marker.indent}- [ ] `;
  }
  return `${marker.indent}${marker.bullet} `;
}

// Markdown tabs advance to the next four-column stop.
function indentWidth(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === " ") width += 1;
    else if (char === "\t") width += 4 - (width % 4);
    else break;
  }
  return width;
}

function renumberFollowingItems(
  value: string,
  afterLineEnd: number,
  marker: Extract<ListMarker, { kind: "ordered" }>,
  tokens: ReturnType<typeof inlineTokenRanges>,
  quote: string,
): { end: number; text: string } | null {
  const baseWidth = indentWidth(marker.indent);
  const parts: string[] = [];
  let expected = Number.parseInt(marker.numberText, 10) + 2;
  let position = afterLineEnd;
  let copiedUntil = afterLineEnd;
  let tokenIndex = 0;
  while (position < value.length && Number.isSafeInteger(expected)) {
    const lineStart = position + 1;
    const nextBreak = value.indexOf("\n", lineStart);
    const lineEnd = nextBreak === -1 ? value.length : nextBreak;
    position = lineEnd;
    let token = tokens[tokenIndex];
    while (token && token.end <= lineStart) {
      tokenIndex += 1;
      token = tokens[tokenIndex];
    }
    // A newline inside a chip does not start a list item.
    if (token && token.start < lineStart) continue;

    const sourceLine = value.slice(lineStart, lineEnd);
    if ((quotePrefix(sourceLine) ?? "") !== quote) break;
    const line = sourceLine.slice(quote.length);
    const width = indentWidth(line);
    if (line.trim() === "" || width < baseWidth) break;
    if (width > baseWidth) continue;
    const parsed = parseListMarker(line);
    if (parsed?.marker.kind !== "ordered" || parsed.marker.delimiter !== marker.delimiter) break;

    const current = parsed.marker;
    const numberStart = lineStart + quote.length + current.indent.length;
    const numberEnd = numberStart + current.numberText.length;
    const replacement = current.numberText.startsWith("0")
      ? String(expected).padStart(current.numberText.length, "0")
      : String(expected);
    if (replacement !== current.numberText) {
      parts.push(value.slice(copiedUntil, numberStart), replacement);
      copiedUntil = numberEnd;
    }
    expected += 1;
  }
  return parts.length === 0 ? null : { end: copiedUntil, text: parts.join("") };
}

function inlineTokenRanges(value: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let offset = 0;
  for (const segment of splitPromptIntoComposerSegments(value)) {
    const end = offset + (segment.type === "text" ? segment.text : segment.source).length;
    if (segment.type !== "text") ranges.push({ start: offset, end });
    offset = end;
  }
  return ranges;
}

function isInsideInlineToken(
  tokens: ReturnType<typeof inlineTokenRanges>,
  cursor: number,
): boolean {
  return tokens.some((range) => cursor > range.start && cursor < range.end);
}

function currentLine(value: string, cursor: number): { start: number; end: number; text: string } {
  const start = value.lastIndexOf("\n", cursor - 1) + 1;
  const endIndex = value.indexOf("\n", cursor);
  const end = endIndex === -1 ? value.length : endIndex;
  return { start, end, text: value.slice(start, end) };
}

/**
 * Shift+Enter on a list or quote line: continue its marker, or remove the
 * marker when the line is empty. Carets inside markers or inline chips and
 * other lines fall through to a plain newline.
 */
export function listContinuationForEnter(value: string, cursor: number): ComposerListEdit | null {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > value.length) return null;
  const line = currentLine(value, cursor);
  const quote = quotePrefix(line.text) ?? "";
  const parsed = parseListMarker(line.text.slice(quote.length));
  if (quote === "" && (!parsed || parsed.marker.space === "")) return null;
  const markerStart = line.start + quote.length;
  const markerEnd = markerStart + (parsed?.markerEnd ?? 0);
  if (cursor < markerEnd) return null;
  const tokens = inlineTokenRanges(value);
  if (isInsideInlineToken(tokens, cursor)) return null;
  if (value.slice(markerEnd, line.end).trim() === "") {
    return {
      start: parsed ? markerStart : line.start,
      end: Math.max(cursor, markerEnd),
      replacement: "",
      cursorAfter: parsed ? markerStart : line.start,
    };
  }
  const insertion = `\n${quote}${parsed ? nextMarkerText(parsed.marker) : ""}`;
  const cursorAfter = cursor + insertion.length;
  const marker = parsed?.marker;
  if (marker?.kind === "ordered") {
    const renumbered = renumberFollowingItems(value, line.end, marker, tokens, quote);
    if (renumbered) {
      return {
        start: cursor,
        end: renumbered.end,
        replacement: insertion + value.slice(cursor, line.end) + renumbered.text,
        cursorAfter,
      };
    }
  }
  return { start: cursor, end: cursor, replacement: insertion, cursorAfter };
}

export function listIndentForTab(
  value: string,
  start: number,
  end: number,
): ComposerListEdit | null {
  if (!Number.isInteger(start) || start !== end || start < 0 || start > value.length) return null;
  const line = currentLine(value, start);
  if (!parseListMarker(line.text)) return null;
  if (isInsideInlineToken(inlineTokenRanges(value), start)) return null;
  return { start: line.start, end: line.start, replacement: "  ", cursorAfter: start + 2 };
}
