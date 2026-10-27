import {
  actionResumeWait,
  type ActionResumeContext,
} from "@t3tools/client-runtime/state/action-resume";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type EnvironmentPauseStatus,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, AtomRegistry, type Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  config: { environment: { capabilities: { environmentPause: true } } },
  connections: [] as { environmentId: EnvironmentId; connected: boolean; since: number }[],
  result: null as unknown,
  context: null as ActionResumeContext | null,
  monitor: vi.fn(),
  contextAtom: vi.fn(),
}));
vi.mock("react", () => ({ useMemo: (make: () => unknown) => make() }));
vi.mock("../../state/entities", () => ({ useEnvironmentServerConfig: () => mocks.config }));
vi.mock("../../state/environment-pause", () => ({
  environmentPauseConnectionsAtom: { kind: "connections" },
  environmentPause: { monitorStatus: mocks.monitor },
}));
vi.mock("../../state/threads", () => ({
  environmentThreadDetails: { actionResumeContextAtom: mocks.contextAtom },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: Atom.Atom<unknown> | { kind: string }) => {
    if ("kind" in atom) {
      return atom.kind === "connections"
        ? mocks.connections
        : atom.kind === "context"
          ? mocks.context
          : mocks.result;
    }
    const registry = AtomRegistry.make();
    try {
      return registry.get(atom);
    } finally {
      registry.dispose();
    }
  },
}));

import { useActionEnvironmentPause, useActionResumeWait } from "./action-resume-state";

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("thread");
const pausedStatus: EnvironmentPauseStatus = {
  observation: "known",
  session: { id: "pause", createdAt: "2026-06-20T00:00:00.000Z", phase: "paused", targets: [] },
  activeThreadCount: 0,
  blockers: [],
  quiet: true,
};
function setup() {
  mocks.config = { environment: { capabilities: { environmentPause: true } } };
  mocks.connections = [{ environmentId, connected: true, since: 100 }];
  mocks.result = AsyncResult.success(pausedStatus, { timestamp: 101 });
  mocks.monitor.mockReset().mockReturnValue({ kind: "monitor" });
  mocks.contextAtom.mockReset().mockReturnValue({ kind: "context" });
  mocks.context = {
    action: {
      runId: "action",
      threadId,
      projectId: ProjectId.make("project"),
      actionId: "build",
      terminalId: "terminal",
      startedAt: "2026-06-20T00:00:00.000Z",
      finishedAt: "2026-06-20T00:00:01.000Z",
      exitCode: 0,
      exitSignal: null,
      actionName: "Build",
      outcome: "succeeded",
      delivery: "pending",
    },
    followUp: null,
    hasPendingRequest: false,
  };
  return {
    read(targetEnvironmentId = environmentId) {
      const pause = useActionEnvironmentPause(targetEnvironmentId);
      const wait = useActionResumeWait(
        { environmentId: targetEnvironmentId, threadId },
        mocks.context!.action,
        pause.paused,
      );
      return { pause, wait };
    },
  };
}

it("does not subscribe to a local draft and starts after its guarded detail reference exists", () => {
  setup();
  const ref = { environmentId, threadId };
  expect(useActionResumeWait(null, null, false).presentation).toBeNull();
  expect(mocks.contextAtom).not.toHaveBeenCalled();
  expect(useActionResumeWait(ref, null, false).presentation).toBeNull();
  expect(mocks.contextAtom).not.toHaveBeenCalled();
  mocks.context = { ...mocks.context!, followUp: { status: "running", queueHeld: false } };
  expect(useActionResumeWait(ref, mocks.context.action, false).status?.state).toBe(
    "follow_up_active",
  );
  expect(mocks.contextAtom).toHaveBeenCalledExactlyOnceWith(ref);
});

it("rejects retained pause observations from before reconnect and failed observations", () => {
  const screen = setup();
  expect(screen.read().pause.paused).toBe(true);
  mocks.connections = [{ environmentId, connected: true, since: 102 }];
  expect(screen.read().pause.paused).toBeNull();
  expect(screen.read().wait.status).toBeNull();
  mocks.result = AsyncResult.failure(Cause.fail(new Error("Offline")));
  expect(screen.read().pause.paused).toBeNull();
  mocks.result = AsyncResult.success(
    { ...pausedStatus, observation: "unknown" },
    { timestamp: 103 },
  );
  expect(screen.read().pause.paused).toBeNull();
});

it("separates resuming from a delivery hold and preserves pending input", () => {
  const screen = setup();
  mocks.result = AsyncResult.success(
    { ...pausedStatus, session: { ...pausedStatus.session!, phase: "resuming" } },
    { timestamp: 101 },
  );
  mocks.context = { ...mocks.context!, hasPendingRequest: true };
  const value = screen.read();
  expect(value.pause.paused).toBe(false);
  expect(value.pause.phase).toBe("resuming");
  expect(value.wait.status?.state).toBe("waiting_for_input");
});

it("treats unsupported connected environments as unpaused and disconnected ones as unknown", () => {
  const screen = setup();
  mocks.config.environment.capabilities.environmentPause = false;
  expect(screen.read().pause.paused).toBe(false);
  expect(mocks.monitor).not.toHaveBeenCalled();
  mocks.connections = [{ environmentId, connected: false, since: 100 }];
  expect(screen.read().pause.paused).toBeNull();
});

it("hides an ended exact continuation even when pause observation becomes unknown", () => {
  const screen = setup();
  mocks.context = { ...mocks.context!, followUp: { status: "completed", queueHeld: false } };
  mocks.result = AsyncResult.initial();
  expect(screen.read().wait.presentation).toBeNull();
});

it("never attaches a different Action's continuation or requests", () => {
  setup();
  const action = mocks.context!.action;
  const other = {
    ...mocks.context!,
    action: { ...action, runId: "other" },
    followUp: { status: "completed" as const, queueHeld: false },
    hasPendingRequest: true,
  };
  const value = actionResumeWait(other, action, false);
  expect(value.status?.state).toBe("pending_delivery");
  expect(value.presentation?.automaticResumeArmed).toBe(true);
});

it("keeps held queued work as attention and hides disposed results", () => {
  setup();
  const context = { ...mocks.context!, followUp: { status: "queued" as const, queueHeld: true } };
  expect(actionResumeWait(context, context.action, false).status?.state).toBe("attention_required");
  expect(
    actionResumeWait(context, { ...context.action, delivery: "disposed" }, null).presentation,
  ).toBeNull();
});

it("reads only the destination environment and the scoped thread context", () => {
  const screen = setup();
  const otherEnvironmentId = EnvironmentId.make("other-environment");
  const value = screen.read(otherEnvironmentId);
  expect(value.pause.paused).toBeNull();
  expect(value.wait.presentation?.automaticResumeArmed).toBe(false);
  expect(mocks.monitor).toHaveBeenCalledWith({ environmentId: otherEnvironmentId, input: {} });
  expect(mocks.contextAtom).toHaveBeenCalledWith({ environmentId: otherEnvironmentId, threadId });
});
