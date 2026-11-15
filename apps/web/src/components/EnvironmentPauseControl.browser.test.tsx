import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  EnvironmentPauseError,
  type EnvironmentPauseStatus,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import * as Cause from "effect/Cause";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../test/render";
import type { EnvironmentPresentation } from "../state/environments";

const mocks = vi.hoisted(() => ({ pause: {}, noticeEnvironment: null as unknown }));
vi.mock("../state/actionResume", () => ({
  useActionEnvironmentPause: () => ({
    environment: mocks.noticeEnvironment,
    phase: "resuming",
    known: true,
    showUnknown: false,
  }),
}));
vi.mock("../state/environmentPause", () => ({
  environmentPause: mocks.pause,
}));

import { EnvironmentPauseControl, EnvironmentPauseNotice } from "./EnvironmentPauseControl";

const environment = {
  environmentId: EnvironmentId.make("remote-environment"),
  label: "Remote environment",
  connection: { phase: "connected" },
  serverConfig: {
    environment: { capabilities: { environmentPause: true } },
    settings: { environmentPauseEnabled: true },
  },
} as EnvironmentPresentation;
const unpaused: EnvironmentPauseStatus = {
  session: null,
  observation: "known",
  quiet: true,
  activeThreadCount: 0,
  blockers: [],
};
const resuming: EnvironmentPauseStatus = {
  ...unpaused,
  quiet: false,
  activeThreadCount: 2,
  session: {
    id: "pause-session",
    createdAt: "2026-10-08T00:00:00.000Z",
    phase: "resuming",
    targets: ["pending", "failed"].map((resume, index) => ({
      threadId: ThreadId.make(`thread-${index}`),
      projectId: ProjectId.make("project"),
      title: "Work",
      pause: "sent",
      resume: resume as "pending" | "failed",
      error: null,
    })),
  },
};

function setup(holdResume = false) {
  const registry = AtomRegistry.make();
  const status = Atom.make(AsyncResult.success(unpaused));
  const statusReads = vi.fn();
  const query = Atom.make((get) => {
    statusReads();
    return get(status);
  });
  const monitor = query.pipe(Atom.withRefresh(15_000), Atom.setIdleTTL(0));
  const active = query.pipe(Atom.withRefresh(1_000), Atom.setIdleTTL(0));
  const intent = Atom.make<"start" | "resume" | null>(null);
  const permission = Atom.make(true);
  const retryPermission = Atom.make(true);
  let finishPause = () => {};
  let failPause = () => {};
  const startResult = new Promise<AtomCommandResult<EnvironmentPauseStatus, unknown>>((resolve) => {
    finishPause = () => resolve(AsyncResult.success(unpaused));
    failPause = () => resolve(AsyncResult.failure(Cause.fail(new Error("Pause was cancelled"))));
  });
  const start = {
    label: "start",
    permissionAtom: () => permission,
    run: vi.fn(() => {
      registry.set(intent, "start");
      return startResult;
    }),
  };
  let finishResume = () => {};
  const resumeResult = new Promise<AtomCommandResult<EnvironmentPauseStatus, unknown>>(
    (resolve) => {
      finishResume = () => resolve(AsyncResult.success(unpaused));
    },
  );
  const resume = {
    label: "resume",
    permissionAtom: () => permission,
    run: vi.fn(async (): Promise<AtomCommandResult<EnvironmentPauseStatus, unknown>> => {
      registry.set(intent, "resume");
      return holdResume ? resumeResult : AsyncResult.success(unpaused);
    }),
  };
  const retry = {
    label: "retry",
    permissionAtom: () => retryPermission,
    run: vi.fn(async (): Promise<AtomCommandResult<EnvironmentPauseStatus, unknown>> =>
      AsyncResult.success(unpaused),
    ),
  };
  mocks.noticeEnvironment = environment;
  Object.assign(mocks.pause, {
    status: () => query,
    monitorStatus: () => monitor,
    activeStatus: () => active,
    intent: () => intent,
    start,
    resume,
    retry,
  });
  return {
    registry,
    status,
    statusReads,
    intent,
    permission,
    retryPermission,
    start,
    resume,
    retry,
    finishResume,
    failPause,
    view: (target = environment, notice = false) => (
      <RegistryContext.Provider value={registry}>
        <EnvironmentPauseControl environment={target} />
        {notice ? <EnvironmentPauseNotice environmentId={target.environmentId} /> : null}
      </RegistryContext.Provider>
    ),
    [Symbol.dispose]: () => {
      finishPause();
      finishResume();
      registry.dispose();
    },
  };
}

