import type { DesktopBridge } from "@t3tools/contracts";
import { type ReactNode, act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { LastCodeImportSettings } from "./LastCodeImportSettings";
import { LastCodeLocalUpdatesSettings } from "./LastCodeLocalUpdatesSettings";

const state = vi.hoisted(() => ({
  desktop: true,
  update: null as { source: string; status: string } | null,
  toast: vi.fn(),
}));
vi.mock("../../env", () => ({
  get isElectron() {
    return state.desktop;
  },
}));
vi.mock("../../state/desktopUpdate", () => ({ useDesktopUpdateState: () => state.update }));
vi.mock("../ui/toast", () => ({
  stackedThreadToast: (value: unknown) => value,
  toastManager: { add: state.toast },
}));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => <>{children}</>,
  SettingsRow: ({ status, control }: { status: ReactNode; control: ReactNode }) => (
    <>
      {status}
      {control}
    </>
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
  }) => <button {...props} aria-pressed={checked} onClick={() => onCheckedChange(!checked)} />,
}));
vi.mock("../ui/button", () => ({
  Button: (props: Record<string, unknown>) => <button {...props} />,
}));

let renderer: ReactTestRenderer;
const preference = { supported: true, showAndInstallLocalNightlies: false, message: null };
const preview = {
  sourceDirectory: "/example/t3",
  destinationDirectory: "/example/lastcode",
  categories: [],
  excluded: [],
  canImport: true,
  message: null,
};

beforeEach(() => {
  state.desktop = true;
  state.update = null;
  state.toast.mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { desktopBridge: undefined });
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});
function setDesktopBridge(
  desktopBridge: Partial<
    Pick<
      DesktopBridge,
      | "getLastCodeSettings"
      | "setShowAndInstallLocalNightlies"
      | "previewT3SettingsImport"
      | "importT3Settings"
    >
  >,
) {
  vi.stubGlobal("window", { desktopBridge });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function button() {
  return renderer.root.findByType("button");
}

describe("LastCode desktop settings", () => {
  it("keeps web controls disabled without requiring a desktop bridge", async () => {
    state.desktop = false;
    await act(() => {
      renderer = create(<LastCodeLocalUpdatesSettings />);
    });
    expect(button().props.disabled).toBe(true);
    await act(() => renderer.update(<LastCodeImportSettings />));
    expect(button().props.disabled).toBe(true);
    expect(state.toast).not.toHaveBeenCalled();
  });

  it("loads the saved preference, disables during persistence and recovers after rejection", async () => {
    const write = deferred<typeof preference>();
    const save = vi.fn(() => write.promise);
    setDesktopBridge({
      getLastCodeSettings: async () => preference,
      setShowAndInstallLocalNightlies: save,
    });
    await act(() => {
      renderer = create(<LastCodeLocalUpdatesSettings />);
    });
    expect(button().props.disabled).toBe(false);
    await act(() => button().props.onClick());
    expect(button().props.disabled).toBe(true);
    expect(save).toHaveBeenCalledExactlyOnceWith(true);
    await act(() => write.reject(new Error("write failed")));
    expect(button().props.disabled).toBe(false);
    expect(button().props["aria-pressed"]).toBe(false);
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Could not change local nightly updates",
        description: "write failed",
      }),
    );
  });

  it("uses the persisted response and blocks toggles while a local update is ready", async () => {
    setDesktopBridge({
      getLastCodeSettings: async () => preference,
      setShowAndInstallLocalNightlies: async () => ({
        ...preference,
        showAndInstallLocalNightlies: true,
      }),
    });
    await act(() => {
      renderer = create(<LastCodeLocalUpdatesSettings />);
    });
    await act(() => button().props.onClick());
    expect(button().props["aria-pressed"]).toBe(true);
    state.update = { source: "lastcode-local", status: "downloaded" };
    await act(() => renderer.update(<LastCodeLocalUpdatesSettings />));
    expect(button().props.disabled).toBe(true);
  });

  it("leaves import disabled after success for restart, and reports the backup location", async () => {
    const operation = deferred<{ imported: []; backupDirectory: string }>();
    setDesktopBridge({
      previewT3SettingsImport: async () => preview,
      importT3Settings: () => operation.promise,
    });
    await act(() => {
      renderer = create(<LastCodeImportSettings />);
    });
    expect(button().props.disabled).toBe(false);
    await act(() => button().props.onClick());
    expect(button().props.disabled).toBe(true);
    await act(() => operation.resolve({ imported: [], backupDirectory: "/example/backup" }));
    expect(button().props.disabled).toBe(true);
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "success",
        description: expect.stringContaining("/example/backup"),
      }),
    );
  });

  it("allows retry after a failed import without reloading its preview", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("import failed"))
      .mockResolvedValue({ imported: [], backupDirectory: "/example/backup" });
    const inspect = vi.fn(async () => preview);
    setDesktopBridge({
      previewT3SettingsImport: inspect,
      importT3Settings: run,
    });
    await act(() => {
      renderer = create(<LastCodeImportSettings />);
    });
    await act(() => button().props.onClick());
    expect(button().props.disabled).toBe(false);
    await act(() => button().props.onClick());
    expect(run).toHaveBeenCalledTimes(2);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(button().props.disabled).toBe(true);
  });

  it("reports a preview read failure and keeps import unavailable", async () => {
    setDesktopBridge({
      previewT3SettingsImport: async () => {
        throw new Error("preview failed");
      },
    });
    await act(() => {
      renderer = create(<LastCodeImportSettings />);
    });
    expect(button().props.disabled).toBe(true);
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Could not inspect T3 Code settings",
        description: "preview failed",
      }),
    );
  });
});
