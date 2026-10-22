import { act, render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import { AuthOrchestrationOperateScope, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { makeThreadFixture } from "../../test-fixtures";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import {
  activateLastCodeThreadRow,
  renameLastCodeThreadRow,
  handleLastCodeThreadRowKeyDown,
  openLastCodeThreadRowMenu,
} from "./lastcodeThreadRowInteractions";
const mocks = vi.hoisted(() => ({
  allowed: true,
  permission: vi.fn(),
  rename: vi.fn(),
  navigate: vi.fn(),
  cleanup: vi.fn(),
  bulk: vi.fn<() => Promise<void>>(),
  menu: vi.fn<() => Promise<void>>(),
  toast: vi.fn(),
}));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: (...args: unknown[]) => {
    mocks.permission(...args);
    return mocks.allowed;
  },
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: mocks.toast },
  stackedThreadToast: (value: unknown) => value,
}));
const thread = makeThreadFixture({
  environmentId: EnvironmentId.make("destination"),
  id: ThreadId.make("row"),
  title: "Row",
});
const threadRef = scopeThreadRef(thread.environmentId, thread.id);
const foreignKey = scopedThreadKey(scopeThreadRef(EnvironmentId.make("other"), thread.id));
const cleanups = [
  null,
  {
    status: "queued",
    repositoryRoot: "/workspace",
    worktreePath: "/workspace-worktrees/recovery",
    queuedAt: "2026-01-01T00:00:00.000Z",
    blockedByThreadId: ThreadId.make("blocker"),
  },
  {
    status: "deleting",
    repositoryRoot: "/workspace",
    worktreePath: "/workspace-worktrees/recovery",
    startedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    status: "failed",
    repositoryRoot: "/workspace",
    worktreePath: "/workspace-worktrees/recovery",
    startedAt: "2026-01-01T00:00:00.000Z",
    failedAt: "2026-01-01T00:01:00.000Z",
    error: "Busy",
  },
] satisfies Array<typeof thread.worktreeCleanup>;
function Harness({
  cleanup = null,
  mobile = false,
  renaming = false,
  promises,
}: {
  cleanup?: typeof thread.worktreeCleanup;
  mobile?: boolean;
  renaming?: boolean;
  promises: Promise<void>[];
}) {
  const value = { ...thread, worktreeCleanup: cleanup ?? null };
  const selected = useThreadSelectionStore((state) =>
    state.selectedThreadKeys.has(scopedThreadKey(threadRef)),
  );
  const activate = () => activateLastCodeThreadRow(value, mocks.navigate, mocks.cleanup);
  return (
    <div
      tabIndex={0}
      data-testid="row"
      onClick={(event) => activateLastCodeThreadRow(value, mocks.navigate, mocks.cleanup, event)}
      onDoubleClick={(event) =>
        renameLastCodeThreadRow(
          event,
          value,
          { isMobile: mobile, renameActive: renaming },
          mocks.rename,
        )
      }
      onKeyDown={(event) => handleLastCodeThreadRowKeyDown(event, activate)}
      onContextMenu={(event) => {
        promises.push(
          openLastCodeThreadRowMenu(
            event,
            threadRef,
            { cleanupBlocked: cleanup != null, isSelected: selected, hasStoppableProcesses: true },
            {
              showThreadMenu: mocks.menu,
              showBulkMenu: mocks.bulk,
              clearSelection: useThreadSelectionStore.getState().clearSelection,
            },
          ),
        );
      }}
    >
      <span>Row body</span>
      <button>Nested control</button>
      <a href="#nested">Link</a>
    </div>
  );
}
function setup() {
  vi.clearAllMocks();
  mocks.allowed = true;
  mocks.menu.mockResolvedValue();
  mocks.bulk.mockResolvedValue();
  useThreadSelectionStore.getState().clearSelection();
  return { [Symbol.dispose]: () => useThreadSelectionStore.getState().clearSelection() };
}
async function renderRow(props: Omit<Parameters<typeof Harness>[0], "promises"> = {}) {
  const promises: Promise<void>[] = [];
  const screen = await render(<Harness {...props} promises={promises} />, { router: false });
  const row = () => screen.container.querySelector<HTMLElement>('[data-testid="row"]')!;
  return Object.assign(screen, {
    row,
    key: (value: string, nested = false, shiftKey = false) =>
      act(async () => {
        (nested ? screen.container.querySelector("button")! : row()).dispatchEvent(
          new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true }),
        );
        await Promise.all(promises);
      }),
    context: () =>
      act(async () => {
        row().dispatchEvent(
          new MouseEvent("contextmenu", {
            clientX: 11,
            clientY: 22,
            bubbles: true,
            cancelable: true,
          }),
        );
        await Promise.all(promises);
      }),
  });
}
describe("row activation and menu routing", () => {
  it.each(cleanups)(
    "keeps pointer and keyboard cleanup gates equivalent for $status",
    async (cleanup) => {
      using _fixture = setup();
      await using screen = await renderRow({ cleanup });
      const { row, key } = screen;
      await act(() => row().click());
      await key("Enter");
      expect(mocks.navigate).toHaveBeenCalledTimes(cleanup == null ? 2 : 0);
      expect(mocks.cleanup).toHaveBeenCalledTimes(cleanup?.status === "failed" ? 2 : 0);
    },
  );
  it("renames the exact destination on an ordinary row-body double click", async () => {
    using _fixture = setup();
    await using screen = await renderRow();
    const { container } = screen;
    await act(() =>
      container
        .querySelector("span")!
        .dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })),
    );
    expect(mocks.rename).toHaveBeenCalledExactlyOnceWith(threadRef, thread.title);
    expect(mocks.permission).toHaveBeenCalledWith(
      thread.environmentId,
      AuthOrchestrationOperateScope,
    );
  });
  it.each(["metaKey", "ctrlKey", "shiftKey", "altKey"])(
    "leaves %s double clicks to selection",
    async (modifier) => {
      using _fixture = setup();
      await using screen = await renderRow();
      const { row } = screen;
      await act(() =>
        row().dispatchEvent(new MouseEvent("dblclick", { bubbles: true, [modifier]: true })),
      );
      expect(mocks.rename).not.toHaveBeenCalled();
    },
  );
  it.each([{ mobile: true }, { renaming: true }, { cleanup: cleanups[1]! }])(
    "preserves mobile, editor and cleanup restrictions: %j",
    async (props) => {
      using _fixture = setup();
      await using screen = await renderRow(props);
      const { row } = screen;
      await act(() => row().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
      expect(mocks.rename).not.toHaveBeenCalled();
    },
  );
  it("rereads destination permission and ignores nested controls for rename/navigation/menu keys", async () => {
    using _fixture = setup();
    await using screen = await renderRow();
    const { row, key, container } = screen;
    mocks.allowed = false;
    await act(() => row().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    mocks.allowed = true;
    await act(() =>
      container
        .querySelector("button")!
        .dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
    );
    await key("Enter", true);
    await key("ContextMenu", true);
    expect(mocks.rename).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.menu).not.toHaveBeenCalled();
  });
  it.each(["ContextMenu", "F10"])(
    "routes %s through the same selected bulk menu and anchor",
    async (value) => {
      using _fixture = setup();
      await using screen = await renderRow();
      const { row, key } = screen;
      await act(() => useThreadSelectionStore.getState().toggleThread(scopedThreadKey(threadRef)));
      using _bounds = vi
        .spyOn(row(), "getBoundingClientRect")
        .mockReturnValue(new DOMRect(30, 40, 200, 24));
      await key(value, false, value === "F10");
      expect(mocks.bulk).toHaveBeenCalledExactlyOnceWith({ x: 46, y: 64 });
      expect(mocks.menu).not.toHaveBeenCalled();
      expect(mocks.navigate).not.toHaveBeenCalled();
    },
  );
  it("clears other selected entries before opening this exact row menu", async () => {
    using _fixture = setup();
    await using screen = await renderRow();
    const { context } = screen;
    await act(() => useThreadSelectionStore.getState().toggleThread(foreignKey));
    await context();
    expect(useThreadSelectionStore.getState().hasSelection()).toBe(false);
    expect(mocks.menu).toHaveBeenCalledExactlyOnceWith(threadRef, { x: 11, y: 22 }, true);
    expect(mocks.bulk).not.toHaveBeenCalled();
  });
  it.each(cleanups.slice(1))(
    "never opens or clears selection for cleanup $status",
    async (cleanup) => {
      using _fixture = setup();
      await using screen = await renderRow({ cleanup });
      const { context } = screen;
      await act(() => useThreadSelectionStore.getState().toggleThread(foreignKey));
      await context();
      expect(useThreadSelectionStore.getState().hasSelection()).toBe(true);
      expect(mocks.menu).not.toHaveBeenCalled();
      expect(mocks.bulk).not.toHaveBeenCalled();
    },
  );
  it("reports rejected single and bulk menu work without navigation or unintended selection cleanup", async () => {
    using _fixture = setup();
    await using screen = await renderRow();
    const { context } = screen;
    mocks.menu.mockRejectedValueOnce(new Error("Single failed"));
    await context();
    expect(mocks.toast).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Thread action failed", description: "Single failed" }),
    );
    await act(() => useThreadSelectionStore.getState().toggleThread(scopedThreadKey(threadRef)));
    mocks.bulk.mockRejectedValueOnce(new Error("Bulk failed"));
    await context();
    expect(mocks.toast).toHaveBeenLastCalledWith(
      expect.objectContaining({ description: "Bulk failed" }),
    );
    expect(useThreadSelectionStore.getState().hasSelection()).toBe(true);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});