it("sends Pause on the first click and Resume on the next while Pause is still in flight", async () => {
  using h = setup();
  await using screen = await render(h.view());
  await screen.getByRole("button", { name: "Pause Remote environment" }).click();
  expect(h.start.run).toHaveBeenCalledExactlyOnceWith(h.registry, {
    environmentId: environment.environmentId,
    input: {},
  });
  await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Resume Remote environment" }).click();
  expect(h.resume.run).toHaveBeenCalledExactlyOnceWith(h.registry, {
    environmentId: environment.environmentId,
    input: {},
  });
  await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
  await act(() => h.failPause());
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
});

it("switches immediately to Pause while Resume is outstanding and keeps the latest click after its reply", async () => {
  using h = setup(true);
  h.registry.set(
    h.status,
    AsyncResult.success({ ...resuming, session: { ...resuming.session!, phase: "paused" } }),
  );
  await using screen = await render(h.view());
  await screen.getByRole("button", { name: "Resume Remote environment" }).click();
  expect(h.resume.run).toHaveBeenCalledOnce();
  await expect
    .element(screen.getByRole("button", { name: "Pause Remote environment" }))
    .toBeEnabled();
  await screen.getByRole("button", { name: "Pause Remote environment" }).click();
  expect(h.start.run).toHaveBeenCalledExactlyOnceWith(h.registry, {
    environmentId: environment.environmentId,
    input: {},
  });
  await expect
    .element(screen.getByRole("button", { name: "Resume Remote environment" }))
    .toBeEnabled();
  await act(() => h.finishResume());
  await expect
    .element(screen.getByRole("button", { name: "Resume Remote environment" }))
    .toBeEnabled();
  await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
});

it.each([true, false])(
  "offers optional pause recovery without blocking Resume (failed=%s)",
  async (failed) => {
    using h = setup();
    const retryLabel = failed ? "Retry pause" : "Pause remaining threads";
    h.registry.set(
      h.status,
      AsyncResult.success({
        ...resuming,
        session: {
          ...resuming.session!,
          phase: "pausing",
          targets: [
            { ...resuming.session!.targets[0]!, pause: failed ? "failed" : "sent" },
            resuming.session!.targets[1]!,
          ],
        },
      }),
    );
    await using screen = await render(h.view(environment, true));
    await expect
      .element(screen.getByRole("button", { name: "Resume Remote environment" }))
      .toBeEnabled();
    await screen.getByRole("button", { name: "Manage pause" }).click();
    await act(() => h.registry.set(h.retryPermission, false));
    await expect
      .element(page.getByRole("dialog").getByRole("button", { name: retryLabel, exact: true }))
      .toBeDisabled();
    await expect
      .element(page.getByRole("dialog").getByRole("button", { name: "Resume", exact: true }))
      .toBeEnabled();
    await act(() => h.registry.set(h.retryPermission, true));
    const retryButton = page
      .getByRole("dialog")
      .getByRole("button", { name: retryLabel, exact: true })
      .element() as HTMLButtonElement;
    await act(() => retryButton.click());
    expect(h.retry.run).toHaveBeenCalledExactlyOnceWith(h.registry, {
      environmentId: environment.environmentId,
      input: {},
    });
    expect(h.start.run).not.toHaveBeenCalled();
    expect(h.resume.run).not.toHaveBeenCalled();
    await expect.element(page.getByRole("dialog")).toBeVisible();
  },
);

