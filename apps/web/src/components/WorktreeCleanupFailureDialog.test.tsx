import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import type { SidebarThreadSummary } from "../types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  copy: vi.fn(),
  copyOptions: undefined as { onError?: (error: unknown) => void } | undefined,
  toast: vi.fn(),
  retry: vi.fn(),
  abandon: vi.fn(),
  confirm: vi.fn(),
  close: vi.fn(),
}));

vi.mock("../hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: (options: { onError?: (error: unknown) => void }) => {
    testState.copyOptions = options;
    return { copyToClipboard: (value: string) => testState.copy(value) };
  },
}));
vi.mock("../state/threads", () => ({
  threadEnvironment: {
    abandonWorktreeCleanup: testState.abandon,
    retryWorktreeCleanup: testState.retry,
  },
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => command,
}));
vi.mock("../localApi", () => ({
  ensureLocalApi: () => ({ dialogs: { confirm: testState.confirm } }),
}));
vi.mock("./ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: testState.toast },
}));
vi.mock("./ui/button", () => ({ Button: "button" }));
vi.mock("./ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? children : null),
  DialogDescription: "p",
  DialogFooter: "footer",
  DialogHeader: "header",
  DialogPanel: "section",
  DialogPopup: "section",
  DialogTitle: "h2",
}));

import { makeThreadFixture } from "../test-fixtures";
import { filterSidebarV2VisibleThreads } from "./Sidebar.logic";
import { WorktreeCleanupFailureDialog } from "./WorktreeCleanupFailureDialog";

const failedThread = makeThreadFixture({
  title: "Deleted thread",
  archivedAt: "2026-08-24T09:00:00.000Z",
  deletedAt: "2026-08-24T10:00:00.000Z",
  worktreeCleanup: {
    status: "failed",
    repositoryRoot: "/repo",
    worktreePath: "/repo-worktrees/deleted",
    startedAt: "2026-08-24T10:00:00.000Z",
    failedAt: "2026-08-24T10:01:00.000Z",
    error: "permission denied",
  },
});

let renderer: ReactTestRenderer | null;

function renderRecovery(thread: SidebarThreadSummary = failedThread): void {
  const rows = filterSidebarV2VisibleThreads([thread], null);
  act(() => {
    const list = rows.map((row) => (
      <WorktreeCleanupFailureDialog key={row.id} thread={row} open onOpenChange={testState.close} />
    ));
    if (renderer) renderer.update(<>{list}</>);
    else renderer = create(<>{list}</>);
  });
}

function button(label: string) {
  return renderer!.root.findAllByType("button").find((item) => item.props.children === label)!;
}

describe("WorktreeCleanupFailureDialog", () => {
  beforeEach(() => {
    renderer = null;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    testState.copyOptions = undefined;
    testState.retry.mockResolvedValue({ _tag: "Success" });
    testState.abandon.mockResolvedValue({ _tag: "Success" });
    testState.confirm.mockResolvedValue(true);
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    vi.unstubAllGlobals();
  });

  it("offers Retry and Keep worktree for archived cleanup and removes them after settlement", async () => {
    renderRecovery();
    expect(button("Keep worktree")).toBeDefined();
    await act(async () => button("Retry").props.onClick());
    expect(testState.retry).toHaveBeenCalledWith({
      environmentId: failedThread.environmentId,
      input: { threadId: failedThread.id },
    });
    expect(testState.close).toHaveBeenCalledWith(false);

    renderRecovery({ ...failedThread, worktreeCleanup: null });
    expect(renderer!.toJSON()).toBeNull();
    expect(failedThread.archivedAt).toBe("2026-08-24T09:00:00.000Z");
  });

  it("keeps the recovery available when Keep worktree is declined, then dismisses it on confirmation", async () => {
    renderRecovery();
    testState.confirm.mockResolvedValueOnce(false);
    await act(async () => button("Keep worktree").props.onClick());
    expect(testState.abandon).not.toHaveBeenCalled();
    expect(testState.close).not.toHaveBeenCalled();
    expect(button("Retry")).toBeDefined();

    await act(async () => button("Keep worktree").props.onClick());
    expect(testState.abandon).toHaveBeenCalledWith({
      environmentId: failedThread.environmentId,
      input: { threadId: failedThread.id },
    });
    expect(testState.close).toHaveBeenCalledWith(false);
    renderRecovery({ ...failedThread, worktreeCleanup: null });
    expect(renderer!.toJSON()).toBeNull();
  });

  it("copies recovery details and reports clipboard failures", async () => {
    renderRecovery();
    await act(async () => button("Copy details").props.onClick());
    expect(testState.copy).toHaveBeenCalledWith(
      expect.stringContaining("Worktree: /repo-worktrees/deleted"),
    );
    testState.copyOptions?.onError?.(new Error("Clipboard API is unavailable"));
    expect(testState.toast).toHaveBeenCalledWith({
      type: "error",
      title: "Could not copy worktree cleanup details",
      description: "Clipboard API is unavailable",
    });
  });
});
