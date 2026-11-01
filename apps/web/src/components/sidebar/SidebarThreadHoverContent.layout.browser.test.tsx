import { useState, type MouseEvent } from "react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  MessageId,
  type PreviewHostingLeaseMetadata,
  type TerminalSummary,
  type ThreadAnnotation,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { expect, it, vi } from "vite-plus/test";
import { commands, page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { makeThreadFixture } from "../../test-fixtures";
import { ThreadAnnotationHoverPopover } from "../thread-annotation/ThreadAnnotation";
import { Popover, PopoverCreateHandle, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarThreadHoverContent } from "./SidebarThreadHoverContent";
import "../../index.css";

const mocks = vi.hoisted(() => ({
  terminals: [] as TerminalSummary[],
  previews: [] as PreviewHostingLeaseMetadata[],
}));

vi.mock("../../hooks/useSettings", () => ({
  useClientSetting: (key: keyof typeof DEFAULT_CLIENT_SETTINGS) => DEFAULT_CLIENT_SETTINGS[key],
}));
vi.mock("~/hooks/useSupportsMultiplePullRequests", () => ({
  useSupportsMultiplePullRequests: () => true,
}));
vi.mock("../../state/terminalSessions", () => ({
  useKnownTerminalSessions: () => mocks.terminals.map((summary) => ({ state: { summary } })),
  useThreadRunningTerminalIds: () => [],
}));
vi.mock("../../state/previewHosting", () => ({ useThreadPreviewLeases: () => mocks.previews }));
vi.mock("./useLastCodeThreadStatus", () => ({ useLastCodeThreadStatus: () => null }));
vi.mock("../../environmentIcons", () => ({ ConnectedEnvironmentIcon: () => null }));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../chat/ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => null }));
// Keep the annotation's real height allocation without loading the Markdown worker graph.
vi.mock("../ChatMarkdown", () => ({
  default: ({ text }: { text: string }) => <div className="whitespace-pre-line">{text}</div>,
}));

function setup(metadataCount: number) {
  const thread = { ...makeThreadFixture(), title: "Layout thread", branch: "layout-branch" };
  thread.pullRequests = Array.from({ length: 70 }, (_, index) => ({
    host: "github.com",
    repository: "example/project",
    number: index + 1,
    url: `https://github.com/example/project/pull/${index + 1}`,
    source: "agent" as const,
    linkedAt: thread.createdAt,
    snapshot: null,
    stack: null,
  }));
  mocks.terminals = Array.from({ length: metadataCount / 2 }, (_, index) => ({
    threadId: thread.id,
    terminalId: `terminal-${index + 1}`,
    cwd: "/example/project",
    worktreePath: null,
    status: "running",
    pid: null,
    exitCode: null,
    exitSignal: null,
    hasRunningSubprocess: true,
    label: `Terminal ${index + 1}: development process with a long descriptive label that wraps within the hover card`,
    updatedAt: thread.createdAt,
  }));
  mocks.previews = Array.from({ length: metadataCount / 2 }, (_, index) => ({
    leaseId: `preview-${index + 1}`,
    threadId: thread.id,
    terminalId: `preview-terminal-${index + 1}`,
    url: `https://preview-${index + 1}.example/`,
    handedOffAt: thread.createdAt,
    expiresAt: thread.createdAt,
    status: "sleeping",
  }));
  return {
    thread,
    lastMetadataLabel: `preview-${metadataCount / 2}.example (preview reopens when viewed)`,
  };
}

function LayoutHarness({
  thread,
  annotated,
  onOpen,
}: {
  thread: ReturnType<typeof setup>["thread"];
  annotated: boolean;
  onOpen: (event: MouseEvent<HTMLAnchorElement>, url: string) => void;
}) {
  const [handle] = useState(PopoverCreateHandle);
  const details = (
    <SidebarThreadHoverContent
      thread={thread}
      threadStatus={null}
      projectTitle="Layout project"
      projectCwd="/example/project"
      projectFaviconPath={null}
      environmentLabel="Layout environment"
      providerEntry={null}
      showInstanceBadge={false}
      modelInstanceId="codex"
      modelLabel="Codex"
      branchMismatch={null}
      terminalStatus={null}
      terminalProcessCount={mocks.terminals.length}
      onOpenPullRequest={onOpen}
    />
  );
  if (!annotated) {
    return (
      <Popover defaultOpen>
        <PopoverTrigger>Show details</PopoverTrigger>
        <PopoverPopup
          animated={false}
          align="start"
          side="right"
          tooltipStyle
          padding="none"
          initialFocus={false}
        >
          <div className="flex min-h-0 max-h-(--available-height) flex-col">{details}</div>
        </PopoverPopup>
      </Popover>
    );
  }
  const annotation: ThreadAnnotation = {
    anchorMessageId: MessageId.make("layout-annotation-anchor"),
    body: Array.from({ length: 40 }, (_, index) => `Annotation line ${index + 1}`).join("\n"),
    createdAt: thread.createdAt,
    updatedAt: thread.createdAt,
    resolvedAt: null,
  };
  return (
    <>
      <PopoverTrigger handle={handle}>Show details</PopoverTrigger>
      <ThreadAnnotationHoverPopover
        annotation={annotation}
        threadRef={scopeThreadRef(thread.environmentId, thread.id)}
        handle={handle}
        navigationTriggerId="layout-navigation"
        threadDetails={details}
        onEdit={() => undefined}
        onResolve={() => undefined}
        onBodyChange={async () => true}
      />
    </>
  );
}

