import { collectMarkdownSourceRanges } from "@t3tools/shared/lastcodeMarkdownSourceRanges";

import { withInfoStringLanguage } from "./composer-code-languages";

export type ComposerEditSelection = { from: number; to: number };
export type ComposerSourceEdit = { value: string; selection: ComposerEditSelection };
export type ComposerFormattingDelimiter = "**" | "*" | "`" | "~~";
export type ComposerFormattingEdits = {
  /** Descending source offsets let the editor apply these without replacing intervening atoms. */
  edits: Array<{ from: number; to: number; text: string }>;
  selection: ComposerEditSelection;
};
export type ComposerSourceFence = {
  from: number;
  to: number;
  contentFrom: number;
  contentTo: number;
};

function orderedSelection(selection: ComposerEditSelection): ComposerEditSelection {
  return {
    from: Math.min(selection.from, selection.to),
    to: Math.max(selection.from, selection.to),
  };
}

/** Decide minimal source edits without treating one star of a bold run as an italic delimiter. */
export function composerSourceFormattingEdits(
  value: string,
  selection: ComposerEditSelection,
  delimiter: ComposerFormattingDelimiter,
): ComposerFormattingEdits {
  const { from, to } = orderedSelection(selection);
  const width = delimiter.length;
  const removePair = (open: number, close: number): ComposerFormattingEdits => {
    const mapOffset = (offset: number) => {
      if (offset <= open) return offset;
      if (offset < open + width) return open;
      if (offset <= close) return offset - width;
      if (offset < close + width) return close - width;
      return offset - width * 2;
    };
    return {
      edits: [
        { from: close, to: close + width, text: "" },
        { from: open, to: open + width, text: "" },
      ],
      selection: { from: mapOffset(from), to: mapOffset(to) },
    };
  };
  const emptyOpen = from === to ? from - width : from;
  const emptyClose = from === to ? to : to - width;
  if (
    (from === to || to - from === width * 2) &&
    emptyOpen >= 0 &&
    value.slice(emptyOpen, emptyOpen + width) === delimiter &&
    value.slice(emptyClose, emptyClose + width) === delimiter &&
    value[emptyOpen - 1] !== delimiter[0] &&
    value[emptyClose + width] !== delimiter[0]
  )
    return removePair(emptyOpen, emptyClose);

  const kind = ({ "**": "strong", "*": "emphasis", "`": "inlineCode", "~~": "delete" } as const)[
    delimiter
  ];
  // Nonempty runs need parser proof: wildcards and escaped stars are source, not formatting.
  const ranges = from === to ? [] : collectMarkdownSourceRanges(value).inline;
  const gapIsNestedSyntax = (start: number, end: number, owner: (typeof ranges)[number]) => {
    if (start === end) return true;
    const syntax = ranges
      .flatMap((range) =>
        range.kind !== owner.kind && range.from >= owner.contentFrom && range.to <= owner.contentTo
          ? [
              { from: range.from, to: range.contentFrom },
              { from: range.contentTo, to: range.to },
            ]
          : [],
      )
      .sort((left, right) => left.from - right.from);
    let covered = start;
    for (const range of syntax) {
      if (range.from > covered) break;
      covered = Math.max(covered, Math.min(end, range.to));
      if (covered === end) return true;
    }
    return false;
  };
  const parsedPair = ranges
    .filter(
      (range) =>
        range.kind === kind &&
        value.slice(range.from, range.contentFrom) === delimiter &&
        value.slice(range.contentTo, range.to) === delimiter,
    )
    .sort((left, right) => left.to - left.from - (right.to - right.from))
    .find(
      (range) =>
        (from === range.from && to === range.to) ||
        (from >= range.contentFrom &&
          to <= range.contentTo &&
          gapIsNestedSyntax(range.contentFrom, from, range) &&
          gapIsNestedSyntax(to, range.contentTo, range)),
    );
  if (parsedPair) return removePair(parsedPair.from, parsedPair.contentTo);
  return {
    edits: [
      { from: to, to, text: delimiter },
      { from, to: from, text: delimiter },
    ],
    selection: { from: from + width, to: to + width },
  };
}

function selectionInsideFence(
  selection: ComposerEditSelection,
  fence: ComposerSourceFence,
): boolean {
  return selection.from >= fence.from && selection.to <= fence.to;
}

function lineStartAt(value: string, offset: number): number {
  return offset === 0 ? 0 : value.lastIndexOf("\n", offset - 1) + 1;
}

