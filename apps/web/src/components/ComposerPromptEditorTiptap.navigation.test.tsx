// @vitest-environment jsdom

import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { serializeEditorDoc } from "~/composer-rich-text-doc";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

const draft =
  "> **Assistant and reasoning text still save intermediate full snapshots**, using the existing 50 ms batching. Compaction still preserves their `turn-item.updated` events. [Code](/workspace/example/src/ProjectionMaintenance.ts:235)";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function mountEditor(value: string, richTextEnabled = true, cursor = 0) {
  await act(async () =>
    root.render(
      <ComposerPromptEditor
        editorRef={createRef<ComposerPromptEditorHandle>()}
        value={value}
        cursor={cursor}
        richTextEnabled={richTextEnabled}
        contextRecords={new Map()}
        skills={[]}
        disabled={false}
        placeholder=""
        onChange={() => {}}
        onPaste={() => {}}
      />,
    ),
  );
  const element = container.querySelector<HTMLElement & { editor: Editor }>(".tiptap");
  if (!element) throw new Error("Composer did not mount");
  return element.editor;
}

function press(editor: Editor, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, cancelable: true, ...options });
  const handled = editor.view.props.handleKeyDown?.(editor.view, event);
  expect(event.defaultPrevented).toBe(Boolean(handled));
  return handled;
}

it.each([false, true])(
  "leaves Up before source markers to the browser with preview %s",
  async (preview) => {
    const editor = await mountEditor(draft, preview, draft.indexOf("**"));
    const position = editor.state.selection.from;
    await act(async () => {
      editor.view.focus();
      expect(press(editor, "ArrowUp")).toBe(false);
      expect(editor.state.selection.from).toBe(position);
      editor.view.updateState(editor.state);
      // Source markers have their own text positions; no styled-edge stop is needed.
      expect(press(editor, "ArrowUp")).toBe(false);
      editor.commands.insertContent("x");
    });
    expect(serializeEditorDoc(editor.state.doc).value).toBe(draft.replace("> **", "> x**"));
  },
);

it.each([false, true])(
  "leaves Down after source markers to the browser with preview %s",
  async (preview) => {
    const editor = await mountEditor("> **bold**", preview);
    await act(async () => {
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)));
      expect(press(editor, "ArrowDown")).toBe(false);
      expect(press(editor, "ArrowDown")).toBe(false);
      editor.commands.insertContent("x");
    });
    expect(serializeEditorDoc(editor.state.doc).value).toBe("> **bold**x");
  },
);

it("leaves vertical navigation between paragraphs to the browser", async () => {
  const editor = await mountEditor("**first**\n**second**");
  await act(async () => {
    const first = editor.state.doc.child(0);
    editor.commands.setTextSelection(first.nodeSize + 1);
    expect(press(editor, "ArrowUp")).toBe(false);
    editor.commands.setTextSelection(first.nodeSize - 1);
    expect(press(editor, "ArrowDown")).toBe(false);
  });
});

it.each([
  { shiftKey: true },
  { altKey: true },
  { metaKey: true },
  { ctrlKey: true },
  { isComposing: true },
])("preserves modified Up behavior for %j", async (options) => {
  const editor = await mountEditor(draft, true, draft.indexOf("Assistant"));
  await act(async () => {
    expect(press(editor, "ArrowUp", options)).toBe(false);
    editor.commands.insertContent("x");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe(draft.replace("> **", "> **x"));
});

it("leaves literal Markdown navigation to the browser in plain mode", async () => {
  const editor = await mountEditor(draft, false);
  await act(async () => {
    editor.commands.setTextSelection(5);
    expect(press(editor, "ArrowUp")).toBe(false);
    editor.commands.insertContent("x");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe(draft.replace("> **", "> **x"));
});
