// @vitest-environment happy-dom
import { act, useEffect } from "react";
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
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { useSidebarPendingFileDropStore } from "../../sidebarPendingFileDropStore";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useLastCodeThreadNavigation } from "./useLastCodeThreadNavigation";
const mocks = vi.hoisted(() => ({
  mobile: false,
  close: vi.fn(),
  navigate: vi.fn<() => Promise<void>>(),
}));
const router = {
  state: { location: { pathname: "/previous" } },
  navigate: mocks.navigate,
  buildLocation: ({ params }: { params: { environmentId: string; threadId: string } }) => ({
    pathname: `/${params.environmentId}/${params.threadId}`,
  }),
};
vi.mock("@tanstack/react-router", () => ({ useRouter: () => router }));
vi.mock("../ui/sidebar", () => ({
  useSidebar: () => ({ isMobile: mocks.mobile, setOpenMobile: mocks.close }),
}));
const first = scopeThreadRef(EnvironmentId.make("first:environment"), ThreadId.make("same:thread"));
const middle = scopeThreadRef(first.environmentId, ThreadId.make("middle"));
const remote = scopeThreadRef(EnvironmentId.make("remote"), first.threadId);
const ordered = [first, middle, remote].map(scopedThreadKey);
const path = (ref: ScopedThreadRef) =>
  router.buildLocation({ params: buildThreadRouteParams(ref) }).pathname;
