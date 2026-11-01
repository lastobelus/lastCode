import { RunId, type ActionResumeState, type ThreadPullRequestLink } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { expect, it, vi } from "vite-plus/test";
import { commands, page, userEvent } from "vite-plus/test/browser";
import type { MouseEvent } from "react";
import { act, render } from "../../../test/render";
import { makeThreadFixture } from "../../test-fixtures";
import { useUiStateStore } from "../../uiStateStore";
import { SidebarThreadHoverContent } from "./SidebarThreadHoverContent";
import { LastCodeThreadHoverDetails } from "./LastCodeThreadHoverDetails";
import type { ThreadStatusPill } from "../Sidebar.logic";
import type { SidebarThreadSummary } from "../../types";
import "../../index.css";

const mocks = vi.hoisted(() => ({ settingRead: vi.fn(), multiplePullRequests: false }));

vi.mock("../../hooks/useSettings", () => ({
  useClientSetting: (key: keyof typeof DEFAULT_CLIENT_SETTINGS) => {
    mocks.settingRead(key);
    return key === "lastcodeStatusIcons"
      ? { Completed: { shape: "triangle-right", style: "outline-fill" } }
      : key === "compactLegacySidebarStatuses"
        ? true
        : DEFAULT_CLIENT_SETTINGS[key];
  },
}));
vi.mock("~/hooks/useSupportsMultiplePullRequests", () => ({
  useSupportsMultiplePullRequests: () => mocks.multiplePullRequests,
}));
vi.mock("../../state/terminalSessions", () => ({
  useKnownTerminalSessions: () => [],
  useThreadRunningTerminalIds: () => [],
}));
vi.mock("../../state/previewHosting", () => ({ useThreadPreviewLeases: () => [] }));
vi.mock("../../environmentIcons", () => ({ ConnectedEnvironmentIcon: () => null }));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../chat/ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => null }));

const thread = {
  ...makeThreadFixture(),
  latestRun: {
    runId: RunId.make("hover-run"),
    status: "completed" as const,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt: "2026-03-09T10:00:00.000Z",
    completedAt: "2026-03-09T10:05:00.000Z",
    assistantMessageId: null,
  },
};
const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

function setup(): Disposable {
  mocks.settingRead.mockClear();
  mocks.multiplePullRequests = false;
  const previous = useUiStateStore.getState().threadLastVisitedAtById;
  useUiStateStore.setState({ threadLastVisitedAtById: {} });
  return {
    [Symbol.dispose]() {
      mocks.multiplePullRequests = false;
      useUiStateStore.setState({ threadLastVisitedAtById: previous });
    },
  };
}

function hoverContent(
  lastVisitedAt: string | null | undefined,
  threadStatus?: ThreadStatusPill | null,
  overrides: Partial<SidebarThreadSummary> = {},
  onOpenPullRequest?: (event: MouseEvent<HTMLAnchorElement>, url: string) => void,
) {
  const renderedThread = { ...thread, ...overrides };
  if (lastVisitedAt === undefined) {
    delete renderedThread.lastVisitedAt;
  } else {
    renderedThread.lastVisitedAt = lastVisitedAt;
  }
  return (
    <SidebarThreadHoverContent
      thread={renderedThread}
      threadStatus={threadStatus}
      projectTitle={null}
      projectCwd={null}
      projectFaviconPath={null}
      environmentLabel={null}
      providerEntry={null}
      showInstanceBadge={false}
      modelInstanceId="codex"
      modelLabel="Codex"
      branchMismatch={null}
      terminalStatus={null}
      terminalProcessCount={0}
      onOpenPullRequest={onOpenPullRequest}
    />
  );
}

function pullRequest(number: number, watching: boolean): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "example/project",
    number,
    url: `https://github.com/example/project/pull/${number}`,
    source: "agent",
    linkedAt: thread.createdAt,
    snapshot: null,
    stack: null,
    ...(watching
      ? {
          watch: {
            startedAt: thread.createdAt,
            headSha: null,
            failedChecks: [],
            passed: false,
            passedChecks: [],
            remarksThrough: thread.createdAt,
            remarkIds: [],
            reactionKeys: [],
            reactionCounts: {},
            conflicting: false,
            wakes: 0,
          },
        }
      : {}),
  };
}

