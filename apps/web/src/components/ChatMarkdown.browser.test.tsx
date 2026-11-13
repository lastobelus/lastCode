import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { searchableMessageSegments } from "@t3tools/shared/threadFindText";
import { countThreadSearchOccurrences } from "@t3tools/shared/threadSearch";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render, stubGlobal } from "../../test/render";
import "../index.css";

import { filesystemEnvironment } from "../state/filesystem";
import { useRightPanelStore, selectThreadRightPanelState } from "../rightPanelStore";
import { remarkEnableOrderedListNumbers } from "@t3tools/shared/markdownPipeline";
import { setMarkdownTaskChecked } from "@t3tools/shared/markdownTaskList";
import { HostImageUrlContext } from "./chat/hostImageUrl";
import { MarkdownFindContext } from "./chat/markdownFindContext";
import { collectThreadFindRanges } from "./chat/threadFindHighlights";
import { readThreadHandoffs, useHandoffsStore } from "../handoffs/handoffsStore";
import { toastManager } from "./ui/toast";

const markdownOpenMocks = vi.hoisted(() => ({
  prepareHostedPreview: vi.fn(),
  searchProjectEntries: vi.fn(),
  createAssetUrl: vi.fn(),
  openPullRequest: vi.fn(),
  denyFilesystemRead: false,
  denyPreviewOperate: false,
  openPreview: vi.fn(),
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
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  readEnvironmentSupportsServerBrowser: () => true,
}));
vi.mock(import("~/lib/openPullRequestLink"), async (original) => ({
  ...(await original()),
  resolvePullRequestPreviewTarget: () => null,
  useOpenChangeRequestLink: (() => markdownOpenMocks.openPullRequest) as never,
}));

const { filesystemMetadata } = vi.hoisted(() => ({
  filesystemMetadata: vi.fn(),
}));
const parsedSources = vi.hoisted(() => [] as string[]);
vi.mock(import("mdast-util-from-markdown"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    fromMarkdown: ((source: string, ...rest: never[]) => {
      parsedSources.push(String(source));
      return (actual.fromMarkdown as (...args: unknown[]) => unknown)(source, ...rest);
    }) as typeof actual.fromMarkdown,
  };
});

vi.mock(import("../state/use-atom-query-runner"), async (original) => {
  const { projectEnvironment } = await import("../state/projects");
  return {
    ...(await original()),
    useAtomQueryRunner: ((family: unknown) =>
      family === filesystemEnvironment.getMetadata
        ? filesystemMetadata
        : family === projectEnvironment.searchEntries
          ? markdownOpenMocks.searchProjectEntries
          : markdownOpenMocks.createAssetUrl) as never,
  };
});

