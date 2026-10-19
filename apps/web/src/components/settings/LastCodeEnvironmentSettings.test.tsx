// @vitest-environment happy-dom
import { EnvironmentId, DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { type ReactElement, type ReactNode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { LastCodeEnvironmentPauseSettings } from "./LastCodeEnvironmentPauseSettings";
import { LastCodeEnvironmentIconSettings } from "./LastCodeEnvironmentIconSettings";

const state = vi.hoisted(() => ({
  settings: {} as ClientSettings,
  listeners: new Set<() => void>(),
  enabled: false,
  mixed: false,
  canWrite: true,
  scope: "environment",
  capabilities: [true] as (boolean | undefined)[],
  write: vi.fn(),
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: state.scope },
    connectedEnvironments: state.capabilities.map((environmentPause) => ({
      serverConfig: { environment: { capabilities: { environmentPause } } },
    })),
  }),
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => state.enabled,
  useScopedSettingsMixed: () => state.mixed,
  useScopedSettingsWriteAllowed: () => state.canWrite,
  useUpdateScopedSettings: () => (patch: { environmentPauseEnabled: boolean }) => {
    state.write(patch);
    state.enabled = patch.environmentPauseEnabled;
    state.mixed = false;
  },
}));
vi.mock("../../hooks/useSettings", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    state.listeners.add(listener);
    return () => {
      state.listeners.delete(listener);
    };
  };
  const getSnapshot = () => state.settings;
  return {
    usePrimarySettings: () => useSyncExternalStore(subscribe, getSnapshot),
    updateClientSettings: (
      update: Partial<ClientSettings> | ((settings: ClientSettings) => Partial<ClientSettings>),
    ) => {
      const patch = typeof update === "function" ? update(state.settings) : update;
      state.settings = { ...state.settings, ...patch };
      for (const listener of state.listeners) listener();
    },
  };
});
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({
    entries: new Map([
      ["primary", { target: { _tag: "PrimaryConnectionTarget", label: "Workstation" } }],
      [
        "remote",
        { target: { _tag: "BearerConnectionTarget", label: "Remote", connectionId: "remote" } },
      ],
    ]),
  }),
}));
vi.mock("../../connection/catalog", () => ({ environmentCatalog: { catalogValueAtom: null } }));
vi.mock("../../state/environments", () => ({ usePrimaryEnvironmentId: () => "primary" }));
vi.mock("../../environmentIcons", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../environmentIcons")>()),
  ConnectedEnvironmentIcon: () => null,
}));
vi.mock("../sidebar/SidebarEnvironmentIcon", () => ({ SidebarEnvironmentIcon: () => null }));
vi.mock("./ProviderAccentColorPicker", () => ({
  ProviderAccentColorPicker: ({
    displayName = "incoming messages",
    value,
    onCommit,
  }: {
    displayName?: string;
    value: string | null;
    onCommit: (value: string) => void;
  }) => (
    <input
      aria-label={displayName}
      defaultValue={value ?? ""}
      onChange={(event) => onCommit(event.currentTarget.value)}
    />
  ),
}));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => <>{children}</>,
  SettingsRow: ({
    control,
    resetAction,
    children,
    status,
  }: {
    control: ReactNode;
    resetAction: ReactNode;
    children: ReactNode;
    status: ReactNode;
  }) => (
    <>
      {control}
      {resetAction}
      {children}
      {status}
    </>
  ),
  SettingResetButton: ({
    label,
    ...props
  }: {
    label: string;
    disabled: boolean;
    onClick: () => void;
  }) => <button aria-label={`Reset ${label}`} {...props} />,
}));
vi.mock("../ui/switch", () => ({
  Switch: ({
    checked,
    mixed,
    onCheckedChange,
    ...props
  }: {
    checked: boolean;
    mixed: boolean;
    onCheckedChange: (value: boolean) => void;
  }) => (
    <button
      {...props}
      aria-pressed={mixed ? "mixed" : checked}
      onClick={() => onCheckedChange(!checked)}
    />
  ),
}));
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(state, {
    settings: { ...DEFAULT_CLIENT_SETTINGS, environmentIconColors: {} },
    enabled: DEFAULT_SERVER_SETTINGS.environmentPauseEnabled,
    mixed: false,
    canWrite: true,
    scope: "environment",
    capabilities: [true],
  });
  state.write.mockClear();
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
function button(label: string) {
  return host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
}
async function color(label: string, value: string) {
  await act(() => {
    const field = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function render(node: ReactElement) {
  await act(() => {
    root.render(node);
  });
}

describe("LastCode environment settings", () => {
  it.each(["project", "checkout"])(
    "disables scoped pause at %s scope including its reset",
    async (scope) => {
      state.scope = scope;
      state.mixed = true;
      await render(<LastCodeEnvironmentPauseSettings />);
      expect(button("Environment pause button").disabled).toBe(true);
      expect(button("Reset environment pause button").disabled).toBe(true);
    },
  );

  it.each([[], [false], [true, undefined]])(
    "requires capability support on every selected connected environment: %j",
    async (...capabilities) => {
      state.capabilities = capabilities.flat() as (boolean | undefined)[];
      await render(<LastCodeEnvironmentPauseSettings />);
      expect(button("Environment pause button").disabled).toBe(true);
    },
  );

  it("honors denied write permission and resets mixed targets to the server default", async () => {
    state.mixed = true;
    state.canWrite = false;
    await render(<LastCodeEnvironmentPauseSettings />);
    expect(button("Environment pause button").disabled).toBe(true);
    state.canWrite = true;
    await act(() => root.render(<LastCodeEnvironmentPauseSettings />));
    expect(button("Environment pause button").getAttribute("aria-pressed")).toBe("mixed");
    await act(() => button("Reset environment pause button").click());
    expect(state.enabled).toBe(DEFAULT_SERVER_SETTINGS.environmentPauseEnabled);
    expect(state.mixed).toBe(false);
    expect(state.write).toHaveBeenCalledExactlyOnceWith({
      environmentPauseEnabled: DEFAULT_SERVER_SETTINGS.environmentPauseEnabled,
    });
  });

  it("turns a mixed pause setting on across the selected targets", async () => {
    state.mixed = true;
    await render(<LastCodeEnvironmentPauseSettings />);
    await act(() => button("Environment pause button").click());
    expect(state.enabled).toBe(true);
    expect(state.mixed).toBe(false);
  });

  it("merges consecutive icon edits against current settings and clears only the requested color", async () => {
    await render(<LastCodeEnvironmentIconSettings />);
    await color("Workstation (local)", "#123456");
    await color("Remote", "#abcdef");
    expect(state.settings.environmentIconColors).toEqual({ primary: "#123456", remote: "#abcdef" });
    await color("Workstation (local)", "");
    expect(state.settings.environmentIconColors).toEqual({ remote: "#abcdef" });
    expect(state.settings.environmentIconColors[EnvironmentId.make("primary")]).toBeUndefined();
  });

  it("keeps badge dimensions when badges are hidden and allows the local icon independently", async () => {
    state.settings = {
      ...state.settings,
      showThreadProviderBadge: true,
      threadProviderBadgeSize: 45,
      threadProviderBadgeTransparency: 20,
      showLocalEnvironmentIcon: false,
    };
    await render(<LastCodeEnvironmentIconSettings />);
    await act(() => button("Show thread provider badges").click());
    expect(state.settings.showThreadProviderBadge).toBe(false);
    expect([...host.querySelectorAll<HTMLInputElement>('input[type="range"]')]).toHaveLength(0);
    await act(() => button("Show local icon").click());
    expect(state.settings.showLocalEnvironmentIcon).toBe(true);
    expect(state.settings.threadProviderBadgeSize).toBe(45);
    expect(state.settings.threadProviderBadgeTransparency).toBe(20);
    await act(() => button("Show thread provider badges").click());
    expect(
      [...host.querySelectorAll<HTMLInputElement>('input[type="range"]')].map((field) =>
        Number(field.value),
      ),
    ).toEqual([45, 20]);
  });
});
