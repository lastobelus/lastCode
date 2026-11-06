import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { type ReactElement, type ReactNode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { LastCodeMessageAppearanceSettings } from "./LastCodeMessageAppearanceSettings";
import { LastCodeScrollbarSettings } from "./LastCodeScrollbarSettings";
import { LastCodeHandoffSettings } from "./LastCodeHandoffSettings";
import { LastCodeSidebarSettings } from "./LastCodeSidebarSettings";

const state = vi.hoisted(() => ({ settings: {} as ClientSettings, writes: vi.fn() }));
vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: () => state.settings,
  updateClientSettings: (patch: Partial<ClientSettings>) => {
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
vi.mock("../ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: ReactNode;
    value: string;
    onValueChange: (value: string) => void;
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.currentTarget.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectPopup: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
}));
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
vi.mock("../ThreadStatusIndicators", () => ({
  ThreadStatusLabel: () => null,
  ThreadWorktreeIndicator: () => null,
}));
vi.mock("../../environmentIcons", () => ({ EnvironmentIcon: () => null }));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  state.settings = { ...DEFAULT_CLIENT_SETTINGS };
  state.writes.mockClear();
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
function control(label: string) {
  return host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
}
async function render(node: ReactElement) {
  await act(() => {
    root.render(node);
  });
}
async function refresh(node: ReactElement) {
  await act(() => root.render(node));
}
async function input(label: string, value: string) {
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      control(label),
      value,
    );
    control(label).dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("LastCode appearance preferences", () => {
  it("retains a custom fill across outline mode and resets style and fill independently", async () => {
    state.settings = { ...state.settings, incomingMessageFillColor: "#123456" };
    await render(<LastCodeMessageAppearanceSettings />);
    await act(() => {
      const select = host.querySelector("select")!;
      select.value = "outline";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await refresh(<LastCodeMessageAppearanceSettings />);
    expect(host.querySelector('[aria-label="incoming messages"]')).toBeNull();
    expect(state.settings.incomingMessageFillColor).toBe("#123456");
    await act(() => control("Reset incoming message style").click());
    await refresh(<LastCodeMessageAppearanceSettings />);
    expect(control("incoming messages").value).toBe("#123456");
    await act(() => control("Reset incoming message fill color").click());
    expect(state.settings.incomingMessageFillColor).toBeNull();
    expect(state.settings.incomingMessageStyle).toBe("neutral");
  });

  it("rejects invalid handoff limits and persists each valid boundary", async () => {
    await render(<LastCodeHandoffSettings />);
    const field = control("Handoffs shown in menus");
    for (const value of [
      String(Number(field.min) - 1),
      String(Number(field.max) + 1),
      "1.5",
      "NaN",
    ])
      await input("Handoffs shown in menus", value);
    expect(state.writes).not.toHaveBeenCalled();
    await input("Handoffs shown in menus", String(Number(field.min)));
    expect(state.settings.handoffsMenuLimit).toBe(Number(field.min));
    await input("Handoffs shown in menus", String(Number(field.max)));
    expect(state.settings.handoffsMenuLimit).toBe(Number(field.max));
  });

  it("keeps scrollbar sizing while disabled and restores each dimension independently", async () => {
    state.settings = {
      ...state.settings,
      largerScrollbarsEnabled: true,
      scrollbarWidth: 12,
      scrollbarMargin: 5,
    };
    await render(<LastCodeScrollbarSettings />);
    await act(() => control("Larger scrollbars").click());
    await refresh(<LastCodeScrollbarSettings />);
    expect([...host.querySelectorAll<HTMLInputElement>('input[type="range"]')]).toHaveLength(0);
    expect(state.settings.scrollbarWidth).toBe(12);
    await act(() => control("Larger scrollbars").click());
    await refresh(<LastCodeScrollbarSettings />);
    await act(() => control("Reset scrollbar width").click());
    expect(state.settings.scrollbarWidth).toBe(DEFAULT_CLIENT_SETTINGS.scrollbarWidth);
    expect(state.settings.scrollbarMargin).toBe(5);
    await act(() => control("Reset scrollbar margin").click());
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
    await act(() => control("LastCode sidebar").click());
    expect(state.settings.lastcodeSidebarEnabled).toBe(false);
    expect(state.settings.legacySidebarScale).toBe(90);
    await act(() => control("Reset LastCode sidebar scale").click());
    expect(state.settings.legacySidebarScale).toBe(DEFAULT_CLIENT_SETTINGS.legacySidebarScale);
    expect(state.settings.legacySidebarThreadGroupingStyle).toBe("typed-groups");
    await act(() => control("Reset thread grouping style").click());
    expect(state.settings.legacySidebarThreadGroupingStyle).toBe("minimal");
  });
});
