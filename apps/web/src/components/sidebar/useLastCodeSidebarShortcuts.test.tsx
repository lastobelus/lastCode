// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { makeThreadFixture } from "../../test-fixtures";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { THREAD_JUMP_HINT_SHOW_DELAY_MS } from "../Sidebar.logic";
import { useLastCodeSidebarShortcuts } from "./useLastCodeSidebarShortcuts";
const mocks = vi.hoisted(() => ({
  navigate: vi.fn(async () => {}),
  close: vi.fn(),
  mobile: false,
  bindings: [] as ResolvedKeybindingsConfig,
}));
const router = { navigate: mocks.navigate };
vi.mock("@tanstack/react-router", () => ({ useRouter: () => router }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.bindings }));
vi.mock("../../state/server", () => ({ primaryServerKeybindingsAtom: {} }));
vi.mock("../ui/sidebar", () => ({
  useSidebar: () => ({ isMobile: mocks.mobile, setOpenMobile: mocks.close }),
}));
const first = makeThreadFixture({
  environmentId: EnvironmentId.make("first"),
  id: ThreadId.make("same"),
});
const second = makeThreadFixture({ ...first, environmentId: EnvironmentId.make("second") });
const key = (thread: typeof first) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
const keys = [key(first), key(second)],
  threads = new Map([
    [key(first), first],
    [key(second), second],
  ]);
function binding(
  command: ResolvedKeybindingsConfig[number]["command"],
  key: string,
): ResolvedKeybindingsConfig[number] {
  return {
    command,
    shortcut: { key, modKey: true, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false },
    whenAst: { type: "not", node: { type: "identifier", name: "terminalFocus" } },
  };
}
function Harness({
  order = keys,
  current = key(first),
  map = threads,
  terminalOpen = false,
}: {
  order?: readonly string[];
  current?: string | null;
  map?: typeof threads;
  terminalOpen?: boolean;
}) {
  const value = useLastCodeSidebarShortcuts(order, map, {
    routeThreadRef: null,
    routeThreadKey: current,
    routeTerminalOpen: terminalOpen,
  });
  return (
    <>
      <div data-thread-selection-safe="" data-testid="safe">
        Safe
      </div>
      <div data-testid="outside">Outside</div>
      <output>{[...value.visibleThreadJumpLabelByKey.values()].join(",")}</output>
    </>
  );
}
let root: Root, container: HTMLDivElement;
const original = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT"),
  platform = Object.getOwnPropertyDescriptor(navigator, "platform");