function expectInside(element: Element, viewport: Element) {
  const rect = element.getBoundingClientRect();
  const bounds = viewport.getBoundingClientRect();
  expect(rect.height).toBeGreaterThan(0);
  expect(rect.top).toBeGreaterThanOrEqual(bounds.top - 1);
  expect(rect.bottom).toBeLessThanOrEqual(bounds.bottom + 1);
}

async function finishScroll(element: Element, input: () => Promise<void>) {
  const finished = new Promise<void>((resolve) =>
    element.addEventListener("scrollend", () => resolve(), { once: true }),
  );
  await input();
  await finished;
}

it.each(
  [false, true].flatMap((annotated) =>
    [640, 240].flatMap((availableHeight) =>
      [2, 60].map((metadataCount) => ({ annotated, availableHeight, metadataCount })),
    ),
  ),
)(
  "keeps PRs and all metadata reachable with $metadataCount labels, $availableHeight px, annotated=$annotated",
  async ({ annotated, availableHeight, metadataCount }) => {
    const { thread, lastMetadataLabel } = setup(metadataCount);
    await page.viewport(1280, availableHeight + 16);
    const onOpen = vi.fn((event: MouseEvent<HTMLAnchorElement>, _url: string) =>
      event.preventDefault(),
    );
    await using screen = await render(
      <LayoutHarness thread={thread} annotated={annotated} onOpen={onOpen} />,
    );
    if (annotated) await userEvent.click(screen.getByRole("button", { name: "Show details" }));
    await expect.element(page.getByText("Layout thread", { exact: true })).toBeVisible();
    const viewport = document.querySelector<HTMLElement>('[data-slot="popover-viewport"]')!;
    const links = [...viewport.querySelectorAll<HTMLAnchorElement>("a")];
    expect(links).toHaveLength(70);
    const prScroller = links[0]!.closest("ul")!.parentElement!;
    await vi.waitFor(() => {
      expect(prScroller.clientHeight).toBeGreaterThanOrEqual(40);
      expectInside(prScroller, viewport);
    });
    // A long list fills the available card before it scrolls, even with ordinary metadata.
    expect(viewport.clientHeight).toBeGreaterThanOrEqual(availableHeight - 24);
    const project = page.getByText("Layout project", { exact: true }).element();
    const metadata = project.parentElement!.parentElement!;
    if (metadataCount === 2 && availableHeight === 640) {
      expect(metadata.scrollHeight).toBeLessThanOrEqual(metadata.clientHeight + 1);
      expectInside(page.getByText(lastMetadataLabel, { exact: true }).element(), viewport);
    }
    if (metadataCount === 60) {
      expect(metadata.scrollHeight).toBeGreaterThan(metadata.clientHeight);
      expectInside(metadata, viewport);
      await userEvent.hover(page.elementLocator(metadata));
      await finishScroll(metadata, () => commands.wheel(200));
      await vi.waitFor(() => expect(metadata.scrollTop).toBeGreaterThan(0));
      await act(() => metadata.focus());
      expect(document.activeElement).toBe(metadata);
      const beforePageDown = metadata.scrollTop;
      await finishScroll(metadata, () => userEvent.keyboard("{PageDown}"));
      await vi.waitFor(() => expect(metadata.scrollTop).toBeGreaterThan(beforePageDown));
      await finishScroll(metadata, () => userEvent.keyboard("{End}"));
      await vi.waitFor(() => {
        expect(document.activeElement).toBe(metadata);
        expectInside(page.getByText(lastMetadataLabel, { exact: true }).element(), metadata);
      });
    }
    await act(() => {
      metadata.scrollTop = metadata.scrollHeight;
      prScroller.scrollTop = prScroller.scrollHeight;
    });
    expectInside(page.getByText(lastMetadataLabel, { exact: true }).element(), metadata);
    const last = links.at(-1)!;
    expectInside(last, prScroller);
    await userEvent.click(page.elementLocator(last));
    expect(onOpen).toHaveBeenCalledWith(expect.anything(), thread.pullRequests.at(-1)!.url);
    if (annotated) {
      const edit = page.getByRole("button", { name: "Edit", exact: true }).element();
      expectInside(edit, viewport);
      const annotationBody = page
        .getByText("Annotation line 1", { exact: false })
        .element().parentElement!;
      await act(() => {
        annotationBody.scrollTop = annotationBody.scrollHeight;
      });
      expect(annotationBody.scrollTop).toBeGreaterThan(0);
      expectInside(annotationBody, viewport);
    }
    if (metadataCount === 2 && availableHeight === 640) {
      await act(() => links[0]!.focus());
      await screen.rerender(
        <LayoutHarness
          thread={{ ...thread, pullRequests: thread.pullRequests.slice(0, 2) }}
          annotated={annotated}
          onOpen={onOpen}
        />,
      );
      await expect.element(page.getByText("Layout thread", { exact: true })).toBeVisible();
      await vi.waitFor(() => {
        expect(viewport.clientHeight).toBeGreaterThan(0);
        expect(viewport.clientHeight).toBeLessThan(availableHeight - 100);
      });
    }
  },
);
