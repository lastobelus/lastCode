import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { searchableMessageSegments } from "@t3tools/shared/threadFindText";
import { countThreadSearchOccurrences } from "@t3tools/shared/threadSearch";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { chatMarkdownClipboardPayload } from "../markdown-clipboard";
import { getSyntaxHighlighterPromise } from "../lib/syntaxHighlighting";
import { MarkdownFindContext } from "./chat/markdownFindContext";
import { useThreadFindHighlights } from "./chat/threadFindHighlights";
import { setMarkdownTaskChecked } from "../markdownTaskList";
import { readThreadHandoffs, useHandoffsStore } from "../handoffs/handoffsStore";
import { useRightPanelStore, selectThreadRightPanelState } from "../rightPanelStore";
import { toastManager } from "./ui/toast";

const markdownOpenMocks = vi.hoisted(() => ({
  prepareHostedPreview: vi.fn(),
  searchProjectEntries: vi.fn(),
  createAssetUrl: vi.fn(),
  openPullRequest: vi.fn(),
  denyFilesystemRead: false,
  preparedConnection: null as { httpBaseUrl: string } | null,
  localApi: undefined as unknown,
}));
vi.mock(import("../localApi"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    readLocalApi: (() => markdownOpenMocks.localApi ?? actual.readLocalApi()) as never,
    ensureLocalApi: (() => markdownOpenMocks.localApi ?? actual.ensureLocalApi()) as never,
  };
});
vi.mock(import("./preview/previewHostingRecovery"), async (original) => ({
  ...(await original()),
  prepareHostedPreview: markdownOpenMocks.prepareHostedPreview,
  mayBeHostedPreviewUrl: (_ref: unknown, url: string) => url.startsWith("http://localhost:4173/"),
}));
vi.mock(import("../state/use-atom-query-runner"), async (original) => {
  const { projectEnvironment } = await import("../state/projects");
  return {
    ...(await original()),
    useAtomQueryRunner: ((query: unknown) =>
      query === projectEnvironment.searchEntries
        ? markdownOpenMocks.searchProjectEntries
        : markdownOpenMocks.createAssetUrl) as never,
  };
});
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  readEnvironmentSupportsServerBrowser: () => true,
}));
vi.mock(import("~/lib/openPullRequestLink"), async (original) => ({
  ...(await original()),
  resolvePullRequestPreviewTarget: () => null,
  useOpenChangeRequestLink: (() => markdownOpenMocks.openPullRequest) as never,
}));

// Atoms derived from the server config run in the real registry over a missing config.
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
// A standard client session, so environment-owned file links can open.
vi.mock(import("../state/session"), async (original) => {
  const { AuthStandardClientScopes, AuthFilesystemReadScope } = await import("@t3tools/contracts");
  const granted = new Set<string>(AuthStandardClientScopes);
  const hasScope = (environmentId: unknown, scope: string) =>
    environmentId !== null &&
    !(markdownOpenMocks.denyFilesystemRead && scope === AuthFilesystemReadScope) &&
    granted.has(scope);
  return {
    ...(await original()),
    useEnvironmentScope: hasScope as never,
    readEnvironmentScope: hasScope as never,
    readPreparedConnection: (() => markdownOpenMocks.preparedConnection) as never,
    usePreparedConnection: (() =>
      markdownOpenMocks.preparedConnection === null
        ? { _tag: "None" }
        : { _tag: "Some", value: markdownOpenMocks.preparedConnection }) as never,
  };
});
vi.mock(import("../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));
// File-label tests exercise authored media and copy text without depending on external requests.
vi.mock(import("@t3tools/shared/markdownImages"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    classifyMarkdownImageSource: (
      ...args: Parameters<typeof actual.classifyMarkdownImageSource>
    ) => {
      if (
        args[0] === "https://example.com/preview.png" ||
        args[0] === "https://example.com/a.png"
      ) {
        return {
          _tag: "Direct" as const,
          uri: "data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20width=%221%22%20height=%221%22/%3E",
        };
      }
      if (args[0] === "https://example.com/preview.mp4") {
        return { _tag: "Direct" as const, uri: "data:video/mp4;base64," };
      }
      return actual.classifyMarkdownImageSource(...args);
    },
  };
});
// A rendered diagram is an SVG; real Mermaid layout is not what these tests exercise.
vi.mock(import("./chat/MermaidDiagram"), async (original) => ({
  ...(await original()),
  MermaidDiagram: () => <svg aria-label="Diagram" />,
}));

import ChatMarkdown from "./ChatMarkdown";

const roots: Root[] = [];

beforeEach(() => {
  markdownOpenMocks.prepareHostedPreview.mockReset();
  markdownOpenMocks.searchProjectEntries
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ entries: [] }));
  markdownOpenMocks.createAssetUrl.mockReset();
  markdownOpenMocks.openPullRequest.mockReset().mockReturnValue(false);
  markdownOpenMocks.denyFilesystemRead = false;
  markdownOpenMocks.preparedConnection = null;
  markdownOpenMocks.localApi = undefined;
  useHandoffsStore.setState({ byThreadKey: {} });
  useRightPanelStore.setState({ byThreadKey: {} });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  CSS.highlights.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(element: ReactElement) {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return {
    container,
    rerender: (next: ReactElement) => act(async () => root.render(next)),
  };
}

async function renderText(text: string, props: Partial<Parameters<typeof ChatMarkdown>[0]> = {}) {
  return (await render(<ChatMarkdown cwd="/tmp/project" text={text} {...props} />)).container;
}

function linkTexts(container: HTMLElement) {
  return [...container.querySelectorAll("a")].map((link) => link.textContent);
}

function buttonsLabelled(container: HTMLElement, label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].filter(
    (button) => button.getAttribute("aria-label") === label,
  );
}

function fileOptions(container: HTMLElement) {
  return [...container.querySelectorAll("button")]
    .map((button) => button.getAttribute("aria-label"))
    .filter((label) => label?.startsWith("File options for "));
}

