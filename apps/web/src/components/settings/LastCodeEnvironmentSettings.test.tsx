import { EnvironmentId, DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { type ReactElement, type ReactNode, act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { LastCodeEnvironmentPauseSettings } from "./LastCodeEnvironmentPauseSettings";
import { LastCodeEnvironmentIconSettings } from "./LastCodeEnvironmentIconSettings";
import { ProviderAccentColorPicker } from "./ProviderAccentColorPicker";

const state = vi.hoisted(() => ({
  settings: {} as ClientSettings,
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
vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: () => state.settings,
  updateClientSettings: (
    update: Partial<ClientSettings> | ((settings: ClientSettings) => Partial<ClientSettings>),
  ) => {
    const patch = typeof update === "function" ? update(state.settings) : update;
    state.settings = { ...state.settings, ...patch };
  },
}));
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
vi.mock("./ProviderAccentColorPicker", () => ({ ProviderAccentColorPicker: () => null }));
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
let renderer: ReactTestRenderer;
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
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});
function button(label: string) {
  return renderer.root.findAllByType("button").find((node) => node.props["aria-label"] === label)!;
}
async function render(node: ReactElement) {
  await act(() => {
    renderer = create(node);
  });
}

describe("LastCode environment settings", () => {
  it.each(["project", "checkout"])(
    "disables scoped pause at %s scope including its reset",
    async (scope) => {
      state.scope = scope;
      state.mixed = true;
      await render(<LastCodeEnvironmentPauseSettings />);
      expect(button("Environment pause button").props.disabled).toBe(true);
      expect(button("Reset environment pause button").props.disabled).toBe(true);
    },
  );

  it.each([[], [false], [true, undefined]])(
    "requires capability support on every selected connected environment: %j",
    async (...capabilities) => {
      state.capabilities = capabilities.flat() as (boolean | undefined)[];
      await render(<LastCodeEnvironmentPauseSettings />);
      expect(button("Environment pause button").props.disabled).toBe(true);
    },
  );

  it("honors denied write permission and resets mixed targets to the server default", async () => {
    state.mixed = true;
    state.canWrite = false;
    await render(<LastCodeEnvironmentPauseSettings />);
    expect(button("Environment pause button").props.disabled).toBe(true);
    state.canWrite = true;
    await act(() => renderer.update(<LastCodeEnvironmentPauseSettings />));
    expect(button("Environment pause button").props["aria-pressed"]).toBe("mixed");
    await act(() => button("Reset environment pause button").props.onClick());
    expect(state.enabled).toBe(DEFAULT_SERVER_SETTINGS.environmentPauseEnabled);
    expect(state.mixed).toBe(false);
    expect(state.write).toHaveBeenCalledExactlyOnceWith({
      environmentPauseEnabled: DEFAULT_SERVER_SETTINGS.environmentPauseEnabled,
    });
  });

  it("turns a mixed pause setting on across the selected targets", async () => {
    state.mixed = true;
    await render(<LastCodeEnvironmentPauseSettings />);
    await act(() => button("Environment pause button").props.onClick());
    expect(state.enabled).toBe(true);
    expect(state.mixed).toBe(false);
  });

  it("merges consecutive icon edits against current settings and clears only the requested color", async () => {
    await render(<LastCodeEnvironmentIconSettings />);
    const pickers = renderer.root.findAllByType(ProviderAccentColorPicker);
    expect(pickers.map((picker) => picker.props.displayName)).toEqual([
      "Workstation (local)",
      "Remote",
    ]);
    await act(() => pickers[0]!.props.onCommit("#123456"));
    await act(() => pickers[1]!.props.onCommit("#abcdef"));
    expect(state.settings.environmentIconColors).toEqual({ primary: "#123456", remote: "#abcdef" });
    await act(() => pickers[0]!.props.onCommit(""));
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
    await act(() => button("Show thread provider badges").props.onClick());
    await act(() => renderer.update(<LastCodeEnvironmentIconSettings />));
    expect(renderer.root.findAllByType("input")).toHaveLength(0);
    await act(() => button("Show local icon").props.onClick());
    expect(state.settings.showLocalEnvironmentIcon).toBe(true);
    expect(state.settings.threadProviderBadgeSize).toBe(45);
    expect(state.settings.threadProviderBadgeTransparency).toBe(20);
    await act(() => button("Show thread provider badges").props.onClick());
    await act(() => renderer.update(<LastCodeEnvironmentIconSettings />));
    expect(renderer.root.findAllByType("input").map((field) => field.props.value)).toEqual([
      45, 20,
    ]);
  });
});