it.each(["pausing", "paused", "resuming"] as const)(
  "sends the next action directly during %s with unfinished deliveries and work",
  async (phase) => {
    using h = setup();
    h.registry.set(
      h.status,
      AsyncResult.success({
        ...unpaused,
        quiet: false,
        activeThreadCount: 2,
        session: {
          id: "pause-session",
          createdAt: "2026-10-08T00:00:00.000Z",
          phase,
          targets: resuming.session!.targets,
        },
      }),
    );
    await using screen = await render(h.view());
    await screen
      .getByRole("button", {
        name: `${phase === "resuming" ? "Pause" : "Resume"} Remote environment`,
      })
      .click();
    if (phase === "resuming") {
      expect(h.start.run).toHaveBeenCalledExactlyOnceWith(h.registry, {
        environmentId: environment.environmentId,
        input: {},
      });
      expect(h.resume.run).not.toHaveBeenCalled();
      await screen.getByRole("button", { name: "Resume Remote environment" }).click();
      expect(h.resume.run).toHaveBeenCalledExactlyOnceWith(h.registry, {
        environmentId: environment.environmentId,
        input: {},
      });
    } else {
      expect(h.resume.run).toHaveBeenCalledOnce();
      expect(h.start.run).not.toHaveBeenCalled();
    }
    await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
  },
);

it.each([
  [
    new EnvironmentPauseError({ operation: "start", reason: "disabled" }),
    "Enable environment pause in Settings before starting a pause.",
  ],
  [
    { message: "This connection does not have permission to send thread messages." },
    "This connection does not have permission to send thread messages.",
  ],
  [{}, "The request failed. Try again."],
] as const)(
  "shows returned errors from both the main control and Resume retry: %j",
  async (cause, message) => {
    using h = setup();
    h.start.run.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(cause)));
    await using screen = await render(h.view(environment, true));
    await screen.getByRole("button", { name: "Pause Remote environment" }).click();
    await expect.element(screen.getByRole("alert")).toHaveTextContent(message);
    await act(() => h.registry.set(h.status, AsyncResult.success(resuming)));
    h.resume.run.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(cause)));
    await screen.getByRole("button", { name: "Manage pause" }).click();
    const resumeButton = page
      .getByRole("dialog")
      .getByRole("button", { name: "Resume", exact: true })
      .element() as HTMLButtonElement;
    await act(() => resumeButton.click());
    expect(h.resume.run).toHaveBeenCalledExactlyOnceWith(h.registry, {
      environmentId: environment.environmentId,
      input: {},
    });
    await expect
      .element(page.getByRole("dialog").getByText(message, { exact: true }))
      .toBeVisible();
  },
);

it("polls slowly with only the main control mounted and uses fast progress only in an open dialog", async () => {
  using h = setup();
  using _timers = fakeTimers();
  h.registry.set(h.status, AsyncResult.success(resuming));
  await using screen = await render(h.view(environment, true));
  const initially = h.statusReads.mock.calls.length;
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  expect(h.statusReads).toHaveBeenCalledTimes(initially);
  await act(() => vi.advanceTimersByTimeAsync(14_000));
  expect(h.statusReads).toHaveBeenCalledTimes(initially + 1);
  const manageButton = screen
    .getByRole("button", { name: "Manage pause" })
    .element() as HTMLButtonElement;
  await act(() => manageButton.click());
  const opened = h.statusReads.mock.calls.length;
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  expect(h.statusReads.mock.calls.length).toBeGreaterThan(opened);
  await screen.unmount();
  const unmounted = h.statusReads.mock.calls.length;
  await act(() => vi.advanceTimersByTimeAsync(15_000));
  expect(h.statusReads).toHaveBeenCalledTimes(unmounted);
});

it("preserves connection permissions for both commands", async () => {
  using h = setup();
  h.registry.set(h.permission, false);
  await using screen = await render(h.view());
  await expect
    .element(screen.getByRole("button", { name: "Pause Remote environment" }))
    .toBeDisabled();
  await act(() => h.registry.set(h.intent, "start"));
  await expect
    .element(screen.getByRole("button", { name: "Resume Remote environment" }))
    .toBeDisabled();
  await act(() => h.registry.set(h.permission, true));
  await screen.rerender(
    h.view({ ...environment, connection: { ...environment.connection, phase: "offline" } }),
  );
  await expect
    .element(screen.getByRole("button", { name: "Resume Remote environment" }))
    .toBeDisabled();
  expect(h.start.run).not.toHaveBeenCalled();
  expect(h.resume.run).not.toHaveBeenCalled();
});
