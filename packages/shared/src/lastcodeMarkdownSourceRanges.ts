import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

export type MarkdownInlineKind = "emphasis" | "strong" | "delete" | "inlineCode";
export type MarkdownLineKind =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6 }
  | { kind: "quote" }
  | { kind: "bullet" }
  | { kind: "ordered" }
  | { kind: "task"; checked: boolean }
  | { kind: "rule" }
  | { kind: "fenceOpen"; language: string; infoFrom: number; infoTo: number }
  | { kind: "fenceBody" }
  | { kind: "fenceClose" }
  | { kind: "indentedCode" };

export interface MarkdownSourceRanges {
  // Hideable delimiters are [from, contentFrom) and [contentTo, to).
  inline: Array<{
    kind: MarkdownInlineKind;
    from: number;
    to: number;
    contentFrom: number;
    contentTo: number;
  }>;
  lines: Array<{
    // Physical line bounds exclude newline characters; nested blocks may share a line.
    lineFrom: number;
    lineTo: number;
    line: MarkdownLineKind;
    syntax: Array<{ from: number; to: number }>;
    blockFrom: number;
    blockTo: number;
  }>;
  fences: Array<{
    from: number;
    to: number;
    contentFrom: number;
    // A closed fence's body ends at its closing line's start, keeping the final newline.
    contentTo: number;
    language: string;
  }>;
}

type MarkdownNode = {
  readonly type: string;
  readonly depth?: number | undefined;
  readonly checked?: boolean | null | undefined;
  readonly children?: readonly MarkdownNode[] | undefined;
  readonly position?:
    | {
        readonly start: { readonly offset?: number | undefined };
        readonly end: { readonly offset?: number | undefined };
      }
    | undefined;
};
type SourceLine = { from: number; to: number; next: number };
type Container =
  | { kind: "quote" }
  | { kind: "list"; firstLine: number; contentFrom: number; indent: number };

const parser = unified().use(remarkParse).use(remarkGfm);

function sourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let from = 0;
  for (const match of source.matchAll(/\r\n|\r|\n/g)) {
    lines.push({ from, to: match.index, next: match.index + match[0].length });
    from = match.index + match[0].length;
  }
  lines.push({ from, to: source.length, next: source.length });
  return lines;
}

function columns(source: string, from: number, to: number): number {
  let column = 0;
  for (let offset = from; offset < to; offset++) {
    column += source[offset] === "\t" ? 4 - (column % 4) : 1;
  }
  return column;
}

