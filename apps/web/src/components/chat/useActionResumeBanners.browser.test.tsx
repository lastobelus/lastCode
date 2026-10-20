import {
  AuthOrchestrationOperateScope,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ActionResumeState,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  scopes: new Map<string, Set<string>>(),
  close: vi.fn<(value: unknown) => Promise<AtomCommandResult<void, Error>>>(),
  resume: vi.fn<(value: unknown) => Promise<AtomCommandResult<void, Error>>>(),
  discard: vi.fn<(value: unknown) => Promise<AtomCommandResult<void, Error>>>(),
  ensureTerminal: vi.fn(),
  focus: vi.fn(),
  error: vi.fn(),
}));
vi.mock(import("../../state/session"), () => ({
  readEnvironmentScope: (environmentId, scope) =>
    state.scopes.get(environmentId)?.has(scope) ?? false,
  useEnvironmentScope: (environmentId, scope) =>
    environmentId !== null && (state.scopes.get(environmentId)?.has(scope) ?? false),
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("../../state/terminal"), () => ({
  terminalEnvironment: { close: state.close } as never,
}));
vi.mock(import("../../state/threads"), () => ({
  threadEnvironment: { resumeAction: state.resume, discardAction: state.discard } as never,
}));
vi.mock(import("../../terminalUiStateStore"), () => ({
  useTerminalUiStateStore: ((select: (store: unknown) => unknown) =>
    select({ ensureTerminal: state.ensureTerminal })) as never,
}));

import { useActionResumeBanners } from "./useActionResumeBanners";
import { ComposerBannerStack } from "./ComposerBannerStack";

const a: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("thread-a"),
};
const b: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment-b"),
  threadId: ThreadId.make("thread-b"),
};
const running: ActionResumeState = {
  runId: "run-a",
  threadId: a.threadId,
  projectId: ProjectId.make("project-a"),
  actionId: "action-a",
  actionName: "Check work",
  command: "check-work",
  terminalId: "terminal-a",
  outcome: "running",
  delivery: "armed",
  startedAt: "2026-08-25T12:00:00.000Z",
  finishedAt: null,
  exitCode: null,
  exitSignal: null,
  progress: {
    version: 1,
    state: "waiting",
    summary: "Waiting for review",
    detail: "Checks in progress",
    updatedAt: "2026-08-25T12:00:00.000Z",
  },
};
const interrupted: ActionResumeState = {
  ...running,
  outcome: "process_lost",
  delivery: "available",
  finishedAt: "2026-08-25T12:01:00.000Z",
};
const success = () => AsyncResult.success(undefined);
const failure = (message = "Failed"): AtomCommandResult<void, Error> =>
  AsyncResult.failure(Cause.fail(new Error(message)));