let capability: ReturnType<typeof useLastCodeThreadNavigation>;
function Harness({
  target = first,
  keys = ordered,
}: {
  target?: ScopedThreadRef;
  keys?: string[];
}) {
  const navigation = useLastCodeThreadNavigation();
  useEffect(() => {
    capability = navigation;
  }, [navigation]);
  return (
    <div data-testid="row" onClick={(event) => navigation.handleThreadClick(event, target, keys)}>
      <span>Row</span>
      <a href="#nested">
        <span>Nested link</span>
      </a>
    </div>
  );
}
let root: Root, container: HTMLDivElement;
const original = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
const platform = Object.getOwnPropertyDescriptor(navigator, "platform");
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
  mocks.navigate.mockResolvedValue();
  router.state.location.pathname = "/previous";
  useThreadSelectionStore.getState().clearSelection();
  useSidebarPendingFileDropStore.setState({ pending: [] });
  Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  if (platform) Object.defineProperty(navigator, "platform", platform);
  else Reflect.deleteProperty(navigator, "platform");
});
async function render(props: Parameters<typeof Harness>[0] = {}) {
  await act(() => root.render(<Harness {...props} />));
}
async function click(init: MouseEventInit = {}, nested = false) {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
  await act(() =>
    container.querySelector(nested ? "a span" : '[data-testid="row"]')!.dispatchEvent(event),
  );
  return event;
}
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const files = [new File(["first"], "first.txt")];
describe("thread selection and navigation", () => {
  it("keeps the shared capability stable across row refreshes and refreshes mobile navigation", async () => {
    await render();
    const original = capability;
    await render({ target: remote });
    expect(capability).toBe(original);
    await click();
    expect(useThreadSelectionStore.getState().anchorThreadKey).toBe(scopedThreadKey(remote));
    expect(mocks.close).not.toHaveBeenCalled();
    mocks.mobile = true;
    await render({ target: middle });
    expect(capability).not.toBe(original);
    await click();
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith(false);
    expect(mocks.navigate).toHaveBeenLastCalledWith({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(middle),
    });
  });
  it("clears selection, anchors the scoped destination and closes mobile before navigation", async () => {
    mocks.mobile = true;
    await render();
    useThreadSelectionStore.getState().toggleThread(scopedThreadKey(remote));
    mocks.navigate.mockImplementation(async () => {
      expect(useThreadSelectionStore.getState().selectedThreadKeys.size).toBe(0);
      expect(useThreadSelectionStore.getState().anchorThreadKey).toBe(scopedThreadKey(first));
      expect(mocks.close).toHaveBeenCalledExactlyOnceWith(false);
    });
    await click();
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(first),
    });
  });
  it("keeps desktop open and changes an anchor even when selection is empty", async () => {
    await render();
    useThreadSelectionStore.getState().setAnchor(scopedThreadKey(remote));
    await click();
    expect(useThreadSelectionStore.getState().anchorThreadKey).toBe(scopedThreadKey(first));
    expect(mocks.close).not.toHaveBeenCalled();
  });
  it.each(["MacIntel", "Win32"])(
    "toggles scoped selection on the %s modifier including trailing clicks",
    async (value) => {
      Object.defineProperty(navigator, "platform", { configurable: true, value });
      await render();
      useThreadSelectionStore.getState().toggleThread(scopedThreadKey(remote));
      const init = { detail: 2, [value === "MacIntel" ? "metaKey" : "ctrlKey"]: true };
      expect((await click(init)).defaultPrevented).toBe(true);
      expect([...useThreadSelectionStore.getState().selectedThreadKeys]).toEqual([
        scopedThreadKey(remote),
        scopedThreadKey(first),
      ]);
      await click(init);
      expect([...useThreadSelectionStore.getState().selectedThreadKeys]).toEqual([
        scopedThreadKey(remote),
      ]);
      expect(mocks.navigate).not.toHaveBeenCalled();
      expect(mocks.close).not.toHaveBeenCalled();
    },
  );
  it("uses the current project order for shift range and keeps the anchor stable", async () => {
    await render({ target: remote });
    useThreadSelectionStore.getState().setAnchor(scopedThreadKey(first));
    expect((await click({ shiftKey: true, detail: 2 })).defaultPrevented).toBe(true);
    expect([...useThreadSelectionStore.getState().selectedThreadKeys]).toEqual(ordered);
    expect(useThreadSelectionStore.getState().anchorThreadKey).toBe(scopedThreadKey(first));
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it("falls back to one scoped selection when the anchor belongs to another list", async () => {
    await render({ target: remote, keys: [scopedThreadKey(remote)] });
    useThreadSelectionStore.getState().setAnchor(scopedThreadKey(first));
    await click({ shiftKey: true });
    expect([...useThreadSelectionStore.getState().selectedThreadKeys]).toEqual([
      scopedThreadKey(remote),
    ]);
    expect(useThreadSelectionStore.getState().anchorThreadKey).toBe(scopedThreadKey(remote));
  });
  it("prioritizes toggle over range when both modifiers are held", async () => {
    await render({ target: remote });
    useThreadSelectionStore.getState().setAnchor(scopedThreadKey(first));
    await click({ metaKey: true, shiftKey: true });
    expect([...useThreadSelectionStore.getState().selectedThreadKeys]).toEqual([
      scopedThreadKey(remote),
    ]);
  });
  it.each([{ button: 2 }, { ctrlKey: true }])(
    "ignores context pointer click %j before selection",
    async (init) => {
      await render();
      useThreadSelectionStore.getState().toggleThread(scopedThreadKey(remote));
      const event = await click(init);
      // React filters right-button click before the handler; Mac Ctrl-click reaches its guard.
      expect(event.defaultPrevented).toBe(init.button !== 2);
      expect([...useThreadSelectionStore.getState().selectedThreadKeys]).toEqual([
        scopedThreadKey(remote),
      ]);
      expect(mocks.navigate).not.toHaveBeenCalled();
    },
  );
  it("leaves nested links and plain trailing clicks without clearing selection", async () => {
    await render();
    useThreadSelectionStore.getState().toggleThread(scopedThreadKey(remote));
    await click({ metaKey: true }, true);
    await click({ detail: 2 });
    expect([...useThreadSelectionStore.getState().selectedThreadKeys]).toEqual([
      scopedThreadKey(remote),
    ]);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it("refreshes target and mobile navigation on the same mounted row", async () => {
    await render();
    const row = container.firstElementChild;
    mocks.mobile = true;
    await render({ target: remote });
    expect(container.firstElementChild).toBe(row);
    await click();
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith(false);
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(remote),
    });
  });
});
describe("file drop navigation identity", () => {
  it("queues files on the already open route without navigation or selection cleanup", async () => {
    await render();
    router.state.location.pathname = path(first);
    useThreadSelectionStore.getState().toggleThread(scopedThreadKey(remote));
    await capability.handleThreadFileDrop(first, files);
    expect(useSidebarPendingFileDropStore.getState().consumePendingFileDrop(first)).toEqual(files);
    expect(useThreadSelectionStore.getState().hasSelection()).toBe(true);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it("keeps a successful destination drop for composer consumption", async () => {
    await render();
    const navigation = deferred();
    mocks.navigate.mockReturnValue(navigation.promise);
    const pending = capability.handleThreadFileDrop(remote, files);
    expect(useSidebarPendingFileDropStore.getState().pending[0]?.threadRef).toEqual(remote);
    expect(useThreadSelectionStore.getState().anchorThreadKey).toBe(scopedThreadKey(remote));
    router.state.location.pathname = path(remote);
    navigation.resolve();
    await pending;
    expect(useSidebarPendingFileDropStore.getState().consumePendingFileDrop(remote)).toEqual(files);
    expect(useSidebarPendingFileDropStore.getState().consumePendingFileDrop(first)).toBeNull();
  });
  it.each(["rejected", "superseded"])(
    "removes only the %s drop and retains newer same-thread and foreign drops",
    async (outcome) => {
      await render();
      const navigation = deferred();
      mocks.navigate.mockReturnValueOnce(navigation.promise);
      const pending = capability.handleThreadFileDrop(first, files);
      const store = useSidebarPendingFileDropStore.getState();
      const newerFiles = [new File(["new"], "new.txt")];
      const newerId = store.queuePendingFileDrop({ threadRef: first, files: newerFiles });
      const foreignId = store.queuePendingFileDrop({ threadRef: remote, files });
      if (outcome === "rejected") navigation.reject(new Error("Interrupted navigation"));
      else {
        router.state.location.pathname = path(remote);
        navigation.resolve();
      }
      await pending;
      expect(useSidebarPendingFileDropStore.getState().pending.map((drop) => drop.id)).toEqual([
        newerId,
        foreignId,
      ]);
      expect(useSidebarPendingFileDropStore.getState().consumePendingFileDrop(first)).toEqual(
        newerFiles,
      );
      expect(useSidebarPendingFileDropStore.getState().consumePendingFileDrop(remote)).toEqual(
        files,
      );
    },
  );
  it("handles overlapping navigations without deleting the successful second drop", async () => {
    await render();
    const earlier = deferred(),
      later = deferred();
    mocks.navigate.mockReturnValueOnce(earlier.promise).mockReturnValueOnce(later.promise);
    const a = capability.handleThreadFileDrop(first, files);
    const b = capability.handleThreadFileDrop(remote, files);
    router.state.location.pathname = path(remote);
    later.resolve();
    await b;
    earlier.resolve();
    await a;
    expect(useSidebarPendingFileDropStore.getState().pending.map((drop) => drop.threadRef)).toEqual(
      [remote],
    );
  });
});