it("scrolls to and opens PRs at the end of a long list while keeping thread details visible", async () => {
  using _state = setup();
  mocks.multiplePullRequests = true;
  const onOpen = vi.fn((event: MouseEvent<HTMLAnchorElement>, _url: string) =>
    event.preventDefault(),
  );
  const onComposerKey = vi.fn();
  const container = document.createElement("div");
  container.style.setProperty("--available-height", "600px");
  await using screen = await render(
    <>
      <textarea aria-label="Composer" onKeyDown={(event) => onComposerKey(event.key)} />
      <div role="dialog">
        <input aria-label="Other dialog field" onKeyDown={(event) => onComposerKey(event.key)} />
      </div>
      {hoverContent(
        null,
        null,
        {
          pullRequests: Array.from({ length: 70 }, (_, index) => pullRequest(index + 1, false)),
        },
        onOpen,
      )}
    </>,
    { container },
  );
  const links = [...screen.container.querySelectorAll<HTMLAnchorElement>("a")];
  expect(links).toHaveLength(70);
  const last = links.at(-1)!;
  const scroller = last.closest("ul")!.parentElement!;
  expect(scroller.clientHeight).toBeGreaterThan(500);
  await userEvent.hover(page.elementLocator(scroller));
  const scrolled = new Promise<void>((resolve) =>
    scroller.addEventListener("scroll", () => resolve(), { once: true }),
  );
  await commands.wheel(200);
  await scrolled;
  expect(scroller.scrollTop).toBeGreaterThan(0);
  const composer = screen.getByRole("textbox", { name: "Composer" });
  await userEvent.click(composer);
  await userEvent.hover(page.elementLocator(scroller));
  for (const key of ["PageDown", "PageUp", "ArrowDown", "ArrowUp"]) {
    await act(() => {
      scroller.scrollTop = 200;
    });
    await userEvent.keyboard(`{${key}}`);
    expect(key.endsWith("Down") ? scroller.scrollTop > 200 : scroller.scrollTop < 200).toBe(true);
  }
  expect(document.activeElement).toBe(composer.element());
  expect(onComposerKey).not.toHaveBeenCalled();
  for (const [position, key] of [
    [0, "PageUp"],
    [0, "ArrowUp"],
    [scroller.scrollHeight, "PageDown"],
    [scroller.scrollHeight, "ArrowDown"],
  ] as const) {
    await act(() => {
      scroller.scrollTop = position;
    });
    const boundary = scroller.scrollTop;
    await userEvent.keyboard(`{${key}}`);
    expect(scroller.scrollTop).toBe(boundary);
  }
  expect(onComposerKey).not.toHaveBeenCalled();
  await userEvent.keyboard("{Control>}{ArrowDown}{/Control}");
  expect(onComposerKey).toHaveBeenCalledWith("ArrowDown");
  onComposerKey.mockClear();
  await act(() =>
    (screen.getByRole("textbox", { name: "Other dialog field" }).element() as HTMLElement).focus(),
  );
  await userEvent.keyboard("{ArrowDown}");
  expect(onComposerKey).toHaveBeenCalledWith("ArrowDown");
  onComposerKey.mockClear();
  await act(() => {
    scroller.scrollTop = 200;
    links[0]!.focus();
  });
  await userEvent.hover(composer);
  const focusedPosition = scroller.scrollTop;
  await userEvent.keyboard("{ArrowDown}");
  expect(scroller.scrollTop).toBeGreaterThan(focusedPosition);
  expect(document.activeElement).toBe(links[0]);
  await act(() => {
    scroller.scrollTop = scroller.scrollHeight;
  });
  expect(scroller.scrollTop).toBeGreaterThan(0);
  await expect.element(screen.getByText(thread.title, { exact: true })).toBeVisible();
  await userEvent.click(page.elementLocator(last));
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(expect.anything(), last.href);
});

it("names active PR watches in the waiting hover and updates when watching stops", async () => {
  using _state = setup();
  const waiting: ThreadStatusPill = {
    label: "Waiting",
    dotClass: "bg-sidebar-muted-foreground",
    colorClass: "text-sidebar-muted-foreground",
    pulse: false,
  };
  await using screen = await render(
    hoverContent(null, waiting, { pullRequests: [pullRequest(12, true), pullRequest(34, false)] }),
  );
  await expect.element(screen.getByText("Watching PR #12", { exact: true })).toBeVisible();
  await screen.rerender(
    hoverContent(null, waiting, { pullRequests: [pullRequest(12, true), pullRequest(34, true)] }),
  );
  await expect.element(screen.getByText("Watching PRs #12, #34", { exact: true })).toBeVisible();
  await screen.rerender(hoverContent(null, waiting, { pullRequests: [pullRequest(12, false)] }));
  await expect.element(screen.getByText("Waiting", { exact: true })).toBeVisible();
});

