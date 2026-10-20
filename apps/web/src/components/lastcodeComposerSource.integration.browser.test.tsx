import type { Editor } from "@tiptap/core";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { act, createRef, useState, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const captured = vi.hoisted(() => ({ editor: null as Editor | null }));
vi.mock("@tiptap/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tiptap/react")>();
  return {
    ...actual,
    EditorContent: (props: ComponentProps<typeof actual.EditorContent>) => {
      captured.editor = props.editor ?? null;
      return <actual.EditorContent {...props} />;
    },
  };
});
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => () => {},
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";
import { composerLivePreviewKey } from "~/lastcodeComposerLivePreviewTiptap";

let root: Root;
let container: HTMLDivElement;
let lastSuppressTrigger: boolean | undefined;
const editorRef = createRef<ComposerPromptEditorHandle>();

beforeEach(() => {
  lastSuppressTrigger = undefined;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  captured.editor = null;
  vi.unstubAllGlobals();
});

function Composer({ source, preview = true }: { source: string; preview?: boolean }) {
  const [value, setValue] = useState(source);
  const [cursor, setCursor] = useState(source.length);
  return (
    <ComposerPromptEditor
      editorRef={editorRef}
      value={value}
      cursor={cursor}
      richTextEnabled={preview}
      contextRecords={new Map()}
      skills={[{ name: "review", path: "/skills/review/SKILL.md", enabled: true }]}
      disabled={false}
      placeholder=""
      onChange={(nextValue, _cursor, sourceCursor, suppressTrigger) => {
        lastSuppressTrigger = suppressTrigger;
        setValue(nextValue);
        setCursor(sourceCursor);
      }}
      onPaste={() => {}}
    />
  );
}

function editor() {
  if (!captured.editor) throw new Error("The active wrapper did not mount its editor");
  return captured.editor;
}

function paste(text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { files: [], getData: (type: string) => (type === "text/plain" ? text : "") },
  });
  return editor().view.someProp("handlePaste", (handler) =>
    handler(editor().view, event as ClipboardEvent, editor().state.doc.slice(0, 0)),
  );
}

it.each([false, true])(
  "makes existing chips editable when a fence is typed around them with preview %s",
  async (preview) => {
    const outside = "[outside.ts](src/outside.ts)\n";
    const citation = serializeAssistantCitation({
      version: 1,
      environmentId: EnvironmentId.make("test-environment"),
      threadId: ThreadId.make("test-thread"),
      messageId: MessageId.make("test-message"),
      text: "quoted text",
      start: 0,
      end: 11,
      prefix: "",
      suffix: "",
    });
    const body = `[example.ts](src/example.ts) $review [Trace](t3-context://v1/terminal/trace-1) ${citation}`;
    const source = outside + "\n" + body + "\n";
    await act(async () => root.render(<Composer source={source} preview={preview} />));
    const atoms = () => {
      const names: string[] = [];
      editor().state.doc.descendants((node) => {
        if (node.isAtom && !node.isText) names.push(node.type.name);
      });
      return names;
    };
    expect(atoms()).toEqual([
      "composer-mention",
      "composer-mention",
      "composer-skill",
      "composer-context-reference",
      "composer-citation",
    ]);
    await act(async () => editorRef.current?.focusAt(outside.length));
    for (const character of "```text") {
      await act(async () => {
        editor().view.dispatch(editor().state.tr.insertText(character));
      });
    }
    const openFence = outside + "```text\n" + body + "\n";
    expect(editorRef.current?.readSnapshot()).toMatchObject({
      value: openFence,
      expandedCursor: outside.length + 7,
    });
    expect(atoms()).toEqual(["composer-mention"]);
    await act(async () => {
      expect(editor().commands.undo()).toBe(true);
    });
    expect(editorRef.current?.readSnapshot().value).toBe(source);
    expect(atoms()).toHaveLength(5);
    await act(async () => {
      expect(editor().commands.redo()).toBe(true);
    });
    expect(editorRef.current?.readSnapshot().value).toBe(openFence);
    expect(atoms()).toEqual(["composer-mention"]);
    await act(async () => editorRef.current?.focusAt(openFence.length));
    for (const character of "```") {
      await act(async () => {
        editor().view.dispatch(editor().state.tr.insertText(character));
      });
    }
    const fenced = openFence + "```";
    expect(editorRef.current?.readSnapshot().value).toBe(fenced);
    const offset = fenced.indexOf("example") + 3;
    await act(async () => editorRef.current?.focusAt(offset));
    expect(editorRef.current?.readSnapshot().expandedCursor).toBe(offset);
    await act(async () => {
      editor().view.dispatch(editor().state.tr.insertText("X"));
    });
    expect(editorRef.current?.readSnapshot().value).toBe(
      fenced.slice(0, offset) + "X" + fenced.slice(offset),
    );
    await act(async () => {
      expect(editor().commands.undo()).toBe(true);
    });
    expect(editorRef.current?.readSnapshot().value).toBe(fenced);
    expect(atoms()).toEqual(["composer-mention"]);
  },
);

