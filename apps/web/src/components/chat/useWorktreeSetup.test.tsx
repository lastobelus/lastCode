// @vitest-environment happy-dom
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ThreadId,
  type ScopedThreadRef,
  type WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ snapshot: null as WorktreeSetupSnapshot | null }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: state.snapshot }) }));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { retryWorkspacePreparation: "retry" },
}));
vi.mock("../../state/vcs", () => ({
  vcsEnvironment: { cancelWorktreeSetup: "cancel", worktreeSetup: () => null },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../terminalUiStateStore", () => ({
  useTerminalUiStateStore: (select: (store: { ensureTerminal: () => void }) => unknown) =>
    select({ ensureTerminal: vi.fn() }),
}));

import { useWorktreeSetup } from "./useWorktreeSetup";

const route = scopeThreadRef(EnvironmentId.make("environment-one"), ThreadId.make("thread-one"));
let root: Root;
let host: HTMLDivElement;
let observed: ReturnType<typeof useWorktreeSetup>;

// ChatView constructs this ref with scopeThreadRef on every render. Preserve
// that allocation here rather than giving the hook a stable test-only object.
function Probe({ environmentId, threadId, draft = false }: ScopedThreadRef & { draft?: boolean }) {
  const routeThreadRef = scopeThreadRef(environmentId, threadId);
  const setup = useWorktreeSetup({
    routeThreadRef,
    ownerKey: `${environmentId}:${threadId}`,
    activeThread: { id: threadId, worktreePath: draft ? null : "/worktree" },
    threadRef: routeThreadRef,
    serverProjection: null,
    activityRun: null,
    localPreparing: false,
    sendQueuesBehindSetup: false,
    followUpSent: false,
  });
  useLayoutEffect(() => {
    observed = setup;
  });
  return setup.worktreeSetup?.sequence ?? "none";
}

function snapshot(sequence: number): WorktreeSetupSnapshot {
  return {
    threadId: route.threadId,
    phase: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    branch: null,
    baseRef: null,
    worktreePath: "/worktree",
    setupScript: null,
    stages: [],
    error: null,
    sequence,
  };
}

async function render(ref = route, draft = false) {
  await act(() => {
    root.render(<Probe {...ref} draft={draft} />);
  });
}

beforeEach(() => {
  state.snapshot = null;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("worktree setup route identity", () => {
  it("rerenders an empty route with equivalent recreated scoped references", async () => {
    await render(route, true);
    await render(route, true);
    expect(host.textContent).toBe("none");
    expect(observed.isPreparingWorktree).toBe(false);
    expect(observed.blocksSend).toBe(false);
  });

  it("keeps the newest snapshot across equivalent refs, older updates and the null bridge", async () => {
    state.snapshot = snapshot(2);
    await render();
    expect(host.textContent).toBe("2");
    expect(observed.blocksSend).toBe(true);
    state.snapshot = snapshot(4);
    await render();
    expect(host.textContent).toBe("4");
    state.snapshot = snapshot(1);
    await render();
    expect(host.textContent).toBe("4");
    state.snapshot = null;
    await render();
    await render();
    expect(host.textContent).toBe("4");
    expect(observed.isPreparingWorktree).toBe(true);
  });

  it.each([
    scopeThreadRef(EnvironmentId.make("environment-two"), route.threadId),
    scopeThreadRef(route.environmentId, ThreadId.make("thread-two")),
  ])("clears the held snapshot when the scoped route changes to %j", async (next) => {
    state.snapshot = snapshot(3);
    await render();
    state.snapshot = null;
    await render();
    expect(host.textContent).toBe("3");
    await render(next);
    expect(host.textContent).toBe("none");
    expect(observed.blocksSend).toBe(false);
    await render(route);
    expect(host.textContent).toBe("none");
  });

  it.each([
    scopeThreadRef(EnvironmentId.make("environment-two"), route.threadId),
    scopeThreadRef(route.environmentId, ThreadId.make("thread-two")),
  ])("retains a cached destination snapshot across null and older updates at %j", async (next) => {
    state.snapshot = snapshot(3);
    await render();
    state.snapshot = { ...snapshot(4), threadId: next.threadId };
    await render(next);
    expect(host.textContent).toBe("4");
    state.snapshot = null;
    await render(next);
    expect(host.textContent).toBe("4");
    state.snapshot = { ...snapshot(1), threadId: next.threadId };
    await render(next);
    expect(host.textContent).toBe("4");
    expect(observed.blocksSend).toBe(true);
  });
});
