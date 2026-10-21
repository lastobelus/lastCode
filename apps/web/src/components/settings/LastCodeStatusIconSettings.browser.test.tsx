import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import type { ClientSettingsUpdate } from "../../hooks/useSettings";
import "../../index.css";
import { configurableThreadStatuses } from "../Sidebar.logic";
import { lastCodeStatusIcon } from "../../lastcodeStatusIcons";
import { LastCodeStatusIconSettings } from "./LastCodeStatusIconSettings";
import { TooltipProvider } from "../ui/tooltip";

const state = vi.hoisted(() => ({
  settings: {} as ClientSettings,
  listeners: new Set<() => void>(),
}));
vi.mock("../../hooks/useSettings", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    usePrimarySettings: () =>
      useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener);
          return () => state.listeners.delete(listener);
        },
        () => state.settings,
      ),
    usePrimarySettingsAvailable: () => true,
    updateClientSettings: (patch: ClientSettingsUpdate) => {
      state.settings = {
        ...state.settings,
        ...(typeof patch === "function" ? patch(state.settings) : patch),
      };
      state.listeners.forEach((listener) => listener());
    },
  };
});
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({
    children,
    resetAction,
  }: {
    children: React.ReactNode;
    resetAction: React.ReactNode;
  }) => (
    <>
      {resetAction}
      {children}
    </>
  ),
  SettingResetButton: ({ onClick }: { onClick: () => void }) => (
    <button onClick={onClick}>Reset status icons</button>
  ),
}));

let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.settings = { ...DEFAULT_CLIENT_SETTINGS };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(() =>
    root.render(
      <TooltipProvider>
        <LastCodeStatusIconSettings />
      </TooltipProvider>,
    ),
  );
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("offers every upstream presentation, keeps operational labels on circles, and selects with the keyboard", async () => {
  expect(host.querySelectorAll('[role="combobox"]')).toHaveLength(
    configurableThreadStatuses.length,
  );
  expect(host.textContent).not.toMatch(/Deleting|Question|Cleanup failed|Needs repair|Archiving/);
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Working status icon"]')!;
  await act(() => trigger.focus());
  await act(() => userEvent.keyboard("{Enter}"));
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(15);
  await act(() => userEvent.keyboard("{Home}{Enter}"));
  expect(state.settings.lastcodeStatusIcons).toEqual({
    Working: { shape: "triangle", style: "open" },
  });
  expect(lastCodeStatusIcon("Deleting", { Deleting: { shape: "square", style: "solid" } })).toEqual(
    { shape: "circle", style: "solid" },
  );
  expect(lastCodeStatusIcon("An arbitrary status", {})).toEqual({
    shape: "circle",
    style: "solid",
  });
  expect(lastCodeStatusIcon("Completed", state.settings.lastcodeStatusIcons)).toEqual({
    shape: "circle",
    style: "solid",
  });
  const preview = trigger.parentElement!.querySelector('[data-status-shape="triangle"]');
  expect(preview).not.toBeNull();
  await act(() => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(state.settings.lastcodeStatusIcons).toEqual({});
});
