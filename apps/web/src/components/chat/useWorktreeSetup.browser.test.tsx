import { render } from "../../../test/render";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ThreadId,
  type ScopedThreadRef,
  type WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import { useLayoutEffect } from "react";

import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ snapshot: null as WorktreeSetupSnapshot | null }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: state.snapshot }) }));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { retryWorkspacePreparation: "retry" },
  environmentThreadDetails: {},
  environmentThreadShells: {},
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

// ChatView constructs this ref with scopeThreadRef on every render. Preserve
// that allocation here rather than giving the hook a stable test-only object.
function Probe({
  environmentId,
  threadId,
  draft = false,
  onValue,
}: ScopedThreadRef & {
  draft?: boolean;
  onValue: (value: ReturnType<typeof useWorktreeSetup>) => void;
}) {
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
    onValue(setup);
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

function setup() {
  state.snapshot = null;
  let observed!: ReturnType<typeof useWorktreeSetup>;
  const observe = (value: typeof observed) => {
    observed = value;
  };
  return {
    get observed() {
      return observed;
    },
    view: (ref = route, draft = false) => <Probe {...ref} draft={draft} onValue={observe} />,
  };
}

describe("worktree setup route identity", () => {
  it("rerenders an empty route with equivalent recreated scoped references", async () => {
    const fixture = setup();
    await using screen = await render(fixture.view(route, true));
    const container = screen.container;
    await screen.rerender(fixture.view(route, true));
    expect(container.textContent).toBe("none");
    expect(fixture.observed.isPreparingWorktree).toBe(false);
    expect(fixture.observed.blocksSend).toBe(false);
  });

  it("keeps the newest snapshot across equivalent refs, older updates and the null bridge", async () => {
    const fixture = setup();
    state.snapshot = snapshot(2);
    await using screen = await render(fixture.view());
    const container = screen.container;
    expect(container.textContent).toBe("2");
    expect(fixture.observed.blocksSend).toBe(true);
    state.snapshot = snapshot(4);
    await screen.rerender(fixture.view());
    expect(container.textContent).toBe("4");
    state.snapshot = snapshot(1);
    await screen.rerender(fixture.view());
    expect(container.textContent).toBe("4");
    state.snapshot = null;
    await screen.rerender(fixture.view());
    await screen.rerender(fixture.view());
    expect(container.textContent).toBe("4");
    expect(fixture.observed.isPreparingWorktree).toBe(true);
  });

  it.each([
    scopeThreadRef(EnvironmentId.make("environment-two"), route.threadId),
    scopeThreadRef(route.environmentId, ThreadId.make("thread-two")),
  ])("clears the held snapshot when the scoped route changes to %j", async (next) => {
    const fixture = setup();
    state.snapshot = snapshot(3);
    await using screen = await render(fixture.view());
    const container = screen.container;
    state.snapshot = null;
    await screen.rerender(fixture.view());
    expect(container.textContent).toBe("3");
    await screen.rerender(fixture.view(next));
    expect(container.textContent).toBe("none");
    expect(fixture.observed.blocksSend).toBe(false);
    await screen.rerender(fixture.view(route));
    expect(container.textContent).toBe("none");
  });

  it.each([
    scopeThreadRef(EnvironmentId.make("environment-two"), route.threadId),
    scopeThreadRef(route.environmentId, ThreadId.make("thread-two")),
  ])("retains a cached destination snapshot across null and older updates at %j", async (next) => {
    const fixture = setup();
    state.snapshot = snapshot(3);
    await using screen = await render(fixture.view());
    const container = screen.container;
    state.snapshot = { ...snapshot(4), threadId: next.threadId };
    await screen.rerender(fixture.view(next));
    expect(container.textContent).toBe("4");
    state.snapshot = null;
    await screen.rerender(fixture.view(next));
    expect(container.textContent).toBe("4");
    state.snapshot = { ...snapshot(1), threadId: next.threadId };
    await screen.rerender(fixture.view(next));
    expect(container.textContent).toBe("4");
    expect(fixture.observed.blocksSend).toBe(true);
  });
});
