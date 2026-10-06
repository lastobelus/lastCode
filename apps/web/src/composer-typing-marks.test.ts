import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { history, redo, undo } from "@tiptap/pm/history";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vite-plus/test";

import { buildDocJson, ComposerCodeExtension, serializeEditorDoc } from "./composer-rich-text-doc";
import { createComposerTypingMarksPlugin } from "./composer-typing-marks";

const schema = getSchema([StarterKit.configure({ code: false }), ComposerCodeExtension]);

function createState(value: string, cursor: number) {
  const doc = schema.nodeFromJSON(buildDocJson(value, () => ({ label: "", description: null })));
  return EditorState.create({
    doc,
    selection: TextSelection.create(doc, cursor),
    plugins: [createComposerTypingMarksPlugin(), history()],
  });
}

function move(state: EditorState, cursor: number) {
  return state.applyTransaction(state.tr.setSelection(TextSelection.create(state.doc, cursor)))
    .state;
}

function type(state: EditorState, text: string) {
  for (const character of text)
    state = state.applyTransaction(state.tr.insertText(character)).state;
  return state;
}

function value(state: EditorState) {
  return serializeEditorDoc(state.doc).value;
}

describe("composer typing marks after moving the caret", () => {
  it.each(["**b**", "*b*", "~~b~~", "`b`", "***b***", "**`b`**"])(
    "types plain text after navigating away from and back to %s",
    (markdown) => {
      let state = createState(markdown, 2);
      state = state.applyTransaction(state.tr.setStoredMarks([])).state;
      state = move(move(state, 1), 2);
      expect(value(type(state, " plain"))).toBe(`${markdown} plain`);
    },
  );

  it("covers caret placement after a controlled rewrite, including an unchanged position", () => {
    let state = createState("x", 2);
    const content = schema.nodeFromJSON(
      buildDocJson("**b**", () => ({ label: "", description: null })),
    );
    state = state.applyTransaction(
      state.tr.replaceWith(0, state.doc.content.size, content.content),
    ).state;
    state = move(state, 2);
    expect(value(type(state, " plain"))).toBe("**b** plain");
  });

  it("resets typing marks after a paste and subsequent navigation", () => {
    let state = createState("", 1);
    const content = schema.nodeFromJSON(
      buildDocJson("**b**", () => ({ label: "", description: null })),
    );
    state = state.applyTransaction(
      state.tr.replaceSelectionWith(content.firstChild!, false).setMeta("uiEvent", "paste"),
    ).state;
    expect(value(type(state, " plain"))).toBe("**b** plain");
    state = move(move(state, 1), 2);
    expect(value(type(state, " plain"))).toBe("**b** plain");
  });

  it("continues the following span after pasting in the middle of a line", () => {
    let state = createState("tail", 1);
    state = state.applyTransaction(
      state.tr
        .insertText("b")
        .addMark(1, 2, schema.marks.bold!.create())
        .setMeta("uiEvent", "paste"),
    ).state;
    expect(value(type(state, "xy"))).toBe("**b**xytail");
  });

  it("types plain after cutting back to a closing boundary", () => {
    let state = createState("**b** plain", 8);
    state = state.applyTransaction(
      state.tr
        .setSelection(TextSelection.create(state.doc, 2, 8))
        // Tiptap's deleteSelection command uses deleteRange without ensureMarks.
        .deleteRange(2, 8)
        .setMeta("uiEvent", "cut"),
    ).state;
    expect(value(state)).toBe("**b**");
    expect(value(type(state, " plain"))).toBe("**b** plain");
  });

  it("preserves formatting while typing inside a span", () => {
    const state = move(createState("**bold**", 5), 3);
    expect(value(type(state, "xy"))).toBe("**boxyld**");
  });

  it("adopts following text marks at a boundary", () => {
    const state = move(createState("**b***tail*", 6), 2);
    expect(value(type(state, "xy"))).toBe("**b***xytail*");
  });

  it("matches the opening marker when placing the caret before formatted text", () => {
    const state = move(createState("x **bold**", 7), 3);
    expect(value(type(state, "xy"))).toBe("x **xybold**");
  });

  it("preserves explicit formatting on and off over several keystrokes", () => {
    let state = move(createState("**b**", 2), 2);
    state = state.applyTransaction(state.tr.addStoredMark(schema.marks.bold!.create())).state;
    state = type(state, "xy");
    expect(value(state)).toBe("**bxy**");
    state = state.applyTransaction(state.tr.removeStoredMark(schema.marks.bold!)).state;
    expect(value(type(state, " plain"))).toBe("**bxy** plain");
  });

  it("preserves an explicit mark decision in a selection transaction", () => {
    let state = createState("**b**", 1);
    state = state.applyTransaction(
      state.tr
        .setSelection(TextSelection.create(state.doc, 2))
        .addStoredMark(schema.marks.italic!.create()),
    ).state;
    expect(value(type(state, "xy"))).toBe("**b*xy***");
  });

  it("does not alter ranged selection replacement", () => {
    let state = createState("**bold**", 5);
    state = state.applyTransaction(
      state.tr.setSelection(TextSelection.create(state.doc, 2, 4)),
    ).state;
    expect(value(type(state, "x"))).toBe("**bxd**");
  });

  it("leaves normal typing transactions alone", () => {
    const state = createState("**b**", 2);
    expect(value(type(state, "xy"))).toBe("**bxy**");
    expect(state.applyTransaction(state.tr.scrollIntoView()).transactions).toHaveLength(1);
  });

  it("adds no undo step and preserves undo/redo content and selection", () => {
    let state = move(move(createState("**b**", 2), 1), 2);
    state = type(state, " plain");
    expect(
      undo(state, (transaction) => {
        state = state.applyTransaction(transaction).state;
      }),
    ).toBe(true);
    expect(value(state)).toBe("**b**");
    expect(state.selection.from).toBe(2);
    expect(value(type(state, " again"))).toBe("**b** again");
    expect(
      redo(state, (transaction) => {
        state = state.applyTransaction(transaction).state;
      }),
    ).toBe(true);
    expect(value(state)).toBe("**b** plain");
    expect(state.selection.from).toBe(8);
  });
});