function deferred() {
  let resolve!: (value: AtomCommandResult<void, Error>) => void;
  const promise = new Promise<AtomCommandResult<void, Error>>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let root: Root;
let container: HTMLDivElement;
let banners: ReturnType<typeof useActionResumeBanners>;
interface ProbeProps {
  route?: ScopedThreadRef;
  thread?: ScopedThreadRef | null;
  action?: ActionResumeState | null;
  mismatch?: boolean;
}
function Probe({ route = a, thread = route, action = running, mismatch = false }: ProbeProps) {
  const value = useActionResumeBanners({
    routeThreadRef: route,
    threadRef: thread,
    action,
    onRequestTerminalFocus: state.focus,
    // Each render captures the route just as ChatView's error setter does.
    onThreadError: (threadId, message) => state.error(route, threadId, message),
  });
  useLayoutEffect(() => {
    banners = value;
  });
  const items = [value.interruptedBanner, value.runningBanner].filter((item) => item !== null);
  return (
    <ComposerBannerStack
      items={
        mismatch
          ? [
              ...items,
              {
                id: "branch-mismatch:test",
                variant: "info",
                icon: null,
                title: "Branch changed",
              },
            ]
          : items
      }
    />
  );
}
async function render(props: ProbeProps = {}) {
  await act(async () => root.render(<Probe {...props} />));
}
function button(label: string) {
  const result = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === label || node.getAttribute("aria-label") === label,
  );
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function settle(
  pending: ReturnType<typeof deferred>,
  result: AtomCommandResult<void, Error>,
) {
  await act(async () => {
    pending.resolve(result);
    await pending.promise;
  });
}
function grant(ref: ScopedThreadRef, scopes: string[]) {
  state.scopes.set(ref.environmentId, new Set(scopes));
}
const allScopes = [AuthTerminalReadScope, AuthTerminalOperateScope, AuthOrchestrationOperateScope];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.scopes.clear();
  grant(a, allScopes);
  grant(b, allScopes);
  for (const command of [state.close, state.resume, state.discard])
    command.mockReset().mockResolvedValue(success());
  for (const spy of [state.focus, state.error, state.ensureTerminal]) spy.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("running Action controls", () => {
  it("opens only the existing Action terminal with read-only access", async () => {
    grant(a, [AuthTerminalReadScope]);
    await render();
    await click("Open terminal");
    expect(state.ensureTerminal).toHaveBeenCalledExactlyOnceWith(a, running.terminalId, {
      open: true,
      active: true,
    });
    expect(state.focus).toHaveBeenCalledOnce();
    expect(state.close).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Cancel");
  });
  it("rechecks read access when the rendered control is retained", async () => {
    await render();
    state.scopes.get(a.environmentId)!.delete(AuthTerminalReadScope);
    await click("Open Action terminal");
    expect(state.ensureTerminal).not.toHaveBeenCalled();
    expect(state.focus).not.toHaveBeenCalled();
    grant(a, []);
    await render();
    expect(container.querySelector("button")).toBeNull();
  });
  it("rechecks destination cancellation access and preserves terminal history", async () => {
    await render();
    state.scopes.get(a.environmentId)!.delete(AuthTerminalOperateScope);
    await click("Cancel");
    expect(state.close).not.toHaveBeenCalled();
    state.scopes.get(a.environmentId)!.add(AuthTerminalOperateScope);
    await click("Cancel");
    expect(state.close).toHaveBeenCalledExactlyOnceWith({
      environmentId: a.environmentId,
      input: {
        threadId: a.threadId,
        terminalId: running.terminalId,
      },
    });
    expect(state.error).not.toHaveBeenCalled();
  });
  it.each(["success", "failure"])(
    "late A cancellation %s cannot clear B, and errors retain A's route",
    async (outcome) => {
      const first = deferred();
      const second = deferred();
      state.close.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      await render();
      await click("Cancel");
      expect(button("Cancelling...").disabled).toBe(true);
      await render({ route: b, action: { ...running, runId: "run-b", terminalId: "terminal-b" } });
      await click("Cancel");
      await settle(first, outcome === "success" ? success() : failure("A failed"));
      expect(button("Cancelling...").disabled).toBe(true);
      if (outcome === "failure")
        expect(state.error).toHaveBeenCalledExactlyOnceWith(a, a.threadId, "A failed");
      await settle(second, success());
      expect(button("Cancel").disabled).toBe(false);
    },
  );
  it("keeps interrupted cancellation silent", async () => {
    state.close.mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt(1)));
    await render();
    await click("Cancel");
    expect(state.error).not.toHaveBeenCalled();
    expect(button("Cancel").disabled).toBe(false);
  });
  it("does nothing with a null destination", async () => {
    await render({ thread: null });
    expect(container.querySelector("button")).toBeNull();
    expect(state.ensureTerminal).not.toHaveBeenCalled();
    expect(state.close).not.toHaveBeenCalled();
  });
});