/** Collect presentation ranges without changing the Markdown or normalizing its text. */
export function collectMarkdownSourceRanges(source: string): MarkdownSourceRanges {
  // Chips occupy one U+FFFC here; send time parses their real source instead.
  const result: MarkdownSourceRanges = { inline: [], lines: [], fences: [] };
  const lines = sourceLines(source);
  const lineIndex = (offset: number) => {
    let low = 0;
    let high = lines.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (lines[middle]!.from <= offset) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  const blockLines = (from: number, to: number) => {
    const first = lineIndex(from);
    let last = lineIndex(to);
    if (last > first && lines[last]!.from === to) last--;
    return lines.slice(first, last + 1);
  };
  const addLine = (
    sourceLine: SourceLine,
    line: MarkdownLineKind,
    syntax: Array<{ from: number; to: number }>,
    blockFrom: number,
    blockTo: number,
  ) => {
    result.lines.push({
      lineFrom: sourceLine.from,
      lineTo: sourceLine.to,
      line,
      syntax,
      blockFrom,
      blockTo,
    });
  };
  // Strip only containers proved by the AST, so a literal ">" in a code body
  // or a lazy continuation cannot become hideable quote syntax.
  const containerContentStart = (line: SourceLine, containers: readonly Container[]) => {
    let offset = line.from;
    for (const container of containers) {
      if (container.kind === "quote") {
        const prefix = /^ {0,3}>[ \t]?/.exec(source.slice(offset, line.to));
        if (prefix) offset += prefix[0].length;
      } else if (container.firstLine === line.from) {
        offset = container.contentFrom;
      } else {
        let width = columns(source, line.from, offset);
        const target = width + container.indent;
        while (offset < line.to && /[ \t]/.test(source[offset]!)) {
          const step = source[offset] === "\t" ? 4 - (width % 4) : 1;
          if (width + step > target) break;
          width += step;
          offset++;
          if (width === target) break;
        }
      }
    }
    return offset;
  };

  const visit = (node: MarkdownNode, containers: readonly Container[]): void => {
    const from = node.position?.start.offset;
    const to = node.position?.end.offset;
    if (from === undefined || to === undefined) return;
    const firstLine = lines[lineIndex(from)]!;
    const firstChild = node.children?.[0]?.position?.start.offset;
    const lastChild = node.children?.at(-1)?.position?.end.offset;
    let childContainers = containers;

    if (node.type === "inlineCode") {
      const ticks = /^`+/.exec(source.slice(from, to))?.[0].length;
      if (ticks !== undefined) {
        result.inline.push({
          kind: "inlineCode",
          from,
          to,
          contentFrom: from + ticks,
          contentTo: to - ticks,
        });
      }
      return;
    }
    if (
      (node.type === "emphasis" || node.type === "strong" || node.type === "delete") &&
      firstChild !== undefined &&
      lastChild !== undefined
    ) {
      result.inline.push({
        kind: node.type,
        from,
        to,
        contentFrom: firstChild,
        contentTo: lastChild,
      });
    } else if (node.type === "heading") {
      const level = node.depth;
      if (level === 1 || level === 2 || level === 3 || level === 4 || level === 5 || level === 6) {
        const atx = /^#{1,6}(?:[ \t]+|$)/.test(source.slice(from, firstLine.to));
        for (const line of blockLines(from, to)) {
          addLine(
            line,
            { kind: "heading", level },
            atx && line === firstLine
              ? [{ from, to: Math.min(firstChild ?? firstLine.to, firstLine.to) }]
              : [],
            from,
            to,
          );
        }
      }
    } else if (node.type === "blockquote") {
      for (const line of blockLines(from, to)) {
        const start = containerContentStart(line, containers);
        const prefix = /^ {0,3}>[ \t]?/.exec(source.slice(start, line.to));
        addLine(
          line,
          { kind: "quote" },
          prefix ? [{ from: start, to: start + prefix[0].length }] : [],
          from,
          to,
        );
      }
      childContainers = [...containers, { kind: "quote" }];
    } else if (node.type === "listItem") {
      const marker = /^(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/.exec(source.slice(from, firstLine.to));
      if (marker) {
        const markerTo = from + marker[0].length;
        const contentFrom = Math.min(firstChild ?? markerTo, firstLine.to);
        const task =
          node.checked !== null && node.checked !== undefined
            ? /^\[[ xX]\][ \t]/.exec(source.slice(markerTo, firstLine.to))
            : null;
        const syntax = [{ from, to: task ? markerTo : contentFrom }];
        if (task) syntax.push({ from: markerTo, to: markerTo + task[0].length });
        addLine(
          firstLine,
          task
            ? { kind: "task", checked: /[xX]/.test(task[0][1]!) }
            : /^\d/.test(marker[0])
              ? { kind: "ordered" }
              : { kind: "bullet" },
          syntax,
          from,
          to,
        );
        childContainers = [
          ...containers,
          {
            kind: "list",
            firstLine: firstLine.from,
            contentFrom,
            indent:
              columns(source, firstLine.from, markerTo) -
              columns(source, firstLine.from, containerContentStart(firstLine, containers)),
          },
        ];
      }
    } else if (node.type === "thematicBreak") {
      addLine(firstLine, { kind: "rule" }, [{ from, to }], from, to);
    } else if (node.type === "code") {
      const opening = /^ {0,3}(`{3,}|~{3,})[ \t]*/.exec(source.slice(from, firstLine.to));
      const codeLines = blockLines(from, to);
      if (opening) {
        const run = opening[1]!;
        const infoFrom = from + opening[0].length;
        const language = /^[^ \t]*/.exec(source.slice(infoFrom, firstLine.to))?.[0] ?? "";
        const lastLine = codeLines.at(-1)!;
        const closingFrom = containerContentStart(lastLine, containers);
        const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(source.slice(closingFrom, lastLine.to));
        const closed =
          lastLine !== firstLine &&
          closing !== null &&
          closing[1]![0] === run[0] &&
          closing[1]!.length >= run.length;
        const contentFrom = Math.min(firstLine.next, to);
        const contentTo = closed ? lastLine.from : to;
        result.fences.push({ from, to, contentFrom, contentTo, language });
        addLine(
          firstLine,
          { kind: "fenceOpen", language, infoFrom, infoTo: infoFrom + language.length },
          [{ from, to: firstLine.to }],
          from,
          to,
        );
        for (const line of codeLines.slice(1)) {
          addLine(
            line,
            { kind: closed && line === lastLine ? "fenceClose" : "fenceBody" },
            closed && line === lastLine ? [{ from: closingFrom, to: line.to }] : [],
            from,
            to,
          );
        }
      } else {
        for (const line of codeLines) addLine(line, { kind: "indentedCode" }, [], from, to);
      }
      return;
    }

    for (const child of node.children ?? []) visit(child, childContainers);
  };

  visit(parser.parse(source), []);
  return result;
}
