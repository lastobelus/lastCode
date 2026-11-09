import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
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
let promises: Promise<void>[];
function Harness({
  cleanup = null,
  mobile = false,
  renaming = false,
}: {
  cleanup?: typeof thread.worktreeCleanup;
  mobile?: boolean;
  renaming?: boolean;
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
let root: Root, container: HTMLDivElement;
const original = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
beforeAll(() =>
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  }),
);
afterAll(() => {
  if (original) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", original);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.allowed = true;
  mocks.menu.mockResolvedValue();
  mocks.bulk.mockResolvedValue();
  promises = [];
  useThreadSelectionStore.getState().clearSelection();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  useThreadSelectionStore.getState().clearSelection();
});
async function render(props: Parameters<typeof Harness>[0] = {}) {
  await act(() => root.render(<Harness {...props} />));
}
const row = () => container.querySelector<HTMLElement>('[data-testid="row"]')!;
async function key(value: string, nested = false, shiftKey = false) {
  await act(async () => {
    (nested ? container.querySelector("button")! : row()).dispatchEvent(
      new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true }),
    );
    await Promise.all(promises);
  });
}
async function context() {
  await act(async () => {
    row().dispatchEvent(
      new MouseEvent("contextmenu", { clientX: 11, clientY: 22, bubbles: true, cancelable: true }),
    );
    await Promise.all(promises);
  });
}
describe("row activation and menu routing", () => {
  it.each(cleanups)(
    "keeps pointer and keyboard cleanup gates equivalent for $status",
    async (cleanup) => {
      await render({ cleanup });
      await act(() => row().click());
      await key("Enter");
      expect(mocks.navigate).toHaveBeenCalledTimes(cleanup == null ? 2 : 0);
      expect(mocks.cleanup).toHaveBeenCalledTimes(cleanup?.status === "failed" ? 2 : 0);
    },
  );
  it("renames the exact destination on an ordinary row-body double click", async () => {
    await render();
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
      await render();
      await act(() =>
        row().dispatchEvent(new MouseEvent("dblclick", { bubbles: true, [modifier]: true })),
      );
      expect(mocks.rename).not.toHaveBeenCalled();
    },
  );
  it.each([{ mobile: true }, { renaming: true }, { cleanup: cleanups[1]! }])(
    "preserves mobile, editor and cleanup restrictions: %j",
    async (props) => {
      await render(props);
      await act(() => row().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
      expect(mocks.rename).not.toHaveBeenCalled();
    },
  );
  it("rereads destination permission and ignores nested controls for rename/navigation/menu keys", async () => {
    await render();
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
      await render();
      await act(() => useThreadSelectionStore.getState().toggleThread(scopedThreadKey(threadRef)));
      vi.spyOn(row(), "getBoundingClientRect").mockReturnValue(new DOMRect(30, 40, 200, 24));
      await key(value, false, value === "F10");
      expect(mocks.bulk).toHaveBeenCalledExactlyOnceWith({ x: 46, y: 64 });
      expect(mocks.menu).not.toHaveBeenCalled();
      expect(mocks.navigate).not.toHaveBeenCalled();
    },
  );
  it("clears other selected entries before opening this exact row menu", async () => {
    await render();
    await act(() => useThreadSelectionStore.getState().toggleThread(foreignKey));
    await context();
    expect(useThreadSelectionStore.getState().hasSelection()).toBe(false);
    expect(mocks.menu).toHaveBeenCalledExactlyOnceWith(threadRef, { x: 11, y: 22 }, true);
    expect(mocks.bulk).not.toHaveBeenCalled();
  });
  it.each(cleanups.slice(1))(
    "never opens or clears selection for cleanup $status",
    async (cleanup) => {
      await render({ cleanup });
      await act(() => useThreadSelectionStore.getState().toggleThread(foreignKey));
      await context();
      expect(useThreadSelectionStore.getState().hasSelection()).toBe(true);
      expect(mocks.menu).not.toHaveBeenCalled();
      expect(mocks.bulk).not.toHaveBeenCalled();
    },
  );
  it("reports rejected single and bulk menu work without navigation or unintended selection cleanup", async () => {
    await render();
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
