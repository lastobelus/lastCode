import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ActionResumeState,
} from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ shells: new Map<string, unknown>() }));

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../../state/entities", () => ({
  useThreadShell: (ref: { environmentId: string; threadId: string } | null) =>
    ref === null ? null : (state.shells.get(`${ref.environmentId}/${ref.threadId}`) ?? null),
  useProject: () => null,
  useEnvironmentServerConfig: () => ({ providers: [] }),
}));
vi.mock("./action-resume-state", () => ({
  useActionEnvironmentPause: (environmentId: string) => ({
    paused: environmentId === "remote-environment",
  }),
}));

import { SubagentRow } from "./SubagentRow";

it.each([
  [true, false, true],
  [false, false, false],
  [true, true, false],
] as const)(
  "shows the owning remote Action with navigation available %s and inherited Action %s",
  (canOpenRemote, inherited, visible) => {
    state.shells.clear();
    const parentEnvironment = EnvironmentId.make("parent-environment");
    const remoteEnvironment = EnvironmentId.make("remote-environment");
    const childId = ThreadId.make("child");
    const parentId = ThreadId.make("parent");
    const projectId = ProjectId.make("project");
    const action: ActionResumeState = {
      runId: "remote-action",
      actionId: "check",
      actionName: "Remote validation",
      threadId: inherited ? parentId : childId,
      projectId,
      terminalId: "terminal",
      outcome: "succeeded",
      delivery: "pending",
      startedAt: "2026-06-20T00:00:00.000Z",
      finishedAt: "2026-06-20T00:00:01.000Z",
      exitCode: 0,
      exitSignal: null,
    };
    state.shells.set(`${remoteEnvironment}/${childId}`, {
      source: {
        id: childId,
        projectId,
        worktreePath: null,
        actionResume: action,
        pendingRuntimeRequest: null,
      },
    });
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
    act(() =>
      root.render(
        <SubagentRow
          environmentId={parentEnvironment}
          canOpenRemote={canOpenRemote}
          elapsed={null}
          subagent={{
            threadId: parentId,
            childThreadId: null,
            origin: "app_owned",
            remoteChild: {
              environmentId: remoteEnvironment,
              threadId: childId,
              label: "Remote environment",
            },
            providerInstanceId: ProviderInstanceId.make("codex"),
            driver: "codex",
            model: null,
            title: "Review changes",
            prompt: "Review changes",
            status: "waiting",
            progress: null,
            result: null,
          }}
        />,
      ),
    );
    if (visible) {
      expect(container.textContent).toContain("Remote validation · Environment paused");
    } else {
      expect(container.textContent).not.toContain("Remote validation");
    }
  },
);