it.each([
  { preview: false, composing: false },
  { preview: true, composing: false },
  { preview: false, composing: true },
  { preview: true, composing: true },
])(
  "suppresses fenced suggestions with preview $preview and composing $composing",
  async ({ preview, composing }) => {
    const source = "```text\n\n```\n";
    await act(async () => root.render(<Composer source={source} preview={preview} />));
    await act(async () => editorRef.current?.focusAt(source.indexOf("\n") + 1));
    await act(async () => {
      if (composing) {
        editor().view.dispatch(
          editor().state.tr.setMeta(composerLivePreviewKey, { composing: true }),
        );
      }
      editor().view.dispatch(editor().state.tr.insertText("@foobar"));
    });
    expect(lastSuppressTrigger).toBe(true);
    const changed = editorRef.current!.readSnapshot().value;
    await act(async () => editorRef.current?.focusAt(changed.length));
    await act(async () => {
      editor().view.dispatch(editor().state.tr.insertText("@foo"));
    });
    expect(lastSuppressTrigger).toBe(false);
  },
);

it.each([false, true])(
  "keeps fence paste literal with preview %s and restores source positions inside token-looking text",
  async (preview) => {
    const source = "```text\n[example.ts](src/example.ts)\n```";
    await act(async () => root.render(<Composer source={source} preview={preview} />));
    const offset = source.indexOf("example") + 3;
    await act(async () => editorRef.current?.focusAt(offset));
    expect(editorRef.current?.readSnapshot().expandedCursor).toBe(offset);
    await act(async () => {
      expect(paste("**a**\n[pasted.ts](src/pasted.ts)")).toBe(true);
    });
    expect(editorRef.current?.readSnapshot().value).toBe(
      source.slice(0, offset) + "**a**\n[pasted.ts](src/pasted.ts)" + source.slice(offset),
    );
    expect(editor().state.doc.textContent).toContain("[exa**a**");
    const atoms: string[] = [];
    editor().state.doc.descendants((node) => {
      if (node.isAtom && !node.isText) atoms.push(node.type.name);
    });
    expect(atoms).toEqual([]);
    expect(editorRef.current?.readSnapshot().expandedCursor).toBe(
      offset + "**a**\n[pasted.ts](src/pasted.ts)".length,
    );
    await act(async () => {
      expect(editor().commands.undo()).toBe(true);
    });
    expect(editorRef.current?.readSnapshot().value).toBe(source);
  },
);

it.each([false, true])("pastes a complete literal fence with preview %s", async (preview) => {
  const source = "```text\n[example.ts](src/example.ts)\n```";
  await act(async () => root.render(<Composer source="" preview={preview} />));
  await act(async () => {
    expect(paste(source)).toBe(true);
  });
  expect(editorRef.current?.readSnapshot().value).toBe(source);
  const atoms: string[] = [];
  editor().state.doc.descendants((node) => {
    if (node.isAtom && !node.isText) atoms.push(node.type.name);
  });
  expect(atoms).toEqual([]);
  expect(editorRef.current?.readSnapshot().expandedCursor).toBe(source.length);
  await act(async () => {
    expect(editor().commands.undo()).toBe(true);
  });
  expect(editorRef.current?.readSnapshot().value).toBe("");
});