it.each(["Working", "Pending Approval", "Awaiting Input"] as const)(
  "keeps %s ahead of the PR watch hover label",
  async (label) => {
    using _state = setup();
    await using screen = await render(
      hoverContent(
        null,
        { label, dotClass: "bg-sky-500", colorClass: "text-sky-600", pulse: false },
        { pullRequests: [pullRequest(12, true)] },
      ),
    );
    await expect.element(screen.getByText(label, { exact: true })).toBeVisible();
    expect(screen.container.textContent).not.toContain("Watching PR");
  },
);

it("uses local visits only when the server omits visited tracking, including live updates", async () => {
  using _state = setup();
  useUiStateStore.setState({
    threadLastVisitedAtById: { [threadKey]: "2026-03-09T10:01:00.000Z" },
  });
  await using screen = await render(hoverContent(undefined));
  const host = screen.container;
  await vi.waitFor(() => expect(host.textContent).toContain("Completed"));
  await act(() =>
    useUiStateStore.setState({
      threadLastVisitedAtById: { [threadKey]: "2026-03-09T10:06:00.000Z" },
    }),
  );
  await vi.waitFor(() => expect(host.textContent).not.toContain("Completed"));
  await screen.rerender(hoverContent("2026-03-09T10:01:00.000Z"));
  await vi.waitFor(() => expect(host.textContent).toContain("Completed"));
  await screen.rerender(hoverContent(null));
  await vi.waitFor(() => expect(host.textContent).not.toContain("Completed"));
});

it("reads shape preferences only in the LastCode hover path, leaving shared and search hovers native", async () => {
  using _state = setup();
  const lastVisitedAt = "2026-03-09T10:01:00.000Z";
  await using screen = await render(hoverContent(lastVisitedAt));
  await vi.waitFor(() => {
    const dot = screen.container.querySelector<HTMLElement>(".rounded-full");
    expect(dot?.getBoundingClientRect().width).toBe(6);
    expect(dot?.getBoundingClientRect().height).toBe(6);
    expect(dot && getComputedStyle(dot).maskImage).toBe("none");
    expect(screen.container.textContent).toContain("Completed");
    expect(mocks.settingRead).not.toHaveBeenCalled();
  });
  await screen.rerender(
    <>
      <section data-hover="shared">{hoverContent(lastVisitedAt)}</section>
      <section data-hover="lastcode">
        <LastCodeThreadHoverDetails
          thread={{ ...thread, lastVisitedAt }}
          sourceControl={{
            gitCwd: null,
            threadProject: null,
            threadProjectCwd: null,
            branchMismatch: null,
            pr: null,
            prStatus: null,
            currentLinkedPr: null,
          }}
          processes={{
            runningTerminalIds: [],
            discoveredPorts: [],
            hasStoppableProcesses: false,
            terminalStatus: null,
          }}
          identity={{
            showsThreadEnvironmentIcon: false,
            threadEnvironmentLabel: null,
            environmentIconColor: undefined,
            modelInstanceId: thread.modelSelection.instanceId,
            providerEntry: null,
            showInstanceBadge: false,
            modelLabel: "Codex",
          }}
          familyPresentation={{
            isAgentCreated: false,
            creatorDescription: null,
            subagentLabel: null,
            relationshipDescription: null,
            relationshipLabel: null,
            relationshipUnavailableLabel: null,
          }}
          projectCwdFallback={null}
          cleanupBlockerTitle={null}
          hasActiveAnnotation={false}
        />
      </section>
    </>,
  );
  await vi.waitFor(() => {
    const shared = screen.container.querySelector('[data-hover="shared"]');
    const lastcode = screen.container.querySelector('[data-hover="lastcode"]');
    expect(shared?.querySelector("[data-status-shape]")).toBeNull();
    const dot = shared?.querySelector<HTMLElement>(".rounded-full");
    const paint = lastcode?.querySelector<HTMLElement>("[data-status-shape] > span");
    if (!dot || !paint) throw new Error("Both hover paths must paint their status.");
    expect(getComputedStyle(dot).maskImage).toBe("none");
    expect(getComputedStyle(paint).backgroundColor).toBe(getComputedStyle(dot).backgroundColor);
    const svg = decodeURIComponent(getComputedStyle(paint).maskImage);
    expect(svg).toContain("rotate(90 3 3)");
    expect(svg).toContain('fill-opacity="0.5" stroke="black" stroke-width="1"');
    expect(shared?.textContent).toContain("Completed");
    expect(lastcode?.textContent).toContain("Completed");
    expect(mocks.settingRead).toHaveBeenCalledWith("lastcodeStatusIcons");
  });
});