// Atoms derived from the server config run in the real registry over a missing config.
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  const modelsConfig = Atom.make({
    environment: { platform: { os: "darwin" } },
    availableEditors: [],
    settings: { providerInstances: {} },
    providers: [
      {
        instanceId: "codex",
        driver: "codex",
        displayName: "Codex",
        models: [{ slug: "gpt-6.1", name: "GPT-6.1", isCustom: false, capabilities: {} }],
      },
    ],
  });
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      configValueAtom: ((environmentId: string) =>
        environmentId === "models" ? modelsConfig : noConfig) as never,
    },
  };
});
vi.mock(import("../state/session"), async (original) => {
  const { AuthStandardClientScopes, AuthFilesystemReadScope, AuthPreviewOperateScope } =
    await import("@t3tools/contracts");
  const granted = new Set<string>(AuthStandardClientScopes);
  const hasScope = (environmentId: unknown, scope: string) =>
    environmentId !== null &&
    !(markdownOpenMocks.denyFilesystemRead && scope === AuthFilesystemReadScope) &&
    !(markdownOpenMocks.denyPreviewOperate && scope === AuthPreviewOperateScope) &&
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
vi.mock(import("../browser/browserLinkTarget"), async (original) => ({
  ...(await original()),
  resolveBrowserLinkTargetPreference: async () => "system" as const,
}));
vi.mock(import("../browser/browserDefaults"), async (original) => {
  const actual = await original();
  return { ...actual, resolveBrowserDefaults: async () => actual.getBrowserDefaults() };
});
vi.mock(import("../state/use-atom-command"), async (original) => {
  const actual = await original();
  const { previewEnvironment } = await import("../state/preview");
  return {
    ...actual,
    useAtomCommand: ((command, options) =>
      Object.is(command, previewEnvironment.open)
        ? markdownOpenMocks.openPreview
        : actual.useAtomCommand(command, options)) as typeof actual.useAtomCommand,
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
const { renderDiagram } = vi.hoisted(() => ({
  renderDiagram: vi.fn<(source: string) => Promise<string> | undefined>(),
}));
// Control rendering latency without running Mermaid layout.
vi.mock(import("./chat/MermaidDiagram"), async (original) => {
  const { use } = await import("react");
  return {
    ...(await original()),
    MermaidDiagram: ({ source }: { source: string }) => {
      const pending = renderDiagram(source);
      return <svg role="img" aria-label={pending ? use(pending) : "Diagram"} />;
    },
  };
});

const appearance = vi.hoisted(() => ({
  value: "light" as "light" | "dark",
  listeners: new Set<() => void>(),
}));
vi.mock(import("../hooks/useTheme"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    appearance.listeners.add(listener);
    return () => appearance.listeners.delete(listener);
  };
  return {
    ...(await original()),
    useRenderedAppearance: () => useSyncExternalStore(subscribe, () => appearance.value),
  };
});

const settingsOverrides = vi.hoisted(() => ({ mathRenderingEnabled: false }));
vi.mock(import("../hooks/useSettings"), async (original) => {
  const actual = await original();
  type Settings = ReturnType<typeof actual.getClientSettings>;
  function useClientSettings<T = Settings>(select?: (settings: Settings) => T): T {
    const settings = { ...actual.getClientSettings(), ...settingsOverrides };
    return select ? select(settings) : (settings as T);
  }
  return { ...actual, useClientSettings };
});

import ChatMarkdown from "./ChatMarkdown";
import { chatMarkdownClipboardPayload } from "../markdown-clipboard";
import { FileMarkdownPreview } from "./files/FileMarkdownPreview";
import { AudioPreview } from "./files/AudioPreview";

it("keeps compact audio playback loaded across signed URL renewals", async () => {
  const original =
    "data:audio/wav;base64,UklGRiUAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQEAAACA";
  const renewed = `${original}#renewed`;
  const preview = (src: string, revision = "clip-v1") => (
    <AudioPreview compact name="clip.wav" src={src} revision={revision} />
  );
  await using screen = await render(preview(original));
  const audio = screen.container.querySelector("audio")!;
  await act(() => {
    audio.dispatchEvent(new Event("loadedmetadata"));
    audio.dispatchEvent(new Event("play"));
  });
  await screen.rerender(preview(renewed));
  expect(screen.container.querySelector("audio")).toBe(audio);
  expect(audio.getAttribute("src")).toBe(original);
  await expect.element(screen.getByRole("button", { name: "Pause clip.wav" })).toBeEnabled();
  await screen.rerender(preview(renewed, "clip-v2"));
  expect(screen.container.querySelector("audio")).not.toBe(audio);
  expect(screen.container.querySelector("audio")?.getAttribute("src")).toBe(renewed);
});

function setup() {
  appearance.value = "light";
  parsedSources.length = 0;
  settingsOverrides.mathRenderingEnabled = false;
  renderDiagram.mockReset();
  filesystemMetadata.mockReset().mockResolvedValue(AsyncResult.success({ entries: [null] }));
  markdownOpenMocks.prepareHostedPreview.mockReset();
  markdownOpenMocks.searchProjectEntries
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ entries: [] }));
  markdownOpenMocks.createAssetUrl.mockReset();
  markdownOpenMocks.openPullRequest.mockReset().mockReturnValue(false);
  markdownOpenMocks.denyFilesystemRead = false;
  markdownOpenMocks.denyPreviewOperate = false;
  markdownOpenMocks.openPreview.mockReset();
  markdownOpenMocks.preparedConnection = null;
  markdownOpenMocks.localApi = undefined;
  useHandoffsStore.setState({ byThreadKey: {} });
  useRightPanelStore.setState({ byThreadKey: {} });
}

function renderText(text: string, props: Partial<Parameters<typeof ChatMarkdown>[0]> = {}) {
  return render(<ChatMarkdown cwd="/tmp/project" text={text} {...props} />);
}

function buttonsLabelled(container: HTMLElement, label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].filter(
    (button) => button.getAttribute("aria-label") === label,
  );
}

const SOURCE_NUMBER_PLUGINS = [remarkEnableOrderedListNumbers];

it("keeps decimal markers in nested user lists while documents keep their counter styles", async () => {
  setup();
  const text = "1. Outer\n   1. Nested\n   7. Skipped\n      1. Deeper\n      4. Fourth";
  await using screen = await render(
    <div className="grid grid-cols-2 gap-8 p-8">
      <section>
        <h2>User message</h2>
        <ChatMarkdown
          cwd={undefined}
          text={text}
          className="user-message-markdown"
          extraRemarkPlugins={SOURCE_NUMBER_PLUGINS}
        />
      </section>
      <section>
        <h2>Markdown preview</h2>
        <ChatMarkdown cwd={undefined} text={text} />
      </section>
    </div>,
  );
  await expect.element(screen.getByText("User message", { exact: true })).toBeVisible();
  const [message, preview] = screen.container.querySelectorAll(".chat-markdown");
  expect(
    [...message!.querySelectorAll("ol")].map((list) => getComputedStyle(list).listStyleType),
  ).toEqual(["decimal", "decimal", "decimal"]);
  expect(
    [...preview!.querySelectorAll("ol")].map((list) => getComputedStyle(list).listStyleType),
  ).toEqual(["decimal", "lower-alpha", "lower-roman"]);
});

