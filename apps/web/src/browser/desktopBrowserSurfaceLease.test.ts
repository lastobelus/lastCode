// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
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

beforeEach(() => useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("desktop browser surface leases", () => {
  it("scopes activity to the runtime tab, ignores released acquire replies, and cleans all leases on unmount", async () => {
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
  vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, 600));
  wrapper.dataset.previewRendering = "active";
  guest.dataset.previewViewportKey = "freeform:800:600:";
  guest.dataset.previewCssWidth = "800";
  guest.dataset.previewCssHeight = "600";
  let frame: FrameRequestCallback | undefined;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    frame = undefined;
  });
  return {
    wrapper,
    guest,
    nextFrame: async () => {
      const callback = frame;
      frame = undefined;
      callback?.(0);
      await Promise.resolve();
    },
  };
}

describe("desktop guest readiness", () => {
  it("waits for paintable React layout and two matching guest viewport frames", async () => {
    const fixture = layoutFixture();
    fixture.wrapper.dataset.previewRendering = "suspended";
    const result = waitForDesktopBrowserSurface({
      request,
      signal: new AbortController().signal,
      wrapper: () => fixture.wrapper,
      guest: () => fixture.guest,
    });
    await fixture.nextFrame();
    expect(fixture.guest.executeJavaScript).not.toHaveBeenCalled();
    fixture.wrapper.dataset.previewRendering = "active";
    fixture.guest.executeJavaScript.mockResolvedValueOnce({ width: 1280, height: 800 });
    await fixture.nextFrame();
    await fixture.nextFrame();
    await fixture.nextFrame();
    expect(await result).toEqual({
      requestId: request.requestId,
      viewport: { width: 800, height: 600 },
    });
  });

  it("bounds an unresponsive guest and cancels a pending layout request", async () => {
    vi.useFakeTimers();
    const fixture = layoutFixture();
    fixture.guest.executeJavaScript.mockImplementation(() => new Promise(() => undefined));
    const result = waitForDesktopBrowserSurface({
      request,
      signal: new AbortController().signal,
      wrapper: () => fixture.wrapper,
      guest: () => fixture.guest,
    });
    await fixture.nextFrame();
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