describe("ChatMarkdown bare anchor placeholders", () => {
  it.each(["<A>", "<a>", "<a >", "<a/>", "<A/>", "<a />"])(
    "preserves unmatched %s without linking later blocks",
    async (token) => {
      const container = await renderText(
        `- **"From ${token}"** appears in the header.\n\n- **Tests:** cover inheritance.\n\nThe deferred move continues on B.\n\nSee <a href="https://example.com">the link</a>.`,
      );
      expect(container.querySelector("strong")?.textContent).toBe(`"From ${token}"`);
      expect(linkTexts(container)).toEqual(["the link"]);
      expect(container.querySelectorAll("li")).toHaveLength(2);
      expect([...container.querySelectorAll("p")].map((p) => p.textContent)).toContain(
        "The deferred move continues on B.",
      );
    },
  );

  it.each(["</a>  ", "<div>more</div>\n</a>"])(
    "preserves a paired anchor closing in the raw block %s",
    async (closing) => {
      const container = await renderText(`See <a>label\n\n${closing}\n\nfinish`);
      expect(container.querySelector("p")?.textContent).toBe("See label");
    },
  );

  it("preserves a paired anchor after comment-looking raw text", async () => {
    const container = await renderText("See <a>label<script><!-- </script> --></a>");
    expect(container.querySelector("p")?.textContent).toBe("See label -->");
  });

  it.each(["<!-- </a> -->", '<div title="</a>">more</div>', '<script>"</a>"</script>'])(
    "ignores apparent closing anchors inside %s",
    async (html) => {
      const container = await renderText(`Before <A>.\n\n${html}\n\nAfter.`);
      expect(container.querySelector("p")?.textContent).toBe("Before <A>.");
      expect(container.querySelectorAll("a")).toHaveLength(0);
    },
  );

  it("preserves paired HTML anchors, details, markdown links, and inline code", async () => {
    const container = await renderText(
      'Bare <a>label</a>, <a id="section"></a>, `<A>`, and [docs](https://example.com).\n\n<details><summary>More</summary>Details</details>',
    );
    expect(linkTexts(container)).toEqual(["label", "", "docs"]);
    expect(container.querySelector("code")?.textContent).toBe("<A>");
    expect(container.querySelector("[data-markdown-details]")?.textContent).toContain("More");
  });
});

describe("ChatMarkdown context references", () => {
  it("renders text and image references through the chip renderer, with readable fallback", async () => {
    const text =
      "See [Terminal output](t3-context://v1/terminal/term-1) and ![Error image](t3-context://v1/image/img-1).";
    const { container, rerender } = await render(
      <ChatMarkdown
        cwd={undefined}
        text={text}
        renderContextReference={({ kind, label }) => (
          <button>
            {kind}: {label}
          </button>
        )}
      />,
    );
    expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "terminal: Terminal output",
      "image: Error image",
    ]);
    expect(container.querySelectorAll("img, a")).toHaveLength(0);
    await rerender(<ChatMarkdown cwd={undefined} text={text} />);
    expect(container.textContent).toBe("See Terminal output and Error image.");
    expect(container.querySelectorAll("img, a, button")).toHaveLength(0);
  });

  it("reads formatted context labels through nested markup instead of the context id", async () => {
    const seen: Array<string> = [];
    await render(
      <ChatMarkdown
        cwd={undefined}
        text="See [**Bold** `code`](t3-context://v1/terminal/term-1)."
        renderContextReference={({ kind, label }) => {
          seen.push(`${kind}: ${label}`);
          return <button>{label}</button>;
        }}
      />,
    );
    expect(new Set(seen)).toEqual(new Set(["terminal: Bold code"]));
  });
});

describe("ChatMarkdown favicon privacy", () => {
  it("suppresses private link images while preserving public links across updates", async () => {
    const markdown = (url: string) => <ChatMarkdown cwd="/tmp/project" text={`[Link](${url})`} />;
    const { container, rerender } = await render(markdown("https://example.com"));
    expect([...container.querySelectorAll("img")].map((image) => image.src)).toEqual([
      "https://www.google.com/s2/favicons?domain=example.com&sz=32",
    ]);
    for (const url of ["http://192.168.1.10:8080", "http://localhost:3000", "http://home.arpa"]) {
      await rerender(markdown(url));
      expect(container.querySelectorAll("img")).toHaveLength(0);
    }
    await rerender(markdown("https://example.com"));
    expect(container.querySelectorAll("img")).toHaveLength(1);
    await rerender(markdown("https://github.com/pingdotgg/t3code/pull/1"));
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.querySelector("a svg")).not.toBeNull();
  });
});

