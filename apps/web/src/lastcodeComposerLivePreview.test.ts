import { describe, expect, it } from "vite-plus/test";
import {
  collectMarkdownSourceRanges,
  type MarkdownSourceRanges,
} from "@t3tools/shared/lastcodeMarkdownSourceRanges";

import {
  buildComposerLivePreview,
  MAX_COMPOSER_LIVE_PREVIEW_LENGTH,
} from "./lastcodeComposerLivePreview";

function preview(source: string, from = source.length, to = from) {
  return buildComposerLivePreview(
    collectMarkdownSourceRanges(source),
    { from, to },
    true,
    source.length,
  );
}

function hiddenSyntaxRanges(result: ReturnType<typeof preview>) {
  return result.classRanges.filter((range) => range.className.includes("syntax-hidden"));
}

function hiddenText(source: string, from = source.length, to = from) {
  return hiddenSyntaxRanges(preview(source, from, to)).map((range) =>
    source.slice(range.from, range.to),
  );
}

describe("composer live preview", () => {
  it("styles formatted content while hiding only the original delimiter runs", () => {
    const source = "**bold** and *italic* and ~~gone~~ end";
    const result = preview(source);
    expect(hiddenText(source)).toEqual(["**", "**", "*", "*", "~~", "~~"]);
    expect(result.classRanges.filter((range) => !range.className.includes("syntax"))).toEqual([
      { from: 2, to: 6, className: "composer-md-strong" },
      { from: 14, to: 20, className: "composer-md-em" },
      { from: 28, to: 32, className: "composer-md-strike" },
    ]);
    expect(hiddenSyntaxRanges(result)).toEqual([
      { from: 0, to: 2, className: "composer-md-syntax composer-md-syntax-hidden" },
      { from: 6, to: 8, className: "composer-md-syntax composer-md-syntax-hidden" },
      { from: 13, to: 14, className: "composer-md-syntax composer-md-syntax-hidden" },
      { from: 20, to: 21, className: "composer-md-syntax composer-md-syntax-hidden" },
      { from: 26, to: 28, className: "composer-md-syntax composer-md-syntax-hidden" },
      { from: 32, to: 34, className: "composer-md-syntax composer-md-syntax-hidden" },
    ]);
  });

  it.each([0, 1, 2, 4, 6, 7, 8])(
    "reveals a strong span when the caret touches offset %s",
    (from) => {
      const result = preview("**bold** end", from);
      expect(hiddenSyntaxRanges(result)).toEqual([]);
      expect(
        result.classRanges.filter((range) => range.className === "composer-md-syntax"),
      ).toEqual([
        { from: 0, to: 2, className: "composer-md-syntax" },
        { from: 6, to: 8, className: "composer-md-syntax" },
      ]);
      expect(result.classRanges).toContainEqual({
        from: 2,
        to: 6,
        className: "composer-md-strong",
      });
    },
  );

  it("reveals a span when either selection endpoint touches it", () => {
    expect(hiddenText("a **b** c", 0, 2)).toEqual([]);
    expect(hiddenText("a **b** c", 7, 9)).toEqual([]);
    expect(hiddenText("a **b** c", 9, 7)).toEqual([]);
    expect(hiddenText("a **b** c", 8, 9)).toEqual(["**", "**"]);
  });

  it("reveals nested constructs independently without revealing unrelated spans", () => {
    const source = "**outer *inner* text** and ~~gone~~ end";
    const result = preview(source, 3);
    expect(hiddenText(source, 3)).toEqual(["*", "*", "~~", "~~"]);
    expect(result.classRanges).toContainEqual({ from: 2, to: 20, className: "composer-md-strong" });
    expect(hiddenText(source, 10)).toEqual(["~~", "~~"]);
  });

  it("styles code as one construct and does not invent emphasis inside it", () => {
    const source = "``*literal*`` end";
    const result = preview(source);
    expect(hiddenText(source)).toEqual(["``", "``"]);
    expect(result.classRanges.filter((range) => !range.className.includes("syntax"))).toEqual([
      { from: 0, to: 13, className: "composer-md-code" },
    ]);
  });

  it("reveals block syntax only on the touched line while keeping styles", () => {
    const source = "# title\n> quoted\n- item\n2. ordered\n---\nend";
    const result = preview(source, 2);
    expect(hiddenText(source, 2)).toEqual(["> ", "- ", "---"]);
    expect(result.lineClasses.map((range) => range.className)).toEqual([
      "composer-md-h1",
      "composer-md-quote",
      "composer-md-list",
      "composer-md-list",
      "composer-md-rule",
    ]);
    expect(result.widgets).toEqual([{ kind: "bullet", from: 17 }]);
    expect(result.classRanges).toContainEqual({ from: 0, to: 2, className: "composer-md-syntax" });
    expect(
      result.classRanges.some(
        (range) => range.from === source.indexOf("2.") && range.className === "composer-md-syntax",
      ),
    ).toBe(true);
  });

  it("gives inactive tasks a checkbox target without changing the source spelling", () => {
    const source = "- [X] done\n- [ ] next\nend";
    const result = preview(source);
    expect(result.widgets).toEqual([
      { kind: "task", from: 0, checked: true },
      { kind: "task", from: 11, checked: false },
    ]);
    expect(hiddenText(source)).toEqual(["- ", "[X] ", "- ", "[ ] "]);
    expect(preview(source, 5).widgets).toEqual([{ kind: "task", from: 11, checked: false }]);
  });

  it("reveals every fence marker while any part of its block is touched", () => {
    const source = "```ts title=x\n*code*\n```\nend";
    const inactive = preview(source);
    expect(inactive.widgets).toEqual([
      {
        kind: "fenceHeader",
        from: 0,
        language: "ts",
      },
    ]);
    expect(hiddenText(source)).toEqual(["```ts title=x", "```"]);
    expect(inactive.lineClasses.map((range) => range.className)).toEqual([
      "composer-md-fence-open",
      "composer-md-fence-body",
      "composer-md-fence-close",
    ]);
    for (const caret of [0, 5, 15, 20, 24]) {
      const active = preview(source, caret);
      expect(hiddenSyntaxRanges(active)).toEqual([]);
      expect(active.widgets).toEqual([]);
      expect(active.lineClasses).toEqual(inactive.lineClasses);
    }
    expect(inactive.classRanges.some((range) => range.className === "composer-md-em")).toBe(false);
  });

  it("keeps hidden syntax classes in source coordinates without mutating cached parser ranges", () => {
    const ranges: MarkdownSourceRanges = {
      inline: [],
      fences: [],
      lines: [
        {
          lineFrom: 0,
          lineTo: 5,
          line: { kind: "quote" },
          syntax: [{ from: 0, to: 2 }],
          blockFrom: 0,
          blockTo: 5,
        },
        {
          lineFrom: 0,
          lineTo: 5,
          line: { kind: "quote" },
          syntax: [{ from: 1, to: 3 }],
          blockFrom: 0,
          blockTo: 5,
        },
      ],
    };
    const before = structuredClone(ranges);
    expect(
      hiddenSyntaxRanges(buildComposerLivePreview(ranges, { from: 7, to: 7 }, true, 7)),
    ).toEqual([
      { from: 0, to: 2, className: "composer-md-syntax composer-md-syntax-hidden" },
      { from: 1, to: 3, className: "composer-md-syntax composer-md-syntax-hidden" },
    ]);
    expect(ranges).toEqual(before);
  });

  it("returns no presentation when disabled or above the character cap", () => {
    const ranges = collectMarkdownSourceRanges("**bold**");
    const empty = { classRanges: [], lineClasses: [], widgets: [] };
    expect(buildComposerLivePreview(ranges, { from: 20, to: 20 }, false, 8)).toEqual(empty);
    expect(
      buildComposerLivePreview(
        ranges,
        { from: 20, to: 20 },
        true,
        MAX_COMPOSER_LIVE_PREVIEW_LENGTH + 1,
      ),
    ).toEqual(empty);
    expect(
      hiddenSyntaxRanges(
        buildComposerLivePreview(
          ranges,
          { from: 20, to: 20 },
          true,
          MAX_COMPOSER_LIVE_PREVIEW_LENGTH,
        ),
      ),
    ).toHaveLength(2);
  });
});
