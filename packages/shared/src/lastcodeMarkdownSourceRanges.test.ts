import { describe, expect, it } from "vite-plus/test";

import { collectMarkdownSourceRanges } from "./lastcodeMarkdownSourceRanges.ts";

function inlineSlices(source: string) {
  return collectMarkdownSourceRanges(source).inline.map((range) => ({
    kind: range.kind,
    source: source.slice(range.from, range.to),
    content: source.slice(range.contentFrom, range.contentTo),
  }));
}

function lineSlices(source: string) {
  return collectMarkdownSourceRanges(source).lines.map((range) => ({
    kind: range.line,
    source: source.slice(range.lineFrom, range.lineTo),
    syntax: range.syntax.map(({ from, to }) => source.slice(from, to)),
    block: source.slice(range.blockFrom, range.blockTo),
  }));
}

describe("collectMarkdownSourceRanges inline syntax", () => {
  it("recognizes the paired underscore correction without treating a filename as emphasis", () => {
    expect(collectMarkdownSourceRanges("clean _build and node_").inline).toEqual([
      { kind: "emphasis", from: 6, to: 22, contentFrom: 7, contentTo: 21 },
    ]);
    expect(collectMarkdownSourceRanges("clean _build and node_modules").inline).toEqual([]);
  });

  it("protects both inline code spans from underscore emphasis", () => {
    expect(collectMarkdownSourceRanges("clean `_build` and `node_modules`").inline).toEqual([
      { kind: "inlineCode", from: 6, to: 14, contentFrom: 7, contentTo: 13 },
      { kind: "inlineCode", from: 19, to: 33, contentFrom: 20, contentTo: 32 },
    ]);
  });

  it("preserves mixed marker spelling and nested constructs", () => {
    expect(inlineSlices("*a* _b_ **c** __d__ ~~e~~ ***nested***")).toEqual([
      { kind: "emphasis", source: "*a*", content: "a" },
      { kind: "emphasis", source: "_b_", content: "b" },
      { kind: "strong", source: "**c**", content: "c" },
      { kind: "strong", source: "__d__", content: "d" },
      { kind: "delete", source: "~~e~~", content: "e" },
      { kind: "emphasis", source: "***nested***", content: "**nested**" },
      { kind: "strong", source: "**nested**", content: "nested" },
    ]);
  });

  it("does not decorate escaped, unpaired, or intraword underscore markers", () => {
    expect(inlineSlices(String.raw`\*literal\* foo_bar_baz _ open *also open`)).toEqual([]);
    expect(inlineSlices(String.raw`*a\*b*`)).toEqual([
      { kind: "emphasis", source: String.raw`*a\*b*`, content: String.raw`a\*b` },
    ]);
  });

  it("leaves code padding and inner backticks in their original positions", () => {
    expect(inlineSlices("`` a`b `` and ` **x** `")).toEqual([
      { kind: "inlineCode", source: "`` a`b ``", content: " a`b " },
      { kind: "inlineCode", source: "` **x** `", content: " **x** " },
    ]);
  });

  it("keeps multiline inline code and surrounding emphasis separate", () => {
    expect(inlineSlices("*before `one\n**two**` after*")).toEqual([
      {
        kind: "emphasis",
        source: "*before `one\n**two**` after*",
        content: "before `one\n**two**` after",
      },
      { kind: "inlineCode", source: "`one\n**two**`", content: "one\n**two**" },
    ]);
  });

  it("keeps a collapsed chip atomic while allowing surrounding emphasis", () => {
    expect(collectMarkdownSourceRanges("_￼_ **￼** ￼_node_modules").inline).toEqual([
      { kind: "emphasis", from: 0, to: 3, contentFrom: 1, contentTo: 2 },
      { kind: "strong", from: 4, to: 9, contentFrom: 6, contentTo: 7 },
    ]);
  });

  it("counts offsets in UTF-16 without normalizing entities or escapes", () => {
    const source = "😀 _a &amp; b_";
    expect(collectMarkdownSourceRanges(source).inline).toEqual([
      { kind: "emphasis", from: 3, to: 14, contentFrom: 4, contentTo: 13 },
    ]);
    expect(inlineSlices(source)[0]?.content).toBe("a &amp; b");
  });

  it("returns no presentation ranges for an empty or plain source", () => {
    expect(collectMarkdownSourceRanges("")).toEqual({ inline: [], lines: [], fences: [] });
    expect(collectMarkdownSourceRanges("plain text\nnext line")).toEqual({
      inline: [],
      lines: [],
      fences: [],
    });
  });
});