describe("ChatMarkdown streaming", () => {
  it("runs only a complete single-line shell block after a click", async () => {
    const onRunShellCommand = vi.fn();
    const message = (text: string, isStreaming = false) => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        isStreaming={isStreaming}
        onRunShellCommand={onRunShellCommand}
      />
    );
    const { container, rerender } = await render(message("```bash\necho hello\n```", true));
    const runButtons = () => buttonsLabelled(container, "Run in terminal");
    expect(runButtons()).toHaveLength(0);

    await rerender(message("```bash\necho hello\n```"));
    await act(async () => runButtons()[0]!.click());
    expect(onRunShellCommand).toHaveBeenCalledExactlyOnceWith("echo hello");

    for (const text of [
      "~~~bash\necho tilde\n~~~",
      "> ```bash\n> echo quote\n> ```",
      "````bash\necho four\n````",
    ]) {
      await rerender(message(text));
      expect(runButtons()).toHaveLength(1);
    }

    for (const text of [
      "```bash\necho one\necho two\n```",
      "```typescript\necho hello\n```",
      "```bash\n\n```",
      "```bash\necho hello\n\n```",
      "```bash\necho hello\\\n```",
      "```bash\necho safe \u202e#\n```",
      "```bash\necho incomplete",
      "~~~bash\necho incomplete",
      "````bash\necho incomplete\n```",
      '<pre><code class="language-bash">echo html</code></pre>',
    ]) {
      await rerender(message(text));
      expect(runButtons()).toHaveLength(0);
    }
  });

  it("does not retokenize completed lines when streaming finishes", async () => {
    const highlighter = await getSyntaxHighlighterPromise("typescript");
    const highlight = vi.spyOn(highlighter, "codeToHast");
    const text = "```typescript\nconst completed = 1;\nconst current = 2;";
    const { rerender } = await render(<ChatMarkdown cwd="/tmp/project" text={text} isStreaming />);
    await vi.waitFor(() => expect(highlight).toHaveBeenCalled());
    highlight.mockClear();
    await rerender(<ChatMarkdown cwd="/tmp/project" text={text + "\n```"} />);
    expect(highlight.mock.calls.every(([code]) => !code.includes("const completed"))).toBe(true);
  });

  it("recovers highlighting after a failed fence changes without resetting its controls", async () => {
    const highlighter = await getSyntaxHighlighterPromise("text");
    const codeToHast = highlighter.codeToHast.bind(highlighter);
    let fail = true;
    vi.spyOn(highlighter, "codeToHast").mockImplementation((...args) => {
      if (fail) throw new Error("Temporary highlighter failure");
      return codeToHast(...args);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const { container, rerender } = await render(
      <ChatMarkdown cwd="/tmp/project" text={"```text\ninitial\n```"} isStreaming />,
    );
    const codeBlock = container.querySelector<HTMLElement>('[data-language="text"]')!;
    const initialWrap = codeBlock.dataset.wrap === "true";
    await act(async () =>
      buttonsLabelled(container, initialWrap ? "Disable line wrap" : "Wrap lines")[0]!.click(),
    );
    expect(container.querySelectorAll(".chat-markdown-shiki")).toHaveLength(0);

    fail = false;
    await rerender(
      <ChatMarkdown cwd="/tmp/project" text={"```text\nrecovered\n```"} isStreaming />,
    );
    await vi.waitFor(() =>
      expect(container.querySelectorAll(".chat-markdown-shiki")).toHaveLength(1),
    );
    expect(container.querySelector('[data-language="text"]')).toBe(codeBlock);
    expect(codeBlock.dataset.wrap).toBe(String(!initialWrap));
  });

  it("preserves code controls and details without highlighting an unchanged fence again", async () => {
    const highlighter = await getSyntaxHighlighterPromise("text");
    const highlight = vi.spyOn(highlighter, "codeToHast");
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockImplementation(async () => undefined);
    const text = [
      "```text",
      "First code block",
      "```",
      "",
      "<details><summary>More</summary>",
      "",
      "Details content",
      "",
      "</details>",
      "",
      "Streaming reply",
    ].join("\n");

    const { container, rerender } = await render(
      <ChatMarkdown cwd="/tmp/project" text={text} isStreaming />,
    );
    const codeBlock = container.querySelector<HTMLElement>('[data-language="text"]')!;
    const initialWrap = codeBlock.dataset.wrap === "true";
    await act(async () => {
      buttonsLabelled(container, initialWrap ? "Disable line wrap" : "Wrap lines")[0]!.click();
      buttonsLabelled(container, "Copy code")[0]!.click();
    });
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[data-markdown-details-summary]")!.click(),
    );
    const details = container.querySelector<HTMLElement>("[data-markdown-details]")!;
    expect(details.dataset.markdownDetailsOpen).toBe("true");
    expect(container.textContent).toContain("Details content");
    expect(writeText).toHaveBeenCalledWith("First code block\n");
    expect(highlight).toHaveBeenCalledTimes(1);

    for (let index = 0; index < 10; index += 1) {
      await rerender(<ChatMarkdown cwd="/tmp/project" text={`${text} ${index}`} isStreaming />);
    }

    expect(highlight).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-language="text"]')).toBe(codeBlock);
    expect(codeBlock.dataset.wrap).toBe(String(!initialWrap));
    expect(container.querySelector("[data-markdown-details]")).toBe(details);
    expect(details.dataset.markdownDetailsOpen).toBe("true");
    await rerender(
      <ChatMarkdown
        cwd="/tmp/project"
        text={text.replace("First code block", "Updated code block")}
        isStreaming
      />,
    );
    const copy = [
      ...buttonsLabelled(container, "Copied"),
      ...buttonsLabelled(container, "Copy code"),
    ][0]!;
    await act(async () => copy.click());
    expect(writeText).toHaveBeenLastCalledWith("Updated code block\n");
    expect(highlight).toHaveBeenCalledTimes(2);
  });

  it("edits the current task text and marker after reusing a renderer", async () => {
    let editedText: string | undefined;
    let rerender: (next: ReactElement) => Promise<void> = async () => {};
    const message = (text: string): ReactElement => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        onTaskListChange={({ markerOffset, checked }) => {
          editedText = setMarkdownTaskChecked(text, markerOffset, checked);
          void rerender(message(editedText));
        }}
      />
    );
    const rendered = await render(message("- [ ] First\n- [ ] Second"));
    rerender = rendered.rerender;
    const { container } = rendered;
    const checkboxes = () => container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    const original = checkboxes()[1]!;
    await rerender(message("- [ ] A longer first task\n- [ ] Second"));
    expect(checkboxes()[1]).toBe(original);

    await act(async () => original.click());
    expect(editedText).toBe("- [ ] A longer first task\n- [x] Second");
    await vi.waitFor(() => expect(checkboxes()[1]!.checked).toBe(true));
  });
});

describe("ChatMarkdown skill chips", () => {
  it("updates digit-leading skill labels when discovered skills change", async () => {
    const text = "Use $2spec with a $20k budget.";
    const { container, rerender } = await render(<ChatMarkdown cwd="/tmp/project" text={text} />);
    expect(container.textContent).not.toContain("2Spec");

    await rerender(
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        skills={[
          { name: "2spec", displayName: "2Spec" },
          { name: "20k", displayName: "MoneySkill" },
        ]}
      />,
    );
    expect(container.textContent).toContain("2Spec");
    expect(container.textContent).toContain("$20k budget");
    expect(container.textContent).not.toContain("MoneySkill");

    await rerender(<ChatMarkdown cwd="/tmp/project" text={text} skills={[]} />);
    expect(container.textContent).not.toContain("2Spec");
  });
});

