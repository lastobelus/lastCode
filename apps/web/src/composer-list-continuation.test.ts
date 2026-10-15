import { describe, expect, it } from "vite-plus/test";

import {
  listContinuationForEnter,
  listIndentForTab,
  nextOrderedMarkerText,
} from "./composer-list-continuation";

function applyEdit(value: string, edit: { start: number; end: number; replacement: string }) {
  return value.slice(0, edit.start) + edit.replacement + value.slice(edit.end);
}

describe("composer list continuation", () => {
  it("continues ordered lists with the next number", () => {
    const value = "1. foo";
    const edit = listContinuationForEnter(value, value.length);
    expect(edit).not.toBeNull();
    expect(applyEdit(value, edit!)).toBe("1. foo\n2. ");
  });

  it("increments multi-digit and paren markers", () => {
    expect(applyEdit("12. foo", listContinuationForEnter("12. foo", 7)!)).toBe("12. foo\n13. ");
    expect(applyEdit("3) foo", listContinuationForEnter("3) foo", 6)!)).toBe("3) foo\n4) ");
  });

  it("continues bullets and keeps indentation", () => {
    expect(applyEdit("- foo", listContinuationForEnter("- foo", 5)!)).toBe("- foo\n- ");
    expect(applyEdit("  * foo", listContinuationForEnter("  * foo", 7)!)).toBe("  * foo\n  * ");
  });

  it("continues tasks unchecked", () => {
    expect(applyEdit("- [x] done", listContinuationForEnter("- [x] done", 10)!)).toBe(
      "- [x] done\n- [ ] ",
    );
  });

  it("splits mid-line items", () => {
    expect(applyEdit("1. foobar", listContinuationForEnter("1. foobar", 5)!)).toBe(
      "1. fo\n2. obar",
    );
  });

  it("exits the list on an empty item", () => {
    expect(applyEdit("1. foo\n2. ", listContinuationForEnter("1. foo\n2. ", 10)!)).toBe("1. foo\n");
    expect(applyEdit("- ", listContinuationForEnter("- ", 2)!)).toBe("");
  });

  it("ignores non-list lines and carets inside the marker", () => {
    expect(listContinuationForEnter("plain text", 5)).toBeNull();
    expect(listContinuationForEnter("1.foo no space", 3)).toBeNull();
    expect(listContinuationForEnter("-foo", 2)).toBeNull();
    expect(listContinuationForEnter("1. foo", 1)).toBeNull();
  });

  it("refuses to split a supplementary currency skill chip", () => {
    const value = "1. 𑿝review go";
    const cursor = value.indexOf(" go") - 1;
    expect(listContinuationForEnter(value, cursor)).toBeNull();
  });

  it("refuses to split an inline chip", () => {
    const value = "1. @README.md go";
    const cursor = value.indexOf("README") + 2;
    expect(listContinuationForEnter(value, cursor)).toBeNull();
  });

  it("indents list items on Tab", () => {
    expect(applyEdit("- foo", listIndentForTab("- foo", 2, 2)!)).toBe("  - foo");
    expect(listIndentForTab("plain", 2, 2)).toBeNull();
    expect(listIndentForTab("- foo", 1, 3)).toBeNull();
  });
});

describe("composer quote continuation", () => {
  it.each(["> ", ">", ">> ", "> > ", "  >  >\t ", ">\t"])(
    "continues the exact quote prefix %j",
    (prefix) => {
      const value = `${prefix}quoted text`;
      const edit = listContinuationForEnter(value, value.length);
      expect(edit).toEqual({ start: value.length, end: value.length, replacement: `\n${prefix}` });
      expect(applyEdit(value, edit!)).toBe(`${value}\n${prefix}`);
    },
  );

  it("splits a quote in the middle without rewriting either side", () => {
    const value = "before\n  >  > quoted text\nafter";
    const cursor = value.indexOf("text");
    const edit = listContinuationForEnter(value, cursor);
    expect(applyEdit(value, edit!)).toBe("before\n  >  > quoted \n  >  > text\nafter");
  });

  it.each([">", "> ", ">   ", ">> ", "  > >\t "])(
    "exits every quote level on an empty %j line",
    (prefix) => {
      const value = `before\n${prefix}\nafter`;
      const cursor = value.indexOf("\nafter");
      const edit = listContinuationForEnter(value, cursor);
      expect(edit).toEqual({ start: 7, end: cursor, replacement: "" });
      expect(applyEdit(value, edit!)).toBe("before\n\nafter");
      expect(applyEdit(prefix, listContinuationForEnter(prefix, prefix.length)!)).toBe("");
    },
  );

  it("does not remove or split a quote prefix before the caret reaches its end", () => {
    const value = "  > >  text";
    for (const cursor of [0, 1, 2, 3, 4, 5, 6]) {
      expect(listContinuationForEnter(value, cursor)).toBeNull();
    }
    expect(listContinuationForEnter(value, 7)?.replacement).toBe("\n  > >  ");
    expect(listContinuationForEnter(">  ", 1)).toBeNull();
  });

  it("does not infer quotes from escaped, inline, or code-indented markers", () => {
    for (const value of ["\\> literal", "words > literal", "    > code", "\t> code"]) {
      expect(listContinuationForEnter(value, value.length)).toBeNull();
    }
  });

  it("refuses to split an inline chip inside a quote", () => {
    const value = "> > @README.md go";
    expect(listContinuationForEnter(value, value.indexOf("README") + 2)).toBeNull();
    const skill = "> 𑿝review go";
    expect(listContinuationForEnter(skill, skill.indexOf(" go") - 1)).toBeNull();
  });

  it("preserves list and task spellings inside a quote without converting them", () => {
    const value = ">  - [X] done";
    const edit = listContinuationForEnter(value, value.length);
    expect(applyEdit(value, edit!)).toBe(">  - [X] done\n>  ");
  });

  it("keeps Tab handling restricted to list items", () => {
    const value = "> quoted";
    expect(listIndentForTab(value, value.length, value.length)).toBeNull();
  });
});

describe("nextOrderedMarkerText", () => {
  it.each([
    ["1.", "2."],
    ["1)", "2)"],
    ["09.", "10."],
    ["001)", "002)"],
    ["99.", "100."],
    ["99999999999999999999.", "99999999999999999999."],
  ])("counts %s up to %s", (marker, expected) => {
    expect(nextOrderedMarkerText(marker)).toBe(expected);
  });
});
