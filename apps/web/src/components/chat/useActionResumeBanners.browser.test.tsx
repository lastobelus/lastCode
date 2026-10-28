import { act, render, type Screen } from "../../../test/render";
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
import { useLayoutEffect } from "react";
import { actionResumeStatus } from "@t3tools/shared/actionResume";
import { actionResumeWait } from "@t3tools/client-runtime/state/action-resume";
import { describe, expect, it, vi } from "vite-plus/test";

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

const observation: { banners: ReturnType<typeof useActionResumeBanners> | null } = {
  banners: null,
};
interface ProbeProps {
  route?: ScopedThreadRef;
  thread?: ScopedThreadRef | null;
  action?: ActionResumeState | null;
  mismatch?: boolean;
  environmentPaused?: boolean;
  hasPendingRequest?: boolean;
  followUp?: Parameters<typeof actionResumeStatus>[0]["followUp"];
  unknown?: boolean;
}
function Probe({
  route = a,
  thread = route,
  action = running,
  mismatch = false,
  environmentPaused = false,
  hasPendingRequest = false,
  followUp,
  unknown = false,
}: ProbeProps) {
  const wait = actionResumeWait(
    action ? { action, followUp: followUp ?? null, hasPendingRequest } : null,
    action,
    unknown ? null : environmentPaused,
  );
  const value = useActionResumeBanners({
    routeThreadRef: route,
    threadRef: thread,
    action: wait.presentation === null ? null : action,
    status: wait.status,
    onRequestTerminalFocus: state.focus,
    // Each render captures the route just as ChatView's error setter does.
    onThreadError: (threadId, message) => state.error(route, threadId, message),
  });
  useLayoutEffect(() => {
    observation.banners = value;
  });
  const items = [value.interruptedBanner, value.pendingBanner, value.runningBanner].filter(
    (item) => item !== null,
  );
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
async function show(screen: Screen, props: ProbeProps = {}) {
  await act(async () => screen.rerender(<Probe {...props} />));
}
function button(container: HTMLElement, label: string) {
  const result = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === label || node.getAttribute("aria-label") === label,
  );
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
async function click(container: HTMLElement, label: string) {
  await act(async () => button(container, label).click());
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

it("keeps a finished Action visible while its follow-up is pending", async () => {
  setup();
  await using screen = await render(null);
  await show(screen, {
    action: { ...running, outcome: "succeeded", delivery: "pending", exitCode: 0 },
  });
  await expect.element(screen.getByText(/Check work/)).toBeVisible();
  expect(screen.container.textContent).not.toContain("Cancel");
});

it("distinguishes current pause from a retained hold and a remaining request", async () => {
  setup();
  await using screen = await render(null);
  const action = {
    ...running,
    outcome: "succeeded",
    delivery: "pending",
    heldByEnvironmentPause: true,
  } as const;
  await show(screen, { action, environmentPaused: true });
  await expect.element(screen.getByText("Check work · Environment paused")).toBeVisible();
  await show(screen, { action, hasPendingRequest: true });
  await expect.element(screen.getByText("Check work · Needs your input")).toBeVisible();
  expect(screen.container.textContent).not.toContain("Resume the environment");
  await show(screen, { action });
  await expect.element(screen.getByText("Check work · Sending result")).toBeVisible();
});
it("keeps a held exact follow-up visible and removes the notice when that run ends", async () => {
  setup();
  await using screen = await render(null);
  const action = { ...running, outcome: "succeeded", delivery: "delivered" } as const;
  await show(screen, { action, followUp: { status: "queued", queueHeld: true } });
  await expect.element(screen.getByText("Check work · Needs attention")).toBeVisible();
  await show(screen, { action, followUp: { status: "completed", queueHeld: false } });
  expect(screen.container.textContent).toBe("");
});
it("opens the originating retained terminal for a pending Action with read access", async () => {
  setup();
  await using screen = await render(null);
  grant(a, [AuthTerminalReadScope]);
  await show(screen, { action: { ...running, outcome: "succeeded", delivery: "pending" } });
  await click(screen.container, "Open terminal");
  expect(state.ensureTerminal).toHaveBeenCalledExactlyOnceWith(a, running.terminalId, {
    open: true,
    active: true,
  });
  expect(state.close).not.toHaveBeenCalled();
});
it("does not promise automatic continuation when the environment state is unknown", async () => {
  setup();
  await using screen = await render(null);
  await show(screen, {
    action: { ...running, outcome: "succeeded", delivery: "pending" },
    unknown: true,
  });
  await expect.element(screen.getByText("Check work · Status unknown")).toBeVisible();
  expect(screen.container.textContent).not.toContain("pick up its result automatically");
});

describe("running Action controls", () => {
  it("opens only the existing Action terminal with read-only access", async () => {
    setup();
    await using screen = await render(null);
    const { container } = screen;

    grant(a, [AuthTerminalReadScope]);
    await show(screen);
    await click(screen.container, "Open terminal");
    expect(state.ensureTerminal).toHaveBeenCalledExactlyOnceWith(a, running.terminalId, {
      open: true,
      active: true,
    });
    expect(state.focus).toHaveBeenCalledOnce();
    expect(state.close).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Cancel");
  });
  it("rechecks read access when the rendered control is retained", async () => {
    setup();
    await using screen = await render(null);
    const { container } = screen;

    await show(screen);
    state.scopes.get(a.environmentId)!.delete(AuthTerminalReadScope);
    await click(screen.container, "Open Action terminal");
    expect(state.ensureTerminal).not.toHaveBeenCalled();
    expect(state.focus).not.toHaveBeenCalled();
    grant(a, []);
    await show(screen);
    expect(container.querySelector("button")).toBeNull();
  });
  it("rechecks destination cancellation access and preserves terminal history", async () => {
    setup();
    await using screen = await render(null);

    await show(screen);
    state.scopes.get(a.environmentId)!.delete(AuthTerminalOperateScope);
    await click(screen.container, "Cancel");
    expect(state.close).not.toHaveBeenCalled();
    state.scopes.get(a.environmentId)!.add(AuthTerminalOperateScope);
    await click(screen.container, "Cancel");
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
      setup();
      await using screen = await render(null);

      const first = deferred();
      const second = deferred();
      state.close.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      await show(screen);
      await click(screen.container, "Cancel");
      expect(button(screen.container, "Cancelling...").disabled).toBe(true);
      await show(screen, {
        route: b,
        action: { ...running, runId: "run-b", terminalId: "terminal-b" },
      });
      await click(screen.container, "Cancel");
      await settle(first, outcome === "success" ? success() : failure("A failed"));
      expect(button(screen.container, "Cancelling...").disabled).toBe(true);
      if (outcome === "failure")
        expect(state.error).toHaveBeenCalledExactlyOnceWith(a, a.threadId, "A failed");
      await settle(second, success());
      expect(button(screen.container, "Cancel").disabled).toBe(false);
    },
  );
  it("keeps interrupted cancellation silent", async () => {
    setup();
    await using screen = await render(null);

    state.close.mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt(1)));
    await show(screen);
    await click(screen.container, "Cancel");
    expect(state.error).not.toHaveBeenCalled();
    expect(button(screen.container, "Cancel").disabled).toBe(false);
  });
  it("does nothing with a null destination", async () => {
    setup();
    await using screen = await render(null);
    const { container } = screen;

    await show(screen, { thread: null });
    expect(container.querySelector("button")).toBeNull();
    expect(state.ensureTerminal).not.toHaveBeenCalled();
    expect(state.close).not.toHaveBeenCalled();
  });
});