describe("ChatMarkdown file-link labels", () => {
  function copySelection(container: HTMLElement) {
    const range = document.createRange();
    range.selectNodeContents(container);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    try {
      return chatMarkdownClipboardPayload(selection)?.text;
    } finally {
      selection.removeAllRanges();
    }
  }

  it.each([
    [String.raw`read \] here`, "read ] here"],
    [String.raw`read \[ here`, "read [ here"],
    [String.raw`read \\\] here`, String.raw`read \] here`],
    [String.raw`read \*this\*`, "read *this*"],
    [String.raw`read \_this\_`, "read _this_"],
  ])("round-trips copied file-link label %s", async (sourceLabel, label) => {
    const source = `[${sourceLabel}](/repo/example.ts:12)`;
    const { container, rerender } = await render(<ChatMarkdown cwd="/repo" text={source} />);
    expect(container.textContent).toContain(label);
    const copied = copySelection(container);
    expect(copied).toBe(source);
    await rerender(<ChatMarkdown cwd="/repo" text={copied!} />);
    expect(copySelection(container)).toBe(source);
  });

  it.each(["diagram", "example.ts", ""])(
    "preserves image-only file labels with alt %s",
    async (alt) => {
      const source = `[![${alt}](https://example.com/preview.png)](/repo/example.ts)`;
      const container = await renderText(source, { cwd: "/repo" });
      expect(container.querySelector("img")?.getAttribute("alt")).toBe(alt);
      expect(container.querySelectorAll("button")).toHaveLength(1);
      expect(container.querySelectorAll('[role="button"]')).toHaveLength(0);
      expect(container.querySelector("button button, button a")).toBeNull();
      expect(copySelection(container)).toBe(source);
    },
  );

  it("keeps video labels non-interactive and copies their source", async () => {
    const source = "[![clip](https://example.com/preview.mp4)](/repo/example.ts)";
    const container = await renderText(source, { cwd: "/repo" });
    expect(container.querySelector("video")?.controls).toBe(false);
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(container.querySelectorAll("[data-markdown-copy-media]")).toHaveLength(1);
    expect(copySelection(container)).toBe(source);
  });

  it("copies the filename for a whitespace-only link label", async () => {
    const container = await renderText("[   ](/repo/example.ts:12)", { cwd: "/repo" });
    expect(copySelection(container)).toBe("[example.ts](/repo/example.ts:12)");
  });

  it.each([false, true])("matches soft-break filenames with lineBreaks=%s", async (lineBreaks) => {
    const container = await renderText("[my\nfile.ts](/repo/my%20file.ts)", {
      cwd: "/repo",
      lineBreaks,
    });
    const link = container.querySelector(".chat-markdown-file-link")!;
    expect(link.textContent).toBe(lineBreaks ? "my\nfile.ts (my file.ts)" : "my file.ts");
    expect(link.querySelectorAll("br")).toHaveLength(lineBreaks ? 1 : 0);
  });

  it.each(["\n", "  \n", "\\\n"])(
    "preserves line breaks in file labels (%j)",
    async (lineBreak) => {
      const source = `[src/${lineBreak}example.ts](/repo/src/example.ts)`;
      const container = await renderText(source, { cwd: "/repo", lineBreaks: true });
      const link = container.querySelector(".chat-markdown-file-link")!;
      expect(link.querySelectorAll("br")).toHaveLength(1);
      expect(link.getAttribute("data-markdown-copy-text")).toMatch(/src\/\n+example\.ts/);
      expect(copySelection(container)).toBe(source);
    },
  );

  it.each([
    "src/\n**example.ts**",
    String.raw`src/\]` + "\nexample.ts",
    "src/[nested]\nexample.ts",
    "src/`bracket ]`\nexample.ts",
    "src/![diagram](https://example.com/preview.png)\nexample.ts",
  ])("preserves authored multiline file label %s", async (sourceLabel) => {
    const source = `[${sourceLabel}](/repo/src/example.ts)`;
    const container = await renderText(source, { cwd: "/repo", lineBreaks: true });
    expect(copySelection(container)).toBe(source);
  });

  it("retains descriptive prose, emphasis, destinations, and copy text", async () => {
    const source = "This function [**validates** the input](/repo/src/example.ts:12).";
    const container = await renderText(source, { cwd: "/repo" });
    const link = container.querySelector(".chat-markdown-file-link")!;
    expect(link.querySelector("strong")?.textContent).toBe("validates");
    expect(link.textContent).toContain("validates the input");
    expect(link.textContent).toContain("example.ts · L12");
    expect(copySelection(container)).toBe(source);
  });
});

describe("ChatMarkdown file citations", () => {
  it.each([true, false])(
    "renders Codex file citations as file chips with parseRawHtml=%s",
    async (parseRawHtml) => {
      const container = await renderText(
        'Created :codex-file-citation{path="/tmp/project/outputs/report.xlsx" purpose="output"}.',
        { lineBreaks: !parseRawHtml, parseRawHtml },
      );
      expect(container.textContent).not.toContain("codex-file-citation");
      expect(fileOptions(container)).toEqual(["File options for report.xlsx"]);
    },
  );

  it("leaves an unfinished streaming citation visible until it is complete", async () => {
    const container = await renderText(
      'Created :codex-file-citation{path="/tmp/project/outputs/report.xlsx"',
      { isStreaming: true },
    );
    expect(container.textContent).toContain(":codex-file-citation");
    expect(fileOptions(container)).toEqual([]);
  });

  it.each([
    ':codex-file-citation{purpose="output"}',
    ':codex-file-citation-extra{path="/tmp/project/outputs/report.xlsx"}',
    'Example: \\:codex-file-citation{path="/tmp/project/outputs/report.xlsx"}',
  ])("leaves %s literal", async (text) => {
    const container = await renderText(text);
    expect(container.textContent).toContain(text.replace("\\", ""));
    expect(fileOptions(container)).toEqual([]);
  });

  it("preserves Codex file citation examples inside code", async () => {
    const directive = ':codex-file-citation{path="/tmp/project/outputs/report.xlsx"}';
    const container = await renderText(
      `Example: \`${directive}\`\n\n\`\`\`text\n${directive}\n\`\`\``,
    );
    expect(container.textContent?.match(/:codex-file-citation/g)).toHaveLength(2);
    expect(fileOptions(container)).toEqual([]);
  });

  it("does not create a nested link for citations inside link text", async () => {
    const directive = ':codex-file-citation{path="/tmp/project/outputs/report.xlsx"}';
    const container = await renderText(`[See ${directive}](https://example.com)`);
    expect(container.textContent).toContain("codex-file-citation");
    expect(fileOptions(container)).toEqual([]);
  });

  it("renders file citations created by over-indented list recovery", async () => {
    const container = await renderText(
      '-       Created :codex-file-citation{path="/tmp/project/outputs/report.xlsx"}',
    );
    expect(container.querySelector("pre")).toBeNull();
    expect(container.querySelector("li")?.textContent).toContain("Created ");
    expect(fileOptions(container)).toEqual(["File options for report.xlsx"]);
  });

  it("disambiguates Codex citations with the same basename", async () => {
    const container = await renderText(
      'Changed :codex-file-citation{path="/tmp/project/src/index.ts"} and :codex-file-citation{path="/tmp/project/test/index.ts"}.',
    );
    expect(container.textContent).toContain("index.ts · project/src");
    expect(container.textContent).toContain("index.ts · project/test");
  });

  it("preserves rejected citations created by over-indented list recovery", async () => {
    const malformed = await renderText(
      'Leading text before list.\n\n-       Bad :codex-file-citation{purpose="output"}',
    );
    expect(malformed.querySelector("li")?.textContent).toBe(
      'Bad :codex-file-citation{purpose="output"}',
    );
    const nestedLink = await renderText(
      'Leading text before list.\n\n-       [Bad :codex-file-citation{path="/tmp/project/report.xlsx"}](https://example.com)',
    );
    expect(nestedLink.textContent).toContain(
      'Bad :codex-file-citation{path="/tmp/project/report.xlsx"}',
    );
  });
});

