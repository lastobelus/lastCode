// @vitest-environment jsdom

import { Editor, Node as TiptapNode } from "@tiptap/core";
import { redo, undo } from "@tiptap/pm/history";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { AllSelection, TextSelection, type Transaction } from "@tiptap/pm/state";
import { act } from "react";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  buildDocJson,
  expandedMarkdownToFlat,
  flatToMarkdown,
  flatToPm,
  pmToFlat,
  serializeEditorDoc,
  serializeSelection,
} from "~/composer-rich-text-doc";
import {
  applyComposerSourceEdit,
  ComposerLivePreviewExtension,
  composerLivePreviewKey,
  handleComposerSourceKey,
  wrapComposerSourceSelection,
} from "~/lastcodeComposerLivePreviewTiptap";
import { groupUndoByChangeKind, type ComposerChangeKind } from "~/composer-undo-grouping";
import {
  replaceComposerFenceLanguage,
  toggleComposerTaskCheckbox,
} from "~/lastcodeComposerSourceEdits";

// Exercise the mounted fence widget's editing callback without the picker popup/icon system.
vi.mock("~/components/chat/ComposerCodeBlockLanguagePicker", async () => {
  const { createElement } = await import("react");
  return {
    ComposerCodeBlockLanguagePicker: (props: {
      language: string;
      disabled: boolean;
      onChange: (language: string) => void;
    }) =>
      createElement(
        "select",
        {
          "aria-label": "Fence language",
          value: props.language,
          disabled: props.disabled,
          onChange: (event: { currentTarget: HTMLSelectElement }) =>
            props.onChange(event.currentTarget.value),
        },
        createElement("option", { value: "ts" }, "TypeScript"),
        createElement("option", { value: "python" }, "Python"),
      ),
  };
});

const mention = TiptapNode.create({
  name: "composer-mention",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes() {
    return { path: { default: "" }, source: { default: "" } };
  },
  renderHTML({ node }) {
    return ["span", { "data-mention": "" }, node.attrs.path];
  },
});

function createSourceEditor(source: string, element?: HTMLElement) {
  return new Editor({
    ...(element ? { element } : {}),
    extensions: [
      StarterKit.configure({
        bold: false,
        italic: false,
        strike: false,
        code: false,
        trailingNode: false,
      }),
      mention,
      ComposerLivePreviewExtension.configure({ enabled: true }),
    ],
    content: buildDocJson(source, () => ({ label: "skill", description: null }), {
      styling: true,
    }),
  });
}

function createSourceState(source: string) {
  const editor = createSourceEditor(source);
  return editor.state.reconfigure({ plugins: editor.extensionManager.plugins });
}

describe("source-preserving composer presentation", () => {
  it("keeps every typed marker across caret movement and a presentation toggle", () => {
    const source = "Fix **this** in `node_modules` and _that_ now";
    let state = createSourceState(source);
    for (let offset = 0; offset <= source.length; offset += 1) {
      const map = serializeEditorDoc(state.doc);
      state = state.apply(
        state.tr.setSelection(TextSelection.create(state.doc, flatToPm(map, offset))),
      );
      expect(serializeEditorDoc(state.doc).value).toBe(source);
    }
    state = state.apply(state.tr.setMeta(composerLivePreviewKey, { enabled: false }));
    expect(serializeEditorDoc(state.doc).value).toBe(source);
    expect(composerLivePreviewKey.getState(state)?.decorations.find()).toEqual([]);
    state = state.apply(state.tr.setMeta(composerLivePreviewKey, { enabled: true }));
    expect(serializeEditorDoc(state.doc).value).toBe(source);
  });

  it("copies actual Markdown even when its delimiters are hidden", () => {
    const source = "**bold** tail";
    let state = createSourceState(source);
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, source.length + 1)));
    expect(composerLivePreviewKey.getState(state)?.decorations.find().length).toBeGreaterThan(0);
    expect(serializeSelection(state.doc, 1, state.doc.content.size - 1)).toBe(source);
  });

  it("never applies emphasis inside either supplied inline code span", () => {
    const source = "clean `_build` and `node_modules`";
    const state = createSourceState(source);
    expect(
      composerLivePreviewKey.getState(state)?.ranges.inline.map((range) => range.kind),
    ).toEqual(["inlineCode", "inlineCode"]);
    expect(serializeEditorDoc(state.doc).value).toBe(source);
  });

  it("does not add undo steps for reveal and mode changes", () => {
    let state = createSourceState("**bold**");
    state = state.apply(state.tr.insertText(" tail", state.doc.content.size - 1));
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 2)));
    state = state.apply(state.tr.setMeta(composerLivePreviewKey, { enabled: false }));
    state = state.apply(state.tr.setMeta(composerLivePreviewKey, { enabled: true }));
    expect(
      undo(state, (transaction) => {
        state = state.apply(transaction);
      }),
    ).toBe(true);
    expect(serializeEditorDoc(state.doc).value).toBe("**bold**");
  });
});

