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
    expect(applyEdit("1)\t", listContinuationForEnter("1)\t", 3)!)).toBe("");
    expect(applyEdit("- [ ] ", listContinuationForEnter("- [ ] ", 6)!)).toBe("");
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
});

describe("composer quote continuation", () => {
  it.each(["> ", ">", ">> ", "> > ", "  >  >\t ", ">\t"])(
    "continues the exact quote prefix %j",
    (prefix) => {
      const value = `${prefix}quoted text`;
      const edit = listContinuationForEnter(value, value.length);
      expect(edit).toEqual({
        start: value.length,
        end: value.length,
        replacement: `\n${prefix}`,
        cursorAfter: value.length + 1 + prefix.length,
      });
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
      expect(edit).toEqual({ start: 7, end: cursor, replacement: "", cursorAfter: 7 });
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

  it.each([
    ["> - item", "> - item\n> - "],
    ["> > + item", "> > + item\n> > + "],
    ["  >  * item", "  >  * item\n  >  * "],
    ["> 09) item", "> 09) item\n> 10) "],
    ["> > 001. item", "> > 001. item\n> > 002. "],
    [">  - [X] done", ">  - [X] done\n>  - [ ] "],
  ])("continues the nested list in %j", (value, expected) => {
    const edit = listContinuationForEnter(value, value.length);
    expect(applyEdit(value, edit!)).toBe(expected);
  });

  it.each([
    ["> - ", "> "],
    ["> *", "> "],
    ["> 2. ", "> "],
    ["> - [x] ", "> "],
    ["> > + ", "> > "],
    ["  >  - [ ]\t", "  >  "],
  ])("exits an empty quoted list %j while keeping its quote", (value, expected) => {
    const edit = listContinuationForEnter(value, value.length);
    expect(applyEdit(value, edit!)).toBe(expected);
    expect(applyEdit(expected, listContinuationForEnter(expected, expected.length)!)).toBe("");
  });

  it("does not split a quoted list before the caret reaches the marker end", () => {
    const value = "> > - [ ] item";
    for (let cursor = 0; cursor < 10; cursor++) {
      expect(listContinuationForEnter(value, cursor)).toBeNull();
    }
    expect(listContinuationForEnter(value, 10)?.replacement).toBe("\n> > - [ ] ");
  });

  it("splits a quoted list in the middle without rewriting the remaining text", () => {
    const value = "before\n> 3) first second\nafter";
    const cursor = value.indexOf("second");
    const edit = listContinuationForEnter(value, cursor);
    expect(applyEdit(value, edit!)).toBe("before\n> 3) first \n> 4) second\nafter");
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

describe("composer list renumbering", () => {
  it("renumbers following items with their padding and leaves the caret after the inserted marker", () => {
    const value = "1. @README.md go\n2. two\n03. three\n10. four";
    const edit = listContinuationForEnter(value, value.indexOf("go"))!;
    expect(applyEdit(value, edit)).toBe("1. @README.md \n2. go\n3. two\n04. three\n5. four");
    expect(edit.cursorAfter).toBe("1. @README.md \n2. ".length);
  });

  it("renumbers indented paren siblings across tab-indented children and stops at a parent", () => {
    const value = "  1) a\n\t1) child\n  2) b\n1) parent\n  3) untouched";
    const edit = listContinuationForEnter(value, value.indexOf("\n"))!;
    expect(applyEdit(value, edit)).toBe(
      "  1) a\n  2) \n\t1) child\n  3) b\n1) parent\n  3) untouched",
    );
    expect(edit.cursorAfter).toBe("  1) a\n  2) ".length);
  });

  // regression: #14332 continuing a numbered list must renumber following items only up to the list boundary
  it.each([
    ["a blank line", ""],
    ["plain text", "text"],
    ["a different delimiter", "1) other list"],
  ])("stops renumbering at %s", (_label, boundary) => {
    const value = `1. a\n2. b\n${boundary}\n3. untouched`;
    const edit = listContinuationForEnter(value, value.indexOf("\n"))!;
    expect(applyEdit(value, edit)).toBe(`1. a\n2. \n3. b\n${boundary}\n3. untouched`);
  });

  it("renumbers quoted siblings and stops when the quote ends", () => {
    const value = "> 1. first\n> 2. second\n> 03. third\noutside\n> 4. untouched";
    const edit = listContinuationForEnter(value, value.indexOf("\n"))!;
    expect(applyEdit(value, edit)).toBe(
      "> 1. first\n> 2. \n> 3. second\n> 04. third\noutside\n> 4. untouched",
    );
    expect(edit.cursorAfter).toBe("> 1. first\n> 2. ".length);
  });

  it("preserves multiline chip contents while renumbering surrounding items", () => {
    const value = '1. a\n2. @"file\n2. name" \n3. b';
    const edit = listContinuationForEnter(value, value.indexOf("\n"))!;
    expect(applyEdit(value, edit)).toBe('1. a\n2. \n3. @"file\n2. name" \n4. b');
  });
});