describe("ChatMarkdown Codex follow-up suggestions", () => {
  it.each([true, false])("renders the label with parseRawHtml=%s", async (parseRawHtml) => {
    const container = await renderText(
      'Done.\n\n- :codex-followup[Prepare print version]{prompt="Prepare the document for printing."}',
      { lineBreaks: !parseRawHtml, parseRawHtml },
    );
    expect(container.textContent).toContain("Prepare print version");
    expect(container.textContent).not.toContain("codex-followup");
    expect(container.textContent).not.toContain("Prepare the document for printing.");
  });

  it("keeps the label of a malformed follow-up created by over-indented list recovery", async () => {
    const container = await renderText("-       Next :codex-followup[Prepare print version]");
    expect(container.querySelector("li")?.textContent).toBe(
      "Next :codex-followup[Prepare print version]",
    );
  });
});

const ARTIFACT_TEMPLATE_DIRECTIVE =
  '::artifact-template{skill_name="artifact-template-hello-world" skill_directory="/Users/test/.codex/skills/artifact-template-hello-world" display_name="Hello World" artifact_kind="document"}';

describe("ChatMarkdown artifact-template cards", () => {
  it.each([true, false])(
    "offers the Codex template from its card with parseRawHtml=%s",
    async (parseRawHtml) => {
      const onUseArtifactTemplate = vi.fn();
      const container = await renderText(ARTIFACT_TEMPLATE_DIRECTIVE, {
        parseRawHtml,
        onUseArtifactTemplate,
      });
      expect(container.textContent).not.toContain("::artifact-template");
      expect(container.textContent).toContain("Hello World");
      expect(container.textContent).toContain("Document template");
      expect(container.querySelector("p div")).toBeNull();
      const use = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Use template",
      )!;
      await act(async () => use.click());
      expect(onUseArtifactTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          skillName: "artifact-template-hello-world",
          displayName: "Hello World",
        }),
      );
    },
  );

  it("renders a passive card outside a composer-backed timeline", async () => {
    const container = await renderText(ARTIFACT_TEMPLATE_DIRECTIVE);
    expect(container.textContent).toContain("Hello World");
    expect(container.textContent).not.toContain("Use template");
  });

  it.each([
    '::artifact-template{skill_name="artifact-template-hello-world" display_name="Hello World" artifact_kind="document"}',
    ARTIFACT_TEMPLATE_DIRECTIVE.slice(0, -1),
    `\\${ARTIFACT_TEMPLATE_DIRECTIVE}`,
    ARTIFACT_TEMPLATE_DIRECTIVE.replace("::artifact-template", "::artifact-template-extra"),
  ])("leaves %s literal", async (text) => {
    const container = await renderText(text);
    expect(container.textContent).toContain("::artifact-template");
    expect(container.textContent).not.toContain("Document template");
  });

  it("preserves artifact-template examples inside code", async () => {
    const container = await renderText(
      `\`${ARTIFACT_TEMPLATE_DIRECTIVE}\`\n\n\`\`\`text\n${ARTIFACT_TEMPLATE_DIRECTIVE}\n\`\`\``,
    );
    expect(container.textContent?.match(/::artifact-template/g)).toHaveLength(2);
    expect(container.textContent).not.toContain("Document template");
  });
});

describe("ChatMarkdown headings", () => {
  it("exposes headings below the host heading without changing their tags", async () => {
    const container = await renderText("# Top\n\n## Section\n\n###### Fine print", {
      headingLevelOffset: 3,
    });
    expect(
      [...container.querySelectorAll("h1, h2, h6")].map((heading) => [
        heading.tagName,
        heading.getAttribute("aria-level"),
      ]),
    ).toEqual([
      ["H1", "4"],
      ["H2", "5"],
      ["H6", "6"],
    ]);
    const flat = await renderText("# Top");
    expect(flat.querySelector("h1")?.hasAttribute("aria-level")).toBe(false);
  });

  it("never gives two headings the same id, even when a suffix matches another heading", async () => {
    const container = await renderText(
      '## Setup\n\n## Setup\n\n## Setup-1\n\n<h2 id="install-1">Pinned</h2>\n\n## Install\n\n## Install',
      { parseRawHtml: true },
    );
    expect([...container.querySelectorAll("h2")].map((heading) => heading.id)).toEqual([
      "user-content-setup",
      "user-content-setup-1",
      "user-content-setup-1-1",
      "user-content-install-1",
      "user-content-install",
      "user-content-install-2",
    ]);
  });
});

describe("ChatMarkdown Windows file links", () => {
  const environmentId = EnvironmentId.make("env-windows");
  const renderWindows = (text: string, parseRawHtml: boolean) =>
    renderText(text, {
      cwd: "C:/Users/shawn/project",
      environmentId,
      lineBreaks: !parseRawHtml,
      parseRawHtml,
    });
  const fileHrefs = (container: HTMLElement) =>
    [...container.querySelectorAll(".chat-markdown-file-link")].map((chip) =>
      chip.getAttribute("href"),
    );

  it.each([
    ["drive paths", "[Open](C:/Users/shawn/project/src/main.ts)"],
    ["backslashes", String.raw`[Open](C:\Users\shawn\project\src\main.ts)`],
    ["reference links", "[Open][source]\n\n[source]: C:/Users/shawn/project/src/main.ts"],
  ])("resolves %s to the workspace file", async (_, text) => {
    for (const parseRawHtml of [true, false]) {
      const container = await renderWindows(text, parseRawHtml);
      expect(fileHrefs(container)).toEqual(["C:/Users/shawn/project/src/main.ts"]);
    }
  });

  it("keeps backslashes CommonMark would read as escapes", async () => {
    for (const parseRawHtml of [true, false]) {
      const container = await renderWindows(
        String.raw`[settings](C:\Users\shawn\.claude\settings.json)`,
        parseRawHtml,
      );
      expect(fileHrefs(container)).toEqual(["C:/Users/shawn/.claude/settings.json"]);
    }
  });

  it("distinguishes same-named backslash paths but not the same file twice", async () => {
    for (const parseRawHtml of [true, false]) {
      const distinct = await renderWindows(
        String.raw`[Source](C:\Users\shawn\project\src\index.ts) and [Test](C:\Users\shawn\project\test\index.ts)`,
        parseRawHtml,
      );
      expect(distinct.textContent).toContain("index.ts · project/src");
      expect(distinct.textContent).toContain("index.ts · project/test");
      const path = String.raw`C:\Users\shawn\project\src\main.ts`;
      const same = await renderWindows(`[Source](${path}) and \`${path}\``, parseRawHtml);
      expect(fileHrefs(same)).toHaveLength(2);
      expect(same.textContent).not.toContain("main.ts ·");
    }
  });

  it("still rejects unsafe schemes", async () => {
    for (const parseRawHtml of [true, false]) {
      const container = await renderWindows(
        "[unsafe](javascript:alert(1)) and [unknown](d:alert(1))",
        parseRawHtml,
      );
      expect(container.innerHTML).not.toContain("javascript:");
      expect(container.innerHTML).not.toContain("d:alert");
      expect(fileHrefs(container)).toEqual([]);
    }
  });
});

