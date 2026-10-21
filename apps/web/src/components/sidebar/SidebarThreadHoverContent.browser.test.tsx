import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { ActionResumeState } from "@t3tools/contracts";
import { makeThreadFixture } from "../../test-fixtures";
import { SidebarThreadHoverContent } from "./SidebarThreadHoverContent";
import "../../index.css";

vi.mock("~/hooks/useSupportsMultiplePullRequests", () => ({
  useSupportsMultiplePullRequests: () => false,
}));
vi.mock("../../state/terminalSessions", () => ({ useKnownTerminalSessions: () => [] }));
vi.mock("../../state/previewHosting", () => ({ useThreadPreviewLeases: () => [] }));
vi.mock("../ThreadStatusIndicators", () => ({ ThreadPullRequestsMiniList: () => null }));

it.each([
  { hasPendingApprovals: true, hasPendingUserInput: false, label: "Pending Approval" },
  { hasPendingApprovals: false, hasPendingUserInput: true, label: "Awaiting Input" },
])("shows $label in the thread hover alongside Action progress", async (status) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const wasDark = document.documentElement.classList.contains("dark");
  document.documentElement.classList.add("dark");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
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
    await act(async () => {
      root.render(
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
    });
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
    await act(async () => root.unmount());
    container.remove();
    document.documentElement.classList.toggle("dark", wasDark);
    vi.unstubAllGlobals();
  }
});