describe("collectMarkdownSourceRanges block syntax", () => {
  it("styles ATX headings and preserves an empty heading's prefix", () => {
    expect(lineSlices("## *Title*\n\n#   ")).toEqual([
      {
        kind: { kind: "heading", level: 2 },
        source: "## *Title*",
        syntax: ["## "],
        block: "## *Title*",
      },
      { kind: { kind: "heading", level: 1 }, source: "#   ", syntax: ["#   "], block: "#   " },
    ]);
  });

  it("styles setext headings without hiding their source", () => {
    const source = "A title\n=======\n\nSecond\n------";
    expect(lineSlices(source)).toEqual([
      {
        kind: { kind: "heading", level: 1 },
        source: "A title",
        syntax: [],
        block: "A title\n=======",
      },
      {
        kind: { kind: "heading", level: 1 },
        source: "=======",
        syntax: [],
        block: "A title\n=======",
      },
      {
        kind: { kind: "heading", level: 2 },
        source: "Second",
        syntax: [],
        block: "Second\n------",
      },
      {
        kind: { kind: "heading", level: 2 },
        source: "------",
        syntax: [],
        block: "Second\n------",
      },
    ]);
  });

  it("identifies quote prefixes per nesting level and leaves lazy continuation untouched", () => {
    const ranges = lineSlices("> outer\n> > inner\n> continuation\nlazy");
    expect(ranges.map(({ source, syntax }) => ({ source, syntax }))).toEqual([
      { source: "> outer", syntax: ["> "] },
      { source: "> > inner", syntax: ["> "] },
      { source: "> continuation", syntax: ["> "] },
      { source: "lazy", syntax: [] },
      { source: "> > inner", syntax: ["> "] },
      { source: "> continuation", syntax: [] },
      { source: "lazy", syntax: [] },
    ]);
    const inner = collectMarkdownSourceRanges("> outer\n> > inner\n> continuation\nlazy").lines[4]!;
    expect(inner.syntax).toEqual([{ from: 10, to: 12 }]);
  });

  it("keeps quote, list, task, and heading prefixes distinct in nested containers", () => {
    const source = "> - [X] done\n>\n>   ## heading\n>   > nested\n>   > next";
    const ranges = lineSlices(source);
    expect(ranges.find(({ kind }) => kind.kind === "task")).toMatchObject({
      kind: { kind: "task", checked: true },
      syntax: ["- ", "[X] "],
    });
    expect(ranges.find(({ kind }) => kind.kind === "heading")).toMatchObject({
      kind: { kind: "heading", level: 2 },
      syntax: ["## "],
    });
    const nestedQuotes = collectMarkdownSourceRanges(source).lines.filter(
      (range) => range.line.kind === "quote" && range.blockFrom > 0,
    );
    expect(nestedQuotes.map(({ syntax }) => syntax)).toEqual([
      [{ from: source.indexOf("> nested"), to: source.indexOf("> nested") + 2 }],
      [{ from: source.indexOf("> next"), to: source.indexOf("> next") + 2 }],
    ]);
  });

  it("preserves bullet, ordered, and task marker spelling", () => {
    expect(lineSlices("+ bullet\n\n3) ordered\n\n- [ ] todo\n- [x]\tdone")).toMatchObject([
      { kind: { kind: "bullet" }, syntax: ["+ "] },
      { kind: { kind: "ordered" }, syntax: ["3) "] },
      { kind: { kind: "task", checked: false }, syntax: ["- ", "[ ] "] },
      { kind: { kind: "task", checked: true }, syntax: ["- ", "[x]\t"] },
    ]);
  });

  it("does not hide a nested child's text in an empty parent list marker", () => {
    expect(lineSlices("-\n  - nested")).toMatchObject([
      { kind: { kind: "bullet" }, source: "-", syntax: ["-"] },
      { kind: { kind: "bullet" }, source: "  - nested", syntax: ["- "] },
    ]);
  });

  it("marks thematic rules without confusing setext underlines or list items", () => {
    expect(
      lineSlices("***\n\n> - - -\n\n---").filter(({ kind }) => kind.kind === "rule"),
    ).toMatchObject([
      { source: "***", syntax: ["***"] },
      { source: "> - - -", syntax: ["- - -"] },
      { source: "---", syntax: ["---"] },
    ]);
  });

  it("suppresses formatting inside indented code", () => {
    const source = "    **literal**\n    _literal_";
    expect(collectMarkdownSourceRanges(source).inline).toEqual([]);
    expect(lineSlices(source)).toMatchObject([
      { kind: { kind: "indentedCode" }, syntax: [] },
      { kind: { kind: "indentedCode" }, syntax: [] },
    ]);
  });

  it("keeps a fence-looking line inside indented code literal", () => {
    const source = "    ```ts\n    **literal**";
    const ranges = collectMarkdownSourceRanges(source);
    expect(ranges.fences).toEqual([]);
    expect(ranges.inline).toEqual([]);
    expect(ranges.lines.map(({ line }) => line.kind)).toEqual(["indentedCode", "indentedCode"]);
  });
});