describe("ChatMarkdown in-page links", () => {
  it.each([true, false])(
    "scrolls a table-of-contents link to its heading without touching the URL (parseRawHtml=%s)",
    async (parseRawHtml) => {
      const scrollIntoView = vi
        .spyOn(HTMLElement.prototype, "scrollIntoView")
        .mockImplementation(() => {});
      const href = window.location.href;
      const container = await renderText(
        "- [Operating model](#1-operating-model)\n- [Missing](#nowhere)\n\n## 1. Operating model\n\n## 1. Operating model",
        { parseRawHtml },
      );
      const headings = [...container.querySelectorAll("h2")];
      expect(headings.map((heading) => heading.id)).toEqual([
        "user-content-1-operating-model",
        "user-content-1-operating-model-1",
      ]);
      const [tocLink, missingLink] = [...container.querySelectorAll("a")];
      await act(async () => tocLink!.click());
      expect(scrollIntoView.mock.contexts).toEqual([headings[0]]);
      await act(async () => missingLink!.click());
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(window.location.href).toBe(href);
    },
  );
});

describe("ChatMarkdown thread find", () => {
  function FindProbe(props: {
    container: HTMLElement;
    query: string;
    activeOccurrence?: number;
    children: ReactElement;
  }) {
    useThreadFindHighlights({
      container: props.container,
      query: props.query,
      activeRowId: "row",
      activeOccurrence: props.activeOccurrence ?? 0,
      onActiveRange: () => {},
    });
    return (
      <div data-timeline-row-id="row">
        <div data-thread-find-text>
          <MarkdownFindContext value={props.query !== ""}>{props.children}</MarkdownFindContext>
        </div>
      </div>
    );
  }
  const frame = () =>
    act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const activeHighlights = () =>
    [...(CSS.highlights.get("t3-thread-find-active") ?? [])].map((range) =>
      (range as Range).toString(),
    );

  it("opens a disclosure only when find selects a match inside it", async () => {
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    roots.push(root);
    const markdown = (
      <ChatMarkdown
        cwd={undefined}
        text={[
          "Visible needle.",
          "<details><summary>Unrelated</summary><p>nothing here</p></details>",
          "<details><summary>Outer</summary><details><summary>Inner</summary><p>needle</p></details></details>",
        ].join("\n\n")}
      />
    );
    const show = (query: string, activeOccurrence: number) =>
      act(() =>
        root.render(
          <FindProbe container={container} query={query} activeOccurrence={activeOccurrence}>
            {markdown}
          </FindProbe>,
        ),
      );
    const openStates = () =>
      [...container.querySelectorAll<HTMLElement>("[data-markdown-details-open]")].map(
        (node) => node.dataset.markdownDetailsOpen,
      );

    await show("", 0);
    expect(container.textContent).not.toContain("nothing here");
    await show("needle", 0);
    await frame();
    expect(openStates()).toEqual(["false", "false", "false"]);
    expect(container.textContent).toContain("nothing here");
    expect(activeHighlights()).toEqual(["needle"]);
    expect(CSS.highlights.get("t3-thread-find")?.size ?? 0).toBe(0);

    await show("needle", 1);
    await frame();
    await frame();
    expect(openStates()).toEqual(["false", "true", "true"]);
    expect(CSS.highlights.get("t3-thread-find-active")?.size).toBe(1);
  });

  it("keeps Mermaid diagrams rendered until find selects a match in their source", async () => {
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    roots.push(root);
    const diagram = "```mermaid\ngraph TD; Alpha-->Beta\n```";
    const show = (query: string) =>
      act(() =>
        root.render(
          <FindProbe container={container} query={query}>
            <ChatMarkdown cwd={undefined} text={`Needle first.\n\n${diagram}\n\n${diagram}`} />
          </FindProbe>,
        ),
      );
    const diagrams = () => container.querySelectorAll('svg[aria-label="Diagram"]').length;

    await show("Needle");
    await frame();
    expect(diagrams()).toBe(2);
    await show("Alpha");
    await frame();
    await frame();
    expect(diagrams()).toBe(1);
    await vi.waitFor(() => expect(activeHighlights()).toEqual(["Alpha"]));
  });

  it.each([
    {
      text: "```mermaid\ngraph TD; SearchSourceAlpha-->B\n```",
      query: "SearchSourceAlpha",
      count: 1,
    },
    {
      text: "★ Insight ─────\nfirst line\nsecond line",
      query: "first line second",
      count: 0,
      lineBreaks: true,
    },
    { text: '```ts title="src/needle.ts"\nconst a = 1;\n```', query: "needle", count: 0 },
    { text: "```weirdlang\nconst a = 1;\n```", query: "weirdlang", count: 0 },
    { text: "Use $test-t3-app now", query: "T3 App Testing", count: 1 },
    { text: "[Guide](/tmp/file.ts)", query: "Guide (file.ts)", count: 1 },
    {
      text: "[![diagram](https://example.com/a.png)](/tmp/file.ts)",
      query: "(file.ts)",
      count: 1,
    },
    {
      text: "[![diagram](https://example.com/a.png)](/tmp/file.ts)",
      query: "diagram",
      count: 0,
    },
    { text: "`/tmp/file.ts:42`", query: "file.ts · L42", count: 1, user: true, lineBreaks: true },
    { text: "> [!NOTE]\n> Searchable alert", query: "Searchable alert", count: 1 },
    {
      text: "<details><summary>Folded</summary><p>Hidden needle</p></details>",
      query: "Hidden needle",
      count: 1,
    },
    { text: ARTIFACT_TEMPLATE_DIRECTIVE, query: "Hello World", count: 1, withTemplate: true },
    {
      text: ARTIFACT_TEMPLATE_DIRECTIVE,
      query: "Document template",
      count: 1,
      withTemplate: true,
    },
    { text: ARTIFACT_TEMPLATE_DIRECTIVE, query: "World Document", count: 0, withTemplate: true },
    { text: ARTIFACT_TEMPLATE_DIRECTIVE, query: "Use template", count: 0, withTemplate: true },
  ])(
    "highlights the indexed occurrences of $query in $text",
    async ({ text, query, count, lineBreaks, user, withTemplate }) => {
      const skills = [{ name: "test-t3-app", displayName: "T3 App Testing" }];
      const container = document.body.appendChild(document.createElement("div"));
      const root = createRoot(container);
      roots.push(root);
      await act(() =>
        root.render(
          <FindProbe container={container} query={query}>
            <ChatMarkdown
              text={text}
              cwd={undefined}
              skills={skills}
              lineBreaks={lineBreaks ?? false}
              parseRawHtml={!user}
              onUseArtifactTemplate={withTemplate ? () => undefined : undefined}
            />
          </FindProbe>,
        ),
      );
      await frame();
      // Lazy blocks such as Mermaid can swap their source text after the first frame,
      // emptying a range for a moment, so wait for the highlights to settle.
      await vi.waitFor(() => {
        const ranges = [...CSS.highlights.values()].flatMap((value) => [...value]);
        expect(ranges.map((range) => (range as Range).toString())).toEqual(
          Array.from({ length: count }, () => query),
        );
      });
      const segments =
        searchableMessageSegments(
          { role: user ? "user" : "assistant", text, streaming: false },
          undefined,
          skills,
        ) ?? [];
      expect(
        segments.reduce((sum, segment) => sum + countThreadSearchOccurrences(segment, query), 0),
      ).toBe(count);
    },
  );
});

