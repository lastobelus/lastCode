import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type EnvironmentPauseStatus,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import * as Cause from "effect/Cause";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import type { EnvironmentPresentation } from "../state/environments";

const mocks = vi.hoisted(() => ({ pause: {} }));
vi.mock("../state/actionResume", () => ({
  useActionEnvironmentPause: () => ({ environment: null }),
}));
vi.mock("../state/environmentPause", () => ({
  environmentPause: mocks.pause,
}));

import { EnvironmentPauseControl } from "./EnvironmentPauseControl";

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

function setup() {
  const registry = AtomRegistry.make();
  const status = Atom.make(AsyncResult.success(unpaused));
  const starting = Atom.make(false);
  const permission = Atom.make(true);
  let finishPause = () => {};
  let failPause = () => {};
  const startResult = new Promise<AtomCommandResult<EnvironmentPauseStatus, Error>>((resolve) => {
    finishPause = () => resolve(AsyncResult.success(unpaused));
    failPause = () => resolve(AsyncResult.failure(Cause.fail(new Error("Pause was cancelled"))));
  });
  const start = {
    label: "start",
    permissionAtom: () => permission,
    run: vi.fn(() => {
      registry.set(starting, true);
      return startResult;
    }),
  };
  const resume = {
    label: "resume",
    permissionAtom: () => permission,
    run: vi.fn(async () => AsyncResult.success(unpaused)),
  };
  Object.assign(mocks.pause, {
    activeStatus: () => status,
    starting: () => starting,
    start,
    resume,
  });
  return {
    registry,
    status,
    starting,
    permission,
    start,
    resume,
    failPause,
    view: (target = environment) => (
      <RegistryContext.Provider value={registry}>
        <EnvironmentPauseControl environment={target} />
      </RegistryContext.Provider>
    ),
    [Symbol.dispose]: () => {
      finishPause();
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

it.each(["pausing", "paused", "resuming"] as const)(
  "sends Resume directly during %s with unfinished deliveries and work",
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
          targets: ["pending", "failed"].map((pause, index) => ({
            threadId: ThreadId.make(`thread-${index}`),
            projectId: ProjectId.make("project"),
            title: "Work",
            pause: pause as "pending" | "failed",
            resume: "pending",
            error: null,
          })),
        },
      }),
    );
    await using screen = await render(h.view());
    await screen.getByRole("button", { name: "Resume Remote environment" }).click();
    expect(h.resume.run).toHaveBeenCalledOnce();
    expect(h.start.run).not.toHaveBeenCalled();
    await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
  },
);

it("preserves connection permissions for both commands", async () => {
  using h = setup();
  h.registry.set(h.permission, false);
  await using screen = await render(h.view());
  await expect
    .element(screen.getByRole("button", { name: "Pause Remote environment" }))
    .toBeDisabled();
  await act(() => h.registry.set(h.starting, true));
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
