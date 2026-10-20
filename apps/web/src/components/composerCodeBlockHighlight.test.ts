import { Editor, Node as TiptapNode, type JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { type Plugin, TextSelection, type Transaction } from "@tiptap/pm/state";
import { type DecorationSet, type EditorView } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import { flatToPm, serializeEditorDoc } from "~/composer-rich-text-doc";
import {
  ComposerLivePreviewExtension,
  composerLivePreviewKey,
} from "~/lastcodeComposerLivePreviewTiptap";
import { MAX_COMPOSER_LIVE_PREVIEW_LENGTH } from "~/lastcodeComposerLivePreview";
import type { DiffThemeName } from "~/lib/diffRendering";
import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";

import { composerCodeBlockHighlight, tokenizeBlock } from "./composerCodeBlockHighlight";

vi.mock("~/lib/syntaxHighlighting", () => ({ getSyntaxHighlighterPromise: vi.fn() }));

const THEME = "pierre-dark" as DiffThemeName;

function fakeHighlighter(colorFor: (content: string) => string | undefined) {
  return {
    codeToTokens(code: string) {
      return {
        tokens: code.split(/\r?\n/).map((line) =>
          line
            .split(/(\s+)/)
            .filter((part) => part.length > 0)
            .map((content) => ({ content, color: colorFor(content) })),
        ),
      };
    },
  } as unknown as Parameters<typeof tokenizeBlock>[0];
}

describe("composer code block highlighting", () => {
  it("maps token offsets to positions within the block text", () => {
    const highlighter = fakeHighlighter((content) => (content === "const" ? "#ff0000" : undefined));

    const decorations = tokenizeBlock(highlighter, "const answer = 42", "ts", THEME);

    expect(decorations).toEqual([{ from: 0, to: 5, color: "#ff0000" }]);
  });

  it("accounts for the newline between lines", () => {
    const highlighter = fakeHighlighter((content) => (content === "two" ? "#00ff00" : undefined));

    const decorations = tokenizeBlock(highlighter, "one\ntwo", "ts", THEME);

    expect(decorations).toEqual([{ from: 4, to: 7, color: "#00ff00" }]);
  });

  it("accounts for both characters of a CRLF line break", () => {
    const highlighter = fakeHighlighter((content) => (content === "two" ? "#00ff00" : undefined));

    const decorations = tokenizeBlock(highlighter, "one\r\ntwo", "ts", THEME);

    expect(decorations).toEqual([{ from: 5, to: 8, color: "#00ff00" }]);
  });

  it("counts supplementary characters as UTF-16 source offsets", () => {
    const highlighter = fakeHighlighter((content) => (content === "two" ? "#00ff00" : undefined));
    expect(tokenizeBlock(highlighter, "😀\ntwo", "ts", THEME)).toEqual([
      { from: 3, to: 6, color: "#00ff00" },
    ]);
  });

  it("skips whitespace-only tokens so indentation is not decorated", () => {
    const highlighter = fakeHighlighter(() => "#0000ff");

    const decorations = tokenizeBlock(highlighter, "  indented", "ts", THEME);

    expect(decorations).toEqual([{ from: 2, to: 10, color: "#0000ff" }]);
  });

  it("falls back to plain text when the grammar throws", () => {
    const throwing = {
      codeToTokens() {
        throw new Error("unsupported language");
      },
    } as unknown as Parameters<typeof tokenizeBlock>[0];

    expect(tokenizeBlock(throwing, "const answer = 42", "nope", THEME)).toEqual([]);
  });
});

describe("source fence highlighting", () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const destroy of cleanup.splice(0)) destroy();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  function sourceContent(source: string): JSONContent {
    return {
      type: "doc",
      content: source.split("\n").map((text) => ({
        type: "paragraph",
        ...(text ? { content: [{ type: "text", text }] } : {}),
      })),
    };
  }

  const mention = TiptapNode.create({
    name: "composer-mention",
    group: "inline",
    inline: true,
    atom: true,
    addAttributes() {
      return { source: { default: "@long-source-path" } };
    },
  });

  function createHarness(source: string, options?: { enabled?: boolean; chip?: boolean }) {
    let theme = THEME;
    let notifyTheme = () => {};
    vi.unstubAllGlobals();
    const content = sourceContent(source);
    if (options?.chip) {
      content.content!.unshift({
        type: "paragraph",
        content: [{ type: "composer-mention" }],
      });
    }
    const editor = new Editor({
      extensions: [
        StarterKit.configure({ codeBlock: false, trailingNode: false }),
        mention,
        ComposerLivePreviewExtension.configure({ enabled: options?.enabled ?? true }),
        composerCodeBlockHighlight({ resolveTheme: () => theme }),
      ],
      content,
    });
    vi.stubGlobal("document", { documentElement: {} });
    vi.stubGlobal(
      "MutationObserver",
      class {
        constructor(callback: () => void) {
          notifyTheme = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    let state = editor.state.reconfigure({ plugins: editor.extensionManager.plugins });
    const plugin = state.plugins.find((candidate) =>
      (candidate as unknown as { key: string }).key.startsWith("composerCodeBlockHighlight"),
    );
    if (!plugin?.spec.view) throw new Error("highlight plugin missing");
    const paints: Array<() => void> = [];
    let pluginView: ReturnType<NonNullable<typeof plugin.spec.view>> | undefined;
    const view = {
      get state() {
        return state;
      },
      dispatch(transaction: Transaction) {
        apply(transaction);
        paints.shift()?.();
      },
    } as unknown as EditorView;
    const apply = (transaction: Transaction) => {
      const previous = state;
      state = state.apply(transaction);
      pluginView?.update?.(view, previous);
    };
    pluginView = plugin.spec.view(view);
    const destroy = () => {
      pluginView?.destroy?.();
      editor.destroy();
    };
    cleanup.push(destroy);
    return {
      get state() {
        return state;
      },
      apply,
      paint: () => new Promise<void>((resolve) => paints.push(resolve)),
      decorations: () => (plugin.getState(state) as DecorationSet).find(),
      textFor: (from: number, to: number) => state.doc.textBetween(from, to, "\n", "\uFFFC"),
      setTheme(nextTheme: DiffThemeName) {
        theme = nextTheme;
        notifyTheme();
      },
      destroy,
    };
  }

  it("colors source bodies across paragraphs without touching fence syntax or stored text", async () => {
    vi.mocked(getSyntaxHighlighterPromise).mockResolvedValue(fakeHighlighter(() => "#ff0000"));
    const source = "before\n```ts title=x\nconst 😀\ntwo\n```\nafter";
    const harness = createHarness(source);
    await harness.paint();
    expect(harness.decorations().map((range) => harness.textFor(range.from, range.to))).toEqual([
      "const",
      "😀",
      "two",
    ]);
    expect(vi.mocked(getSyntaxHighlighterPromise)).toHaveBeenCalledWith("ts");
    expect(serializeEditorDoc(harness.state.doc).value).toBe(source);
    expect(
      harness.state.doc.content.content.every(
        (node: ProseMirrorNode) => node.type.name === "paragraph",
      ),
    ).toBe(true);
  });

  it("highlights quoted/list code without coloring its container prefixes", async () => {
    const highlighter = fakeHighlighter(() => "#ff0000");
    const tokenize = vi.spyOn(highlighter, "codeToTokens");
    vi.mocked(getSyntaxHighlighterPromise).mockResolvedValue(highlighter);
    const source = "> - ```ts\r\n>   code\r\n>   x > y\r\n>   ```\n\n- ```ts\n  other\n  ```";
    const harness = createHarness(source);
    await harness.paint();
    const painted = harness.decorations().map((range) => harness.textFor(range.from, range.to));
    expect(painted).toEqual(["code", "x", ">", "y", "other"]);
    expect(tokenize.mock.calls.map((call) => call[0])).toContain("code\r\nx > y\r\n");
    expect(tokenize.mock.calls.map((call) => call[0])).toContain("other\n");
    expect(serializeEditorDoc(harness.state.doc).value).toBe(source);
  });

  it("uses collapsed fence offsets when a source-expanding chip precedes the fence", async () => {
    vi.mocked(getSyntaxHighlighterPromise).mockResolvedValue(fakeHighlighter(() => "#ff0000"));
    const harness = createHarness("```ts\ncode\n```", { chip: true });
    await harness.paint();
    expect(harness.decorations().map((range) => harness.textFor(range.from, range.to))).toEqual([
      "code",
    ]);
    expect(serializeEditorDoc(harness.state.doc).value).toBe("@long-source-path\n```ts\ncode\n```");
  });

  it("still paints successful fences when another highlighter fails to load", async () => {
    vi.mocked(getSyntaxHighlighterPromise).mockImplementation((language) =>
      language === "ts"
        ? Promise.resolve(fakeHighlighter(() => "#ff0000"))
        : Promise.reject(new Error("Shiki failed to initialize")),
    );
    const harness = createHarness("```ts\na\n```\n```py\nb\n```");
    await harness.paint();
    expect(harness.decorations().map((range) => harness.textFor(range.from, range.to))).toEqual([
      "a",
    ]);
  });

  it("drops a stale async result after its source fence is replaced", async () => {
    let resolveOld!: (highlighter: Parameters<typeof tokenizeBlock>[0]) => void;
    const old = new Promise<Parameters<typeof tokenizeBlock>[0]>((resolve) => {
      resolveOld = resolve;
    });
    const highlighter = fakeHighlighter(() => "#ff0000");
    const tokenize = vi.spyOn(highlighter, "codeToTokens");
    vi.mocked(getSyntaxHighlighterPromise).mockReturnValueOnce(old).mockResolvedValue(highlighter);
    const harness = createHarness("```ts\nold\n```");
    const preview = composerLivePreviewKey.getState(harness.state)!;
    const from = flatToPm(preview.map, preview.source.indexOf("old"));
    harness.apply(harness.state.tr.insertText("new", from, from + 3));
    await harness.paint();
    expect(harness.decorations().map((range) => harness.textFor(range.from, range.to))).toEqual([
      "new",
    ]);
    resolveOld(highlighter);
    await old;
    expect(tokenize.mock.calls.map(([code]) => code)).toEqual(["new\n"]);
    expect(harness.decorations().map((range) => harness.textFor(range.from, range.to))).toEqual([
      "new",
    ]);
  });

  it("reuses unchanged fence tokens after source outside it shifts its positions", async () => {
    const highlighter = fakeHighlighter(() => "#ff0000");
    const tokenize = vi.spyOn(highlighter, "codeToTokens");
    vi.mocked(getSyntaxHighlighterPromise).mockResolvedValue(highlighter);
    const harness = createHarness("before\n```ts\ncode\n```");
    await harness.paint();
    const oldPosition = harness.decorations()[0]!.from;
    harness.apply(harness.state.tr.insertText("more ", 1));
    expect(harness.decorations()[0]!.from).toBe(oldPosition + 5);
    expect(harness.decorations().map((range) => harness.textFor(range.from, range.to))).toEqual([
      "code",
    ]);
    const preview = composerLivePreviewKey.getState(harness.state)!;
    harness.apply(
      harness.state.tr.setSelection(
        TextSelection.create(harness.state.doc, flatToPm(preview.map, 3)),
      ),
    );
    expect(tokenize).toHaveBeenCalledTimes(1);
    expect(getSyntaxHighlighterPromise).toHaveBeenCalledTimes(1);
  });

  it("repaints for a theme change while preserving source", async () => {
    const highlighter = fakeHighlighter(() => "#ff0000");
    vi.mocked(getSyntaxHighlighterPromise).mockResolvedValue(highlighter);
    const harness = createHarness("```ts\ncode\n```");
    await harness.paint();
    const tokenize = vi.spyOn(highlighter, "codeToTokens");
    const repaint = harness.paint();
    harness.setTheme("github-light" as DiffThemeName);
    await repaint;
    expect(tokenize).toHaveBeenCalledWith("code\n", { lang: "ts", theme: "github-light" });
    expect(harness.decorations()).toHaveLength(1);
    expect(serializeEditorDoc(harness.state.doc).value).toBe("```ts\ncode\n```");
  });

  it("clears decorations when preview is disabled and paints again when enabled", async () => {
    vi.mocked(getSyntaxHighlighterPromise).mockResolvedValue(fakeHighlighter(() => "#ff0000"));
    const harness = createHarness("```ts\ncode\n```");
    await harness.paint();
    harness.apply(harness.state.tr.setMeta(composerLivePreviewKey, { enabled: false }));
    expect(harness.decorations()).toEqual([]);
    const repaint = harness.paint();
    harness.apply(harness.state.tr.setMeta(composerLivePreviewKey, { enabled: true }));
    await repaint;
    expect(harness.decorations()).toHaveLength(1);
  });

  it("does not load a grammar while preview is disabled or source is above its cap", () => {
    vi.mocked(getSyntaxHighlighterPromise).mockResolvedValue(fakeHighlighter(() => "#ff0000"));
    const disabled = createHarness("```ts\ncode\n```", { enabled: false });
    expect(disabled.decorations()).toEqual([]);
    const capped = createHarness(
      `\`\`\`ts\n${"x".repeat(MAX_COMPOSER_LIVE_PREVIEW_LENGTH + 1)}\n\`\`\``,
    );
    expect(capped.decorations()).toEqual([]);
    expect(getSyntaxHighlighterPromise).not.toHaveBeenCalled();
  });

  it("leaves a small fence plain when the surrounding prompt exceeds the presentation cap", () => {
    vi.mocked(getSyntaxHighlighterPromise).mockResolvedValue(fakeHighlighter(() => "#ff0000"));
    const source = `${"x".repeat(MAX_COMPOSER_LIVE_PREVIEW_LENGTH)}\n\`\`\`ts\ncode\n\`\`\``;
    const harness = createHarness(source);
    expect(composerLivePreviewKey.getState(harness.state)!.parsed).toBe(false);
    expect(harness.decorations()).toEqual([]);
    expect(getSyntaxHighlighterPromise).not.toHaveBeenCalled();
  });

  it("maps existing colors during composition and tokenizes the completed source", async () => {
    const highlighter = fakeHighlighter(() => "#ff0000");
    const tokenize = vi.spyOn(highlighter, "codeToTokens");
    vi.mocked(getSyntaxHighlighterPromise).mockResolvedValue(highlighter);
    const harness = createHarness("```ts\ncode\n```");
    await harness.paint();
    harness.apply(harness.state.tr.setMeta(composerLivePreviewKey, { composing: true }));
    const preview = composerLivePreviewKey.getState(harness.state)!;
    const from = flatToPm(preview.map, preview.source.indexOf("code"));
    harness.apply(harness.state.tr.insertText("x", from));
    expect(tokenize).toHaveBeenCalledTimes(1);
    const repaint = harness.paint();
    harness.apply(harness.state.tr.setMeta(composerLivePreviewKey, { composing: false }));
    await repaint;
    expect(tokenize.mock.calls.map(([code]) => code)).toEqual(["code\n", "xcode\n"]);
    expect(harness.decorations().map((range) => harness.textFor(range.from, range.to))).toEqual([
      "xcode",
    ]);
  });

  it("does not repaint after destruction while a grammar is still loading", async () => {
    let resolve!: (highlighter: Parameters<typeof tokenizeBlock>[0]) => void;
    const grammar = new Promise<Parameters<typeof tokenizeBlock>[0]>((done) => {
      resolve = done;
    });
    vi.mocked(getSyntaxHighlighterPromise).mockReturnValue(grammar);
    const highlighter = fakeHighlighter(() => "#ff0000");
    const tokenize = vi.spyOn(highlighter, "codeToTokens");
    const harness = createHarness("```ts\ncode\n```");
    harness.destroy();
    resolve(highlighter);
    await grammar;
    expect(tokenize).not.toHaveBeenCalled();
    expect(harness.decorations()).toEqual([]);
  });
});

describe("highlighting edited fences", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function mountFence(text: string, resolveTheme = () => THEME) {
    vi.useFakeTimers();
    const highlighter = fakeHighlighter((content) =>
      content.startsWith("x") ? "#ff0000" : undefined,
    );
    const tokenize = vi.spyOn(highlighter, "codeToTokens");
    vi.mocked(getSyntaxHighlighterPromise).mockResolvedValue(highlighter);
    const editor = new Editor({
      extensions: [
        StarterKit.configure({ codeBlock: false, trailingNode: false }),
        ComposerLivePreviewExtension.configure({ enabled: true }),
        composerCodeBlockHighlight({ resolveTheme }),
      ],
      content: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "```ts" }] },
          { type: "paragraph", content: [{ type: "text", text }] },
        ],
      },
    });
    vi.stubGlobal("document", { documentElement: {} });
    vi.stubGlobal(
      "MutationObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    // Source preview must precede highlighting, as in the mounted editor.
    let state = editor.state.reconfigure({ plugins: editor.extensionManager.plugins });
    const plugin = state.plugins.find((candidate) =>
      (candidate as unknown as { key: string }).key.startsWith("composerCodeBlockHighlight"),
    ) as Plugin<DecorationSet>;
    const codeStart = state.doc.child(0).nodeSize + 1;
    // Like a real view, every dispatch updates the plugin's view.
    let pluginView: ReturnType<NonNullable<typeof plugin.spec.view>> | undefined;
    const view = {
      get state() {
        return state;
      },
      dispatch: (transaction: Transaction) => {
        const previous = state;
        state = state.apply(transaction);
        pluginView?.update?.(view, previous);
      },
    } as unknown as EditorView;
    pluginView = plugin.spec.view!(view);
    onTestFinished(() => {
      pluginView?.destroy?.();
      editor.destroy();
    });
    await vi.advanceTimersByTimeAsync(0);
    return {
      tokenize,
      codeStart,
      ranges: () =>
        plugin
          .getState(state)!
          .find()
          .map(({ from, to }) => [from - codeStart + 1, to - codeStart + 1]),
      edit: async (change: (transaction: Transaction) => Transaction) => {
        view.dispatch(change(state.tr));
        await vi.advanceTimersByTimeAsync(0);
      },
      colored: () =>
        plugin
          .getState(state)!
          .find()
          .map((decoration) => state.doc.textBetween(decoration.from, decoration.to)),
    };
  }

  it("maps colors while typing above 2,000 characters and refreshes 300 ms after the last edit", async () => {
    const fence = await mountFence(`x ${"y".repeat(1_999)}`);
    expect(fence.tokenize).toHaveBeenCalledTimes(1);

    await fence.edit((tr) => tr.insertText("x ", fence.codeStart));
    await vi.advanceTimersByTimeAsync(250);
    await fence.edit((tr) => tr.insertText("y ", fence.codeStart));
    await vi.advanceTimersByTimeAsync(299);

    expect(fence.tokenize).toHaveBeenCalledTimes(1);
    expect(fence.colored()).toEqual(["x"]);
    expect(fence.ranges()).toEqual([[5, 6]]);

    await vi.advanceTimersByTimeAsync(1);

    expect(fence.tokenize).toHaveBeenCalledTimes(2);
    expect(fence.colored()).toEqual(["x", "x"]);
  });

  it("ignores a pending highlight when its text is edited away and restored", async () => {
    const fence = await mountFence(`x ${"y".repeat(1_999)}`);
    const staleHighlighter = fakeHighlighter(() => "#00ff00");
    const staleTokenize = vi.spyOn(staleHighlighter, "codeToTokens");
    let finishLoading!: () => void;
    vi.mocked(getSyntaxHighlighterPromise).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishLoading = () => resolve(staleHighlighter);
        }),
    );

    await fence.edit((tr) => tr.insertText("x ", fence.codeStart));
    await vi.advanceTimersByTimeAsync(300);
    await fence.edit((tr) => tr.insertText("y ", fence.codeStart));
    await fence.edit((tr) => tr.delete(fence.codeStart, fence.codeStart + 2));
    finishLoading();
    await vi.advanceTimersByTimeAsync(0);

    expect(staleTokenize).not.toHaveBeenCalled();
    expect(fence.colored()).toEqual(["x"]);
    await vi.advanceTimersByTimeAsync(300);
    expect(fence.tokenize).toHaveBeenCalledTimes(2);
    expect(fence.colored()).toEqual(["x", "x"]);
  });

  it("refreshes a long fence immediately when the theme changes during a pending edit", async () => {
    let theme = THEME;
    const fence = await mountFence(`x ${"y".repeat(1_999)}`, () => theme);
    await fence.edit((tr) => tr.insertText("x ", fence.codeStart));

    theme = "pierre-light";
    await fence.edit((tr) => tr.setMeta("theme", true));

    expect(fence.tokenize).toHaveBeenCalledTimes(2);
    expect(fence.tokenize).toHaveBeenLastCalledWith(expect.any(String), { lang: "ts", theme });
    expect(fence.colored()).toEqual(["x", "x"]);
    await vi.advanceTimersByTimeAsync(300);
    expect(fence.tokenize).toHaveBeenCalledTimes(2);
  });

  it("refreshes immediately when an edit leaves the fence at 2,000 characters", async () => {
    const fence = await mountFence(`x ${"y".repeat(1_996)}`);

    await fence.edit((tr) => tr.insertText("x ", fence.codeStart));

    expect(fence.tokenize).toHaveBeenCalledTimes(2);
    expect(fence.colored()).toEqual(["x", "x"]);
  });

  it("clips a split token to its fences without coloring the paragraph between them", async () => {
    const fence = await mountFence("x".repeat(6_000));

    await fence.edit((tr) =>
      tr.split(fence.codeStart + 3_000).insert(
        fence.codeStart + 3_001,
        ["```", "plain", "```ts"].map((text) =>
          tr.doc.type.schema.node("paragraph", null, [tr.doc.type.schema.text(text)]),
        ),
      ),
    );

    expect(fence.tokenize).toHaveBeenCalledTimes(1);
    expect(fence.colored()).toEqual(["x".repeat(3_000), "x".repeat(3_000)]);
  });

  it("clears retained colors when the new language highlighter fails to load", async () => {
    const fence = await mountFence(`x ${"y".repeat(1_999)}`);
    vi.mocked(getSyntaxHighlighterPromise).mockRejectedValue(new Error("Shiki failed to load"));

    await fence.edit((tr) => tr.insertText("py", 4, 6));
    expect(fence.colored()).toEqual(["x"]);

    await vi.advanceTimersByTimeAsync(300);

    expect(fence.colored()).toEqual([]);
  });
});