describe("ChatMarkdown managed destinations", () => {
  const threadRef = {
    environmentId: EnvironmentId.make("markdown-env"),
    threadId: ThreadId.make("markdown-thread"),
  };
  function pendingPreparation() {
    let finish!: (result: { url: string; managed: boolean; restored: boolean }) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    markdownOpenMocks.prepareHostedPreview.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
          entered();
        }),
    );
    return { started, finish: (url: string) => finish({ url, managed: true, restored: true }) };
  }

  it.each([
    [
      "http://localhost:4173/docs?mode=preview",
      "https://workstation.example:4173/docs?mode=preview",
    ],
    ["https://example.com/docs?mode=public", "https://example.com/docs?mode=public"],
  ])("opens a desktop context-menu link at its prepared destination", async (href, preparedUrl) => {
    vi.stubGlobal("desktopBridge", {});
    const openExternal = vi.fn().mockResolvedValue(undefined);
    markdownOpenMocks.localApi = {
      contextMenu: { show: vi.fn().mockResolvedValue("open-external") },
      shell: { openExternal },
    };
    const preparation = pendingPreparation();
    const container = await renderText(`[docs](${href})`, { cwd: undefined, threadRef });
    await act(async () => {
      container.querySelector("a")!.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 4,
          clientY: 8,
        }),
      );
      await preparation.started;
    });
    expect(openExternal).not.toHaveBeenCalled();
    await act(async () => preparation.finish(preparedUrl));
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledWith(preparedUrl));
    expect(markdownOpenMocks.prepareHostedPreview).toHaveBeenCalledWith(threadRef, href);
  });

  it.each(["png", "mp4"])("waits for recovery before opening a %s link", async (extension) => {
    const href = `http://localhost:4173/preview.${extension}`;
    const preparedUrl = `https://workstation.example:4173/preview.${extension}`;
    const preparation = pendingPreparation();
    const onImageExpand = vi.fn();
    const container = await renderText(`[media](${href})`, {
      cwd: undefined,
      threadRef,
      onImageExpand,
    });
    await act(async () => {
      container.querySelector<HTMLAnchorElement>("a")!.click();
      await preparation.started;
    });
    expect(onImageExpand).not.toHaveBeenCalled();
    await act(async () => preparation.finish(preparedUrl));
    await vi.waitFor(() =>
      expect(onImageExpand).toHaveBeenCalledExactlyOnceWith({
        index: 0,
        images: [
          expect.objectContaining({
            src: preparedUrl,
            originalUrl: preparedUrl,
            actionsSource: expect.objectContaining({ src: preparedUrl }),
          }),
        ],
      }),
    );
    expect(markdownOpenMocks.prepareHostedPreview).toHaveBeenCalledWith(
      threadRef,
      href,
      "resource",
    );
  });

  it.each(["png", "mp4"])("prepares embedded %s before loading its bytes", async (extension) => {
    const source = `http://localhost:4173/report.${extension}`;
    const destination = `https://workstation.example:4173/report.${extension}`;
    const preparation = pendingPreparation();
    const container = await renderText(`![report](${source})`, { cwd: "/workspace", threadRef });
    expect(markdownOpenMocks.prepareHostedPreview).toHaveBeenCalledWith(
      threadRef,
      source,
      "resource",
    );
    expect(container.querySelector("img[src], video[src]")).toBeNull();
    await act(async () => preparation.finish(destination));
    expect(container.querySelector("img[src], video[src]")?.getAttribute("src")).toBe(destination);
    expect(container.querySelector(`[src="${source}"]`)).toBeNull();
    if (extension === "mp4") {
      markdownOpenMocks.prepareHostedPreview.mockResolvedValueOnce({
        url: destination,
        managed: true,
        restored: true,
      });
      const play = container.querySelector<HTMLButtonElement>('button[aria-label="Play report"]');
      expect(play).not.toBeNull();
      await act(async () => play!.click());
      expect(markdownOpenMocks.prepareHostedPreview).toHaveBeenNthCalledWith(
        2,
        threadRef,
        source,
        "resource",
      );
    }
  });

  it("ignores preparation for an embedded image after its source changes", async () => {
    const first = pendingPreparation();
    const second = pendingPreparation();
    const { container, rerender } = await render(
      <ChatMarkdown
        cwd="/workspace"
        text="![report](http://localhost:4173/first.png)"
        threadRef={threadRef}
      />,
    );
    await rerender(
      <ChatMarkdown
        cwd="/workspace"
        text="![report](http://localhost:4173/second.png)"
        threadRef={threadRef}
      />,
    );
    await act(async () => first.finish("https://workstation.example:4173/first.png"));
    expect(container.querySelector("img[src]")).toBeNull();
    await act(async () => second.finish("https://workstation.example:4173/second.png"));
    expect(container.querySelector("img[src]")?.getAttribute("src")).toBe(
      "https://workstation.example:4173/second.png",
    );
  });
});

