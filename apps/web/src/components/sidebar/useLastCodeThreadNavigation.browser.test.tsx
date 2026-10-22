import { act, render } from "../../../test/render";
import { useEffect } from "react";

import { describe, expect, it, vi } from "vite-plus/test";
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
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useRouter: () => router,
}));
vi.mock("../ui/sidebar", () => ({
  useSidebar: () => ({ isMobile: mocks.mobile, setOpenMobile: mocks.close }),
}));
const first = scopeThreadRef(EnvironmentId.make("first:environment"), ThreadId.make("same:thread"));
const middle = scopeThreadRef(first.environmentId, ThreadId.make("middle"));
const remote = scopeThreadRef(EnvironmentId.make("remote"), first.threadId);
const ordered = [first, middle, remote].map(scopedThreadKey);
const path = (ref: ScopedThreadRef) =>
  router.buildLocation({ params: buildThreadRouteParams(ref) }).pathname;

function Harness({
  target = first,
  keys = ordered,
  onNavigation,
}: {
  target?: ScopedThreadRef;
  keys?: string[];
  onNavigation: (value: ReturnType<typeof useLastCodeThreadNavigation>) => void;
}) {
  const navigation = useLastCodeThreadNavigation(keys);
  useEffect(() => {
    onNavigation(navigation);
  }, [navigation, onNavigation]);
  return (
    <div data-testid="row" onClick={(event) => navigation.handleThreadClick(event, target)}>
      <span>Row</span>
      <a href="#nested">
        <span>Nested link</span>
      </a>
    </div>
  );
}

