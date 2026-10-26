import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  type WorktreeSuspensionPolicy,
} from "@t3tools/contracts";
import {
  clearProjectSettingsOverrides,
  resolveProjectSettings,
} from "@t3tools/shared/projectSettings";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { LastCodeStorageSettings, SavedWorkspacesLaunch } from "./LastCodeStorageSettings";
import "~/index.css";

const state = vi.hoisted(() => ({
  settings: {} as typeof DEFAULT_SERVER_SETTINGS,
  scope: "environment",
  mixed: false,
  canWrite: true,
  capabilities: [true] as (boolean | undefined)[],
  offlineCount: 0,
  write: vi.fn(),
}));
const projectId = ProjectId.make("project");

vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => {
    const project = state.scope === "project" || state.scope === "checkout";
    const resolved = resolveProjectSettings(state.settings, project ? projectId : null);
    const connectedEnvironments = state.capabilities.map((worktreeSuspension, index) => ({
      environmentId: `environment-${index}`,
      serverConfig: { environment: { capabilities: { worktreeSuspension } } },
    }));
    const targets = connectedEnvironments.map(({ environmentId }) => ({
      environmentId,
      projectId: project ? projectId : null,
      settings: resolved.settings,
      sources: resolved.sources,
    }));
    return {
      scope: { kind: state.scope },
      targets,
      target: targets[0] ?? null,
      connectedEnvironments,
      environments: [...connectedEnvironments, ...Array.from({ length: state.offlineCount })],
    };
  },
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () =>
    resolveProjectSettings(
      state.settings,
      state.scope === "project" || state.scope === "checkout" ? projectId : null,
    ).settings,
  useScopedSettingsMixed: () => state.mixed,
  useScopedSettingsWriteAllowed: () => state.canWrite,
  useUpdateScopedSettings: () => (patch: { worktreeSuspension: WorktreeSuspensionPolicy }) => {
    state.write(patch);
    state.settings = applyServerSettingsPatch(
      state.settings,
      state.scope === "project" || state.scope === "checkout"
        ? {
            projectSettingsOverrides: {
              [projectId]: {
                ...state.settings.projectSettingsOverrides[projectId],
                worktreeSuspension: patch.worktreeSuspension,
              },
            },
          }
        : patch,
    );
  },
  useClearScopedSettings: () => () => {
    state.settings = applyServerSettingsPatch(state.settings, {
      projectSettingsOverrides: {
        [projectId]: clearProjectSettingsOverrides(state.settings, projectId, [
          "worktreeSuspension",
        ]),
      },
    });
  },
}));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ title, children }: { title: string; children: ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
  SettingsRow: ({
    title,
    description,
    status,
    control,
  }: {
    title: string;
    description: ReactNode;
    status: ReactNode;
    control: ReactNode;
  }) => (
    <div>
      <h3>{title}</h3>
      {description}
      {status}
      {control}
    </div>
  ),
}));

function setup() {
  state.settings = { ...DEFAULT_SERVER_SETTINGS, projectSettingsOverrides: {} };
  state.scope = "environment";
  state.mixed = false;
  state.canWrite = true;
  state.capabilities = [true];
  state.offlineCount = 0;
  state.write.mockReset();
}

async function selectPolicy(screen: Awaited<ReturnType<typeof render>>, value: string) {
  await screen.getByRole("combobox", { name: "Suspend worktrees automatically" }).click();
  await page.getByRole("option", { name: value, exact: true }).click();
}

it("requires a chosen positive delay and an explicit scope before enabling suspension", async () => {
  setup();
  await using screen = await render(
    <LastCodeStorageSettings savedWorkspaces={<SavedWorkspacesLaunch onOpen={() => {}} />} />,
  );
  await expect
    .element(screen.getByRole("combobox", { name: "Suspend worktrees automatically" }))
    .toHaveTextContent("Off");
  await expect.element(screen.getByText(/Choose Keep workspace/)).not.toBeInTheDocument();
  await selectPolicy(screen, "Custom");
  await expect.element(screen.getByText(/Choose Keep workspace/)).toBeVisible();
  const save = screen.getByRole("button", { name: "Save suspension policy" });
  const days = screen.getByRole("spinbutton", { name: "Suspension delay in days" });
  await expect.element(days).toHaveValue(null);
  for (const checkbox of screen.container.querySelectorAll('[role="checkbox"]')) {
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
  }
  await days.fill("0");
  await expect.element(save).toBeDisabled();
  await days.fill("14");
  await expect.element(save).toBeDisabled();
  expect(state.settings.worktreeSuspension).toEqual({ mode: "off" });
  expect(state.write).not.toHaveBeenCalled();
  await screen.getByRole("checkbox", { name: "Child threads you haven’t joined" }).click();
  await save.click();
  expect(state.settings.worktreeSuspension).toEqual({
    mode: "custom",
    afterDays: 14,
    scopes: { subagents: false, untouchedChildren: true, otherThreads: false },
  });
  expect(state.settings.storageCleanup).toEqual(DEFAULT_SERVER_SETTINGS.storageCleanup);
  expect(state.settings.worktreeCleanup).toBeNull();
});