describe("interrupted Action delivery", () => {
  it.each(["resume", "discard"] as const)(
    "%s disables both controls and latches success until projection changes",
    async (operation) => {
      await using screen = await render(null);
      const { container } = screen;

      setup();

      const pending = deferred();
      state[operation].mockReturnValueOnce(pending.promise);
      await show(screen, { action: interrupted });
      await click(screen.container, operation === "resume" ? "Resume agent" : "Discard");
      expect([...container.querySelectorAll("button")].every((node) => node.disabled)).toBe(true);
      expect(state[operation]).toHaveBeenCalledExactlyOnceWith({
        environmentId: a.environmentId,
        input: { threadId: a.threadId },
      });
      expect(state[operation === "resume" ? "discard" : "resume"]).not.toHaveBeenCalled();
      await settle(pending, success());
      expect([...container.querySelectorAll("button")].every((node) => node.disabled)).toBe(true);
      await show(screen, { action: { ...interrupted, delivery: "delivered" } });
      expect([...container.querySelectorAll("button")].map((node) => node.textContent)).toEqual([
        "Open terminal",
      ]);
      expect(state.close).not.toHaveBeenCalled();
      expect(state.ensureTerminal).not.toHaveBeenCalled();
    },
  );
  it.each(["resume", "discard"] as const)(
    "%s failure enables retry and reports the captured route",
    async (operation) => {
      setup();
      await using screen = await render(null);

      state[operation].mockResolvedValueOnce(failure("Delivery failed"));
      await show(screen, { action: interrupted });
      await click(screen.container, operation === "resume" ? "Resume agent" : "Discard");
      expect(button(screen.container, "Resume agent").disabled).toBe(false);
      expect(button(screen.container, "Discard").disabled).toBe(false);
      expect(state.error).toHaveBeenCalledExactlyOnceWith(a, a.threadId, "Delivery failed");
    },
  );
  it.each(["resume", "discard"] as const)(
    "%s interruption clears pending without an error",
    async (operation) => {
      setup();
      await using screen = await render(null);

      state[operation].mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt(1)));
      await show(screen, { action: interrupted });
      await click(screen.container, operation === "resume" ? "Resume agent" : "Discard");
      expect(button(screen.container, "Resume agent").disabled).toBe(false);
      expect(state.error).not.toHaveBeenCalled();
    },
  );
  it.each(["resume", "discard"] as const)(
    "%s retained controls obey permission revocation",
    async (operation) => {
      setup();
      await using screen = await render(null);

      await show(screen, { action: interrupted });
      state.scopes.get(a.environmentId)!.delete(AuthOrchestrationOperateScope);
      await click(screen.container, operation === "resume" ? "Resume agent" : "Discard");
      expect(state[operation]).not.toHaveBeenCalled();
      await show(screen, { action: interrupted });
      expect(button(screen.container, "Resume agent").disabled).toBe(true);
      expect(button(screen.container, "Discard").disabled).toBe(true);
    },
  );
  it.each([
    ["route", "success"],
    ["route", "failure"],
    ["run", "success"],
    ["run", "failure"],
  ] as const)("resets on %s changes and ignores A's late %s cleanup", async (change, outcome) => {
    setup();
    await using screen = await render(null);

    const first = deferred();
    const second = deferred();
    state.resume.mockReturnValueOnce(first.promise);
    state.discard.mockReturnValueOnce(second.promise);
    await show(screen, { action: interrupted });
    await click(screen.container, "Resume agent");
    const next = {
      route: change === "route" ? b : a,
      action: { ...interrupted, runId: change === "run" ? "run-b" : interrupted.runId },
    };
    await show(screen, next);
    expect(button(screen.container, "Discard").disabled).toBe(false);
    await click(screen.container, "Discard");
    await settle(first, outcome === "success" ? success() : failure("Old delivery failed"));
    expect(button(screen.container, "Discarding...").disabled).toBe(true);
    expect(button(screen.container, "Resume agent").disabled).toBe(true);
    if (outcome === "failure")
      expect(state.error).toHaveBeenCalledExactlyOnceWith(a, a.threadId, "Old delivery failed");
    await settle(second, failure());
    expect(button(screen.container, "Discard").disabled).toBe(false);
  });
  it("keeps the latest operation pending when both controls dispatch before render", async () => {
    setup();
    await using screen = await render(null);

    const resume = deferred();
    const discard = deferred();
    state.resume.mockReturnValueOnce(resume.promise);
    state.discard.mockReturnValueOnce(discard.promise);
    await show(screen, { action: interrupted });
    // Existing behavior has no synchronous lock; disabled controls take effect after render.
    await act(async () => {
      button(screen.container, "Resume agent").click();
      button(screen.container, "Discard").click();
    });
    expect(state.resume).toHaveBeenCalledOnce();
    expect(state.discard).toHaveBeenCalledOnce();
    await settle(resume, failure());
    expect(button(screen.container, "Discarding...").disabled).toBe(true);
    await settle(discard, failure());
    expect(button(screen.container, "Resume agent").disabled).toBe(false);
  });
  it("resets on removal and stays inert without a thread", async () => {
    setup();
    await using screen = await render(null);
    const { container } = screen;

    await show(screen, { action: interrupted, thread: null });
    expect(button(screen.container, "Resume agent").disabled).toBe(true);
    await show(screen, { action: null });
    expect(container.textContent).toBe("");
    expect(state.resume).not.toHaveBeenCalled();
    expect(state.discard).not.toHaveBeenCalled();
  });
});