/** A real source document and history, with the composer's grouping applied at dispatch. */
function sourceComposer(source: string, platform = "MacIntel", mountedEditor?: Editor) {
  let state = mountedEditor?.state ?? createSourceState(source);
  let previous: ComposerChangeKind | null = null;
  let clock = 0;
  const transactions: Transaction[] = [];
  const nativeDispatch = mountedEditor?.view.props.dispatchTransaction;
  const dispatch = (transaction: Transaction) => {
    transaction.setTime((clock += 80));
    previous = groupUndoByChangeKind(transaction, previous);
    transactions.push(transaction);
    if (nativeDispatch) {
      nativeDispatch(transaction);
      state = mountedEditor!.state;
    } else state = state.apply(transaction);
  };
  if (mountedEditor) mountedEditor.view.setProps({ dispatchTransaction: dispatch });
  const view = mountedEditor?.view ?? {
    get state() {
      return state;
    },
    dispatch,
  };
  const sourcePosition = (offset: number) => {
    const map = serializeEditorDoc(state.doc);
    return flatToPm(map, expandedMarkdownToFlat(map, offset));
  };
  return {
    view,
    transactions,
    get state() {
      return state;
    },
    value: () => serializeEditorDoc(state.doc).value,
    selection: () => {
      const map = serializeEditorDoc(state.doc);
      return {
        from: flatToMarkdown(map, pmToFlat(map, state.selection.from)),
        to: flatToMarkdown(map, pmToFlat(map, state.selection.to)),
      };
    },
    select(from: number, to = from) {
      dispatch(
        state.tr.setSelection(
          TextSelection.create(state.doc, sourcePosition(from), sourcePosition(to)),
        ),
      );
    },
    type(text: string) {
      for (const character of text) dispatch(state.tr.insertText(character));
    },
    key(key: string, modifiers: Partial<KeyboardEvent> = {}) {
      return handleComposerSourceKey(
        view,
        {
          key,
          keyCode: 0,
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          isComposing: false,
          ...modifiers,
        } as KeyboardEvent,
        platform,
      );
    },
    undo: () => undo(state, dispatch),
    redo: () => redo(state, dispatch),
    atoms: () => {
      const atoms: ProseMirrorNode[] = [];
      state.doc.descendants((node) => {
        if (node.isAtom && node.isInline && !node.isText) atoms.push(node);
      });
      return atoms;
    },
  };
}

