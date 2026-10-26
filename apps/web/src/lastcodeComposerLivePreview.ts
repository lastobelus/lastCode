import type {
  MarkdownInlineKind,
  MarkdownLineKind,
  MarkdownSourceRanges,
} from "@t3tools/shared/lastcodeMarkdownSourceRanges";

export const MAX_COMPOSER_LIVE_PREVIEW_LENGTH = 12_000;

export type ComposerSourceSelection = { from: number; to: number };
export type ComposerPreviewClassRange = ComposerSourceSelection & { className: string };
export type ComposerPreviewWidget =
  | { kind: "bullet"; from: number }
  | { kind: "task"; from: number; checked: boolean }
  | { kind: "fenceHeader"; from: number; language: string };

export interface ComposerLivePreview {
  classRanges: ComposerPreviewClassRange[];
  lineClasses: ComposerPreviewClassRange[];
  widgets: ComposerPreviewWidget[];
}

const INLINE_CLASSES: Record<MarkdownInlineKind, string> = {
  emphasis: "composer-md-em",
  strong: "composer-md-strong",
  delete: "composer-md-strike",
  inlineCode: "composer-md-code",
};

function lineClass(line: MarkdownLineKind): string {
  switch (line.kind) {
    case "heading":
      return `composer-md-h${line.level}`;
    case "quote":
      return "composer-md-quote";
    case "bullet":
    case "ordered":
      return "composer-md-list";
    case "task":
      return "composer-md-task";
    case "rule":
      return "composer-md-rule";
    case "fenceOpen":
      return "composer-md-fence-open";
    case "fenceBody":
      return "composer-md-fence-body";
    case "fenceClose":
      return "composer-md-fence-close";
    case "indentedCode":
      return "composer-md-code";
  }
}

function touches(selection: ComposerSourceSelection, from: number, to: number): boolean {
  return (
    Math.max(selection.from, selection.to) >= from && Math.min(selection.from, selection.to) <= to
  );
}

function byPosition(left: ComposerSourceSelection, right: ComposerSourceSelection): number {
  return left.from - right.from || left.to - right.to;
}

/** Presentation only: every range remains in the parser's collapsed source coordinates. */
export function buildComposerLivePreview(
  ranges: MarkdownSourceRanges,
  selection: ComposerSourceSelection,
  enabled: boolean,
  sourceLength: number,
): ComposerLivePreview {
  const preview: ComposerLivePreview = {
    classRanges: [],
    lineClasses: [],
    widgets: [],
  };
  if (!enabled || sourceLength > MAX_COMPOSER_LIVE_PREVIEW_LENGTH) return preview;

  const addSyntax = (from: number, to: number, hidden: boolean) => {
    if (from >= to) return;
    preview.classRanges.push({
      from,
      to,
      className: hidden ? "composer-md-syntax composer-md-syntax-hidden" : "composer-md-syntax",
    });
  };

  for (const inline of ranges.inline) {
    const hidden = !touches(selection, inline.from, inline.to);
    const from = inline.kind === "inlineCode" ? inline.from : inline.contentFrom;
    const to = inline.kind === "inlineCode" ? inline.to : inline.contentTo;
    if (from < to) preview.classRanges.push({ from, to, className: INLINE_CLASSES[inline.kind] });
    addSyntax(inline.from, inline.contentFrom, hidden);
    addSyntax(inline.contentTo, inline.to, hidden);
  }

  for (const { lineFrom, lineTo, line, syntax, blockFrom, blockTo } of ranges.lines) {
    preview.lineClasses.push({ from: lineFrom, to: lineTo, className: lineClass(line) });
    const fence =
      line.kind === "fenceOpen" || line.kind === "fenceBody" || line.kind === "fenceClose";
    const active = fence
      ? touches(selection, blockFrom, blockTo)
      : touches(selection, lineFrom, lineTo);
    const hidden = !active && line.kind !== "ordered" && line.kind !== "indentedCode";
    for (const range of syntax) addSyntax(range.from, range.to, hidden);
    if (!hidden || syntax.length === 0) continue;

    const from = syntax[0]!.from;
    switch (line.kind) {
      case "bullet":
        preview.widgets.push({ kind: "bullet", from });
        break;
      case "task":
        preview.widgets.push({
          kind: "task",
          from,
          checked: line.checked,
        });
        break;
      case "fenceOpen":
        preview.widgets.push({
          kind: "fenceHeader",
          from,
          language: line.language,
        });
        break;
    }
  }

  preview.classRanges.sort(byPosition);
  preview.lineClasses.sort(byPosition);
  preview.widgets.sort((left, right) => left.from - right.from);
  return preview;
}