describe("completed Action held by Pause", () => {
  it("shows the retained result with read-only destination access and keeps pending intent until delivery changes", async () => {
    setup();
    grant(a, []);
    await using screen = await render(null);
    const held: ActionResumeState = {
      ...running,
      outcome: "succeeded",
      delivery: "pending",
      heldByEnvironmentPause: true,
      finishedAt: "2026-08-25T12:01:00.000Z",
      exitCode: 0,
      report: { version: 1, outcome: "success", summary: "Documentation preview ready" },
    };
    await show(screen, { action: held, environmentPaused: true });
    await expect.element(screen.getByText("Check work · Environment paused")).toBeVisible();
    await expect
      .element(screen.getByText(/Documentation preview ready.*Automatic wake-ups are held/))
      .toBeVisible();
    expect(screen.container.textContent).toContain("Resume the environment");
    for (const name of ["Resume agent", "Discard", "Cancel", "Open terminal"]) {
      await expect
        .element(screen.getByRole("button", { name, exact: true }))
        .not.toBeInTheDocument();
    }
    expect(state.resume).not.toHaveBeenCalled();
    expect(state.discard).not.toHaveBeenCalled();
    expect(state.close).not.toHaveBeenCalled();
    expect(state.ensureTerminal).not.toHaveBeenCalled();

    await show(screen, {
      action: { ...held, delivery: "delivered" },
      followUp: { status: "completed", queueHeld: false },
    });
    await expect
      .element(screen.getByText("Check work · Environment paused"))
      .not.toBeInTheDocument();
    expect(screen.container.textContent).toBe("");
    await show(screen, { action: { ...held, delivery: "available" } });
    await expect.element(screen.getByText("Check work · Needs attention")).toBeVisible();
    expect(button(screen.container, "Resume agent").disabled).toBe(true);
    expect(button(screen.container, "Discard").disabled).toBe(true);
  });
});

