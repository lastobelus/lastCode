import { describe, expect, it } from "vite-plus/test";
import { collectMarkdownSourceRanges } from "@t3tools/shared/markdownSourceRanges";

import {
  composerFenceCode,
  composerSourceFormattingEdits,
  indentComposerFenceLines,
  insertComposerFenceNewline,
  replaceComposerFenceLanguage,
  toggleComposerTaskCheckbox,
  type ComposerFormattingDelimiter,
  type ComposerSourceFence,
} from "./composerSourceEdits";

function toggleComposerSourceFormatting(
  value: string,
  selection: { from: number; to: number },
  delimiter: ComposerFormattingDelimiter,
) {
  const decision = composerSourceFormattingEdits(value, selection, delimiter);
  let nextValue = value;
  for (const edit of decision.edits) {
    nextValue = nextValue.slice(0, edit.from) + edit.text + nextValue.slice(edit.to);
  }
  return { value: nextValue, selection: decision.selection };
}

function fence(value: string): ComposerSourceFence {
  const range = collectMarkdownSourceRanges(value).fences[0];
  if (!range) throw new Error("test source has no fence");
  return range;
}

describe("composer source formatting", () => {
  it("returns descending minimal edits around source that can belong to an atom", () => {
    const value = "before @README.md after";
    const decision = composerSourceFormattingEdits(value, { from: 7, to: 17 }, "**");
    expect(decision).toEqual({
      edits: [
        { from: 17, to: 17, text: "**" },
        { from: 7, to: 7, text: "**" },
      ],
      selection: { from: 9, to: 19 },
    });
    const formatted = toggleComposerSourceFormatting(value, { from: 7, to: 17 }, "**");
    expect(formatted.value).toBe("before **@README.md** after");
    expect(composerSourceFormattingEdits(formatted.value, formatted.selection, "**").edits).toEqual(
      [
        { from: 19, to: 21, text: "" },
        { from: 7, to: 9, text: "" },
      ],
    );
  });

  it.each([
    { from: 0, to: 8 },
    { from: 2, to: 6 },
  ])("adds italics without removing a bold run at $from:$to", (selection) => {
    const italic = toggleComposerSourceFormatting("**bold**", selection, "*");
    expect(italic).toEqual({
      value: "***bold***",
      selection: { from: selection.from + 1, to: selection.to + 1 },
    });
    expect(toggleComposerSourceFormatting(italic.value, italic.selection, "*")).toEqual({
      value: "**bold**",
      selection,
    });
  });

  it("removes outer strong while retaining nested strike for full and content selections", () => {
    const source = "**~~x~~**";
    for (const selection of [
      { from: 4, to: 5 },
      { from: 0, to: source.length },
    ]) {
      const unwrapped = toggleComposerSourceFormatting(source, selection, "**");
      expect(unwrapped.value).toBe("~~x~~");
      expect(unwrapped.selection).toEqual(
        selection.from === 0 ? { from: 0, to: 5 } : { from: 2, to: 3 },
      );
      expect(composerSourceFormattingEdits(source, selection, "**").edits).toEqual([
        { from: 7, to: 9, text: "" },
        { from: 0, to: 2, text: "" },
      ]);
      const wrapped = toggleComposerSourceFormatting(unwrapped.value, unwrapped.selection, "**");
      expect(wrapped.value).toBe(selection.from === 0 ? source : "~~**x**~~");
      expect(toggleComposerSourceFormatting(wrapped.value, wrapped.selection, "**")).toEqual(
        unwrapped,
      );
    }
  });

  it("removes outer strike while retaining nested strong for full and content selections", () => {
    const source = "~~**x**~~";
    for (const selection of [
      { from: 4, to: 5 },
      { from: 0, to: source.length },
    ]) {
      const unwrapped = toggleComposerSourceFormatting(source, selection, "~~");
      expect(unwrapped.value).toBe("**x**");
      expect(unwrapped.selection).toEqual(
        selection.from === 0 ? { from: 0, to: 5 } : { from: 2, to: 3 },
      );
      const wrapped = toggleComposerSourceFormatting(unwrapped.value, unwrapped.selection, "~~");
      expect(wrapped.value).toBe(selection.from === 0 ? source : "**~~x~~**");
      expect(toggleComposerSourceFormatting(wrapped.value, wrapped.selection, "~~")).toEqual(
        unwrapped,
      );
    }
  });

  it("removes code and surrounding bold separately while retaining the other delimiters", () => {
    const source = "**`x`**";
    const selection = { from: 3, to: 4 };
    const plainStrong = toggleComposerSourceFormatting(source, selection, "`");
    expect(plainStrong).toEqual({ value: "**x**", selection: { from: 2, to: 3 } });
    expect(toggleComposerSourceFormatting(plainStrong.value, plainStrong.selection, "`")).toEqual({
      value: source,
      selection,
    });
    const plainCode = toggleComposerSourceFormatting(source, selection, "**");
    expect(plainCode).toEqual({ value: "`x`", selection: { from: 1, to: 2 } });
  });

  it("preserves wildcard stars that do not parse as an emphasis pair", () => {
    const source = "files *.ts and *.js";
    expect(toggleComposerSourceFormatting(source, { from: 7, to: 15 }, "*")).toEqual({
      value: "files **.ts and **.js",
      selection: { from: 8, to: 16 },
    });
  });

  it("preserves an escaped opening star when wrapping its selected literal text", () => {
    expect(toggleComposerSourceFormatting("\\*word*", { from: 2, to: 6 }, "*")).toEqual({
      value: "\\**word**",
      selection: { from: 3, to: 7 },
    });
  });

  it("treats unparsed nonempty spaced pairs as literal source instead of removing them", () => {
    expect(toggleComposerSourceFormatting("** word **", { from: 2, to: 8 }, "**")).toEqual({
      value: "**** word ****",
      selection: { from: 4, to: 10 },
    });
  });

  it("distinguishes an empty bold pair from an empty italic pair", () => {
    expect(toggleComposerSourceFormatting("****", { from: 2, to: 2 }, "*")).toEqual({
      value: "******",
      selection: { from: 3, to: 3 },
    });
    expect(toggleComposerSourceFormatting("****", { from: 2, to: 2 }, "**")).toEqual({
      value: "",
      selection: { from: 0, to: 0 },
    });
  });

  it("does not remove one backtick from a longer inline-code delimiter", () => {
    expect(toggleComposerSourceFormatting("``two``", { from: 2, to: 5 }, "`")).toEqual({
      value: "```two```",
      selection: { from: 3, to: 6 },
    });
  });
  it.each<ComposerFormattingDelimiter>(["**", "*", "`", "~~"])(
    "wraps and unwraps only the selected source with %s",
    (delimiter) => {
      const value = "prefix selected suffix";
      const edit = toggleComposerSourceFormatting(value, { from: 7, to: 15 }, delimiter);
      expect(edit).toEqual({
        value: `prefix ${delimiter}selected${delimiter} suffix`,
        selection: { from: 7 + delimiter.length, to: 15 + delimiter.length },
      });
      expect(toggleComposerSourceFormatting(edit.value, edit.selection, delimiter)).toEqual({
        value,
        selection: { from: 7, to: 15 },
      });
    },
  );

  it.each<ComposerFormattingDelimiter>(["**", "*", "`", "~~"])(
    "removes selected inner delimiters with %s",
    (delimiter) => {
      const value = `prefix ${delimiter}selected${delimiter} suffix`;
      expect(
        toggleComposerSourceFormatting(
          value,
          { from: 7, to: 15 + delimiter.length * 2 },
          delimiter,
        ),
      ).toEqual({
        value: "prefix selected suffix",
        selection: { from: 7, to: 15 },
      });
    },
  );

  it.each<ComposerFormattingDelimiter>(["**", "*", "`", "~~"])(
    "inserts an empty pair and then removes it with %s",
    (delimiter) => {
      const edit = toggleComposerSourceFormatting("before after", { from: 7, to: 7 }, delimiter);
      expect(edit).toEqual({
        value: `before ${delimiter}${delimiter}after`,
        selection: { from: 7 + delimiter.length, to: 7 + delimiter.length },
      });
      expect(toggleComposerSourceFormatting(edit.value, edit.selection, delimiter)).toEqual({
        value: "before after",
        selection: { from: 7, to: 7 },
      });
    },
  );

  it("preserves a manually chosen underscore and surrounding nested formatting", () => {
    expect(toggleComposerSourceFormatting("_manual_", { from: 1, to: 7 }, "*")).toEqual({
      value: "_*manual*_",
      selection: { from: 2, to: 8 },
    });
    expect(toggleComposerSourceFormatting("***nested***", { from: 3, to: 9 }, "**")).toEqual({
      value: "*nested*",
      selection: { from: 1, to: 7 },
    });
  });

  it("keeps malformed or unmatched source intact outside the explicit edit", () => {
    expect(toggleComposerSourceFormatting("**one *two", { from: 2, to: 5 }, "**")).toEqual({
      value: "****one** *two",
      selection: { from: 4, to: 7 },
    });
    expect(
      toggleComposerSourceFormatting("a @path with spaces b", { from: 2, to: 19 }, "**"),
    ).toEqual({ value: "a **@path with spaces** b", selection: { from: 4, to: 21 } });
  });
});

