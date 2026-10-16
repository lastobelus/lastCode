import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { type ReactNode, act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { LastCodeMessageAppearanceSettings } from "./LastCodeMessageAppearanceSettings";
import { LastCodeScrollbarSettings } from "./LastCodeScrollbarSettings";
import { LastCodeHandoffSettings } from "./LastCodeHandoffSettings";
import { LastCodeSidebarSettings } from "./LastCodeSidebarSettings";
import { ProviderAccentColorPicker } from "./ProviderAccentColorPicker";
import { Select } from "../ui/select";

const state = vi.hoisted(() => ({ settings: {} as ClientSettings, writes: vi.fn() }));
vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: () => state.settings,
  useUpdateClientSettings: () => (patch: Partial<ClientSettings>) => {
    state.writes(patch);
    state.settings = { ...state.settings, ...patch };
  },
}));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({
    control,
    resetAction,
    children,
  }: {
    control: ReactNode;
    resetAction: ReactNode;
    children: ReactNode;
  }) => (
    <>
      {control}
      {resetAction}
      {children}
    </>
  ),
  SettingResetButton: ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button aria-label={`Reset ${label}`} onClick={onClick} />
  ),
}));
vi.mock("../ui/switch", () => ({
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked: boolean;
    onCheckedChange: (value: boolean) => void;
  }) => <button {...props} onClick={() => onCheckedChange(!checked)} />,
}));
vi.mock("../ui/select", () => {
  const Content = ({ children }: { children: ReactNode }) => <>{children}</>;
  return {
    Select: Content,
    SelectTrigger: Content,
    SelectValue: Content,
    SelectPopup: Content,
    SelectItem: Content,
  };
});
vi.mock("./ProviderAccentColorPicker", () => ({ ProviderAccentColorPicker: () => null }));
vi.mock("../ThreadStatusIndicators", () => ({
  ThreadStatusLabel: () => null,
  ThreadWorktreeIndicator: () => null,
}));
vi.mock("../../environmentIcons", () => ({ EnvironmentIcon: () => null }));

let renderer: ReactTestRenderer;
beforeEach(() => {
  state.settings = { ...DEFAULT_CLIENT_SETTINGS };
  state.writes.mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});
function control(label: string) {
  return renderer.root
    .findAllByProps({ "aria-label": label })
    .find((node) => typeof node.type === "string")!;
}
async function render(node: ReactNode) {
  await act(() => {
    renderer = create(node);
  });
}
async function refresh(node: ReactNode) {
  await act(() => renderer.update(node));
}
async function input(label: string, value: string) {
  await act(() => control(label).props.onChange({ currentTarget: { value } }));
}

describe("LastCode appearance preferences", () => {
  it("retains a custom fill across outline mode and resets style and fill independently", async () => {
    state.settings.incomingMessageFillColor = "#123456";
    await render(<LastCodeMessageAppearanceSettings />);
    await act(() => renderer.root.findByType(Select).props.onValueChange("outline"));
    await refresh(<LastCodeMessageAppearanceSettings />);
    expect(renderer.root.findAllByType(ProviderAccentColorPicker)).toHaveLength(0);
    expect(state.settings.incomingMessageFillColor).toBe("#123456");
    await act(() => control("Reset incoming message style").props.onClick());
    await refresh(<LastCodeMessageAppearanceSettings />);
    expect(renderer.root.findByType(ProviderAccentColorPicker).props.value).toBe("#123456");
    await act(() => control("Reset incoming message fill color").props.onClick());
    expect(state.settings.incomingMessageFillColor).toBeNull();
    expect(state.settings.incomingMessageStyle).toBe("neutral");
  });

  it("rejects invalid handoff limits and persists each valid boundary", async () => {
    await render(<LastCodeHandoffSettings />);
    const field = control("Handoffs shown in menus");
    for (const value of [String(field.props.min - 1), String(field.props.max + 1), "1.5", "NaN"])
      await input("Handoffs shown in menus", value);
    expect(state.writes).not.toHaveBeenCalled();
    await input("Handoffs shown in menus", String(field.props.min));
    expect(state.settings.handoffsMenuLimit).toBe(field.props.min);
    await input("Handoffs shown in menus", String(field.props.max));
    expect(state.settings.handoffsMenuLimit).toBe(field.props.max);
  });

  it("keeps scrollbar sizing while disabled and restores each dimension independently", async () => {
    state.settings = {
      ...state.settings,
      largerScrollbarsEnabled: true,
      scrollbarWidth: 12,
      scrollbarMargin: 5,
    };
    await render(<LastCodeScrollbarSettings />);
    await input("Scrollbar width", "NaN");
    expect(state.writes).not.toHaveBeenCalled();
    await act(() => control("Larger scrollbars").props.onClick());
    await refresh(<LastCodeScrollbarSettings />);
    expect(renderer.root.findAllByType("input")).toHaveLength(0);
    expect(state.settings.scrollbarWidth).toBe(12);
    await act(() => control("Larger scrollbars").props.onClick());
    await refresh(<LastCodeScrollbarSettings />);
    await act(() => control("Reset scrollbar width").props.onClick());
    expect(state.settings.scrollbarWidth).toBe(DEFAULT_CLIENT_SETTINGS.scrollbarWidth);
    expect(state.settings.scrollbarMargin).toBe(5);
    await act(() => control("Reset scrollbar margin").props.onClick());
    expect(state.settings.scrollbarMargin).toBe(DEFAULT_CLIENT_SETTINGS.scrollbarMargin);
  });

  it("keeps sidebar preferences independent when disabling LastCode and resetting scale and grouping", async () => {
    state.settings = {
      ...state.settings,
      lastcodeSidebarEnabled: true,
      legacySidebarScale: 90,
      legacySidebarThreadGroupingStyle: "typed-groups",
    };
    await render(<LastCodeSidebarSettings />);
    await act(() => control("LastCode sidebar").props.onClick());
    expect(state.settings.lastcodeSidebarEnabled).toBe(false);
    expect(state.settings.legacySidebarScale).toBe(90);
    await input("Scale LastCode sidebar", "1000");
    expect(state.settings.legacySidebarScale).toBe(90);
    await act(() => control("Reset LastCode sidebar scale").props.onClick());
    expect(state.settings.legacySidebarScale).toBe(DEFAULT_CLIENT_SETTINGS.legacySidebarScale);
    expect(state.settings.legacySidebarThreadGroupingStyle).toBe("typed-groups");
    await act(() => control("Reset thread grouping style").props.onClick());
    expect(state.settings.legacySidebarThreadGroupingStyle).toBe("minimal");
  });
});
