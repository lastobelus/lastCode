import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ActionResumeState,
  type EnvironmentPauseStatus,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { ActionResumeContext } from "@t3tools/client-runtime/state/action-resume";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

const mocks = vi.hoisted(() => ({
  environment: {
    environmentId: "environment",
    label: "QA environment",
    connection: { phase: "connected" },
    serverConfig: {
      environment: { capabilities: { environmentPause: true } },
      settings: { environmentPauseEnabled: true },
    },
  },
  query: null as unknown,
  context: null as unknown,
  requested: vi.fn(),
}));
vi.mock("./environments", () => ({
  useEnvironment: (id: string | null) => (id === null ? null : mocks.environment),
}));
vi.mock("./environmentPause", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentPauseConnectionsAtom: Atom.make([
      { environmentId: "environment", connected: true, since: 0 },
    ]),
    environmentPause: { monitorStatus: () => mocks.query },
  };
});
vi.mock("./threads", () => ({
  environmentThreadDetails: {
    actionResumeContextAtom: (ref: ScopedThreadRef) => {
      mocks.requested(ref);
      if (ref === null) throw new Error("Draft detail subscribed before its thread exists");
      return mocks.context;
    },
  },
}));
vi.mock("./use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));

import { useActionResumeWait } from "./actionResume";
import { EnvironmentPauseNotice } from "../components/EnvironmentPauseControl";

const ref = { environmentId: EnvironmentId.make("environment"), threadId: ThreadId.make("thread") };
const action: ActionResumeState = {
  runId: "check",
  actionId: "check",
  actionName: "Check project",
  threadId: ref.threadId,
  projectId: ProjectId.make("project"),
  terminalId: "terminal",
  outcome: "succeeded",
  delivery: "pending",
  startedAt: "2026-06-20T00:00:00.000Z",
  finishedAt: "2026-06-20T00:00:01.000Z",
  exitCode: 0,
  exitSignal: null,
};
const unpaused: EnvironmentPauseStatus = {
  observation: "known",
  session: null,
  activeThreadCount: 0,
  blockers: [],
  quiet: true,
};
function setup() {
  mocks.requested.mockReset();
  mocks.environment = {
    ...mocks.environment,
    serverConfig: {
      ...mocks.environment.serverConfig,
      environment: { capabilities: { environmentPause: true } },
    },
  };
  const registry = AtomRegistry.make();
  const query = Atom.make<AsyncResult.AsyncResult<EnvironmentPauseStatus, Error>>(
    AsyncResult.success(unpaused, { timestamp: 1 }),
  );
  const context = Atom.make<ActionResumeContext | null>({
    action,
    followUp: null,
    hasPendingRequest: false,
  });
  mocks.query = query;
  mocks.context = context;
  return { registry, query, context };
}
function Probe({
  detailRef,
  currentAction,
}: {
  detailRef: ScopedThreadRef | null;
  currentAction: ActionResumeState | null;
}) {
  const wait = useActionResumeWait(detailRef, currentAction);
  return <output>{wait.presentation?.label ?? "No Action wait"}</output>;
}

it("does not load a draft's reserved ID and subscribes after it becomes a server thread", async () => {
  const h = setup();
  using _registry = { [Symbol.dispose]: () => h.registry.dispose() };
  const view = (detailRef: ScopedThreadRef | null, currentAction: ActionResumeState | null) => (
    <RegistryContext.Provider value={h.registry}>
      <Probe detailRef={detailRef} currentAction={currentAction} />
    </RegistryContext.Provider>
  );
  await using screen = await render(view(null, null));
  expect(mocks.requested).not.toHaveBeenCalled();
  await screen.rerender(view(ref, action));
  await expect.element(screen.getByText("Sending result")).toBeVisible();
  expect(mocks.requested).toHaveBeenCalledWith(ref);
  await act(() =>
    h.registry.set(h.context, {
      action,
      followUp: { status: "completed", queueHeld: false },
      hasPendingRequest: false,
    }),
  );
  await expect.element(screen.getByText("No Action wait")).toBeVisible();
});

it("shows an unknown pause without an Action or retained session, then hides known unpaused and unsupported states", async () => {
  const h = setup();
  using _registry = { [Symbol.dispose]: () => h.registry.dispose() };
  h.registry.set(h.query, AsyncResult.failure(Cause.fail(new Error("Unavailable"))));
  const view = () => (
    <RegistryContext.Provider value={h.registry}>
      <EnvironmentPauseNotice environmentId={ref.environmentId} />
    </RegistryContext.Provider>
  );
  await using screen = await render(view());
  await expect.element(screen.getByText("QA environment · Status unknown")).toBeVisible();
  await act(() =>
    h.registry.set(
      h.query,
      AsyncResult.success({ ...unpaused, observation: "unknown" }, { timestamp: 2 }),
    ),
  );
  await expect.element(screen.getByText("QA environment · Status unknown")).toBeVisible();
  await act(() => h.registry.set(h.query, AsyncResult.success(unpaused, { timestamp: 3 })));
  await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
  mocks.environment = {
    ...mocks.environment,
    serverConfig: {
      ...mocks.environment.serverConfig,
      environment: { capabilities: { environmentPause: false } },
    },
  };
  await screen.rerender(view());
  await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
});
