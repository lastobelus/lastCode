import { act, render } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";
import { RunId, type ActionResumeState } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { makeThreadFixture } from "../../test-fixtures";
import { useUiStateStore } from "../../uiStateStore";
import { SidebarThreadHoverContent } from "./SidebarThreadHoverContent";
import "../../index.css";

vi.mock("~/hooks/useSupportsMultiplePullRequests", () => ({
  useSupportsMultiplePullRequests: () => false,
}));
vi.mock("../../state/terminalSessions", () => ({ useKnownTerminalSessions: () => [] }));
vi.mock("../../state/previewHosting", () => ({ useThreadPreviewLeases: () => [] }));
vi.mock("../ThreadStatusIndicators", () => ({ ThreadPullRequestsMiniList: () => null }));

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
      { router: false },
    );
    const { container } = screen;
    expect(container.textContent).toContain("Completed");
    await act(() => useUiStateStore.setState({ threadLastVisitedAtById: { [key]: later } }));
    expect(container.textContent).not.toContain("Completed");
    await act(() => useUiStateStore.setState({ threadLastVisitedAtById: { [key]: earlier } }));
    expect(container.textContent).toContain("Completed");
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
      { router: false },
    );
    const { container } = screen;
    const label = [...container.querySelectorAll("div")].find(
      (element) => element.textContent === status.label && element.children.length === 0,
    );
    if (!label) throw new Error(`Missing ${status.label} status in thread hover`);
    const dot = label.parentElement?.querySelector<HTMLElement>(".rounded-full");
    if (!dot) throw new Error("Missing status dot in thread hover");
    expect(dot.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(getComputedStyle(dot).backgroundColor).toBe(getComputedStyle(label).color);
    expect(container.textContent).toContain("Checks are still running");
  } finally {
    document.documentElement.classList.toggle("dark", wasDark);
  }
});