function lineEndAt(value: string, offset: number): number {
  const newline = value.indexOf("\n", offset);
  const end = newline === -1 ? value.length : newline;
  return end > 0 && value[end - 1] === "\r" ? end - 1 : end;
}

/** Quote markers survive; list markers become their equally wide continuation indentation. */
function fenceContinuationPrefix(value: string, fence: ComposerSourceFence): string {
  return value.slice(lineStartAt(value, fence.from), fence.from).replace(/[^> \t]/g, " ");
}

function whitespaceWidth(text: string): number {
  let width = 0;
  for (const character of text) width += character === "\t" ? 4 - (width % 4) : 1;
  return width;
}

function consumeIndent(value: string, from: number, to: number, target: number): number {
  let width = 0;
  let offset = from;
  while (offset < to && /[ \t]/.test(value[offset]!)) {
    const step = value[offset] === "\t" ? 4 - (width % 4) : 1;
    if (width + step > target) break;
    width += step;
    offset++;
  }
  return offset;
}

/** Find the current line's container while tolerating alternative quote spacing. */
function fenceBodyStart(value: string, from: number, to: number, prefix: string): number {
  if (value.startsWith(prefix, from)) return from + prefix.length;
  const quotes = [...prefix].filter((character) => character === ">").length;
  if (quotes === 0) return consumeIndent(value, from, to, whitespaceWidth(prefix));
  let offset = from;
  for (let count = 0; count < quotes; count++) {
    while (offset < to && /[ \t]/.test(value[offset]!)) offset++;
    if (value[offset] !== ">") return from;
    offset++;
    if (/[ \t]/.test(value[offset] ?? "")) offset++;
  }
  const afterQuote = prefix.slice(prefix.lastIndexOf(">") + 1);
  const remainingIndent = /^[ \t]/.test(afterQuote) ? afterQuote.slice(1) : afterQuote;
  return consumeIndent(value, offset, to, whitespaceWidth(remainingIndent));
}

/** Strip proven fence containers while retaining original line endings and source offset mapping. */
export function composerFenceCode(value: string, fence: ComposerSourceFence) {
  const prefix = fenceContinuationPrefix(value, fence);
  const body = value.slice(fence.contentFrom, fence.contentTo);
  const lines: Array<{ codeFrom: number; codeTo: number; sourceFrom: number }> = [];
  let code = "";
  let lineFrom = fence.contentFrom;
  const appendLine = (lineTo: number, newline: string) => {
    const sourceFrom = fenceBodyStart(value, lineFrom, lineTo, prefix);
    const codeFrom = code.length;
    code += value.slice(sourceFrom, lineTo);
    lines.push({ codeFrom, codeTo: code.length, sourceFrom });
    code += newline;
    lineFrom = lineTo + newline.length;
  };
  for (const match of body.matchAll(/\r\n|\r|\n/g)) {
    appendLine(fence.contentFrom + match.index, match[0]);
  }
  if (lineFrom < fence.contentTo) appendLine(fence.contentTo, "");
  return { code, lines };
}