it("shows unavailable audio when a workspace embed has no thread", async () => {
  setup();
  await using screen = await renderText("![recording](clip.wav)");
  expect(screen.container.textContent).toContain("Audio unavailable");
  expect(screen.container.textContent).not.toContain("Loading audio");
  expect(screen.container.querySelector("audio")).toBeNull();
});

it("loads a host image through the page's own route when there is no environment", async () => {
  setup();
  const pixel =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const hostImageUrl = vi.fn((_path: string) => pixel);
  await using screen = await render(
    <HostImageUrlContext value={hostImageUrl}>
      <ChatMarkdown cwd={undefined} text="![Shot](</work/my shot.png>)" />
    </HostImageUrlContext>,
  );
  await expect.element(screen.getByAltText("Shot")).toHaveAttribute("src", pixel);
  expect(new Set(hostImageUrl.mock.calls.map(([path]) => path))).toEqual(
    new Set(["/work/my shot.png"]),
  );
});

it("loads the <picture> source for the current theme through the image route", async () => {
  setup();
  const pixel =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const hostImageUrl = (path: string) => `${pixel}#${path}`;
  await using screen = await render(
    <HostImageUrlContext value={hostImageUrl}>
      <ChatMarkdown
        cwd={undefined}
        text={
          '<picture><source media="(prefers-color-scheme: dark)" srcset="/work/dark.png"><img src="/work/light.png" alt="Shot"></picture>'
        }
      />
    </HostImageUrlContext>,
  );
  await expect
    .element(screen.getByAltText("Shot"))
    .toHaveAttribute("src", `${pixel}#/work/light.png`);

  await act(() => {
    appearance.value = "dark";
    for (const listener of appearance.listeners) listener();
  });
  await expect
    .element(screen.getByAltText("Shot"))
    .toHaveAttribute("src", `${pixel}#/work/dark.png`);
});

it("reuses the parse of a streaming reply's finished blocks when it remounts", async () => {
  setup();
  const message = (
    <ChatMarkdown cwd="/tmp/project" text={"Finished block\n\nStill growing"} isStreaming />
  );
  {
    await using _first = await render(message);
  }
  await using screen = await render(message);
  await expect.element(screen.getByText("Still growing")).toBeVisible();
  expect(parsedSources.filter((source) => source.includes("Finished block"))).toHaveLength(1);
});

it("reuses the parse of a remounted message that has stable extra plugins", async () => {
  setup();
  const parsed = vi.fn();
  const countingPlugins = [() => () => void parsed()];
  const message = (
    <ChatMarkdown cwd="/tmp/project" text="Cached text" extraRemarkPlugins={countingPlugins} />
  );
  {
    await using _first = await render(message);
  }
  await using screen = await render(message);
  await expect.element(screen.getByText("Cached text")).toBeVisible();
  expect(parsed).toHaveBeenCalledTimes(1);
});

it("highlights a code block's own source when an earlier block of the same length was cached", async () => {
  setup();
  const highlightedText = (container: HTMLElement) =>
    container.querySelector(".chat-markdown-shiki")?.textContent?.trim();
  // These two lines share a 32-bit FNV-1a hash and a length.
  const first = 'const commitSha = "f36a6d8fe0aa";';
  const second = 'const commitSha = "cb06f8d135b3";';
  {
    await using screen = await renderText(`\`\`\`ts\n${first}\n\`\`\``);
    await vi.waitFor(() => expect(highlightedText(screen.container)).toBe(first));
  }
  await using screen = await renderText(`\`\`\`ts\n${second}\n\`\`\``);
  await vi.waitFor(() => expect(highlightedText(screen.container)).toBe(second));
});

