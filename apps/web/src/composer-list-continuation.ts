import { splitPromptIntoComposerSegments } from "./composer-editor-mentions";

/**
 * List and quote continuation, plus list indentation, for the composer.
 *
 * Implemented once at the ChatComposer level (store replacement), so both
 * composer modes behave identically and serialize identically:
 * Shift+Enter continues a list item or quote, or exits it on an empty line.
 * Tab indents a list item. All edits operate on literal Markdown source.
 */

export interface ComposerListEdit {
  /** Expanded (plain string) offsets into the prompt. */
  start: number;
  end: number;
  replacement: string;
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

function segmentSource(
  segment: ReturnType<typeof splitPromptIntoComposerSegments>[number],
): string {
  if (segment.type === "text") return segment.text;
  return segment.source;
}

/** True when splitting at the caret would cut an inline chip in two. */
function isInsideInlineToken(value: string, cursor: number): boolean {
  let offset = 0;
  for (const segment of splitPromptIntoComposerSegments(value)) {
    const end = offset + segmentSource(segment).length;
    if (segment.type !== "text" && cursor > offset && cursor < end) return true;
    offset = end;
  }
  return false;
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
  if (!parsed && quote === "") return null;
  const markerStart = line.start + quote.length;
  const markerEnd = markerStart + (parsed?.markerEnd ?? 0);
  if (cursor < markerEnd) return null;
  if (isInsideInlineToken(value, cursor)) return null;
  if (value.slice(markerEnd, line.end).trim() === "") {
    // An empty list exits its marker but keeps the quote; an empty quote exits all levels.
    return {
      start: parsed ? markerStart : line.start,
      end: Math.max(cursor, markerEnd),
      replacement: "",
    };
  }
  return {
    start: cursor,
    end: cursor,
    replacement: `\n${quote}${parsed ? nextMarkerText(parsed.marker) : ""}`,
  };
}

export function listIndentForTab(
  value: string,
  start: number,
  end: number,
): ComposerListEdit | null {
  if (!Number.isInteger(start) || start !== end || start < 0 || start > value.length) return null;
  const line = currentLine(value, start);
  if (!parseListMarker(line.text)) return null;
  if (isInsideInlineToken(value, start)) return null;
  return { start: line.start, end: line.start, replacement: "  " };
}