describe("Action banner stack", () => {
  it.each([false, true])(
    "preserves environment-first order and Action copy with branch mismatch %s",
    async (mismatch) => {
      await using screen = await render(null);
      const { container } = screen;

      setup();

      await show(screen, { action: interrupted, mismatch });
      expect(observation.banners!.runningBanner).toBeNull();
      expect(observation.banners!.interruptedBanner).toMatchObject({
        id: "action-interrupted:run-a",
        variant: "warning",
      });
      const interruptedNotice = container.querySelector('[data-composer-banner-stack="true"]')!;
      expect(interruptedNotice.textContent).toContain("Check work · Interrupted");
      expect(interruptedNotice.textContent).toContain(
        "The command was interrupted and the agent won't continue automatically.",
      );
      if (mismatch) await expect.element(screen.getByText("Branch changed")).toBeVisible();
      else await expect.element(screen.getByText("Branch changed")).not.toBeInTheDocument();
      await show(screen, {
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
      expect(observation.banners!.runningBanner?.variant).toBe("info");
      await expect.element(screen.getByText(/Compiling\./)).toBeVisible();
      if (mismatch)
        expect(container.textContent!.indexOf("Compiling")).toBeLessThan(
          container.textContent!.indexOf("Branch changed"),
        );
    },
  );
});

function setup() {
  observation.banners = null;
  state.scopes.clear();
  grant(a, allScopes);
  grant(b, allScopes);
  for (const command of [state.close, state.resume, state.discard])
    command.mockReset().mockResolvedValue(success());
  for (const spy of [state.focus, state.error, state.ensureTerminal]) spy.mockReset();
}