describe("ChatMarkdown favicon privacy", () => {
  it("suppresses private link images while preserving public links across updates", async () => {
    setup();
    const markdown = (url: string) => <ChatMarkdown cwd="/tmp/project" text={`[Link](${url})`} />;
    await using screen = await render(markdown("https://example.com"));
    const { container, rerender } = screen;
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

describe("ChatMarkdown external link labels", () => {
  it("keeps a leading emoji whole", async () => {
    setup();
    await using screen = await render(
      <ChatMarkdown cwd="/tmp/project" text="[😀 Read the documentation](https://example.com)" />,
    );
    await vi.waitFor(() => {
      const link = screen.container.querySelector("a");
      expect(link?.textContent).toContain("😀 Read");
      const walker = document.createTreeWalker(link!, NodeFilter.SHOW_TEXT);
      const textNodes: string[] = [];
      while (walker.nextNode()) textNodes.push(walker.currentNode.nodeValue ?? "");
      expect(textNodes.filter((node) => /\p{Surrogate}/u.test(node))).toEqual([]);
    });
  });
});

describe("ChatMarkdown streaming", () => {
  it("runs only a complete single-line shell block after a click", async () => {
    setup();
    const onRunShellCommand = vi.fn();
    const message = (text: string, isStreaming = false) => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        isStreaming={isStreaming}
        onRunShellCommand={onRunShellCommand}
      />
    );
    await using screen = await render(message("```bash\necho hello\n```", true));
    const { container, rerender } = screen;
    const runButtons = () => buttonsLabelled(container, "Run in terminal");
    expect(runButtons()).toHaveLength(0);

    await rerender(message("```bash\necho hello\n```"));
    await act(async () => runButtons()[0]!.click());
    expect(onRunShellCommand).toHaveBeenCalledExactlyOnceWith("echo hello");

    for (const text of [
      "~~~bash\necho tilde\n~~~",
      "> ```bash\n> echo quote\n> ```",
      "````bash\necho four\n````",
      "- Command\n\n  ```bash\n  echo list\n  ```",
      "```bash\r\necho crlf\r\n```\r",
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

  it("edits the current task text and marker after reusing a renderer", async () => {
    setup();
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
    await using rendered = await render(message("- [ ] First\n- [ ] Second"));
    rerender = rendered.rerender;
    const { container } = rendered;
    const checkboxes = () => container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    const original = checkboxes()[1]!;
    await rerender(message("- [ ] A longer first task\n- [ ] Second"));
    expect(checkboxes()[1]).toBe(original);

    await act(async () => original.click());
    expect(editedText).toBe("- [ ] A longer first task\n- [x] Second");
    await vi.waitFor(() => expect(checkboxes()[1]!.checked).toBe(true));
    await rerender(message("- [ ] A longer first task\n- [ ] Second"));
    expect(checkboxes()[1]).toBe(original);
    expect(checkboxes()[1]!.checked).toBe(false);
  });

  it.each([
    ["read-only", undefined],
    ["editable", () => {}],
  ])(
    "unchecks the remaining %s task when the checked row above it is removed",
    async (_, onTaskListChange) => {
      setup();
      const message = (text: string) => (
        <ChatMarkdown cwd="/tmp/project" text={text} onTaskListChange={onTaskListChange} />
      );
      await using screen = await render(message("- [x] Completed item\n- [ ] Pending item"));
      await screen.rerender(message("- [ ] Pending item"));
      const checkboxes =
        screen.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
      expect(checkboxes).toHaveLength(1);
      expect(checkboxes[0]!.checked).toBe(false);
    },
  );
});

describe("ChatMarkdown workspace file opens", () => {
  const threadRef = {
    environmentId: EnvironmentId.make("workspace"),
    threadId: ThreadId.make("thread"),
  };

  it("keeps a newer absolute file open when an earlier repo-relative lookup finishes", async () => {
    setup();
    const result = AsyncResult.success({
      entries: [{ path: "notes/a.md", kind: "file" }],
      truncated: false,
    });
    let resolvePending!: (value: typeof result) => void;
    const pending = new Promise<typeof result>((resolve) => {
      resolvePending = resolve;
    });
    markdownOpenMocks.searchProjectEntries.mockReturnValueOnce(pending);
    using openFile = vi
      .spyOn(useRightPanelStore.getState(), "openFile")
      .mockImplementation(() => {});
    await using screen = await renderText(
      "[Notes](physics/notes/a.md) and [Other](/elsewhere/b.md:9)",
      {
        cwd: "/school/physics",
        threadRef,
      },
    );
    const { container } = screen;
    const [notes, other] = container.querySelectorAll("a");
    await act(async () => notes!.click());
    expect(markdownOpenMocks.searchProjectEntries).toHaveBeenCalledOnce();
    expect(openFile).not.toHaveBeenCalled();

    await act(async () => other!.click());
    await act(async () => resolvePending(result));

    expect(openFile).toHaveBeenCalledExactlyOnceWith(threadRef, "/elsewhere/b.md", 9);
    expect(markdownOpenMocks.searchProjectEntries).toHaveBeenCalledOnce();
  });
});

describe("ChatMarkdown skill chips", () => {
  it("shows the skill's details and opens its instructions", async () => {
    setup();
    const threadRef = {
      environmentId: EnvironmentId.make("workspace"),
      threadId: ThreadId.make("thread"),
    };
    await using screen = await renderText("Run $review now", {
      threadRef,
      skills: [
        {
          name: "review",
          displayName: "Review",
          description: "Reviews the current branch.",
          path: "/skills/review/SKILL.md",
          enabled: true,
        },
      ],
    });
    using openFile = vi
      .spyOn(useRightPanelStore.getState(), "openFile")
      .mockImplementation(() => {});

    await userEvent.click(screen.getByRole("button", { name: "Skill Review. Show details" }));
    await expect.element(page.getByText("Reviews the current branch.")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "View instructions" }));

    expect(openFile).toHaveBeenCalledExactlyOnceWith(threadRef, "/skills/review/SKILL.md");
  });

  it("names a mentioned model as its provider does, without a thread", async () => {
    setup();
    await using screen = await renderText("Ask (model:codex/gpt-6.1), not model:openai/gpt-4o.", {
      environmentId: EnvironmentId.make("models"),
    });

    await expect
      .element(screen.getByRole("button", { name: "Model GPT-6.1. Show details" }))
      .toBeVisible();
    expect(buttonsLabelled(screen.container, "Model gpt-4o. Show details")).toEqual([]);
    expect(screen.container.textContent).toBe("Ask (GPT-6.1), not model:openai/gpt-4o.");
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
    setup();
    await using screen = await render(<ChatMarkdown cwd="/repo" text={source} />);
    const { container, rerender } = screen;
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
      setup();
      await using screen = await renderText(source, { cwd: "/repo" });
      const { container } = screen;
      expect(container.querySelector("img")?.getAttribute("alt")).toBe(alt);
      expect(container.querySelectorAll("button")).toHaveLength(1);
      expect(container.querySelectorAll('[role="button"]')).toHaveLength(0);
      expect(container.querySelector("button button, button a")).toBeNull();
      expect(copySelection(container)).toBe(source);
    },
  );

  it("keeps video labels non-interactive and copies their source", async () => {
    const source = "[![clip](https://example.com/preview.mp4)](/repo/example.ts)";
    setup();
    await using screen = await renderText(source, { cwd: "/repo" });
    const { container } = screen;
    expect(container.querySelector("video")?.controls).toBe(false);
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(container.querySelectorAll("[data-markdown-copy-media]")).toHaveLength(1);
    expect(copySelection(container)).toBe(source);
  });

  it("copies the filename for a whitespace-only link label", async () => {
    setup();
    await using screen = await renderText("[   ](/repo/example.ts:12)", { cwd: "/repo" });
    const { container } = screen;
    expect(copySelection(container)).toBe("[example.ts](/repo/example.ts:12)");
  });

  it.each([false, true])("matches soft-break filenames with lineBreaks=%s", async (lineBreaks) => {
    setup();
    await using screen = await renderText("[my\nfile.ts](/repo/my%20file.ts)", {
      cwd: "/repo",
      lineBreaks,
    });
    const { container } = screen;
    const link = container.querySelector(".chat-markdown-file-link")!;
    expect(link.textContent).toBe(lineBreaks ? "my\nfile.ts (my file.ts)" : "my file.ts");
    expect(link.querySelectorAll("br")).toHaveLength(lineBreaks ? 1 : 0);
  });

  it.each(["\n", "  \n", "\\\n"])(
    "preserves line breaks in file labels (%j)",
    async (lineBreak) => {
      const source = `[src/${lineBreak}example.ts](/repo/src/example.ts)`;
      setup();
      await using screen = await renderText(source, { cwd: "/repo", lineBreaks: true });
      const { container } = screen;
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
    setup();
    await using screen = await renderText(source, { cwd: "/repo", lineBreaks: true });
    const { container } = screen;
    expect(copySelection(container)).toBe(source);
  });

  it("retains descriptive prose, emphasis, destinations, and copy text", async () => {
    const source = "This function [**validates** the input](/repo/src/example.ts:12).";
    setup();
    await using screen = await renderText(source, { cwd: "/repo" });
    const { container } = screen;
    const link = container.querySelector(".chat-markdown-file-link")!;
    expect(link.querySelector("strong")?.textContent).toBe("validates");
    expect(link.textContent).toContain("validates the input");
    expect(link.textContent).toContain("example.ts · L12");
    expect(copySelection(container)).toBe(source);
  });
});

describe("ChatMarkdown authored file-label search", () => {
  it.each([
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
  ])("finds the indexed occurrences of $query in $text", async ({ text, query, count }) => {
    setup();
    await using screen = await render(
      <div data-timeline-row-id="row">
        <div data-thread-find-text>
          <MarkdownFindContext value={true}>
            <ChatMarkdown text={text} cwd={undefined} />
          </MarkdownFindContext>
        </div>
      </div>,
    );
    expect(
      collectThreadFindRanges(screen.container, query).map((match) => match.range.toString()),
    ).toEqual(Array.from({ length: count }, () => query));
    const segments = searchableMessageSegments({ role: "assistant", text, streaming: false }) ?? [];
    expect(
      segments.reduce((sum, segment) => sum + countThreadSearchOccurrences(segment, query), 0),
    ).toBe(count);
  });
});

describe("ChatMarkdown headings", () => {
  it("keeps insight streaming, reference links, and heading anchors in one message", async () => {
    setup();
    const rule = "─".repeat(20);
    const text = `## Setup\n\nBefore [source][src].\n\n★ Insight ${rule}\nA **streaming** note.`;
    const message = (text: string, isStreaming: boolean) => (
      <ChatMarkdown
        cwd={undefined}
        text={text}
        renderInsights
        lineBreaks
        isStreaming={isStreaming}
      />
    );
    await using screen = await render(message(text, true));
    await expect.element(screen.getByRole("note")).toHaveTextContent("Insight A streaming note.");
    await screen.rerender(
      message(
        `${text}\n${rule}\n\n## Setup\n\nAfter [source][src].\n\n[src]:\n  https://example.com`,
        false,
      ),
    );
    await expect.element(screen.getByRole("note")).toHaveTextContent("Insight A streaming note.");
    expect([...screen.container.querySelectorAll("h2")].map((heading) => heading.id)).toEqual([
      "user-content-setup",
      "user-content-setup-1",
    ]);
    expect(
      [...screen.container.querySelectorAll("a")].filter(
        (link) => link.href === "https://example.com/",
      ),
    ).toHaveLength(2);
    await expect.element(screen.getByRole("note")).not.toHaveTextContent("After");
  });

  it("never gives two headings the same id, even when a suffix matches another heading", async () => {
    setup();
    await using screen = await renderText(
      '## Setup\n\n## Setup\n\n## Setup-1\n\n<h2 id="install-1">Pinned</h2>\n\n## Install\n\n## Install',
      { parseRawHtml: true },
    );
    const { container } = screen;
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

describe("ChatMarkdown inline code selection", () => {
  it("selects the whole inline code span on double-click, but only a word in fenced code", async () => {
    setup();
    await using screen = await renderText(
      "Run `migration-gate --dry-run` first.\n\n```txt\nfenced-block word\n```",
    );
    await userEvent.dblClick(screen.getByText("migration-gate --dry-run"));
    expect(window.getSelection()?.toString()).toBe("migration-gate --dry-run");

    window.getSelection()?.removeAllRanges();
    const fenced = screen.container.querySelector("pre code")!;
    await userEvent.dblClick(fenced, { position: { x: 4, y: 4 } });
    expect(window.getSelection()?.toString()).toBe("fenced");
  });

  it("selects the whole line on triple-click beside a favicon link or a file chip", async () => {
    setup();
    await using screen = await renderText(
      "Before [docs](https://example.com/docs) after words\n\nBefore [App.tsx](/tmp/project/src/App.tsx) after words",
    );
    const tripleClickWord = async (paragraph: HTMLElement, word: string) => {
      const text = [...paragraph.childNodes].find((node) => node.textContent?.includes(word))!;
      const range = document.createRange();
      range.setStart(text, text.textContent!.indexOf(word));
      range.setEnd(text, text.textContent!.indexOf(word) + word.length);
      const wordBox = range.getBoundingClientRect();
      const paragraphBox = paragraph.getBoundingClientRect();
      window.getSelection()?.removeAllRanges();
      await userEvent.tripleClick(paragraph, {
        position: {
          x: wordBox.left - paragraphBox.left + wordBox.width / 2,
          y: wordBox.top - paragraphBox.top + wordBox.height / 2,
        },
      });
      return window.getSelection()?.toString().trim();
    };

    const paragraphs = screen.container.querySelectorAll("p");
    expect(paragraphs).toHaveLength(2);
    const selections = [];
    const lines = [];
    for (const paragraph of paragraphs) {
      lines.push(paragraph.textContent?.trim(), paragraph.textContent?.trim());
      selections.push(
        await tripleClickWord(paragraph, "Before"),
        await tripleClickWord(paragraph, "after"),
      );
    }
    expect(selections).toEqual(lines);
  });
});

describe("ChatMarkdown alert copy", () => {
  it("copies a fully selected callout as alert Markdown and a partial one as text", async () => {
    setup();
    await using screen = await renderText("> [!WARNING]\n> Back up first.");
    const [label, body] = screen.container.querySelectorAll('[role="note"] > p');
    const select = (startNode: Node, endNode: Node, endOffset: number) => {
      const range = document.createRange();
      range.setStart(startNode, 0);
      range.setEnd(endNode, endOffset);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return chatMarkdownClipboardPayload(selection)?.text;
    };
    const labelText = label!.lastChild!;
    const bodyText = body!.firstChild!;

    expect(select(labelText, bodyText, bodyText.textContent!.length)).toBe(
      "> [!WARNING]\n> Back up first.",
    );
    expect(select(labelText, bodyText, "Back up".length)).toBe("Warning\n\nBack up");
  });
});

describe("ChatMarkdown file chip tooltips", () => {
  it("wraps a long path so its file name stays inside the tooltip", async () => {
    setup();
    const path =
      "/tmp/project/packages/client-runtime/src/state/generated/environment-connection-handshake-retry-policy-fixtures.ts";
    await using screen = await renderText(`See [the fixtures](${path}).`);

    await userEvent.hover(screen.container.querySelector(".chat-markdown-file-link")!);
    const tooltip = page.getByText(path);
    await expect.element(tooltip).toBeVisible();

    const popup = tooltip.element().closest("[data-side]")!;
    const pathEnd = document.createRange();
    pathEnd.selectNodeContents(tooltip.element());
    expect(pathEnd.getBoundingClientRect().right).toBeLessThanOrEqual(
      popup.getBoundingClientRect().right,
    );
  });
});

describe("ChatMarkdown editor deep links", () => {
  const hrefs = (container: HTMLElement) =>
    [...container.querySelectorAll("a")].map((link) => link.getAttribute("href"));

  it("keeps local editor file links", async () => {
    setup();
    await using screen = await renderText(
      "[file.md line 3](cursor://file/Users/me/repo/file.md:3) and [same](vscode://file/Users/me/repo/file.md:3:7)",
    );
    expect(hrefs(screen.container)).toEqual([
      "cursor://file/Users/me/repo/file.md:3",
      "vscode://file/Users/me/repo/file.md:3:7",
    ]);
  });

  it("still drops other editor links and unknown schemes", async () => {
    setup();
    await using screen = await renderText(
      "[prompt](cursor://anysphere.cursor-deeplink/prompt?text=hi) [user](cursor://me@file/Users/me/file.md) [unknown](foo://file/Users/me/file.md)",
    );
    expect(screen.container.innerHTML).not.toContain("://");
    expect(hrefs(screen.container).filter(Boolean)).toEqual([]);
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

  it("still rejects unsafe schemes", async () => {
    setup();
    for (const parseRawHtml of [true, false]) {
      await using screen = await renderWindows(
        "[unsafe](javascript:alert(1)) and [unknown](d:alert(1))",
        parseRawHtml,
      );
      const { container } = screen;
      expect(container.innerHTML).not.toContain("javascript:");
      expect(container.innerHTML).not.toContain("d:alert");
      expect(fileHrefs(container)).toEqual([]);
    }
  });
});

describe("ChatMarkdown managed destinations", () => {
  const threadRef = {
    environmentId: EnvironmentId.make("markdown-env"),
    threadId: ThreadId.make("markdown-thread"),
  };
  const href = "http://localhost:4173/completed-action";
  const prepared = {
    url: "https://workstation.example:4173/completed-action",
    localUrl: href,
    managed: true,
    restored: true,
  };
  const renderFileLink = () =>
    render(
      <FileMarkdownPreview
        cwd="/repo"
        relativePath="docs/report.md"
        text={`[Open the completed Action](${href})`}
        threadRef={threadRef}
        workspaceMutationId={null}
      />,
    );

  it.each(["web", "desktop"])(
    "reports a failed managed file-preview link on %s without external fallback",
    async (surface) => {
      setup();
      using _bridge = stubGlobal("desktopBridge", surface === "desktop" ? {} : undefined);
      const cause = new Error("Preview hosting could not be recovered.");
      markdownOpenMocks.prepareHostedPreview.mockRejectedValueOnce(cause);
      const openExternal = vi.fn();
      markdownOpenMocks.localApi = { shell: { openExternal } };
      await using screen = await renderFileLink();
      using popup = vi.spyOn(window, "open").mockReturnValue(null);
      using toast = vi.spyOn(toastManager, "add").mockReturnValue("managed-link-error");
      using report = vi.spyOn(console, "error").mockImplementation(() => {});
      await screen.getByRole("link", { name: "Open the completed Action" }).click();
      await vi.waitFor(() =>
        expect(report).toHaveBeenCalledWith(
          "[chat-markdown] action failed",
          { operation: "open-link-in-preview", target: href },
          cause,
        ),
      );
      expect(markdownOpenMocks.prepareHostedPreview).toHaveBeenCalledExactlyOnceWith(
        threadRef,
        href,
      );
      expect(toast).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          type: "error",
          title: "Unable to open link in browser",
          description: cause.message,
        }),
      );
      expect(markdownOpenMocks.openPreview).not.toHaveBeenCalled();
      expect(openExternal).not.toHaveBeenCalled();
      expect(popup).toHaveBeenCalledTimes(surface === "web" ? 1 : 0);
    },
  );

  it("opens a managed file-preview link in its owning panel without error feedback", async () => {
    setup();
    using _bridge = stubGlobal("desktopBridge", undefined);
    markdownOpenMocks.prepareHostedPreview.mockResolvedValueOnce(prepared);
    markdownOpenMocks.openPreview.mockResolvedValueOnce(
      AsyncResult.success({
        threadId: threadRef.threadId,
        tabId: "markdown-browser-tab",
        runtime: "server",
        backingPage: "server",
        navStatus: { _tag: "Idle" },
        canGoBack: false,
        canGoForward: false,
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await using screen = await renderFileLink();
    using _popup = vi.spyOn(window, "open").mockReturnValue(null);
    using toast = vi.spyOn(toastManager, "add").mockReturnValue("managed-link-error");
    await screen.getByRole("link", { name: "Open the completed Action" }).click();
    await vi.waitFor(() =>
      expect(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef)
          .activeSurfaceId,
      ).toBe("browser:markdown-browser-tab"),
    );
    expect(markdownOpenMocks.openPreview).toHaveBeenCalledExactlyOnceWith({
      environmentId: threadRef.environmentId,
      input: expect.objectContaining({
        threadId: threadRef.threadId,
        url: href,
        runtime: "server",
        browserHost: "environment",
      }),
    });
    expect(toast).not.toHaveBeenCalled();
  });

  it("reports a blocked popup without bypassing the owning environment's preview scope", async () => {
    setup();
    using _bridge = stubGlobal("desktopBridge", undefined);
    markdownOpenMocks.denyPreviewOperate = true;
    markdownOpenMocks.prepareHostedPreview.mockResolvedValueOnce(prepared);
    const openExternal = vi.fn();
    markdownOpenMocks.localApi = { shell: { openExternal } };
    await using screen = await renderFileLink();
    using _popup = vi.spyOn(window, "open").mockReturnValue(null);
    using toast = vi.spyOn(toastManager, "add").mockReturnValue("managed-link-error");
    using report = vi.spyOn(console, "error").mockImplementation(() => {});
    await screen.getByRole("link", { name: "Open the completed Action" }).click();
    await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
    expect(toast).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: "error",
        title: "Unable to open link in browser",
        description: "Unable to open link. Allow popups and try again.",
      }),
    );
    expect(markdownOpenMocks.openPreview).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

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
    setup();
    using _desktopBridge = new DisposableStack();
    _desktopBridge.defer(() => vi.unstubAllGlobals());
    vi.stubGlobal("desktopBridge", {});
    const openExternal = vi.fn().mockResolvedValue(undefined);
    markdownOpenMocks.localApi = {
      contextMenu: { show: vi.fn().mockResolvedValue("open-external") },
      shell: { openExternal },
    };
    const preparation = pendingPreparation();
    await using screen = await renderText(`[docs](${href})`, { cwd: undefined, threadRef });
    const { container } = screen;
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
    setup();
    const href = `http://localhost:4173/preview.${extension}`;
    const preparedUrl = `https://workstation.example:4173/preview.${extension}`;
    const preparation = pendingPreparation();
    const onImageExpand = vi.fn();
    await using screen = await renderText(`[media](${href})`, {
      cwd: undefined,
      threadRef,
      onImageExpand,
    });
    const { container } = screen;
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
    setup();
    const source = `http://localhost:4173/report.${extension}`;
    const destination = `https://workstation.example:4173/report.${extension}`;
    const preparation = pendingPreparation();
    await using screen = await renderText(`![report](${source})`, { cwd: "/workspace", threadRef });
    const { container } = screen;
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
    setup();
    const first = pendingPreparation();
    const second = pendingPreparation();
    await using screen = await render(
      <ChatMarkdown
        cwd="/workspace"
        text="![report](http://localhost:4173/first.png)"
        threadRef={threadRef}
      />,
    );
    const { container, rerender } = screen;
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
    setup();
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
    await using screen = await renderText(`[Review this PR](${target.url})`, {
      cwd: "/repo",
      threadRef: ref,
    });
    const { container } = screen;
    await act(async () => container.querySelector<HTMLAnchorElement>("a")!.click());
    expect(readThreadHandoffs(ref)[0]).toMatchObject({
      markdownLabel: "Review this PR",
      target: { kind: "pull-request", ...target },
    });
    expect(readThreadHandoffs(ref)[0]?.target).not.toHaveProperty("environmentId");
  });

  it("keeps the authored label when a resolved file is reopened by filename", async () => {
    setup();
    const ref = {
      environmentId: EnvironmentId.make("file-env"),
      threadId: ThreadId.make("handoff-thread"),
    };
    await using screen = await render(
      <ChatMarkdown cwd="/repo" threadRef={ref} text="[Final report](/repo/docs/report.md)" />,
    );
    const { container, rerender } = screen;
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
    setup();
    const ref = {
      environmentId: EnvironmentId.make("file-link-env"),
      threadId: ThreadId.make("file-link-thread"),
    };
    markdownOpenMocks.searchProjectEntries.mockResolvedValue(
      AsyncResult.success({ entries: [{ path: "nested/report.md", kind: "file" }] }),
    );
    await using screen = await renderText(`[report.md](${href})`, { cwd: "/repo", threadRef: ref });
    const { container } = screen;
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
      setup();
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
      using toast = vi.spyOn(toastManager, "add").mockReturnValue("restricted-media-toast");
      await using screen = await renderText("[image](/tmp/linked.png)", {
        cwd: "/repo",
        threadRef: ref,
        onImageExpand,
      });
      const { container } = screen;
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