it("preserves an existing zero-day permanent deletion rule while configuring top-level suspension", async () => {
  setup();
  state.settings = applyServerSettingsPatch(state.settings, {
    storageCleanup: { worktreeSettledAfterDays: 0, worktreeAfterDays: 30, worktreeOnMerge: true },
  });
  const cleanup = state.settings.storageCleanup;
  await using screen = await render(<LastCodeStorageSettings />);
  await selectPolicy(screen, "Custom");
  await screen.getByRole("spinbutton", { name: "Suspension delay in days" }).fill("3");
  await screen
    .getByRole("checkbox", { name: "Top-level threads and threads you’ve joined" })
    .click();
  await screen.getByRole("button", { name: "Save suspension policy" }).click();
  expect(state.settings.storageCleanup).toEqual(cleanup);
  expect(state.settings.worktreeSuspension).toMatchObject({
    mode: "custom",
    afterDays: 3,
    scopes: { otherThreads: true, subagents: false },
  });
});

it("sets project Off and restores Inherit without losing other project overrides", async () => {
  setup();
  state.scope = "project";
  const environmentPolicy = {
    mode: "custom" as const,
    afterDays: 14,
    scopes: { subagents: false, untouchedChildren: true, otherThreads: false },
  };
  state.settings = applyServerSettingsPatch(state.settings, {
    worktreeSuspension: environmentPolicy,
    projectSettingsOverrides: { [projectId]: { defaultAutoPull: true } },
  });
  await using screen = await render(<LastCodeStorageSettings />);
  await expect
    .element(screen.getByRole("combobox", { name: "Suspend worktrees automatically" }))
    .toHaveTextContent("Inherit");
  await selectPolicy(screen, "Off");
  expect(state.settings.projectSettingsOverrides[projectId]?.worktreeSuspension).toEqual({
    mode: "off",
  });
  expect(state.settings.worktreeSuspension).toEqual(environmentPolicy);
  await screen.rerender(<LastCodeStorageSettings />);
  await selectPolicy(screen, "Inherit");
  await screen.rerender(<LastCodeStorageSettings />);
  expect(state.settings.projectSettingsOverrides[projectId]).toEqual({ defaultAutoPull: true });
  await expect
    .element(screen.getByRole("combobox", { name: "Suspend worktrees automatically" }))
    .toHaveTextContent("Inherit");
  await expect.element(screen.getByText(/after 14 days settled and unused/)).toBeVisible();
});

it("does not copy one machine’s policy when configuring mixed targets", async () => {
  setup();
  state.capabilities = [true, true];
  state.mixed = true;
  state.settings = applyServerSettingsPatch(state.settings, {
    worktreeSuspension: {
      mode: "custom",
      afterDays: 14,
      scopes: { subagents: true, untouchedChildren: false, otherThreads: false },
    },
  });
  await using screen = await render(<LastCodeStorageSettings />);
  await expect
    .element(screen.getByRole("combobox", { name: "Suspend worktrees automatically" }))
    .toHaveTextContent("Mixed");
  await selectPolicy(screen, "Custom");
  await expect
    .element(screen.getByRole("spinbutton", { name: "Suspension delay in days" }))
    .toHaveValue(null);
  await expect
    .element(screen.getByRole("checkbox", { name: "Finished subagents", exact: true }))
    .not.toBeChecked();
  await expect
    .element(screen.getByRole("button", { name: "Save suspension policy" }))
    .toBeDisabled();
  expect(state.write).not.toHaveBeenCalled();
});

it.each([[], [false], [true, undefined]])(
  "requires suspension support on every connected environment: %j",
  async (...capabilities) => {
    setup();
    state.capabilities = capabilities.flat() as (boolean | undefined)[];
    await using screen = await render(<LastCodeStorageSettings />);
    await expect
      .element(screen.getByRole("combobox", { name: "Suspend worktrees automatically" }))
      .toBeDisabled();
    expect(state.write).not.toHaveBeenCalled();
  },
);

