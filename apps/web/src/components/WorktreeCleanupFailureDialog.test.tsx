import { renderToStaticMarkup } from "react-dom/server";
import type { SidebarThreadSummary } from "../types";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  copy: vi.fn(),
  copyDetails: undefined as (() => void) | undefined,
  copyOptions: undefined as { onError?: (error: unknown) => void } | undefined,
  toast: vi.fn(),
}));

vi.mock("../hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: (options: { onError?: (error: unknown) => void }) => {
    testState.copyOptions = options;
    return { copyToClipboard: (value: string) => testState.copy(value) };
  },
}));
vi.mock("../state/threads", () => ({
  threadEnvironment: {
    abandonWorktreeCleanup: Symbol("abandonWorktreeCleanup"),
    retryWorktreeCleanup: Symbol("retryWorktreeCleanup"),
  },
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(),
}));
vi.mock("./ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: testState.toast },
}));
vi.mock("./ui/button", () => ({
  Button: (props: { children?: unknown; onClick?: () => void }) => {
    if (props.children === "Copy details") testState.copyDetails = props.onClick;
    return null;
  },
}));
vi.mock("./ui/dialog", () => {
  const passthrough = ({ children }: { children?: unknown }) => children;
  return {
    Dialog: passthrough,
    DialogDescription: passthrough,
    DialogFooter: passthrough,
    DialogHeader: passthrough,
    DialogPanel: passthrough,
    DialogPopup: passthrough,
    DialogTitle: passthrough,
  };
});

import { WorktreeCleanupFailureDialog } from "./WorktreeCleanupFailureDialog";

const failedThread = {
  environmentId: "environment-test",
  id: "thread-test",
  title: "Deleted thread",
  worktreeCleanup: {
    status: "failed",
    repositoryRoot: "/repo",
    worktreePath: "/repo-worktrees/deleted",
    startedAt: "2026-08-24T10:00:00.000Z",
    failedAt: "2026-08-24T10:01:00.000Z",
    error: "permission denied",
  },
} as SidebarThreadSummary;

function renderDialog(): void {
  renderToStaticMarkup(
    <WorktreeCleanupFailureDialog thread={failedThread} open onOpenChange={() => undefined} />,
  );
}

describe("WorktreeCleanupFailureDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.copyDetails = undefined;
    testState.copyOptions = undefined;
  });

  it("routes Copy details through the guarded clipboard helper", () => {
    renderDialog();

    testState.copyDetails?.();

    expect(testState.copy).toHaveBeenCalledWith(
      expect.stringContaining("Worktree: /repo-worktrees/deleted"),
    );
  });

  it("reports clipboard failures instead of throwing from the click handler", () => {
    renderDialog();

    testState.copyOptions?.onError?.(new Error("Clipboard API is unavailable"));

    expect(testState.toast).toHaveBeenCalledWith({
      type: "error",
      title: "Could not copy worktree cleanup details",
      description: "Clipboard API is unavailable",
    });
  });
});