it("preserves real chips and context references when copying source through the wrapper", async () => {
  const source = "**see** [example.ts](src/example.ts) [Trace](t3-context://v1/terminal/trace-1)";
  await act(async () => root.render(<Composer source={source} />));
  const nodeNames: string[] = [];
  editor().state.doc.descendants((node) => {
    nodeNames.push(node.type.name);
  });
  expect(nodeNames).toContain("composer-mention");
  expect(nodeNames).toContain("composer-context-reference");
  expect(editorRef.current?.readSnapshot().contextIds).toEqual(["trace-1"]);
  await act(async () => {
    editor().commands.selectAll();
  });
  const clipboard = new Map<string, string>();
  const event = new Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { setData: (type: string, value: string) => clipboard.set(type, value) },
  });
  await act(async () => {
    editor().view.dom.dispatchEvent(event);
  });
  expect(clipboard.get("text/plain")).toBe(source);
});

it("retains the editor and its paste undo step when preview is toggled", async () => {
  await act(async () => root.render(<Composer source="before " />));
  const mounted = editor();
  await act(async () => {
    expect(paste("**after**")).toBe(true);
  });
  expect(editorRef.current?.readSnapshot().value).toBe("before **after**");
  await act(async () => root.render(<Composer source="before " preview={false} />));
  expect(editor()).toBe(mounted);
  await act(async () => {
    expect(editor().commands.undo()).toBe(true);
  });
  expect(editorRef.current?.readSnapshot().value).toBe("before ");
});

it("keeps fenced tokens literal across a preview toggle without losing source selection or undo", async () => {
  const outside = "[outside.ts](src/outside.ts)";
  const source = `${outside}\n\`\`\`text\n[example.ts](src/example.ts)\n\`\`\``;
  await act(async () => root.render(<Composer source={source} preview={false} />));
  const mounted = editor();
  const atomSources = () => {
    const sources: string[] = [];
    editor().state.doc.descendants((node) => {
      if (node.isAtom && !node.isText) sources.push(node.attrs.source);
    });
    return sources;
  };
  expect(atomSources()).toEqual([outside]);
  const offset = source.indexOf("example") + 3;
  await act(async () => editorRef.current?.focusAt(offset));
  expect(editorRef.current?.readSnapshot().expandedCursor).toBe(offset);
  await act(async () => {
    editor().view.dispatch(editor().state.tr.insertText("X"));
  });
  const editedSource = source.slice(0, offset) + "X" + source.slice(offset);
  expect(editorRef.current?.readSnapshot().value).toBe(editedSource);

  await act(async () => root.render(<Composer source={source} preview />));
  expect(editor()).toBe(mounted);
  expect(atomSources()).toEqual([outside]);
  expect(editorRef.current?.readSnapshot()).toMatchObject({
    value: editedSource,
    expandedCursor: offset + 1,
  });
  await act(async () => {
    expect(editor().commands.undo()).toBe(true);
  });
  expect(editorRef.current?.readSnapshot().value).toBe(source);
  expect(atomSources()).toEqual([outside]);
});

it("normalizes HTML clipboard breaks through the active source editor", async () => {
  await act(async () => root.render(<Composer source="" />));
  await act(async () => {
    expect(
      editor().view.pasteHTML(
        "<p>first<br>second</p>",
        new Event("paste", { cancelable: true }) as ClipboardEvent,
      ),
    ).toBe(true);
  });
  expect(editorRef.current?.readSnapshot().value).toBe("first\nsecond");
});

it("formats source as one undo step through the editor keyboard handler", async () => {
  await act(async () => root.render(<Composer source="word" />));
  await act(async () => {
    editor().commands.setTextSelection({ from: 1, to: 5 });
  });
  const event = new KeyboardEvent("keydown", {
    key: "b",
    ...(navigator.platform.includes("Mac") ? { metaKey: true } : { ctrlKey: true }),
    cancelable: true,
  });
  await act(async () => {
    expect(
      editor().view.someProp("handleKeyDown", (handler) => handler(editor().view, event)),
    ).toBe(true);
  });
  expect(editorRef.current?.readSnapshot().value).toBe("**word**");
  await act(async () => {
    expect(editor().commands.undo()).toBe(true);
  });
  expect(editorRef.current?.readSnapshot().value).toBe("word");
});