async function click(container: HTMLElement, init: MouseEventInit = {}, nested = false) {
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
function setup() {
  vi.clearAllMocks();
  mocks.mobile = false;
  mocks.navigate.mockResolvedValue();
  router.state.location.pathname = "/previous";
  const selection = useThreadSelectionStore.getState();
  const pending = useSidebarPendingFileDropStore.getState().pending;
  useThreadSelectionStore.getState().clearSelection();
  useSidebarPendingFileDropStore.setState({ pending: [] });
  const platform = Object.getOwnPropertyDescriptor(navigator, "platform");
  Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
  let capability!: ReturnType<typeof useLastCodeThreadNavigation>;
  const observe = (value: typeof capability) => {
    capability = value;
  };
  return {
    get capability() {
      return capability;
    },
    view: (props: { target?: ScopedThreadRef; keys?: string[] } = {}) => (
      <Harness {...props} onNavigation={observe} />
    ),
    [Symbol.dispose]() {
      if (platform) Object.defineProperty(navigator, "platform", platform);
      else Reflect.deleteProperty(navigator, "platform");
      useThreadSelectionStore.setState(selection);
      useSidebarPendingFileDropStore.setState({ pending });
    },
  };
}
// The hook uses the deliberately mocked router rather than a mounted RouterProvider.
const renderOptions = { router: false as const };
const files = [new File(["first"], "first.txt")];
describe("thread selection and navigation", () => {
  it("refreshes bound range order on the same mounted row without replacing navigation or file drop", async () => {
    using fixture = setup();
    await using screen = await render(fixture.view({ target: remote }), renderOptions);
    const container = screen.container;
    const original = fixture.capability;
    const reversed = ordered.toReversed();
    await screen.rerender(fixture.view({ target: remote, keys: reversed }));
    expect(fixture.capability.navigateToThread).toBe(original.navigateToThread);
    expect(fixture.capability.handleThreadFileDrop).toBe(original.handleThreadFileDrop);
    useThreadSelectionStore.getState().setAnchor(scopedThreadKey(first));
    await click(container, { shiftKey: true });
    expect([...useThreadSelectionStore.getState().selectedThreadKeys]).toEqual(reversed);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it("keeps the shared capability stable across row refreshes and refreshes mobile navigation", async () => {
    using fixture = setup();
    await using screen = await render(fixture.view(), renderOptions);
    const container = screen.container;
    const original = fixture.capability;
    await screen.rerender(fixture.view({ target: remote }));
    expect(fixture.capability).toBe(original);
    await click(container);
    expect(useThreadSelectionStore.getState().anchorThreadKey).toBe(scopedThreadKey(remote));
    expect(mocks.close).not.toHaveBeenCalled();
    mocks.mobile = true;
    await screen.rerender(fixture.view({ target: middle }));
    expect(fixture.capability).not.toBe(original);
    await click(container);
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith(false);
    expect(mocks.navigate).toHaveBeenLastCalledWith({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(middle),
    });
  });
  it("clears selection, anchors the scoped destination and closes mobile before navigation", async () => {
    using fixture = setup();
    mocks.mobile = true;
    await using screen = await render(fixture.view(), renderOptions);
    const container = screen.container;
    useThreadSelectionStore.getState().toggleThread(scopedThreadKey(remote));
    mocks.navigate.mockImplementation(async () => {
      expect(useThreadSelectionStore.getState().selectedThreadKeys.size).toBe(0);
      expect(useThreadSelectionStore.getState().anchorThreadKey).toBe(scopedThreadKey(first));
      expect(mocks.close).toHaveBeenCalledExactlyOnceWith(false);
    });
    await click(container);
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(first),
    });
  });
  it("keeps desktop open and changes an anchor even when selection is empty", async () => {
    using fixture = setup();
    await using screen = await render(fixture.view(), renderOptions);
    const container = screen.container;
    useThreadSelectionStore.getState().setAnchor(scopedThreadKey(remote));
    await click(container);
    expect(useThreadSelectionStore.getState().anchorThreadKey).toBe(scopedThreadKey(first));
    expect(mocks.close).not.toHaveBeenCalled();
  });
  it.each(["MacIntel", "Win32"])(
    "toggles scoped selection on the %s modifier including trailing clicks",
    async (value) => {
      using fixture = setup();
      Object.defineProperty(navigator, "platform", { configurable: true, value });
      await using screen = await render(fixture.view(), renderOptions);
      const container = screen.container;
      useThreadSelectionStore.getState().toggleThread(scopedThreadKey(remote));
      const init = { detail: 2, [value === "MacIntel" ? "metaKey" : "ctrlKey"]: true };
      expect((await click(container, init)).defaultPrevented).toBe(true);
      expect([...useThreadSelectionStore.getState().selectedThreadKeys]).toEqual([
        scopedThreadKey(remote),
        scopedThreadKey(first),
      ]);
      await click(container, init);
      expect([...useThreadSelectionStore.getState().selectedThreadKeys]).toEqual([
        scopedThreadKey(remote),
      ]);
      expect(mocks.navigate).not.toHaveBeenCalled();
      expect(mocks.close).not.toHaveBeenCalled();
    },
  );
  it("uses the current project order for shift range and keeps the anchor stable", async () => {
    using fixture = setup();
    await using screen = await render(fixture.view({ target: remote }), renderOptions);
    const container = screen.container;
    useThreadSelectionStore.getState().setAnchor(scopedThreadKey(first));
    expect((await click(container, { shiftKey: true, detail: 2 })).defaultPrevented).toBe(true);
    expect([...useThreadSelectionStore.getState().selectedThreadKeys]).toEqual(ordered);
    expect(useThreadSelectionStore.getState().anchorThreadKey).toBe(scopedThreadKey(first));
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it("falls back to one scoped selection when the anchor belongs to another list", async () => {
    using fixture = setup();
    await using screen = await render(
      fixture.view({ target: remote, keys: [scopedThreadKey(remote)] }),
      renderOptions,
    );
    const container = screen.container;
    useThreadSelectionStore.getState().setAnchor(scopedThreadKey(first));
    await click(container, { shiftKey: true });
    expect([...useThreadSelectionStore.getState().selectedThreadKeys]).toEqual([
      scopedThreadKey(remote),
    ]);
    expect(useThreadSelectionStore.getState().anchorThreadKey).toBe(scopedThreadKey(remote));
  });
  it("prioritizes toggle over range when both modifiers are held", async () => {
    using fixture = setup();
    await using screen = await render(fixture.view({ target: remote }), renderOptions);
    const container = screen.container;
    useThreadSelectionStore.getState().setAnchor(scopedThreadKey(first));
    await click(container, { metaKey: true, shiftKey: true });
    expect([...useThreadSelectionStore.getState().selectedThreadKeys]).toEqual([
      scopedThreadKey(remote),
    ]);
  });
  it.each([{ button: 2 }, { ctrlKey: true }])(
    "ignores context pointer click %j before selection",
    async (init) => {
      using fixture = setup();
      await using screen = await render(fixture.view(), renderOptions);
      const container = screen.container;
      useThreadSelectionStore.getState().toggleThread(scopedThreadKey(remote));
      const event = await click(container, init);
      // React filters right-button click before the handler; Mac Ctrl-click reaches its guard.
      expect(event.defaultPrevented).toBe(init.button !== 2);
      expect([...useThreadSelectionStore.getState().selectedThreadKeys]).toEqual([
        scopedThreadKey(remote),
      ]);
      expect(mocks.navigate).not.toHaveBeenCalled();
    },
  );
  it("leaves nested links and plain trailing clicks without clearing selection", async () => {
    using fixture = setup();
    await using screen = await render(fixture.view(), renderOptions);
    const container = screen.container;
    useThreadSelectionStore.getState().toggleThread(scopedThreadKey(remote));
    await click(container, { metaKey: true }, true);
    await click(container, { detail: 2 });
    expect([...useThreadSelectionStore.getState().selectedThreadKeys]).toEqual([
      scopedThreadKey(remote),
    ]);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it("refreshes target and mobile navigation on the same mounted row", async () => {
    using fixture = setup();
    await using screen = await render(fixture.view(), renderOptions);
    const container = screen.container;
    const row = container.firstElementChild;
    mocks.mobile = true;
    await screen.rerender(fixture.view({ target: remote }));
    expect(container.firstElementChild).toBe(row);
    await click(container);
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith(false);
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(remote),
    });
  });
});
describe("file drop navigation identity", () => {
  it("queues files on the already open route without navigation or selection cleanup", async () => {
    using fixture = setup();
    await using _screen = await render(fixture.view(), renderOptions);
    router.state.location.pathname = path(first);
    useThreadSelectionStore.getState().toggleThread(scopedThreadKey(remote));
    await fixture.capability.handleThreadFileDrop(first, files);
    expect(useSidebarPendingFileDropStore.getState().consumePendingFileDrop(first)).toEqual(files);
    expect(useThreadSelectionStore.getState().hasSelection()).toBe(true);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it("keeps a successful destination drop for composer consumption", async () => {
    using fixture = setup();
    await using _screen = await render(fixture.view(), renderOptions);
    const navigation = deferred();
    mocks.navigate.mockReturnValue(navigation.promise);
    const pending = fixture.capability.handleThreadFileDrop(remote, files);
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
      using fixture = setup();
      await using _screen = await render(fixture.view(), renderOptions);
      const navigation = deferred();
      mocks.navigate.mockReturnValueOnce(navigation.promise);
      const pending = fixture.capability.handleThreadFileDrop(first, files);
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
    using fixture = setup();
    await using _screen = await render(fixture.view(), renderOptions);
    const earlier = deferred(),
      later = deferred();
    mocks.navigate.mockReturnValueOnce(earlier.promise).mockReturnValueOnce(later.promise);
    const a = fixture.capability.handleThreadFileDrop(first, files);
    const b = fixture.capability.handleThreadFileDrop(remote, files);
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