describe("chat file handoffs", () => {
  it("captures the opened PR surface and retains its host", async () => {
    const ref = {
      environmentId: EnvironmentId.make("pr-env"),
      threadId: ThreadId.make("pr-thread"),
    };
    const target = {
      projectId: "host-fallback-project",
      host: "github.example",
      repository: "other/repo",
      number: 8,
      url: "https://github.example/other/repo/pull/8",
    };
    markdownOpenMocks.openPullRequest.mockImplementationOnce(() => {
      useRightPanelStore.getState().openPullRequest(ref, target);
      return true;
    });
    const container = await renderText(`[Review this PR](${target.url})`, {
      cwd: "/repo",
      threadRef: ref,
    });
    await act(async () => container.querySelector<HTMLAnchorElement>("a")!.click());
    expect(readThreadHandoffs(ref)[0]).toMatchObject({
      markdownLabel: "Review this PR",
      target: { kind: "pull-request", ...target },
    });
    expect(readThreadHandoffs(ref)[0]?.target).not.toHaveProperty("environmentId");
  });

  it("keeps the authored label when a resolved file is reopened by filename", async () => {
    const ref = {
      environmentId: EnvironmentId.make("file-env"),
      threadId: ThreadId.make("handoff-thread"),
    };
    const { container, rerender } = await render(
      <ChatMarkdown cwd="/repo" threadRef={ref} text="[Final report](/repo/docs/report.md)" />,
    );
    const open = () => act(async () => container.querySelector<HTMLAnchorElement>("a")!.click());
    await open();
    expect(readThreadHandoffs(ref)).toHaveLength(1);
    expect(readThreadHandoffs(ref)[0]).toMatchObject({
      markdownLabel: "Final report",
      target: { kind: "file", path: "/repo/docs/report.md" },
    });
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).activeSurfaceId,
    ).toBe("file:docs/report.md");
    await rerender(
      <ChatMarkdown cwd="/repo" threadRef={ref} text="[report.md](/repo/docs/report.md)" />,
    );
    await open();
    expect(readThreadHandoffs(ref)).toHaveLength(1);
    expect(readThreadHandoffs(ref)[0]?.markdownLabel).toBe("Final report");
    expect(readThreadHandoffs(ref)[0]?.sequence).toBe(2);
  });
});

describe("chat file link destination ownership", () => {
  it.each([
    ["/repo/report.md:12", "report.md", false],
    ["./report.md:12", "./report.md", false],
    ["file:///repo/report.md#L12", "report.md", false],
    ["report.md#L12", "nested/report.md", true],
    ["report.md:12", "nested/report.md", true],
    ["test_utils.py:12", "test_utils.py", true],
    ["__init__.py:12", "__init__.py", true],
    ["_config.yml:12", "_config.yml", true],
    ["2024-notes.md:12", "2024-notes.md", true],
  ])("opens %s without losing explicit path intent", async (href, expectedPath, shouldSearch) => {
    const ref = {
      environmentId: EnvironmentId.make("file-link-env"),
      threadId: ThreadId.make("file-link-thread"),
    };
    markdownOpenMocks.searchProjectEntries.mockResolvedValue(
      AsyncResult.success({ entries: [{ path: "nested/report.md", kind: "file" }] }),
    );
    const container = await renderText(`[report.md](${href})`, { cwd: "/repo", threadRef: ref });
    await act(async () =>
      container.querySelector<HTMLAnchorElement>(".chat-markdown-file-link")!.click(),
    );
    await vi.waitFor(() =>
      expect(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).activeSurfaceId,
      ).toBe(`file:${expectedPath}`),
    );
    const panel = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);
    expect(panel.surfaces.find((surface) => surface.id === panel.activeSurfaceId)).toMatchObject({
      revealLine: 12,
    });
    expect(markdownOpenMocks.searchProjectEntries).toHaveBeenCalledTimes(shouldSearch ? 1 : 0);
    if (shouldSearch)
      expect(markdownOpenMocks.searchProjectEntries).toHaveBeenCalledWith({
        environmentId: ref.environmentId,
        input: { cwd: "/repo", query: expectedPath.split("/").at(-1), limit: 25, kind: "file" },
      });
  });
});

describe("restricted chat media expansion", () => {
  it.each([true, false])(
    "scopes fresh requests and expands only granted media (%s)",
    async (granted) => {
      const ref = {
        environmentId: EnvironmentId.make("restricted-media-env"),
        threadId: ThreadId.make("restricted-media-thread"),
      };
      markdownOpenMocks.denyFilesystemRead = true;
      markdownOpenMocks.preparedConnection = { httpBaseUrl: "https://workstation.example" };
      markdownOpenMocks.createAssetUrl.mockResolvedValue(
        granted
          ? AsyncResult.success({ relativeUrl: "/api/assets/linked-image" })
          : AsyncResult.failure(Cause.fail(new Error("File is not published"))),
      );
      const onImageExpand = vi.fn();
      const toast = vi.spyOn(toastManager, "add").mockReturnValue("restricted-media-toast");
      const container = await renderText("[image](/tmp/linked.png)", {
        cwd: "/repo",
        threadRef: ref,
        onImageExpand,
      });
      await act(async () => container.querySelector<HTMLAnchorElement>("a")!.click());
      await vi.waitFor(() =>
        expect(markdownOpenMocks.createAssetUrl).toHaveBeenCalledExactlyOnceWith({
          environmentId: ref.environmentId,
          input: {
            resource: {
              _tag: "media-file",
              threadId: ref.threadId,
              path: "/tmp/linked.png",
              linkedThreadFile: true,
            },
          },
        }),
      );
      if (granted) {
        await vi.waitFor(() =>
          expect(onImageExpand).toHaveBeenCalledWith({
            index: 0,
            images: [
              expect.objectContaining({
                src: "https://workstation.example/api/assets/linked-image",
              }),
            ],
          }),
        );
        expect(toast).not.toHaveBeenCalled();
      } else {
        await vi.waitFor(() =>
          expect(toast).toHaveBeenCalledWith(
            expect.objectContaining({
              title: "Media unavailable",
              description: "File is not published",
            }),
          ),
        );
        expect(onImageExpand).not.toHaveBeenCalled();
        expect(readThreadHandoffs(ref)).toEqual([]);
      }
    },
  );
});