describe("composer source transactions", () => {
  it("maps a caret after a converted chip and leaves text literal when the fence is removed", () => {
    const source = "\n[example.ts](src/example.ts)\n";
    const composer = sourceComposer(source);
    expect(composer.atoms()).toHaveLength(1);
    composer.select(source.length);
    composer.view.dispatch(composer.state.tr.insertText("```", 1));
    expect(composer.value()).toBe("```" + source);
    expect(composer.atoms()).toHaveLength(0);
    expect(composer.selection()).toEqual({ from: source.length + 3, to: source.length + 3 });
    composer.view.dispatch(composer.state.tr.delete(1, 4));
    expect(composer.value()).toBe(source);
    expect(composer.atoms()).toHaveLength(0);
    expect(composer.selection()).toEqual({ from: source.length, to: source.length });
    expect(composer.undo()).toBe(true);
    expect(composer.value()).toBe("```" + source);
    expect(composer.atoms()).toHaveLength(0);
    expect(composer.undo()).toBe(true);
    expect(composer.value()).toBe(source);
    expect(composer.atoms()).toHaveLength(1);
  });

  it.each([
    { preview: false, composing: false, padding: 0 },
    { preview: true, composing: false, padding: 0 },
    { preview: false, composing: true, padding: 0 },
    { preview: true, composing: true, padding: 0 },
    { preview: false, composing: false, padding: 13_000 },
    { preview: true, composing: false, padding: 13_000 },
  ])(
    "makes existing fence atoms literal with $preview preview, $composing composition and $padding padding",
    ({ preview, composing, padding }) => {
      const outside = "x".repeat(padding) + (padding ? "\n" : "") + "[outside.ts](outside.ts)\n";
      const body = "[first.ts](first.ts) [second.ts](second.ts)\n";
      const source = outside + "\n" + body;
      const composer = sourceComposer(source);
      expect(composer.atoms()).toHaveLength(3);
      const outsideAtom = composer.atoms()[0]!;
      composer.view.dispatch(
        composer.state.tr.setMeta(composerLivePreviewKey, { enabled: preview, composing }),
      );
      composer.select(outside.length);
      composer.type("```text");
      const fenced = outside + "```text\n" + body;
      expect(composer.value()).toBe(fenced);
      expect(composer.atoms()).toHaveLength(1);
      expect(composer.atoms()[0]!.eq(outsideAtom)).toBe(true);
      expect(composer.selection()).toEqual({ from: outside.length + 7, to: outside.length + 7 });
      expect(composer.undo()).toBe(true);
      expect(composer.value()).toBe(source);
      expect(composer.atoms()).toHaveLength(3);
      expect(composer.redo()).toBe(true);
      expect(composer.value()).toBe(fenced);
      expect(composer.atoms()).toHaveLength(1);
      const inside = fenced.indexOf("first.ts") + 3;
      composer.select(inside);
      composer.type("X");
      expect(composer.value()).toBe(fenced.slice(0, inside) + "X" + fenced.slice(inside));
      expect(composer.undo()).toBe(true);
      expect(composer.value()).toBe(fenced);
    },
  );

  it("wraps Select All with typed backticks in one source paragraph and one undo step", () => {
    const composer = sourceComposer("hello");
    composer.view.dispatch(composer.state.tr.setSelection(new AllSelection(composer.state.doc)));
    expect(
      wrapComposerSourceSelection(
        composer.view,
        composer.state.selection.from,
        composer.state.selection.to,
        "`",
        "`",
      ),
    ).toBe(true);
    expect(composer.value()).toBe("`hello`");
    expect(composer.state.doc.childCount).toBe(1);
    expect(composer.selection()).toEqual({ from: 1, to: 6 });
    expect(composer.undo()).toBe(true);
    expect(composer.value()).toBe("hello");
  });

  it("formats AllSelection inside its paragraph without creating extra lines", () => {
    const composer = sourceComposer("hello");
    composer.view.dispatch(composer.state.tr.setSelection(new AllSelection(composer.state.doc)));
    expect(composer.key("b", { metaKey: true })).toBe(true);
    expect(composer.value()).toBe("**hello**");
    expect(composer.state.doc.childCount).toBe(1);
    expect(composer.selection()).toEqual({ from: 2, to: 7 });
    expect(composer.undo()).toBe(true);
    expect(composer.value()).toBe("hello");
    expect(composer.state.selection).toBeInstanceOf(AllSelection);
    expect(composer.redo()).toBe(true);
    composer.view.dispatch(composer.state.tr.setSelection(new AllSelection(composer.state.doc)));
    expect(composer.key("b", { metaKey: true })).toBe(true);
    expect(composer.value()).toBe("hello");
    expect(composer.state.doc.childCount).toBe(1);
  });

  it.each([
    { key: "b", modifiers: { metaKey: true }, delimiter: "**" },
    { key: "i", modifiers: { metaKey: true }, delimiter: "*" },
    { key: "e", modifiers: { metaKey: true }, delimiter: "`" },
    { key: "s", modifiers: { metaKey: true, shiftKey: true }, delimiter: "~~" },
  ])(
    "wraps and unwraps selected source through the $key shortcut",
    ({ key, modifiers, delimiter }) => {
      const composer = sourceComposer("before selected after");
      composer.select(7, 15);
      const dispatches = composer.transactions.length;
      expect(composer.key(key, modifiers)).toBe(true);
      expect(composer.transactions).toHaveLength(dispatches + 1);
      expect(composer.value()).toBe(`before ${delimiter}selected${delimiter} after`);
      expect(composer.selection()).toEqual({
        from: 7 + delimiter.length,
        to: 15 + delimiter.length,
      });
      expect(composer.key(key, modifiers)).toBe(true);
      expect(composer.value()).toBe("before selected after");
      expect(composer.selection()).toEqual({ from: 7, to: 15 });
      expect(composer.undo()).toBe(true);
      expect(composer.value()).toBe(`before ${delimiter}selected${delimiter} after`);
      expect(composer.undo()).toBe(true);
      expect(composer.value()).toBe("before selected after");
    },
  );

  it.each(["b", "e"])("leaves Mac Ctrl+%s navigation to the browser", (key) => {
    const composer = sourceComposer("before selected after");
    composer.select(7);
    const dispatches = composer.transactions.length;
    expect(composer.key(key, { ctrlKey: true })).toBe(false);
    expect(composer.transactions).toHaveLength(dispatches);
    expect(composer.value()).toBe("before selected after");
    expect(composer.selection()).toEqual({ from: 7, to: 7 });
  });

  it.each([
    { key: "b", shiftKey: false, delimiter: "**" },
    { key: "i", shiftKey: false, delimiter: "*" },
    { key: "e", shiftKey: false, delimiter: "`" },
    { key: "s", shiftKey: true, delimiter: "~~" },
  ])("formats source with Ctrl+$key on non-Mac platforms", ({ key, shiftKey, delimiter }) => {
    const composer = sourceComposer("selected", "Win32");
    composer.select(0, 8);
    expect(composer.key(key, { metaKey: true, shiftKey })).toBe(false);
    expect(composer.key(key, { ctrlKey: true, shiftKey })).toBe(true);
    expect(composer.value()).toBe(`${delimiter}selected${delimiter}`);
    expect(composer.undo()).toBe(true);
    expect(composer.value()).toBe("selected");
  });

  it("formats an atom and its adjacent source without replacing the atom", () => {
    const source = "before @README.md after";
    const composer = sourceComposer(source);
    const original = composer.atoms()[0]!;
    composer.select(7, source.length);
    expect(composer.key("b", { metaKey: true })).toBe(true);
    expect(composer.value()).toBe("before **@README.md after**");
    expect(composer.atoms()).toHaveLength(1);
    expect(composer.atoms()[0]!.eq(original)).toBe(true);
    expect(
      serializeSelection(
        composer.state.doc,
        composer.state.selection.from,
        composer.state.selection.to,
      ),
    ).toBe("@README.md after");
    expect(composer.key("b", { metaKey: true })).toBe(true);
    expect(composer.value()).toBe(source);
    expect(composer.atoms()[0]!.eq(original)).toBe(true);
    expect(composer.undo()).toBe(true);
    expect(composer.atoms()[0]!.eq(original)).toBe(true);
  });

  it("inserts and removes an empty pair with one undo step per gesture", () => {
    const composer = sourceComposer("ab");
    composer.select(1);
    expect(composer.key("b", { metaKey: true })).toBe(true);
    expect(composer.value()).toBe("a****b");
    expect(composer.selection()).toEqual({ from: 3, to: 3 });
    expect(composer.key("b", { metaKey: true })).toBe(true);
    expect(composer.value()).toBe("ab");
    expect(composer.selection()).toEqual({ from: 1, to: 1 });
    expect(composer.undo()).toBe(true);
    expect(composer.value()).toBe("a****b");
    expect(composer.selection()).toEqual({ from: 3, to: 3 });
    expect(composer.undo()).toBe(true);
    expect(composer.value()).toBe("ab");
    expect(composer.selection()).toEqual({ from: 1, to: 1 });
  });

  it("keeps a two-step formatting transaction separate from typing before and after it", () => {
    const composer = sourceComposer("draft ");
    composer.select(6);
    composer.type("one");
    composer.select(6, 9);
    expect(composer.key("b", { metaKey: true })).toBe(true);
    expect(composer.transactions.at(-1)!.steps).toHaveLength(2);
    composer.select(composer.value().length);
    composer.type("!");
    expect(composer.undo()).toBe(true);
    expect(composer.value()).toBe("draft **one**");
    expect(composer.undo()).toBe(true);
    expect(composer.value()).toBe("draft one");
    expect(composer.selection()).toEqual({ from: 6, to: 9 });
    expect(composer.undo()).toBe(true);
    expect(composer.value()).toBe("draft ");
  });

  it("completes an opening fence using real empty and closing paragraphs", () => {
    const source = "before @README.md\n```ts";
    const composer = sourceComposer(source);
    const atom = composer.atoms()[0]!;
    composer.select(source.length);
    expect(composer.key("Enter")).toBe(true);
    expect(composer.value()).toBe(`${source}\n\n\`\`\``);
    expect(composer.state.doc.childCount).toBe(4);
    expect(composer.state.doc.child(2).childCount).toBe(0);
    expect(composer.state.doc.child(3).textContent).toBe("```");
    expect(composer.selection()).toEqual({ from: source.length + 1, to: source.length + 1 });
    expect(composer.atoms()[0]!.eq(atom)).toBe(true);
    expect(composer.undo()).toBe(true);
    expect(composer.value()).toBe(source);
    expect(composer.state.doc.childCount).toBe(2);
    expect(composer.redo()).toBe(true);
    expect(composer.state.doc.child(2).childCount).toBe(0);
    expect(composer.selection()).toEqual({ from: source.length + 1, to: source.length + 1 });
  });

  it("splits a fence body into paragraphs and keeps its indentation", () => {
    const source = "before\n```ts\n  one two\n```\nafter";
    const composer = sourceComposer(source);
    const cursor = source.indexOf("two");
    composer.select(cursor);
    expect(composer.key("Enter")).toBe(true);
    expect(composer.value()).toBe("before\n```ts\n  one \n  two\n```\nafter");
    expect(composer.state.doc.childCount).toBe(6);
    expect(composer.state.doc.child(2).textContent).toBe("  one ");
    expect(composer.state.doc.child(3).textContent).toBe("  two");
    expect(composer.selection()).toEqual({ from: cursor + 3, to: cursor + 3 });
    expect(composer.undo()).toBe(true);
    expect(composer.value()).toBe(source);
    expect(composer.selection()).toEqual({ from: cursor, to: cursor });
  });

  it("indents and outdents selected fence lines while retaining selection through undo", () => {
    const source = "```ts\none\ntwo\n```";
    const composer = sourceComposer(source);
    const from = source.indexOf("one") + 1;
    const to = source.indexOf("two") + 2;
    composer.select(from, to);
    expect(composer.key("Tab")).toBe(true);
    expect(composer.value()).toBe("```ts\n  one\n  two\n```");
    expect(composer.selection()).toEqual({ from: from + 2, to: to + 4 });
    expect(composer.key("Tab", { shiftKey: true })).toBe(true);
    expect(composer.value()).toBe(source);
    expect(composer.selection()).toEqual({ from, to });
    expect(composer.undo()).toBe(true);
    expect(composer.value()).toBe("```ts\n  one\n  two\n```");
    expect(composer.selection()).toEqual({ from: from + 2, to: to + 4 });
    expect(composer.undo()).toBe(true);
    expect(composer.value()).toBe(source);
    expect(composer.selection()).toEqual({ from, to });
  });

  it.each([{ metaKey: true }, { ctrlKey: true }])(
    "lets Mod-Enter fall through without editing a fence",
    (modifier) => {
      const source = "```ts\ncode\n```";
      const composer = sourceComposer(source);
      composer.select(source.indexOf("code") + 2);
      const dispatches = composer.transactions.length;
      const selection = composer.selection();
      expect(composer.key("Enter", modifier)).toBe(false);
      expect(composer.transactions).toHaveLength(dispatches);
      expect(composer.value()).toBe(source);
      expect(composer.selection()).toEqual(selection);
    },
  );

  it("applies raw multiline edits while retaining blank paragraphs and atoms outside the change", () => {
    const source = "@README.md\nbefore KEEP after\n@NEXT.md after";
    const composer = sourceComposer(source);
    const atoms = composer.atoms();
    expect(atoms).toHaveLength(2);
    const from = source.indexOf("KEEP");
    composer.select(from, from + 4);
    const value = source.replace("KEEP", "one\n\nthree");
    expect(
      applyComposerSourceEdit(composer.view, {
        value,
        selection: { from: from + 4, to: from + 4 },
      }),
    ).toBe(true);
    expect(composer.value()).toBe(value);
    expect(composer.state.doc.childCount).toBe(5);
    expect(composer.state.doc.child(2).childCount).toBe(0);
    expect(composer.atoms()).toHaveLength(2);
    expect(composer.atoms().every((atom, index) => atom.eq(atoms[index]!))).toBe(true);
    expect(composer.selection()).toEqual({ from: from + 4, to: from + 4 });
    expect(composer.undo()).toBe(true);
    expect(composer.value()).toBe(source);
    expect(composer.selection()).toEqual({ from, to: from + 4 });
    expect(composer.atoms().every((atom, index) => atom.eq(atoms[index]!))).toBe(true);
  });

  it("toggles only the task character and preserves the selection across undo and redo", () => {
    const source = "before\n- [ ] task\nafter";
    const composer = sourceComposer(source);
    const selection = { from: source.indexOf("after"), to: source.length };
    composer.select(selection.from, selection.to);
    const from = source.indexOf("[") + 1;
    expect(
      applyComposerSourceEdit(
        composer.view,
        toggleComposerTaskCheckbox(source, selection, { from, to: from + 1 }),
      ),
    ).toBe(true);
    expect(composer.value()).toBe("before\n- [x] task\nafter");
    expect(composer.selection()).toEqual(selection);
    expect(composer.undo()).toBe(true);
    expect(composer.value()).toBe(source);
    expect(composer.selection()).toEqual(selection);
    expect(composer.redo()).toBe(true);
    expect(composer.value()).toBe("before\n- [x] task\nafter");
    expect(composer.selection()).toEqual(selection);
  });

  it("changes only the fence language while mapping and restoring selection history", () => {
    const source = "before\n```ts title=example\ncode\n```\nafter";
    const composer = sourceComposer(source);
    const from = source.indexOf("ts");
    const selection = { from: source.indexOf("code"), to: source.indexOf("code") + 4 };
    composer.select(selection.from, selection.to);
    const edit = replaceComposerFenceLanguage(source, selection, { from, to: from + 2 }, "python");
    expect(applyComposerSourceEdit(composer.view, edit)).toBe(true);
    expect(composer.value()).toBe("before\n```python title=example\ncode\n```\nafter");
    expect(composer.selection()).toEqual({ from: selection.from + 4, to: selection.to + 4 });
    expect(composer.undo()).toBe(true);
    expect(composer.value()).toBe(source);
    expect(composer.selection()).toEqual(selection);
    expect(composer.redo()).toBe(true);
    expect(composer.value()).toBe(edit.value);
    expect(composer.selection()).toEqual(edit.selection);
  });
  it("keeps large drafts unparsed until a fence gesture needs their boundaries", () => {
    const source = "```ts\n" + "x".repeat(21_000) + "\n```";
    const composer = sourceComposer(source);
    const preview = composerLivePreviewKey.getState(composer.state)!;
    expect(preview.parsed).toBe(false);
    expect(preview.ranges).toEqual({ inline: [], lines: [], fences: [] });
    composer.select(20_000);
    expect(composer.key("Enter")).toBe(true);
    expect(composer.value()).toBe(source.slice(0, 20_000) + "\n" + source.slice(20_000));
    expect(composerLivePreviewKey.getState(composer.state)!.parsed).toBe(false);
    expect(composer.undo()).toBe(true);
    expect(composer.value()).toBe(source);
  });

  it("reparses source when rich preview turns on after plain edits", () => {
    const composer = sourceComposer("**old**");
    composer.view.dispatch(composer.state.tr.setMeta(composerLivePreviewKey, { enabled: false }));
    composer.select(2, 5);
    composer.type("new");
    expect(composerLivePreviewKey.getState(composer.state)!.ranges.inline).toEqual([]);
    composer.view.dispatch(composer.state.tr.setMeta(composerLivePreviewKey, { enabled: true }));
    expect(composerLivePreviewKey.getState(composer.state)!.ranges.inline[0]?.kind).toBe("strong");
    expect(composer.value()).toBe("**new**");
  });

  it("pastes a shared source prefix before an atom without changing or demoting it", () => {
    const source = "[file.ts](file.ts) ";
    const composer = sourceComposer(source);
    const pasted = "[fiXYZ";
    composer.select(0);
    expect(
      applyComposerSourceEdit(
        composer.view,
        {
          value: pasted + source,
          selection: { from: pasted.length, to: pasted.length },
        },
        { from: 0, to: 0 },
      ),
    ).toBe(true);
    expect(composer.value()).toBe(pasted + source);
    expect(composer.atoms()).toHaveLength(1);
    expect(composer.selection()).toEqual({ from: pasted.length, to: pasted.length });
    expect(composer.undo()).toBe(true);
    expect(composer.value()).toBe(source);
  });
});