describe("collectMarkdownSourceRanges fences", () => {
  it("retains exact body offsets and language-token boundaries when metadata follows", () => {
    const source = "```ts title=example\n**literal**\n```";
    const ranges = collectMarkdownSourceRanges(source);
    expect(ranges.inline).toEqual([]);
    expect(ranges.fences).toEqual([
      { from: 0, to: 35, contentFrom: 20, contentTo: 32, language: "ts" },
    ]);
    expect(ranges.lines[0]?.line).toEqual({
      kind: "fenceOpen",
      language: "ts",
      infoFrom: 3,
      infoTo: 5,
    });
    expect(lineSlices(source)).toMatchObject([
      { kind: { kind: "fenceOpen" }, syntax: ["```ts title=example"] },
      { kind: { kind: "fenceBody" }, syntax: [] },
      { kind: { kind: "fenceClose" }, syntax: ["```"] },
    ]);
    expect(ranges.lines.every(({ blockFrom, blockTo }) => blockFrom === 0 && blockTo === 35)).toBe(
      true,
    );
  });

  it("keeps an unfinished fence body through source end", () => {
    const source = "```\n_body_\n";
    const ranges = collectMarkdownSourceRanges(source);
    expect(ranges.fences).toEqual([
      { from: 0, to: source.length, contentFrom: 4, contentTo: source.length, language: "" },
    ]);
    expect(ranges.inline).toEqual([]);
    expect(ranges.lines.map(({ line }) => line.kind)).toEqual(["fenceOpen", "fenceBody"]);
    expect(collectMarkdownSourceRanges("```").fences).toEqual([
      { from: 0, to: 3, contentFrom: 3, contentTo: 3, language: "" },
    ]);
  });

  it("recognizes tilde fences, longer closing runs, indentation, and empty bodies", () => {
    const source = "  ~~~~ ruby extra\n   ~~~~~\t";
    const ranges = collectMarkdownSourceRanges(source);
    expect(ranges.fences).toHaveLength(1);
    expect(ranges.fences[0]?.language).toBe("ruby");
    expect(ranges.fences[0]?.contentFrom).toBe(ranges.fences[0]?.contentTo);
    expect(ranges.lines.map(({ line }) => line.kind)).toEqual(["fenceOpen", "fenceClose"]);
    const opening = ranges.lines[0]?.line;
    expect(opening).toMatchObject({ kind: "fenceOpen", infoFrom: 7, infoTo: 11 });
    expect(lineSlices(source)[1]?.syntax).toEqual(["   ~~~~~\t"]);
  });

  it("does not close on the wrong marker, a short run, or trailing text", () => {
    const source = "````js\n```\n~~~~\n```` trailing";
    const ranges = collectMarkdownSourceRanges(source);
    expect(ranges.fences[0]?.contentTo).toBe(source.length);
    expect(ranges.lines.map(({ line }) => line.kind)).toEqual([
      "fenceOpen",
      "fenceBody",
      "fenceBody",
      "fenceBody",
    ]);
  });

  it("recognizes fenced code under nested quote and list prefixes", () => {
    const source = "> - ```ts meta\n>   > literal\n>   ```";
    const ranges = collectMarkdownSourceRanges(source);
    expect(ranges.fences).toEqual([
      { from: 4, to: source.length, contentFrom: 15, contentTo: 29, language: "ts" },
    ]);
    expect(
      ranges.lines.filter(({ line }) => line.kind.startsWith("fence")).map(({ line }) => line.kind),
    ).toEqual(["fenceOpen", "fenceBody", "fenceClose"]);
    const quoteSyntax = ranges.lines
      .filter(({ line }) => line.kind === "quote")
      .flatMap(({ syntax }) => syntax);
    expect(quoteSyntax).toEqual([
      { from: 0, to: 2 },
      { from: 15, to: 17 },
      { from: 29, to: 31 },
    ]);
    expect(lineSlices(source).find(({ kind }) => kind.kind === "fenceClose")?.syntax).toEqual([
      "```",
    ]);
  });

  it("preserves CRLF offsets and does not include newlines in line syntax", () => {
    const source = "```ts\r\nx\r\n```\r\n";
    const ranges = collectMarkdownSourceRanges(source);
    expect(ranges.fences).toEqual([
      { from: 0, to: 13, contentFrom: 7, contentTo: 10, language: "ts" },
    ]);
    expect(ranges.lines.map(({ lineFrom, lineTo }) => [lineFrom, lineTo])).toEqual([
      [0, 5],
      [7, 8],
      [10, 13],
    ]);
  });

  it("finds nested fence closers after tab-padded and indented list markers", () => {
    const source = "   - \t```ts\n        x\n        ```";
    const ranges = collectMarkdownSourceRanges(source);
    expect(ranges.fences).toHaveLength(1);
    expect(
      ranges.lines.filter(({ line }) => line.kind.startsWith("fence")).map(({ line }) => line.kind),
    ).toEqual(["fenceOpen", "fenceBody", "fenceClose"]);
    expect(lineSlices(source).find(({ kind }) => kind.kind === "fenceClose")?.syntax).toEqual([
      "```",
    ]);
  });
});