/** Fence and selection offsets are expanded source offsets, not collapsed chip offsets. */
export function insertComposerFenceNewline(
  value: string,
  selection: ComposerEditSelection,
  fence: ComposerSourceFence,
): ComposerSourceEdit | null {
  const ordered = orderedSelection(selection);
  if (!selectionInsideFence(ordered, fence)) return null;
  const { from, to } = ordered;
  const lineStart = lineStartAt(value, from);
  const lineEnd = lineEndAt(value, from);
  const prefix = fenceContinuationPrefix(value, fence);
  const openingLine = lineStart === lineStartAt(value, fence.from);
  const bodyStart = fenceBodyStart(value, lineStart, lineEnd, prefix);
  const indent = openingLine
    ? prefix
    : value.slice(lineStart, bodyStart) + /^[ \t]*/.exec(value.slice(bodyStart, from))![0];
  const newline = value.slice(lineEnd, lineEnd + 2) === "\r\n" ? "\r\n" : "\n";
  const openingEnd = lineEndAt(value, fence.from);
  const openingRun = /^ {0,3}(`{3,}|~{3,})/.exec(value.slice(fence.from, openingEnd))?.[1];
  const completeOpening =
    from === to && from === openingEnd && fence.contentTo === fence.to && openingRun !== undefined;
  const inserted = completeOpening
    ? `${newline}${indent}${newline}${indent}${openingRun}`
    : `${newline}${indent}`;
  const caret = from + newline.length + indent.length;
  return {
    value: value.slice(0, from) + inserted + value.slice(to),
    selection: { from: caret, to: caret },
  };
}

/** Tab inserts at a caret; selected code shifts by whole lines, as the existing composer did. */
export function indentComposerFenceLines(
  value: string,
  selection: ComposerEditSelection,
  fence: ComposerSourceFence,
  direction: "in" | "out",
): ComposerSourceEdit | null {
  const ordered = orderedSelection(selection);
  if (!selectionInsideFence(ordered, fence)) return null;
  const { from, to } = ordered;
  const prefix = fenceContinuationPrefix(value, fence);
  const caretLine = lineStartAt(value, from);
  const caretInBody =
    caretLine >= fence.contentFrom &&
    (caretLine < fence.contentTo ||
      (fence.contentTo === fence.to && caretLine === fence.contentTo));
  if (from === to && !caretInBody) return { value, selection: ordered };
  if (from === to && direction === "in") {
    const at = Math.max(from, fenceBodyStart(value, caretLine, lineEndAt(value, from), prefix));
    return {
      value: value.slice(0, at) + "  " + value.slice(at),
      selection: { from: at + 2, to: at + 2 },
    };
  }

  const start = Math.max(lineStartAt(value, from), fence.contentFrom);
  // A nonempty selection ending at the next line's start excludes that line.
  const end = lineEndAt(value, Math.max(from, to - 1));
  const edits: Array<{ from: number; removed: number; inserted: string }> = [];
  let lineFrom = start;
  while (lineFrom <= end && lineFrom < fence.contentTo) {
    const lineEnd = lineEndAt(value, lineFrom);
    const bodyStart = fenceBodyStart(value, lineFrom, lineEnd, prefix);
    const line = value.slice(bodyStart, lineEnd);
    if (direction === "in") {
      if (line.length > 0) edits.push({ from: bodyStart, removed: 0, inserted: "  " });
    } else {
      const removed = line.startsWith("  ") ? 2 : /^[ \t]/.test(line) ? 1 : 0;
      if (removed > 0) edits.push({ from: bodyStart, removed, inserted: "" });
    }
    const next = value.indexOf("\n", lineFrom);
    if (next === -1 || next >= end) break;
    lineFrom = next + 1;
  }

  const mapOffset = (offset: number) => {
    let delta = 0;
    for (const edit of edits) {
      if (offset < edit.from) break;
      if (offset < edit.from + edit.removed) return edit.from + delta + edit.inserted.length;
      delta += edit.inserted.length - edit.removed;
    }
    return offset + delta;
  };
  let nextValue = value;
  for (const edit of edits.toReversed()) {
    nextValue =
      nextValue.slice(0, edit.from) + edit.inserted + nextValue.slice(edit.from + edit.removed);
  }
  return { value: nextValue, selection: { from: mapOffset(from), to: mapOffset(to) } };
}

/** The toggle range selects only the single character inside the source checkbox. */
export function toggleComposerTaskCheckbox(
  value: string,
  selection: ComposerEditSelection,
  toggleRange: ComposerEditSelection,
): ComposerSourceEdit | null {
  const { from, to } = toggleRange;
  if (
    to !== from + 1 ||
    value[from - 1] !== "[" ||
    value[to] !== "]" ||
    !/^[ xX]$/.test(value.slice(from, to))
  )
    return null;
  return {
    value: value.slice(0, from) + (value[from] === " " ? "x" : " ") + value.slice(to),
    selection: { ...selection },
  };
}

/** Replaces only the language token. Whitespace and metadata remain byte-for-byte intact. */
export function replaceComposerFenceLanguage(
  value: string,
  selection: ComposerEditSelection,
  infoRange: ComposerEditSelection,
  language: string,
): ComposerSourceEdit {
  const { from, to } = infoRange;
  const suffix = value.slice(to, lineEndAt(value, to));
  // Metadata still needs a language in front, or Markdown treats it as the language.
  const replacement = withInfoStringLanguage(
    value.slice(from, to),
    language || (suffix.trim() ? "text" : ""),
  );
  const delta = replacement.length - (to - from);
  const mapOffset = (offset: number) => {
    if (offset < from) return offset;
    if (offset >= to) return offset + delta;
    return from + Math.min(offset - from, replacement.length);
  };
  return {
    value: value.slice(0, from) + replacement + value.slice(to),
    selection: { from: mapOffset(selection.from), to: mapOffset(selection.to) },
  };
}
