import { EnvironmentId, MessageId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { formatActionResumeFollowUp } from "@t3tools/shared/actionResume";
import { act, createRef, useState, type ComponentProps, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { MessagesTimeline } from "./MessagesTimeline";
const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const CREATED_AT = "2026-03-17T19:12:28.000Z";

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type Entry = TimelineProps["timelineEntries"][number];

// The timeline remembers scroll position and open disclosures per thread key,
// so every render gets a fresh thread.
let threadCount = 0;

function baseProps(): Omit<TimelineProps, "timelineEntries"> {
  threadCount += 1;
  return {
    isWorking: false,
    activeTurnInProgress: false,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    routeThreadKey: `environment-local:thread-${threadCount}`,
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    onRollbackCheckpoint: () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light",
    timestampFormat: "locale",
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
    onManualNavigation: () => {},
  };
}

function message(
  text: string,
  overrides: Partial<Extract<Entry, { kind: "message" }>["message"]> = {},
  id = "message-1",
): Entry {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt: CREATED_AT,
    message: {
      id: MessageId.make(id),
      role: "user",
      text,
      runId: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      streaming: false,
      ...overrides,
    },
  };
}

const roots: Root[] = [];
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function renderElement(element: ReactElement) {
  container = document.body.appendChild(document.createElement("div"));
  container.style.cssText = "height: 1200px; width: 900px; display: flex; flex-direction: column;";
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return container;
}

describe("Action result timeline integration", () => {
  const tall = (index: number) =>
    message(
      `Message ${index}\n\n${"Long paragraph. ".repeat(80)}`,
      { role: "assistant" },
      `message-${index}`,
    );
  const tallEntries = Array.from({ length: 12 }, (_, index) => tall(index));

  async function waitForList(props: ReturnType<typeof baseProps>) {
    await vi.waitFor(() => {
      const viewport = props.listRef.current?.getScrollableNode();
      expect(viewport?.scrollHeight ?? 0).toBeGreaterThan(viewport?.clientHeight ?? 0);
    });
    return props.listRef.current!.getScrollableNode()!;
  }

  it("keeps Action disclosure on the same row and reading position without treating an ordinary prompt as an Action", async () => {
    const props = baseProps();
    const result = formatActionResumeFollowUp({
      actionName: "Inspect project",
      actionId: "inspect-project",
      runId: "action-run",
      validatedStatus: "succeeded",
      lifecycleOutcome: "succeeded",
      exitCode: 0,
      report: {
        version: 1,
        outcome: "success",
        summary: "Inspection complete",
        facts: { Detail: "A long result. ".repeat(30).trim() },
      },
      output: undefined,
    });
    const entries = [
      ...tallEntries,
      message(result, { createdBy: "system" }, "action-result"),
      message(result, { createdBy: "user" }, "ordinary-prompt"),
      tall(14),
      tall(15),
    ];
    function Chat() {
      const [liveFollowEnabled, setLiveFollowEnabled] = useState(true);
      return (
        <div className="contents" onWheelCapture={() => setLiveFollowEnabled(false)}>
          <MessagesTimeline
            {...props}
            timelineEntries={entries}
            liveFollowEnabled={liveFollowEnabled}
          />
        </div>
      );
    }
    await renderElement(<Chat />);
    const viewport = await waitForList(props);
    await userEvent.wheel(viewport, { delta: { y: -600 } });
    const selector = '[data-message-id="action-result"]';
    await vi.waitFor(() => expect(container.querySelector(selector)).not.toBeNull());
    await act(async () =>
      container.querySelector<HTMLElement>(selector)!.scrollIntoView({ block: "center" }),
    );
    await vi.waitFor(() =>
      expect(container.querySelector(selector + " button[aria-expanded]")).not.toBeNull(),
    );
    const row = container.querySelector<HTMLElement>(selector)!;
    const before = row.getBoundingClientRect().top;
    const rowId = row.dataset.timelineRowId;
    const toggle = row.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    await act(async () => toggle.click());
    await vi.waitFor(() => expect(row.querySelector("dl")).not.toBeNull());
    expect(container.querySelector(selector)).toBe(row);
    expect(row.dataset.timelineRowId).toBe(rowId);
    expect(Math.abs(row.getBoundingClientRect().top - before)).toBeLessThan(3);
    expect(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight).toBeGreaterThan(100);
    const prompt = container.querySelector('[data-message-id="ordinary-prompt"]')!;
    expect(prompt.textContent).toContain("Automated Project Action follow-up.");
    expect(prompt.querySelector("dl")).toBeNull();
    expect(prompt.textContent).not.toContain("Succeeded: Inspect project");
    await act(async () => toggle.click());
    await vi.waitFor(() => expect(row.querySelector("dl")).toBeNull());
    expect(Math.abs(row.getBoundingClientRect().top - before)).toBeLessThan(3);
  });
});
