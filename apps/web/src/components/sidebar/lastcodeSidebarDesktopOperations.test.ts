import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";
import {
  downloadLastCodeSidebarUpdate,
  installLastCodeSidebarUpdate,
} from "./lastcodeSidebarDesktopOperations";

const mocks = vi.hoisted(() => ({ confirm: vi.fn(), toast: vi.fn(), downloaded: vi.fn() }));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ dialogs: { confirm: mocks.confirm } }),
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: mocks.toast },
  stackedThreadToast: (value: unknown) => value,
}));
vi.mock("../desktopUpdate.toast", () => ({ showDesktopUpdateDownloadedToast: mocks.downloaded }));
const state: DesktopUpdateState = {
  enabled: true,
  source: "hosted",
  status: "downloaded",
  channel: "latest",
  currentVersion: "1.0.0",
  hostArch: "arm64",
  appArch: "x64",
  runningUnderArm64Translation: true,
  availableVersion: "1.1.0",
  downloadedVersion: "1.1.0",
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  localBuildProgress: null,
  localBuildFailure: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};
const result = (message: string | null = null, completed = false): DesktopUpdateActionResult => ({
  accepted: true,
  completed,
  state: { ...state, message },
});
function bridge() {
  return {
    downloadUpdate: vi.fn<() => Promise<DesktopUpdateActionResult>>(),
    installUpdate: vi.fn<() => Promise<DesktopUpdateActionResult>>(),
    openExternal: vi.fn(async () => true),
  };
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
function completion() {
  const done = deferred<void>();
  const pending = vi.fn((value: boolean) => {
    if (!value) done.resolve();
  });
  return { pending, done: done.promise };
}
beforeEach(() => vi.clearAllMocks());
describe("LastCode update operations", () => {
  it("keeps download pending until IPC completes, then presents downloaded result", async () => {
    const shell = bridge(),
      ipc = deferred<DesktopUpdateActionResult>(),
      finish = completion();
    shell.downloadUpdate.mockReturnValue(ipc.promise);
    downloadLastCodeSidebarUpdate(shell, finish.pending);
    expect(finish.pending).not.toHaveBeenCalled();
    ipc.resolve(result(null, true));
    await finish.done;
    expect(mocks.downloaded).toHaveBeenCalledWith(
      shell,
      expect.objectContaining({ downloadedVersion: "1.1.0" }),
    );
    expect(mocks.toast).not.toHaveBeenCalled();
  });
  it.each([false, true])("reports download %s failure and releases pending", async (rejected) => {
    const shell = bridge(),
      finish = completion();
    if (rejected) shell.downloadUpdate.mockRejectedValue(new Error("Unavailable"));
    else shell.downloadUpdate.mockResolvedValue(result("Unavailable"));
    downloadLastCodeSidebarUpdate(shell, finish.pending);
    await finish.done;
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: rejected ? "Could not start update download" : "Could not download update",
        description: "Unavailable",
      }),
    );
    expect(mocks.downloaded).not.toHaveBeenCalled();
  });
  it("does not install while confirmation is outstanding or cancelled", async () => {
    const shell = bridge(),
      choice = deferred<boolean>(),
      finish = completion();
    mocks.confirm.mockReturnValue(choice.promise);
    const operation = installLastCodeSidebarUpdate(shell, state, finish.pending);
    expect(shell.installUpdate).not.toHaveBeenCalled();
    choice.resolve(false);
    await operation;
    expect(shell.installUpdate).not.toHaveBeenCalled();
    expect(finish.pending).toHaveBeenCalledWith(false);
    expect(mocks.toast).not.toHaveBeenCalled();
  });
  it("reports confirmation failure without attempting install", async () => {
    const shell = bridge(),
      finish = completion();
    mocks.confirm.mockRejectedValue(new Error("Dialog failed"));
    await installLastCodeSidebarUpdate(shell, state, finish.pending);
    expect(shell.installUpdate).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not confirm update", description: "Dialog failed" }),
    );
    expect(finish.pending).toHaveBeenCalledWith(false);
  });
  it.each([false, true])(
    "installs after confirmation, preserving %s IPC failure",
    async (rejected) => {
      const shell = bridge(),
        finish = completion();
      mocks.confirm.mockResolvedValue(true);
      if (rejected) shell.installUpdate.mockRejectedValue(new Error("Install failed"));
      else shell.installUpdate.mockResolvedValue(result("Install failed"));
      await installLastCodeSidebarUpdate(shell, state, finish.pending);
      await finish.done;
      expect(mocks.confirm).toHaveBeenCalledWith(
        expect.stringContaining("Install update 1.1.0 and restart T3 Code?"),
      );
      expect(shell.installUpdate).toHaveBeenCalledOnce();
      expect(mocks.toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Could not install update",
          description: "Install failed",
        }),
      );
    },
  );
});