describe("interrupted Action delivery", () => {
  it.each(["resume", "discard"] as const)(
    "%s disables both controls and latches success until projection changes",
    async (operation) => {
      const pending = deferred();
      state[operation].mockReturnValueOnce(pending.promise);
      await render({ action: interrupted });
      await click(operation === "resume" ? "Resume agent" : "Discard");
      expect([...container.querySelectorAll("button")].every((node) => node.disabled)).toBe(true);
      expect(state[operation]).toHaveBeenCalledExactlyOnceWith({
        environmentId: a.environmentId,
        input: { threadId: a.threadId },
      });
      expect(state[operation === "resume" ? "discard" : "resume"]).not.toHaveBeenCalled();
      await settle(pending, success());
      expect([...container.querySelectorAll("button")].every((node) => node.disabled)).toBe(true);
      await render({ action: { ...interrupted, delivery: "delivered" } });
      expect(container.querySelector("button")).toBeNull();
      expect(state.close).not.toHaveBeenCalled();
      expect(state.ensureTerminal).not.toHaveBeenCalled();
    },
  );
  it.each(["resume", "discard"] as const)(
    "%s failure enables retry and reports the captured route",
    async (operation) => {
      state[operation].mockResolvedValueOnce(failure("Delivery failed"));
      await render({ action: interrupted });
      await click(operation === "resume" ? "Resume agent" : "Discard");
      expect(button("Resume agent").disabled).toBe(false);
      expect(button("Discard").disabled).toBe(false);
      expect(state.error).toHaveBeenCalledExactlyOnceWith(a, a.threadId, "Delivery failed");
    },
  );
  it.each(["resume", "discard"] as const)(
    "%s interruption clears pending without an error",
    async (operation) => {
      state[operation].mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt(1)));
      await render({ action: interrupted });
      await click(operation === "resume" ? "Resume agent" : "Discard");
      expect(button("Resume agent").disabled).toBe(false);
      expect(state.error).not.toHaveBeenCalled();
    },
  );
  it.each(["resume", "discard"] as const)(
    "%s retained controls obey permission revocation",
    async (operation) => {
      await render({ action: interrupted });
      state.scopes.get(a.environmentId)!.delete(AuthOrchestrationOperateScope);
      await click(operation === "resume" ? "Resume agent" : "Discard");
      expect(state[operation]).not.toHaveBeenCalled();
      await render({ action: interrupted });
      expect(button("Resume agent").disabled).toBe(true);
      expect(button("Discard").disabled).toBe(true);
    },
  );
  it.each([
    ["route", "success"],
    ["route", "failure"],
    ["run", "success"],
    ["run", "failure"],
  ] as const)("resets on %s changes and ignores A's late %s cleanup", async (change, outcome) => {
    const first = deferred();
    const second = deferred();
    state.resume.mockReturnValueOnce(first.promise);
    state.discard.mockReturnValueOnce(second.promise);
    await render({ action: interrupted });
    await click("Resume agent");
    const next = {
      route: change === "route" ? b : a,
      action: { ...interrupted, runId: change === "run" ? "run-b" : interrupted.runId },
    };
    await render(next);
    expect(button("Discard").disabled).toBe(false);
    await click("Discard");
    await settle(first, outcome === "success" ? success() : failure("Old delivery failed"));
    expect(button("Discarding...").disabled).toBe(true);
    expect(button("Resume agent").disabled).toBe(true);
    if (outcome === "failure")
      expect(state.error).toHaveBeenCalledExactlyOnceWith(a, a.threadId, "Old delivery failed");
    await settle(second, failure());
    expect(button("Discard").disabled).toBe(false);
  });
  it("keeps the latest operation pending when both controls dispatch before render", async () => {
    const resume = deferred();
    const discard = deferred();
    state.resume.mockReturnValueOnce(resume.promise);
    state.discard.mockReturnValueOnce(discard.promise);
    await render({ action: interrupted });
    // Existing behavior has no synchronous lock; disabled controls take effect after render.
    await act(async () => {
      button("Resume agent").click();
      button("Discard").click();
    });
    expect(state.resume).toHaveBeenCalledOnce();
    expect(state.discard).toHaveBeenCalledOnce();
    await settle(resume, failure());
    expect(button("Discarding...").disabled).toBe(true);
    await settle(discard, failure());
    expect(button("Resume agent").disabled).toBe(false);
  });
  it("resets on removal and stays inert without a thread", async () => {
    await render({ action: interrupted, thread: null });
    expect(button("Resume agent").disabled).toBe(true);
    await render({ action: null });
    expect(container.textContent).toBe("");
    expect(state.resume).not.toHaveBeenCalled();
    expect(state.discard).not.toHaveBeenCalled();
  });
});

describe("Action banner stack", () => {
  it.each([false, true])(
    "preserves warning-first order and Action copy with branch mismatch %s",
    async (mismatch) => {
      // Warning banners share urgent priority and retain their input order.
      await render({ action: { ...running, delivery: "available" }, mismatch });
      expect(banners.runningBanner).toMatchObject({
        id: "action-running:run-a",
        priority: "activity",
        variant: "warning",
      });
      expect(banners.interruptedBanner).toMatchObject({
        id: "action-interrupted:run-a",
        variant: "warning",
      });
      const front = container.querySelector('[data-composer-banner-drawer="true"]')!;
      expect(front.textContent).toContain("Check work was interrupted");
      expect(front.textContent).toContain(
        "LastCode did not restart the command or wake the agent.",
      );
      const notices = container.querySelector('[aria-label="Other notices"]')!;
      expect(notices.textContent).toContain("Waiting for review");
      expect(notices.textContent).toContain("Checks in progress");
      expect(notices.textContent).toContain("Resumes when this thread is idle.");
      if (mismatch)
        expect(notices.textContent!.indexOf("Waiting for review")).toBeLessThan(
          notices.textContent!.indexOf("Branch changed"),
        );
      await render({
        action: {
          ...running,
          progress: {
            version: 1,
            state: "working",
            summary: "Compiling",
            updatedAt: "2026-08-25T12:00:00.000Z",
          },
        },
        mismatch,
      });
      expect(banners.runningBanner?.variant).toBe("info");
      expect(
        container.querySelector('[data-composer-banner-drawer="true"]')?.textContent,
      ).toContain("Compiling");
    },
  );
});
