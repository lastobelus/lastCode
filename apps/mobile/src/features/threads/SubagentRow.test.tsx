import {
  EnvironmentId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type ActionResumeState,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import type { ThreadFeedActivity } from "../../lib/threadActivity";

const state = vi.hoisted(() => ({
  shells: new Map<string, unknown>(),
  liveAgents: [] as ReadonlyArray<OrchestrationV2Subagent>,
  environments: new Map<string, unknown>(),
  dispatch: vi.fn(),
}));

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({
    children,
    disabled,
    onPress,
    accessibilityRole,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onPress?: () => void;
    accessibilityRole?: "button" | "link";
  }) => (
    <button type="button" role={accessibilityRole} disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string, select?: (value: unknown) => unknown) => {
    const value =
      atom === "config" ? { providers: [] } : { projection: { subagents: state.liveAgents } };
    return select ? select(value) : value;
  },
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ dispatch: state.dispatch }),
  StackActions: { push: (name: string, params: unknown) => ({ type: "PUSH", name, params }) },
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { configValueAtom: () => "config" } }));
vi.mock("../../state/threads", () => ({
  environmentThreadDetails: { threadAtom: () => "thread" },
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ presentationById: state.environments }),
}));
vi.mock("./use-visible-second-clock", () => ({ useVisibleSecondClock: () => 0 }));
vi.mock("./thread-inspector-navigation", () => ({ useOpenThreadInspector: () => () => false }));
vi.mock("./work-log-layout", () => ({
  WorkLogBlock: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ProviderIcon", () => ({
  ProviderIcon: () => null,
  ProviderInstanceIcon: () => null,
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: (ref: { environmentId: string; threadId: string } | null) =>
    ref === null ? null : (state.shells.get(`${ref.environmentId}/${ref.threadId}`) ?? null),
  useProject: () => null,
  useEnvironmentServerConfig: () => ({ providers: [] }),
  useServerConfigs: () => new Map(),
}));
vi.mock("./action-resume-state", () => ({
  useActionEnvironmentPause: (environmentId: string) => ({
    paused: environmentId === "remote-environment",
  }),
}));

import { SubagentRow } from "./SubagentRow";
import { ThreadSubagentGroup } from "./thread-subagent-group";

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
            driver: ProviderDriverKind.make("codex"),
            model: null,
            title: "Review changes",
            prompt: "Review changes",
            status: "waiting",
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

it.each([true, false])(
  "opens a completed timeline task's live remote destination only when connected: %s",
  (connected) => {
    state.shells.clear();
    state.environments.clear();
    state.dispatch.mockClear();
    const parentEnvironment = EnvironmentId.make("parent-environment");
    const remoteEnvironment = EnvironmentId.make("remote-environment");
    const parentId = ThreadId.make("parent");
    const childId = ThreadId.make("remote-child");
    const item: Extract<OrchestrationV2TurnItem, { type: "subagent" }> = {
      id: TurnItemId.make("task-item"),
      threadId: parentId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      type: "subagent",
      subagentId: NodeId.make("task"),
      origin: "app_owned",
      driver: ProviderDriverKind.make("remote"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      childThreadId: null,
      title: "Completed remote check",
      prompt: "Check the change",
      status: "completed",
      result: "Check passed",
      startedAt: null,
      completedAt: null,
      updatedAt: DateTime.makeUnsafe("2026-06-20T00:00:00Z"),
    };
    state.liveAgents = [
      {
        ...item,
        id: item.subagentId,
        parentNodeId: NodeId.make("parent-node"),
        createdBy: "agent",
        nativeTaskRef: null,
        model: null,
        remoteChild: {
          environmentId: remoteEnvironment,
          threadId: childId,
          label: "Remote environment",
        },
      },
    ];
    if (connected) state.environments.set(remoteEnvironment, {});
    const activity = {
      projectedItem: { item },
    } as ThreadFeedActivity;
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
        <ThreadSubagentGroup
          activities={[activity]}
          environmentId={parentEnvironment}
          anchorKey="task"
          expandedRows={{}}
          iconSubtleColor="#888"
          onToggleRow={() => {}}
        />,
      ),
    );
    const card = container.querySelector("button");
    expect(card).not.toBeNull();
    expect(card!.disabled).toBe(!connected);
    act(() => card!.click());
    if (connected) {
      expect(state.dispatch).toHaveBeenCalledExactlyOnceWith({
        type: "PUSH",
        name: "Thread",
        params: { environmentId: remoteEnvironment, threadId: childId },
      });
    } else {
      expect(state.dispatch).not.toHaveBeenCalled();
    }
  },
);
