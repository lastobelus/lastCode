import {
  ProjectId,
  ThreadId,
  type ActionResumeState,
  type OrchestrationV2PendingBackgroundTask,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { actionResumeStatus } from "@t3tools/shared/actionResume";
import {
  runningActionBanner,
  interruptedActionBanner,
  pendingActionBanner,
} from "./ComposerActionResume";
import { backgroundWorkNowItem } from "./ThreadActivityBanners";
import { LastCodeThreadNow } from "./LastCodeThreadNow";
import "../../index.css";

const settings = vi.hoisted(() => ({ hover: false }));
vi.mock("../../hooks/useSettings", () => ({
  useClientSetting: () => settings.hover,
}));

function setup() {
  settings.hover = false;
  const threadId = ThreadId.make("current-work-thread");
  const action: ActionResumeState = {
    runId: "action-run",
    threadId,
    projectId: ProjectId.make("current-work-project"),
    actionId: "quick-ci",
    actionName: "Quick CI",
    terminalId: "action-terminal",
    outcome: "running",
    delivery: "armed",
    startedAt: "2026-10-01T12:00:00.000Z",
    finishedAt: null,
    exitCode: null,
    exitSignal: null,
    progress: {
      version: 1,
      state: "working",
      summary: "Web tests and type checks",
      updatedAt: "2026-10-01T12:00:00.000Z",
    },
  };
  const watch: OrchestrationV2PendingBackgroundTask = {
    taskId: "pull-request-watch:github.com/example/project#526",
    kind: "monitor",
    description: "Watching pull request #526",
    awaited: true,
  };
  const subagents: OrchestrationV2PendingBackgroundTask[] = [
    {
      taskId: "review-permissions",
      kind: "subagent",
      description: "Review permissions",
      childThreadId: ThreadId.make("permissions-thread"),
    },
    {
      taskId: "check-hover",
      kind: "subagent",
      description: "Check hover behavior",
      childThreadId: ThreadId.make("hover-thread"),
    },
  ];
  const openThread = vi.fn();
  function view(
    tasks: OrchestrationV2PendingBackgroundTask[] = [],
    current: ActionResumeState | null = action,
    environmentPaused = false,
    followUp: Parameters<typeof actionResumeStatus>[0]["followUp"] = null,
  ) {
    const status = current
      ? actionResumeStatus({
          action: current,
          environmentPaused,
          followUp,
          hasPendingRequest: false,
        })
      : null;
    const running =
      current?.outcome === "running"
        ? runningActionBanner({
            action: current,
            status,
            cancelling: false,
            canRead: true,
            canOperate: true,
            onCancel: vi.fn(),
            onOpenTerminal: vi.fn(),
          })
        : null;
    const interrupted = interruptedActionBanner({
      action: current?.delivery === "available" ? current : null,
      status,
      canOperate: true,
      pending: null,
      onResume: vi.fn(),
      onDiscard: vi.fn(),
    });
    return (
      <div style={{ width: 600, maxWidth: "100%" }}>
        <LastCodeThreadNow
          attention={null}
          goal={null}
          syncPhase={null}
          work={backgroundWorkNowItem({
            threadId,
            tasks,
            turnItems: [],
            stopDisabled: false,
            stopping: false,
            onStop: async () => {},
            onOpenThread: openThread,
          })}
          tasks={tasks}
          turnItems={[]}
          action={current}
          actionItems={[
            interrupted,
            pendingActionBanner({
              action: current,
              status,
              canRead: true,
              onOpenTerminal: vi.fn(),
            }),
            running,
          ]}
          onOpenThread={openThread}
        />
      </div>
    );
  }
  return { action, watch, subagents, openThread, view };
}

it.each(["action", "watch", "subagents"] as const)(
  "shows an Action with %s work in the full list",
  async (scenario) => {
    const { view, watch, subagents } = setup();
    const tasks = scenario === "action" ? [] : scenario === "watch" ? [watch] : subagents;
    await using screen = await render(view(tasks));
    await expect.element(screen.getByText(/Running Quick CI/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Show work details" }));
    const details = page.getByRole("dialog", { name: "Current work" });
    await expect.element(details).toBeVisible();
    await expect.element(details.getByText("Quick CI", { exact: true })).toBeVisible();
    await expect
      .element(details.getByRole("button", { name: "Cancel", exact: true }))
      .toBeVisible();
    for (const task of tasks) {
      await expect.element(details.getByText(task.description!, { exact: true })).toBeVisible();
    }
    if (scenario === "subagents") {
      await userEvent.click(details.getByRole("button", { name: "Open thread" }).first());
    }
  },
);

it("keeps text hover off by default while info click and hover still reveal details", async () => {
  const { view } = setup();
  await using screen = await render(view());
  await userEvent.hover(screen.getByText("Running Quick CI", { exact: true }));
  await expect.element(page.getByRole("dialog", { name: "Current work" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Show work details" }));
  await expect.element(page.getByRole("dialog", { name: "Current work" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("dialog", { name: "Current work" })).not.toBeInTheDocument();
  await userEvent.hover(screen.getByText("Running Quick CI", { exact: true }));
  await userEvent.hover(screen.getByRole("button", { name: "Show work details" }));
  await expect.element(page.getByRole("dialog", { name: "Current work" })).toBeVisible();
});

it("opens the same full list on status text hover when enabled, including long names", async () => {
  const { view, subagents } = setup();
  settings.hover = true;
  const longName = "Review every permission boundary for background Actions and PR watches";
  subagents[1] = { ...subagents[1]!, description: longName };
  await using screen = await render(view(subagents));
  await userEvent.hover(screen.getByText(/Running Quick CI/));
  const details = page.getByRole("dialog", { name: "Current work" });
  await expect.element(details.getByText(longName, { exact: true })).toBeVisible();
  await userEvent.click(details.getByRole("button", { name: "Open thread" }).last());
});

it("keeps interrupted and paused Action details alongside a watch, then removes ended continuation work", async () => {
  const { view, action, watch } = setup();
  await using screen = await render(
    view([watch], { ...action, outcome: "process_lost", delivery: "available" }),
  );
  await expect.element(screen.getByText(/Quick CI · Interrupted/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Show work details" }));
  const details = page.getByRole("dialog", { name: "Current work" });
  await expect.element(details.getByRole("button", { name: "Resume agent" })).toBeVisible();
  await expect.element(details.getByRole("button", { name: "Discard" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await screen.rerender(
    view([watch], { ...action, outcome: "succeeded", delivery: "pending", exitCode: 0 }, true),
  );
  await userEvent.click(screen.getByRole("button", { name: "Show work details" }));
  await expect.element(details.getByText(/Resume the environment/)).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await screen.rerender(
    view([watch], { ...action, outcome: "succeeded", delivery: "delivered", exitCode: 0 }, false, {
      status: "completed",
      queueHeld: false,
    }),
  );
  await expect
    .element(screen.getByText("Watching pull request #526", { exact: true }))
    .toBeVisible();
  expect(screen.container.textContent).not.toContain("Quick CI");
  await screen.rerender(view([], null));
  expect(screen.container.querySelector("[data-lastcode-current-work]")).toBeNull();
});