it("honors denied write permission for editing an existing custom policy", async () => {
  setup();
  state.canWrite = false;
  state.settings = applyServerSettingsPatch(state.settings, {
    worktreeSuspension: {
      mode: "custom",
      afterDays: 3,
      scopes: { subagents: true, untouchedChildren: false, otherThreads: false },
    },
  });
  await using screen = await render(<LastCodeStorageSettings />);
  await expect
    .element(screen.getByRole("spinbutton", { name: "Suspension delay in days" }))
    .toBeDisabled();
  await expect
    .element(screen.getByRole("checkbox", { name: "Finished subagents", exact: true }))
    .toBeDisabled();
  await expect
    .element(screen.getByRole("button", { name: "Save suspension policy" }))
    .toBeDisabled();
  expect(state.write).not.toHaveBeenCalled();
});

it("explains project cleanup Off and offline targets while leaving their policies unchanged", async () => {
  setup();
  state.scope = "project";
  state.offlineCount = 1;
  state.settings = applyServerSettingsPatch(state.settings, {
    projectSettingsOverrides: { [projectId]: { worktreeCleanup: { mode: "off" } } },
  });
  await using screen = await render(<LastCodeStorageSettings />);
  await expect.element(screen.getByText(/will not suspend/)).toBeVisible();
  await expect
    .element(screen.getByText(/Offline environments will not get this setting/))
    .toBeVisible();
  await selectPolicy(screen, "Custom");
  expect(state.settings.projectSettingsOverrides[projectId]?.worktreeCleanup).toEqual({
    mode: "off",
  });
  expect(state.write).not.toHaveBeenCalled();
});

it("enables suspension while environment cleanup stays Off", async () => {
  setup();
  state.settings = applyServerSettingsPatch(state.settings, { worktreeCleanup: { mode: "off" } });
  const cleanup = state.settings.storageCleanup;
  await using screen = await render(<LastCodeStorageSettings />);
  await expect.element(screen.getByText(/will not suspend/)).not.toBeInTheDocument();
  await selectPolicy(screen, "Custom");
  await screen.getByRole("spinbutton", { name: "Suspension delay in days" }).fill("3");
  await screen.getByRole("checkbox", { name: "Finished subagents", exact: true }).click();
  await screen.getByRole("button", { name: "Save suspension policy" }).click();
  await screen.rerender(<LastCodeStorageSettings />);
  expect(state.settings.worktreeSuspension).toEqual({
    mode: "custom",
    afterDays: 3,
    scopes: { subagents: true, untouchedChildren: false, otherThreads: false },
  });
  expect(state.settings.worktreeCleanup).toEqual({ mode: "off" });
  expect(state.settings.storageCleanup).toEqual(cleanup);
  await expect.element(screen.getByText(/will not suspend/)).not.toBeInTheDocument();
});

it("shows inherited suspension without a veto when project cleanup inherits environment Off", async () => {
  setup();
  state.scope = "project";
  state.settings = applyServerSettingsPatch(state.settings, {
    worktreeCleanup: { mode: "off" },
    worktreeSuspension: {
      mode: "custom",
      afterDays: 14,
      scopes: { subagents: false, untouchedChildren: true, otherThreads: false },
    },
    projectSettingsOverrides: { [projectId]: { defaultAutoPull: true } },
  });
  await using screen = await render(<LastCodeStorageSettings />);
  await expect
    .element(screen.getByRole("combobox", { name: "Suspend worktrees automatically" }))
    .toHaveTextContent("Inherit");
  await expect.element(screen.getByText(/after 14 days settled and unused/)).toBeVisible();
  await expect.element(screen.getByText(/will not suspend/)).not.toBeInTheDocument();
  expect(state.write).not.toHaveBeenCalled();
});

it("identifies explicit project cleanup Off even when its value equals environment Off", async () => {
  setup();
  state.scope = "project";
  state.settings = applyServerSettingsPatch(state.settings, {
    worktreeCleanup: { mode: "off" },
    worktreeSuspension: {
      mode: "custom",
      afterDays: 14,
      scopes: { subagents: false, untouchedChildren: true, otherThreads: false },
    },
    projectSettingsOverrides: { [projectId]: { worktreeCleanup: { mode: "off" } } },
  });
  await using screen = await render(<LastCodeStorageSettings />);
  await expect
    .element(
      screen.getByText(/An explicit project cleanup Off override protects a selected project/),
    )
    .toBeVisible();
  await selectPolicy(screen, "Off");
  await screen.rerender(<LastCodeStorageSettings />);
  expect(state.settings.projectSettingsOverrides[projectId]?.worktreeSuspension).toEqual({
    mode: "off",
  });
  expect(state.settings.worktreeSuspension.mode).toBe("custom");
});
