import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { actionResumeWait } from "@t3tools/client-runtime/state/action-resume";
import { EnvironmentId, ProjectId, ThreadId, type ActionResumeState } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => false }));
vi.mock("../../state/terminal", () => ({
  terminalEnvironment: { close: { permissionAtom: () => false } },
}));
vi.mock("../../state/threads", () => ({
  threadEnvironment: {
    resumeAction: { permissionAtom: () => false },
    discardAction: { permissionAtom: () => false },
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./EnvironmentPauseControl", () => ({
  useEnvironmentPauseControl: () => ({ visible: false, modal: null }),
}));
vi.mock("./action-resume-state", () => ({
  useActionEnvironmentPause: () => ({ paused: true, phase: "paused", showUnknown: false }),
  useActionResumeWait: (_ref: unknown, action: ActionResumeState) =>
    actionResumeWait({ action, followUp: null, hasPendingRequest: false }, action, true),
}));

import { ActionResumeNotice } from "./ActionResumeNotice";

it.each([
  ["succeeded", "success", "Succeeded"],
  ["failed", "success", "Failed"],
  ["succeeded", "blocked", "Blocked"],
] as const)(
  "shows %s/%s result meaning and summary alongside the pause reason",
  (outcome, reportOutcome, label) => {
    const reactGlobal = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previous = reactGlobal.IS_REACT_ACT_ENVIRONMENT;
    using _actEnvironment = {
      [Symbol.dispose]: () => {
        reactGlobal.IS_REACT_ACT_ENVIRONMENT = previous;
      },
    };
    reactGlobal.IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    const root = createRoot(container);
    using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
    const action: ActionResumeState = {
      runId: "check",
      actionId: "check",
      actionName: "Check project",
      threadId: ThreadId.make("thread"),
      projectId: ProjectId.make("project"),
      terminalId: "terminal",
      outcome,
      delivery: "pending",
      startedAt: "2026-06-20T00:00:00.000Z",
      finishedAt: "2026-06-20T00:00:01.000Z",
      exitCode: outcome === "failed" ? 1 : 0,
      exitSignal: null,
      report: { version: 1, outcome: reportOutcome, summary: "Project validation report" },
    };
    const thread = {
      id: action.threadId,
      actionResume: action,
    } as unknown as EnvironmentThreadShell;
    act(() =>
      root.render(
        <ActionResumeNotice environmentId={EnvironmentId.make("environment")} thread={thread} />,
      ),
    );
    expect(container.textContent).toContain(label);
    expect(container.textContent).toContain("Project validation report");
    expect(container.textContent).toContain("Environment paused");
    expect(container.textContent).toContain("Resume the environment");
  },
);
