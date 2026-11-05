import { fakeTimers } from "../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import type {
  DesktopBrowserSurfaceRequest,
  DesktopBrowserSurfaceResponse,
} from "@t3tools/contracts";

import {
  createDesktopBrowserSurfaceLeaseController,
  waitForDesktopBrowserSurface,
} from "./desktopBrowserSurfaceLease";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";

const request: DesktopBrowserSurfaceRequest = {
  type: "surface",
  threadId: "thread-1",
  tabId: "tab-1",
  runtimeTabId: "runtime-tab-1",
  requestId: "request-1",
  leaseId: "lease-1",
  action: "acquire",
  viewport: { _tag: "freeform", width: 800, height: 600 },
};

function setup() {
  const previous = useBrowserSurfaceStore.getState();
  useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
  return {
    [Symbol.dispose]() {
      useBrowserSurfaceStore.setState(previous);
    },
  };
}

describe("desktop browser surface leases", () => {
  it("scopes activity to the runtime tab, ignores released acquire replies, and cleans all leases on unmount", async () => {
    using _store = setup();
    const responses: DesktopBrowserSurfaceResponse[] = [];
    const pending: Array<{
      resolve: (response: DesktopBrowserSurfaceResponse) => void;
      signal: AbortSignal;
    }> = [];
    const controller = createDesktopBrowserSurfaceLeaseController({
      runtimeTabId: request.runtimeTabId,
      respond: (response) => {
        responses.push(response);
      },
      ready: (_request, signal) =>
        new Promise((resolve) => {
          pending.push({ resolve, signal });
        }),
    });
    using _controller = { [Symbol.dispose]: () => controller.dispose() };
    controller.handle({ ...request, runtimeTabId: "other-runtime" });
    expect(pending).toHaveLength(0);
    controller.handle(request);
    expect(useBrowserSurfaceStore.getState().activityByTabId[request.runtimeTabId]).toBe(1);
    controller.handle({ ...request, action: "release", requestId: "release-request" });
    expect(pending[0]!.signal.aborted).toBe(true);
    pending[0]!.resolve({ requestId: request.requestId, viewport: { width: 800, height: 600 } });
    await Promise.resolve();
    expect(responses).toEqual([{ requestId: "release-request", viewport: null }]);
    expect(useBrowserSurfaceStore.getState().activityByTabId[request.runtimeTabId]).toBeUndefined();
    controller.handle(request);
    controller.handle({ ...request, leaseId: "lease-2", requestId: "request-2" });
    expect(useBrowserSurfaceStore.getState().activityByTabId[request.runtimeTabId]).toBe(2);
    controller.dispose();
    expect(pending.slice(1).every(({ signal }) => signal.aborted)).toBe(true);
    expect(useBrowserSurfaceStore.getState().activityByTabId[request.runtimeTabId]).toBeUndefined();
  });

  it("releases a lease when readiness fails", async () => {
    using _store = setup();
    const respond = vi.fn();
    const controller = createDesktopBrowserSurfaceLeaseController({
      runtimeTabId: request.runtimeTabId,
      respond,
      ready: async () => ({
        requestId: request.requestId,
        viewport: null,
        reason: "layout-timeout",
      }),
    });
    using _controller = { [Symbol.dispose]: () => controller.dispose() };
    controller.handle(request);
    await Promise.resolve();
    expect(respond).toHaveBeenCalledWith({
      requestId: request.requestId,
      viewport: null,
      reason: "layout-timeout",
    });
    expect(useBrowserSurfaceStore.getState().activityByTabId[request.runtimeTabId]).toBeUndefined();
  });
});

function layoutFixture() {
  const wrapper = document.createElement("div");
  const guest = Object.assign(document.createElement("webview"), {
    getWebContentsId: () => 23,
    executeJavaScript: vi.fn(async () => ({ width: 800, height: 600 })),
  });
  wrapper.append(guest);
  document.body.append(wrapper);
  const bounds = vi
    .spyOn(wrapper, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(0, 0, 800, 600));
  wrapper.dataset.previewRendering = "active";
  guest.dataset.previewViewportKey = "freeform:800:600:";
  guest.dataset.previewCssWidth = "800";
  guest.dataset.previewCssHeight = "600";
  const abort = new AbortController();
  return {
    wrapper,
    guest,
    signal: abort.signal,
    [Symbol.dispose]() {
      abort.abort();
      bounds.mockRestore();
      wrapper.remove();
    },
  };
}

describe("desktop guest readiness", () => {
  it("waits for paintable React layout and two matching guest viewport frames", async () => {
    using _timers = fakeTimers();
    using fixture = layoutFixture();
    fixture.wrapper.dataset.previewRendering = "suspended";
    const result = waitForDesktopBrowserSurface({
      request,
      signal: fixture.signal,
      wrapper: () => fixture.wrapper,
      guest: () => fixture.guest,
    });
    await vi.advanceTimersByTimeAsync(16);
    expect(fixture.guest.executeJavaScript).not.toHaveBeenCalled();
    fixture.wrapper.dataset.previewRendering = "active";
    fixture.guest.executeJavaScript.mockResolvedValueOnce({ width: 1280, height: 800 });
    await vi.advanceTimersByTimeAsync(16);
    await vi.advanceTimersByTimeAsync(16);
    await vi.advanceTimersByTimeAsync(16);
    expect(await result).toEqual({
      requestId: request.requestId,
      viewport: { width: 800, height: 600 },
    });
  });

  it("bounds an unresponsive guest and cancels a pending layout request", async () => {
    using _timers = fakeTimers();
    using fixture = layoutFixture();
    fixture.guest.executeJavaScript.mockImplementation(() => new Promise(() => undefined));
    const result = waitForDesktopBrowserSurface({
      request,
      signal: fixture.signal,
      wrapper: () => fixture.wrapper,
      guest: () => fixture.guest,
    });
    await vi.advanceTimersByTimeAsync(16);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toEqual({
      requestId: request.requestId,
      viewport: null,
      reason: "layout-timeout",
    });
    const abort = new AbortController();
    const canceled = waitForDesktopBrowserSurface({
      request,
      signal: abort.signal,
      wrapper: () => fixture.wrapper,
      guest: () => fixture.guest,
    });
    abort.abort();
    expect(await canceled).toEqual({
      requestId: request.requestId,
      viewport: null,
      reason: "guest-unavailable",
    });
  });
});
