import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { makeThreadFixture } from "../../test-fixtures";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { useLastCodeThreadRowGestures } from "./lastcodeThreadRowInteractions";
const mocks = vi.hoisted(() => ({
  mobile: false,
  allowed: true,
  navigate: vi.fn(async () => {}),
  click: vi.fn(),
  rename: vi.fn(),
  menu: vi.fn(async () => {}),
  bulk: vi.fn(async () => {}),
}));
vi.mock("../../hooks/useMediaQuery", () => ({ useIsMobile: () => mocks.mobile }));
vi.mock("../../state/session", () => ({ readEnvironmentScope: () => mocks.allowed }));
const first = makeThreadFixture({
  environmentId: EnvironmentId.make("first"),
  id: ThreadId.make("same"),
  title: "First",
});
const remote = { ...first, environmentId: EnvironmentId.make("remote"), title: "Remote" };
const firstRef = scopeThreadRef(first.environmentId, first.id),
  remoteRef = scopeThreadRef(remote.environmentId, remote.id);
const failed = {
  status: "failed",
  repositoryRoot: "/workspace",
  worktreePath: "/workspace-tree",
  startedAt: "2026-01-01T00:00:00Z",
  failedAt: "2026-01-01T00:01:00Z",
  error: "Busy",
} as const;
function Harness({
  thread = first,
  renameActive = false,
  stoppable = true,
}: {
  thread?: typeof first;
  renameActive?: boolean;
  stoppable?: boolean;
}) {
  const selected = useThreadSelectionStore((state) =>
    state.selectedThreadKeys.has(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
  );
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const gestures = useLastCodeThreadRowGestures(
    thread,
    { navigateToThread: mocks.navigate, handleThreadClick: mocks.click },
    {
      showThreadMenu: mocks.menu,
      showBulkMenu: mocks.bulk,
      clearSelection,
    },
    { selected, hasStoppableProcesses: stoppable, renameActive },
    mocks.rename,
  );
  return (
    <>
      <div
        data-testid="row"
        tabIndex={0}
        onClick={gestures.handleRowClick}
        onDoubleClick={gestures.handleRowDoubleClick}
        onKeyDown={gestures.handleRowKeyDown}
        onContextMenu={gestures.handleRowContextMenu}
      >
        <span>{thread.title}</span>
        <button>Nested</button>
      </div>
      {gestures.cleanupFailureOpen ? (
        <button onClick={() => gestures.setCleanupFailureOpen(false)}>Close cleanup failure</button>
      ) : null}
    </>
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
  mocks.mobile = false;
  mocks.allowed = true;
  useThreadSelectionStore.getState().clearSelection();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});
async function render(props: Parameters<typeof Harness>[0] = {}) {
  await act(() => root.render(<Harness {...props} />));
}
const row = () => container.querySelector('[data-testid="row"]')!;
async function key(value: string, nested = false) {
  await act(() =>
    (nested ? row().querySelector("button")! : row()).dispatchEvent(
      new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }),
    ),
  );
}
async function pointer(name: string) {
  await act(() =>
    row().dispatchEvent(
      new MouseEvent(name, { bubbles: true, cancelable: true, clientX: 11, clientY: 22 }),
    ),
  );
}
it("refreshes scoped pointer/keyboard/rename/menu destinations on one mounted row", async () => {
  await render();
  const before = row();
  await render({ thread: remote, stoppable: false });
  expect(row()).toBe(before);
  await pointer("click");
  expect(mocks.click).toHaveBeenCalledWith(expect.anything(), remoteRef);
  await key("Enter");
  expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith(remoteRef);
  await pointer("dblclick");
  expect(mocks.rename).toHaveBeenCalledExactlyOnceWith(remoteRef, remote.title);
  await pointer("contextmenu");
  expect(mocks.menu).toHaveBeenCalledExactlyOnceWith(remoteRef, { x: 11, y: 22 }, false);
});
it("owns cleanup failure state across rerenders and closes it without navigating", async () => {
  await render({ thread: { ...first, worktreeCleanup: failed } });
  await pointer("click");
  const close = container.querySelectorAll("button")[1]!;
  expect(close.textContent).toBe("Close cleanup failure");
  await render({ thread: { ...first, worktreeCleanup: failed }, renameActive: true });
  expect(container.querySelectorAll("button")[1]).toBe(close);
  await act(() => close.click());
  expect(container.querySelectorAll("button")).toHaveLength(1);
  await key("Enter");
  expect(container.querySelectorAll("button")).toHaveLength(2);
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(mocks.click).not.toHaveBeenCalled();
});
it("keeps pending cleanup rows inert and does not open menus or clear other selection", async () => {
  const pending = {
    status: "deleting",
    repositoryRoot: failed.repositoryRoot,
    worktreePath: failed.worktreePath,
    startedAt: failed.startedAt,
  } as const;
  await render({ thread: { ...first, worktreeCleanup: pending } });
  useThreadSelectionStore.getState().toggleThread(scopedThreadKey(remoteRef));
  await pointer("click");
  await key("Enter");
  await pointer("contextmenu");
  expect(container.querySelectorAll("button")).toHaveLength(1);
  expect(mocks.click).not.toHaveBeenCalled();
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(mocks.menu).not.toHaveBeenCalled();
  expect(useThreadSelectionStore.getState().hasSelection()).toBe(true);
});
it("reads selected state after store updates for native context-menu keys and isolates nested keys", async () => {
  await render();
  await key("Enter", true);
  await key("ContextMenu", true);
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(mocks.menu).not.toHaveBeenCalled();
  await act(() => useThreadSelectionStore.getState().toggleThread(scopedThreadKey(firstRef)));
  vi.spyOn(row(), "getBoundingClientRect").mockReturnValue(new DOMRect(30, 40, 200, 24));
  await key("ContextMenu");
  expect(mocks.bulk).toHaveBeenCalledExactlyOnceWith({ x: 46, y: 64 });
  expect(mocks.menu).not.toHaveBeenCalled();
});
it("preserves editor/mobile restrictions and checks permission at rename execution", async () => {
  await render();
  mocks.allowed = false;
  await pointer("dblclick");
  expect(mocks.rename).not.toHaveBeenCalled();
  mocks.allowed = true;
  await render({ renameActive: true });
  await pointer("dblclick");
  expect(mocks.rename).not.toHaveBeenCalled();
  mocks.mobile = true;
  await render();
  await pointer("dblclick");
  expect(mocks.rename).not.toHaveBeenCalled();
  mocks.mobile = false;
  await render();
  await pointer("dblclick");
  expect(mocks.rename).toHaveBeenCalledExactlyOnceWith(firstRef, first.title);
});