describe("composer fence source edits", () => {
  it.each([
    { opening: "> ```ts", prefix: "> " },
    { opening: "> > ```ts", prefix: "> > " },
    { opening: "- ```sh", prefix: "  " },
    { opening: "12. ```sh", prefix: "    " },
    { opening: "> - ```sh", prefix: ">   " },
    { opening: "- > ```sh", prefix: "  > " },
  ])(
    "completes an opening fence inside $opening without recreating its list marker",
    ({ opening, prefix }) => {
      const edit = insertComposerFenceNewline(
        opening,
        { from: opening.length, to: opening.length },
        fence(opening),
      );
      expect(edit).toEqual({
        value: `${opening}\n${prefix}\n${prefix}\`\`\``,
        selection: {
          from: opening.length + 1 + prefix.length,
          to: opening.length + 1 + prefix.length,
        },
      });
      const closed = fence(edit!.value);
      expect(closed.contentTo).toBeLessThan(closed.to);
    },
  );

  it.each([
    {
      source: "> ```ts\n>   one two\n> ```",
      expected: "> ```ts\n>   one \n>   two\n> ```",
      prefix: ">   ",
    },
    {
      source: "> > ```ts\n>>  one two\n> > ```",
      expected: "> > ```ts\n>>  one \n>>  two\n> > ```",
      prefix: ">>  ",
    },
    {
      source: "- ```ts\n    one two\n  ```",
      expected: "- ```ts\n    one \n    two\n  ```",
      prefix: "    ",
    },
    {
      source: "> - ```ts\n>     one two\n>   ```",
      expected: "> - ```ts\n>     one \n>     two\n>   ```",
      prefix: ">     ",
    },
  ])(
    "keeps the body's exact container prefix while splitting $source",
    ({ source, expected, prefix }) => {
      const from = source.indexOf("two");
      expect(insertComposerFenceNewline(source, { from, to: from }, fence(source))).toEqual({
        value: expected,
        selection: { from: from + 1 + prefix.length, to: from + 1 + prefix.length },
      });
      expect(fence(expected).contentTo).toBeLessThan(fence(expected).to);
    },
  );

  it.each([
    { source: "> ```ts\n> code\n> ```", expected: "> ```ts\n>   code\n> ```" },
    { source: "- ```ts\n  code\n  ```", expected: "- ```ts\n    code\n  ```" },
    { source: "> - ```ts\n>   code\n>   ```", expected: "> - ```ts\n>     code\n>   ```" },
    { source: "> > ```ts\n>> code\n> > ```", expected: "> > ```ts\n>>   code\n> > ```" },
  ])(
    "indents after the container and leaves fence markers intact in $source",
    ({ source, expected }) => {
      const range = fence(source);
      const selection = { from: range.from, to: range.to };
      const indented = indentComposerFenceLines(source, selection, range, "in")!;
      expect(indented.value).toBe(expected);
      expect(fence(indented.value).contentTo).toBeLessThan(fence(indented.value).to);
      expect(
        indentComposerFenceLines(indented.value, indented.selection, fence(indented.value), "out"),
      ).toEqual({ value: source, selection });
    },
  );

  it("indents only the body when the selection includes both fence markers, even twice", () => {
    const source = "```ts\none\n\ntwo\n```";
    const selection = { from: 0, to: source.length };
    const once = indentComposerFenceLines(source, selection, fence(source), "in")!;
    const twice = indentComposerFenceLines(once.value, once.selection, fence(once.value), "in")!;
    expect(once.value).toBe("```ts\n  one\n\n  two\n```");
    expect(twice.value).toBe("```ts\n    one\n\n    two\n```");
    expect(fence(twice.value).contentTo).toBeLessThan(fence(twice.value).to);
    const backOnce = indentComposerFenceLines(
      twice.value,
      twice.selection,
      fence(twice.value),
      "out",
    )!;
    expect(
      indentComposerFenceLines(backOnce.value, backOnce.selection, fence(backOnce.value), "out"),
    ).toEqual({ value: source, selection });
  });

  it("does not outdent structural list padding or blank quote prefixes", () => {
    const source = "> - ```ts\n>   code\n>   \n>   ```";
    const range = fence(source);
    const selection = { from: range.from, to: range.to };
    expect(indentComposerFenceLines(source, selection, range, "out")).toEqual({
      value: source,
      selection,
    });
    expect(indentComposerFenceLines(source, selection, range, "in")!.value).toBe(
      "> - ```ts\n>     code\n>   \n>   ```",
    );
  });

  it("keeps a code greater-than operator out of the quote continuation prefix", () => {
    const source = "> ```ts\n> > code\n> ```";
    const cursor = source.indexOf("code") + 4;
    expect(
      insertComposerFenceNewline(source, { from: cursor, to: cursor }, fence(source))!.value,
    ).toBe("> ```ts\n> > code\n> \n> ```");
  });

  it("treats Tab on an opening or closing marker as handled without changing its source", () => {
    const source = "> ```ts\n> code\n> ```";
    const range = fence(source);
    for (const cursor of [range.from + 1, range.to]) {
      const selection = { from: cursor, to: cursor };
      expect(indentComposerFenceLines(source, selection, range, "in")).toEqual({
        value: source,
        selection,
      });
      expect(indentComposerFenceLines(source, selection, range, "out")).toEqual({
        value: source,
        selection,
      });
    }
  });

  it.each(["```", "```ts", "````ts title=x", "~~~python"])(
    "completes an unclosed opening fence %s",
    (value) => {
      const run = /^(`+|~+)/.exec(value)![0];
      const range = {
        from: 0,
        to: value.length,
        contentFrom: value.length,
        contentTo: value.length,
      };
      expect(
        insertComposerFenceNewline(value, { from: value.length, to: value.length }, range),
      ).toEqual({
        value: `${value}\n\n${run}`,
        selection: { from: value.length + 1, to: value.length + 1 },
      });
    },
  );

  it("keeps indentation when completing a fence", () => {
    const value = "  ```ts";
    expect(
      insertComposerFenceNewline(
        value,
        { from: 7, to: 7 },
        { from: 2, to: 7, contentFrom: 7, contentTo: 7 },
      ),
    ).toEqual({
      value: "  ```ts\n  \n  ```",
      selection: { from: 10, to: 10 },
    });
  });

  it("does not add a second closer to an already closed fence", () => {
    const value = "```ts\nbody\n```\nafter";
    expect(insertComposerFenceNewline(value, { from: 5, to: 5 }, fence(value))).toEqual({
      value: "```ts\n\nbody\n```\nafter",
      selection: { from: 6, to: 6 },
    });
  });

  it("replaces selected code with an indented newline and preserves the rest", () => {
    const value = "before\n```ts\n  one two\n```\nafter";
    const from = value.indexOf("two");
    expect(insertComposerFenceNewline(value, { from, to: from + 3 }, fence(value))).toEqual({
      value: "before\n```ts\n  one \n  \n```\nafter",
      selection: { from: from + 3, to: from + 3 },
    });
  });

  it("keeps a closing line literal when Enter is pressed there", () => {
    const value = "```\nbody\n```";
    expect(
      insertComposerFenceNewline(value, { from: value.length, to: value.length }, fence(value)),
    ).toEqual({
      value: `${value}\n`,
      selection: { from: value.length + 1, to: value.length + 1 },
    });
  });

  it("preserves CRLF text around an inserted newline", () => {
    const value = "```ts\r\n  code\r\n```";
    const from = value.indexOf("code") + 2;
    expect(insertComposerFenceNewline(value, { from, to: from }, fence(value))).toEqual({
      value: "```ts\r\n  co\r\n  de\r\n```",
      selection: { from: from + 4, to: from + 4 },
    });
  });

  it("inserts two spaces at a collapsed caret", () => {
    const value = "```\naaa\n```";
    expect(indentComposerFenceLines(value, { from: 5, to: 5 }, fence(value), "in")).toEqual({
      value: "```\na  aa\n```",
      selection: { from: 7, to: 7 },
    });
  });

  it("indents selected lines and excludes a line at the selection's end", () => {
    const value = "```\none\n\ntwo\nthree\n```";
    const from = value.indexOf("one") + 1;
    const to = value.indexOf("three");
    const edit = indentComposerFenceLines(value, { from, to }, fence(value), "in");
    expect(edit).toEqual({
      value: "```\n  one\n\n  two\nthree\n```",
      selection: { from: from + 2, to: to + 4 },
    });
    expect(
      indentComposerFenceLines(edit!.value, edit!.selection, fence(edit!.value), "out"),
    ).toEqual({ value, selection: { from, to } });
  });

  it("outdents manual tabs and odd spaces without eating code", () => {
    const value = "```\n  two\n one\n\ttab\nplain\n```";
    const from = value.indexOf("  two") + 1;
    const to = value.indexOf("plain") + 5;
    expect(indentComposerFenceLines(value, { from, to }, fence(value), "out")).toEqual({
      value: "```\ntwo\none\ntab\nplain\n```",
      selection: { from: 4, to: to - 4 },
    });
  });

  it("keeps CRLF when indenting several lines", () => {
    const value = "```\r\none\r\ntwo\r\n```";
    const from = value.indexOf("one");
    const to = value.indexOf("two") + 3;
    expect(indentComposerFenceLines(value, { from, to }, fence(value), "in")).toEqual({
      value: "```\r\n  one\r\n  two\r\n```",
      selection: { from: from + 2, to: to + 4 },
    });
  });

  it("does not edit a selection outside the owning fence", () => {
    const value = "before\n```\ncode\n```\nafter";
    expect(insertComposerFenceNewline(value, { from: 0, to: 0 }, fence(value))).toBeNull();
    expect(
      indentComposerFenceLines(value, { from: 10, to: value.length }, fence(value), "in"),
    ).toBeNull();
  });
});

describe("composer fence code source mapping", () => {
  it("strips nested quote prefixes while retaining UTF-16 positions and code greater-than operators", () => {
    const source = "> > ```ts\n>> const 😀\n> > > value\n> > ```";
    const extracted = composerFenceCode(source, fence(source));
    expect(extracted.code).toBe("const 😀\n> value\n");
    expect(extracted.lines).toEqual([
      { codeFrom: 0, codeTo: 8, sourceFrom: source.indexOf("const") },
      { codeFrom: 9, codeTo: 16, sourceFrom: source.indexOf("> value") },
    ]);
    for (const line of extracted.lines) {
      expect(extracted.code.slice(line.codeFrom, line.codeTo)).toBe(
        source.slice(line.sourceFrom, line.sourceFrom + line.codeTo - line.codeFrom),
      );
    }
  });

  it("strips list continuation padding while retaining code indentation and blank lines", () => {
    const source = "- ```sh\n    echo one\n  \n  echo two\n  ```";
    const extracted = composerFenceCode(source, fence(source));
    expect(extracted.code).toBe("  echo one\n\necho two\n");
    expect(extracted.lines).toEqual([
      { codeFrom: 0, codeTo: 10, sourceFrom: source.indexOf("    echo") + 2 },
      { codeFrom: 11, codeTo: 11, sourceFrom: source.indexOf("\n  \n") + 3 },
      { codeFrom: 12, codeTo: 20, sourceFrom: source.indexOf("echo two") },
    ]);
  });

  it("retains CRLF separators and exact offsets after quoted list containers", () => {
    const source = "> - ```ts\r\n>   one\r\n>     two\r\n>   ```";
    const extracted = composerFenceCode(source, fence(source));
    expect(extracted.code).toBe("one\r\n  two\r\n");
    expect(extracted.lines).toEqual([
      { codeFrom: 0, codeTo: 3, sourceFrom: source.indexOf("one") },
      { codeFrom: 5, codeTo: 10, sourceFrom: source.indexOf("two") - 2 },
    ]);
  });
});

describe("composer widget source edits", () => {
  it.each([" ", "x", "X"])("toggles a [%s] checkbox without moving the selection", (checked) => {
    const value = `before\n- [${checked}] task\nafter`;
    const from = value.indexOf("[") + 1;
    const selection = { from: 1, to: 4 };
    expect(toggleComposerTaskCheckbox(value, selection, { from, to: from + 1 })).toEqual({
      value: `before\n- [${checked === " " ? "x" : " "}] task\nafter`,
      selection,
    });
  });

  it("refuses a stale checkbox target", () => {
    expect(
      toggleComposerTaskCheckbox("- [no] task", { from: 5, to: 5 }, { from: 3, to: 4 }),
    ).toBeNull();
    expect(
      toggleComposerTaskCheckbox("- [ ] task", { from: 5, to: 5 }, { from: 2, to: 5 }),
    ).toBeNull();
  });

  it("replaces a language and preserves all spacing and metadata", () => {
    const value = "before\n```  ts  title=example\ncode\n```\nafter";
    const from = value.indexOf("ts");
    const selection = { from: value.indexOf("code"), to: value.indexOf("code") + 4 };
    expect(
      replaceComposerFenceLanguage(value, selection, { from, to: from + 2 }, "python"),
    ).toEqual({
      value: "before\n```  python  title=example\ncode\n```\nafter",
      selection: { from: selection.from + 4, to: selection.to + 4 },
    });
  });

  it("uses text when clearing a language before metadata", () => {
    const value = "```ts title=example\ncode\n```";
    expect(replaceComposerFenceLanguage(value, { from: 0, to: 0 }, { from: 3, to: 5 }, "")).toEqual(
      {
        value: "```text title=example\ncode\n```",
        selection: { from: 0, to: 0 },
      },
    );
  });

  it("clears a language while preserving otherwise untouched whitespace", () => {
    const value = "```ts  \ncode\n```";
    expect(replaceComposerFenceLanguage(value, { from: 4, to: 4 }, { from: 3, to: 5 }, "")).toEqual(
      {
        value: "```  \ncode\n```",
        selection: { from: 3, to: 3 },
      },
    );
  });

  it("inserts a language into a bare opening fence", () => {
    const value = "```\ncode\n```";
    expect(
      replaceComposerFenceLanguage(value, { from: 5, to: 5 }, { from: 3, to: 3 }, "rust"),
    ).toEqual({
      value: "```rust\ncode\n```",
      selection: { from: 9, to: 9 },
    });
  });
});