/** Mount real ProseMirror widgets while retaining the existing source/history harness. */
function mountSourceWidgets(source: string) {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createSourceEditor(source, host);
  const composer = sourceComposer(source, "MacIntel", editor);
  const view = editor.view;
  let editable = true;
  view.setProps({
    editable: () => editable,
    handleScrollToSelection: () => true,
  });
  composer.select(source.length - 5, source.length);
  return {
    composer,
    host,
    view,
    readOnly() {
      editable = false;
      view.updateState(composer.state);
    },
    destroy() {
      editor.destroy();
      host.remove();
    },
  };
}

describe("mounted composer widget edits", () => {
  let mounted: ReturnType<typeof mountSourceWidgets>;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });
  afterEach(async () => {
    await act(async () => mounted?.destroy());
    vi.unstubAllGlobals();
  });

  const cases = [
    { kind: "task", body: "- [ ] task", selector: "input[type=checkbox]" },
    { kind: "fence", body: "```ts title=example\ncode\n```", selector: "select" },
  ] as const;

  function change(control: HTMLInputElement | HTMLSelectElement) {
    if (control instanceof HTMLInputElement) control.checked = true;
    else control.value = "python";
    control.dispatchEvent(new Event("change", { bubbles: true }));
  }

  it.each(cases)(
    "$kind callback follows the live widget position and selection across source edits and undo",
    async ({ kind, body, selector }) => {
      const source = `@README.md lead\n${body}\nafter`;
      await act(async () => {
        mounted = mountSourceWidgets(source);
      });
      const { composer } = mounted;
      const control = mounted.host.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!;
      expect(control).not.toBeNull();
      const atom = composer.atoms()[0]!;
      // Keep the original mounted callback, but move its target and change the live selection.
      await act(async () => {
        composer.select(0);
        composer.type("prefix ");
        composer.select(composer.value().length - 4, composer.value().length - 1);
      });
      expect(mounted.host.querySelector(selector)).toBe(control);
      const before = composer.value();
      const selection = composer.selection();
      const edits = composer.transactions.filter((transaction) => transaction.docChanged).length;
      const focus = vi.spyOn(mounted.view, "focus");
      if (kind === "task") {
        const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
        control.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
      }
      await act(async () => change(control));
      const after =
        kind === "task" ? before.replace("[ ]", "[x]") : before.replace("```ts", "```python");
      const delta = kind === "task" ? 0 : 4;
      expect(composer.value()).toBe(after);
      expect(composer.selection()).toEqual({
        from: selection.from + delta,
        to: selection.to + delta,
      });
      expect(composer.transactions.filter((transaction) => transaction.docChanged)).toHaveLength(
        edits + 1,
      );
      expect(composer.atoms()[0]!.eq(atom)).toBe(true);
      expect(focus).toHaveBeenCalledTimes(kind === "task" ? 0 : 1);
      await act(async () => {
        expect(composer.undo()).toBe(true);
      });
      expect(composer.value()).toBe(before);
      expect(composer.selection()).toEqual(selection);
      await act(async () => {
        expect(composer.redo()).toBe(true);
      });
      expect(composer.value()).toBe(after);
      expect(composer.selection()).toEqual({
        from: selection.from + delta,
        to: selection.to + delta,
      });
    },
  );

  it.each(cases)(
    "$kind callback ignores read-only and removed targets",
    async ({ body, selector }) => {
      const source = `@README.md lead\n${body}\nafter`;
      await act(async () => {
        mounted = mountSourceWidgets(source);
      });
      const { composer } = mounted;
      const control = mounted.host.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!;
      expect(control).not.toBeNull();
      const focus = vi.spyOn(mounted.view, "focus");
      mounted.readOnly();
      const dispatches = composer.transactions.length;
      const selection = composer.selection();
      await act(async () => change(control));
      expect(composer.transactions).toHaveLength(dispatches);
      expect(composer.value()).toBe(source);
      expect(composer.selection()).toEqual(selection);
      expect(focus).not.toHaveBeenCalled();
      if (control instanceof HTMLInputElement) expect(control.checked).toBe(false);

      // Return to editable before removing the target, so the missing-position guard is exercised.
      mounted.view.setProps({ editable: () => true });
      await act(async () => {
        composer.select(source.indexOf(body), source.indexOf(body) + body.length);
        composer.type("plain");
        expect(mounted.host.querySelector(selector)).toBeNull();
        const dispatchesAfterRemoval = composer.transactions.length;
        const selectionAfterRemoval = composer.selection();
        // Invoke the detached control before the fence root's queued unmount.
        change(control);
        expect(composer.transactions).toHaveLength(dispatchesAfterRemoval);
        expect(composer.selection()).toEqual(selectionAfterRemoval);
      });
      expect(composer.value()).toBe("@README.md lead\nplain\nafter");
      expect(focus).not.toHaveBeenCalled();
    },
  );
});