it("keeps an explicitly supplied status or null ahead of the visit-aware fallback", async () => {
  using _state = setup();
  const supplied: ThreadStatusPill = {
    label: "Failed",
    dotClass: "bg-red-500",
    colorClass: "text-red-600",
    pulse: false,
  };
  await using screen = await render(hoverContent("2026-03-09T10:01:00.000Z", supplied));
  await vi.waitFor(() => {
    expect(screen.container.textContent).toContain("Failed");
    expect(screen.container.textContent).not.toContain("Completed");
  });
  await screen.rerender(hoverContent("2026-03-09T10:01:00.000Z", null));
  await vi.waitFor(() => {
    expect(screen.container.textContent).not.toContain("Failed");
    expect(screen.container.textContent).not.toContain("Completed");
    expect(screen.container.querySelector(".rounded-full")).toBeNull();
  });
});

it("updates search hover completion from local visits when the server omits visit tracking", async () => {
  const earlier = "2026-03-09T10:04:00.000Z";
  const later = "2026-03-09T10:06:00.000Z";
  const thread = {
    ...makeThreadFixture({
      runtime: null,
      hasActionableProposedPlan: false,
      latestRun: {
        runId: RunId.make("search-completion"),
        status: "completed",
        assistantMessageId: null,
        requestedAt: earlier,
        startedAt: earlier,
        completedAt: "2026-03-09T10:05:00.000Z",
      },
    }),
  };
  delete thread.lastVisitedAt;
  const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const previous = useUiStateStore.getState().threadLastVisitedAtById;
  try {
    useUiStateStore.setState({ threadLastVisitedAtById: { [key]: earlier } });
    await using screen = await render(
      <SidebarThreadHoverContent
        thread={thread}
        projectTitle={null}
        projectCwd={null}
        projectFaviconPath={null}
        environmentLabel={null}
        providerEntry={null}
        showInstanceBadge={false}
        modelInstanceId="codex"
        modelLabel="Codex"
        branchMismatch={null}
        terminalStatus={null}
        terminalProcessCount={0}
      />,
    );
    const { container } = screen;
    await vi.waitFor(() => expect(container.textContent).toContain("Completed"));
    await act(() => useUiStateStore.setState({ threadLastVisitedAtById: { [key]: later } }));
    await vi.waitFor(() => expect(container.textContent).not.toContain("Completed"));
    await act(() => useUiStateStore.setState({ threadLastVisitedAtById: { [key]: earlier } }));
    await vi.waitFor(() => expect(container.textContent).toContain("Completed"));
  } finally {
    useUiStateStore.setState({ threadLastVisitedAtById: previous });
  }
});

it.each([
  { hasPendingApprovals: true, hasPendingUserInput: false, label: "Pending Approval" },
  { hasPendingApprovals: false, hasPendingUserInput: true, label: "Awaiting Input" },
])("shows $label in the thread hover alongside Action progress", async (status) => {
  const wasDark = document.documentElement.classList.contains("dark");
  document.documentElement.classList.add("dark");
  const thread = makeThreadFixture({
    hasPendingApprovals: status.hasPendingApprovals,
    hasPendingUserInput: status.hasPendingUserInput,
  });
  const actionResume: ActionResumeState = {
    runId: "action-1",
    threadId: thread.id,
    projectId: thread.projectId,
    actionId: "wait-for-checks",
    actionName: "Wait for checks",
    terminalId: "terminal-1",
    outcome: "running",
    delivery: "armed",
    startedAt: thread.createdAt,
    finishedAt: null,
    exitCode: null,
    exitSignal: null,
    progress: {
      version: 1,
      state: "waiting",
      summary: "Checks are still running",
      updatedAt: thread.updatedAt,
    },
  };
  try {
    await using screen = await render(
      <SidebarThreadHoverContent
        thread={{ ...thread, actionResume }}
        projectTitle={null}
        projectCwd={null}
        projectFaviconPath={null}
        environmentLabel={null}
        providerEntry={null}
        showInstanceBadge={false}
        modelInstanceId="codex"
        modelLabel="Codex"
        branchMismatch={null}
        terminalStatus={null}
        terminalProcessCount={0}
      />,
    );
    const { container } = screen;
    await vi.waitFor(() => {
      const label = [...container.querySelectorAll("div")].find(
        (element) => element.textContent === status.label && element.children.length === 0,
      );
      if (!label) throw new Error(`Missing ${status.label} status in thread hover`);
      const dot = label.parentElement?.querySelector<HTMLElement>(".rounded-full");
      if (!dot) throw new Error("Missing status dot in thread hover");
      expect(dot.getBoundingClientRect().width).toBeGreaterThan(0);
      expect(getComputedStyle(dot).backgroundColor).toBe(getComputedStyle(label).color);
      expect(container.textContent).toContain("Checks are still running");
    });
  } finally {
    document.documentElement.classList.toggle("dark", wasDark);
  }
});
