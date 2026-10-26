import { RunId, type ActionResumeState } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { makeThreadFixture } from "../../test-fixtures";
import { useUiStateStore } from "../../uiStateStore";
import { SidebarThreadHoverContent } from "./SidebarThreadHoverContent";
import { LastCodeThreadHoverDetails } from "./LastCodeThreadHoverDetails";
import type { ThreadStatusPill } from "../Sidebar.logic";
import "../../index.css";

const mocks = vi.hoisted(() => ({ settingRead: vi.fn() }));

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
  useSupportsMultiplePullRequests: () => false,
}));
vi.mock("../../state/terminalSessions", () => ({ useKnownTerminalSessions: () => [] }));
vi.mock("../../state/previewHosting", () => ({ useThreadPreviewLeases: () => [] }));
vi.mock("../ThreadStatusIndicators", () => ({ ThreadPullRequestsMiniList: () => null }));
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
  const previous = useUiStateStore.getState().threadLastVisitedAtById;
  useUiStateStore.setState({ threadLastVisitedAtById: {} });
  return {
    [Symbol.dispose]() {
      useUiStateStore.setState({ threadLastVisitedAtById: previous });
    },
  };
}

function hoverContent(
  lastVisitedAt: string | null | undefined,
  threadStatus?: ThreadStatusPill | null,
) {
  const renderedThread = { ...thread };
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
    />
  );
}

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