beforeEach(() => {
  vi.clearAllMocks();
  mocks.mobile = false;
  mocks.bindings = [
    binding("thread.next", "]"),
    binding("thread.previous", "["),
    binding("thread.jump.2", "2"),
  ];
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(navigator, "platform", { configurable: true, value: "Linux" });
  useThreadSelectionStore.getState().clearSelection();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  useThreadSelectionStore.getState().clearSelection();
  vi.useRealTimers();
  if (original) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", original);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  if (platform) Object.defineProperty(navigator, "platform", platform);
  else Reflect.deleteProperty(navigator, "platform");
});
async function press(key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  await act(() => window.dispatchEvent(event));
  return event;
}
describe("root native shortcut arbitration", () => {
  it("navigates exact colliding-environment targets, clears selection, anchors and closes mobile", async () => {
    mocks.mobile = true;
    await act(() => root.render(<Harness />));
    useThreadSelectionStore.getState().toggleThread(key(first));
    const next = await press("]");
    expect(next.defaultPrevented).toBe(true);
    expect(mocks.navigate).toHaveBeenLastCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: second.environmentId, threadId: second.id },
    });
    expect(useThreadSelectionStore.getState().selectedThreadKeys.size).toBe(0);
    expect(useThreadSelectionStore.getState().anchorThreadKey).toBe(key(second));
    expect(mocks.close).toHaveBeenCalledWith(false);
    await press("2");
    expect(mocks.navigate).toHaveBeenCalledTimes(2);
  });
  it.each(["repeat", "prevented", "palette", "model"] as const)(
    "does not consume a %s key event",
    async (guard) => {
      await act(() => root.render(<Harness />));
      const marker = document.createElement("div");
      if (guard === "palette") marker.setAttribute("data-command-palette", "");
      if (guard === "model") marker.setAttribute("data-model-picker-content", "");
      container.append(marker);
      const event = new KeyboardEvent("keydown", {
        key: "]",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
        repeat: guard === "repeat",
      });
      if (guard === "prevented") event.preventDefault();
      await act(() => window.dispatchEvent(event));
      expect(mocks.navigate).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(guard === "prevented");
    },
  );
  it("reads terminal focus at event time and ignores absent targets or traversal edges", async () => {
    await act(() => root.render(<Harness />));
    const terminal = document.createElement("div"),
      input = document.createElement("input");
    terminal.dataset.terminalOwner = "drawer";
    terminal.append(input);
    container.append(terminal);
    await act(() => input.focus());
    expect((await press("]")).defaultPrevented).toBe(false);
    expect(mocks.navigate).not.toHaveBeenCalled();
    await act(() => input.blur());
    await act(() => root.render(<Harness current={key(second)} />));
    expect((await press("]")).defaultPrevented).toBe(false);
    await act(() => root.render(<Harness map={new Map([[key(first), first]])} />));
    expect((await press("2")).defaultPrevented).toBe(false);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it("uses refreshed projection order and bindings, with only one navigation per native event", async () => {
    await act(() => root.render(<Harness current={null} />));
    await press("]");
    expect(mocks.navigate).toHaveBeenLastCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: first.environmentId, threadId: first.id },
    });
    mocks.bindings = [binding("thread.next", "n")];
    await act(() => root.render(<Harness current={null} order={keys.toReversed()} />));
    expect((await press("]")).defaultPrevented).toBe(false);
    await press("n");
    expect(mocks.navigate).toHaveBeenLastCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: second.environmentId, threadId: second.id },
    });
    expect(mocks.navigate).toHaveBeenCalledTimes(2);
  });
  it("preserves safe-area selection and dismisses it outside", async () => {
    await act(() => root.render(<Harness />));
    useThreadSelectionStore.getState().toggleThread(key(first));
    await act(() =>
      container
        .querySelector('[data-testid="safe"]')!
        .dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
    );
    expect(useThreadSelectionStore.getState().selectedThreadKeys.size).toBe(1);
    await act(() =>
      container
        .querySelector('[data-testid="outside"]')!
        .dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
    );
    expect(useThreadSelectionStore.getState().selectedThreadKeys.size).toBe(0);
  });
  it("refreshes terminal-open context without retaining an old target binding", async () => {
    mocks.bindings = [
      { ...binding("thread.next", "]"), whenAst: { type: "identifier", name: "terminalOpen" } },
    ];
    await act(() => root.render(<Harness />));
    expect((await press("]")).defaultPrevented).toBe(false);
    await act(() => root.render(<Harness terminalOpen />));
    expect((await press("]")).defaultPrevented).toBe(true);
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
  });
  it("removes keyboard and selection listeners on unmount", async () => {
    await act(() => root.render(<Harness />));
    await act(() => root.render(null));
    useThreadSelectionStore.getState().toggleThread(key(first));
    await press("]");
    await act(() => container.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(useThreadSelectionStore.getState().selectedThreadKeys.size).toBe(1);
  });
  it("keeps delayed configured jump labels and hides them on terminal focus", async () => {
    vi.useFakeTimers();
    await act(() => root.render(<Harness />));
    await press("Control");
    expect(container.querySelector("output")!.textContent).toBe("");
    await act(() => vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS));
    expect(container.querySelector("output")!.textContent).toBe("Ctrl+2");
    const terminal = document.createElement("div"),
      input = document.createElement("input");
    terminal.dataset.terminalOwner = "drawer";
    terminal.append(input);
    container.append(terminal);
    await act(() => input.focus());
    expect(container.querySelector("output")!.textContent).toBe("");
  });
});
