import type {
  DesktopBrowserSurfaceRequest,
  DesktopBrowserSurfaceResponse,
} from "@t3tools/contracts";

import { acquireBrowserSurfaceActivity } from "./browserSurfaceStore";
import { browserViewportSettingKey } from "./browserViewportLayout";

interface SurfaceGuest extends HTMLElement {
  getWebContentsId: () => number;
  executeJavaScript: (code: string) => Promise<unknown>;
}

/** Wait for React's activity update and the guest's actual CSS viewport, without focusing it. */
export function waitForDesktopBrowserSurface(input: {
  readonly request: DesktopBrowserSurfaceRequest;
  readonly signal: AbortSignal;
  readonly wrapper: () => HTMLElement | null;
  readonly guest: () => SurfaceGuest | null;
}): Promise<DesktopBrowserSurfaceResponse> {
  const { request, signal } = input;
  return new Promise((resolve) => {
    let finished = false;
    let frame = 0;
    let matchedFrames = 0;
    const finish = (response: Omit<DesktopBrowserSurfaceResponse, "requestId">) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      signal.removeEventListener("abort", canceled);
      resolve({ requestId: request.requestId, ...response });
    };
    const canceled = () => finish({ viewport: null, reason: "guest-unavailable" });
    const timer = setTimeout(() => finish({ viewport: null, reason: "layout-timeout" }), 2000);
    signal.addEventListener("abort", canceled, { once: true });
    if (signal.aborted) {
      canceled();
      return;
    }

    const check = async () => {
      if (finished) return;
      const wrapper = input.wrapper();
      const guest = input.guest();
      if (!wrapper?.isConnected || !guest?.isConnected) {
        finish({ viewport: null, reason: "guest-unavailable" });
        return;
      }
      const rect = wrapper.getBoundingClientRect();
      const style = getComputedStyle(wrapper);
      const width = Number(guest.dataset.previewCssWidth);
      const height = Number(guest.dataset.previewCssHeight);
      const paintable =
        wrapper.dataset.previewRendering === "active" &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.right > 0 &&
        rect.bottom > 0 &&
        rect.left < window.innerWidth &&
        rect.top < window.innerHeight &&
        rect.width > 0 &&
        rect.height > 0;
      const viewportApplied =
        !request.viewport ||
        guest.dataset.previewViewportKey === browserViewportSettingKey(request.viewport);
      if (
        paintable &&
        viewportApplied &&
        Number.isInteger(width) &&
        width > 0 &&
        Number.isInteger(height) &&
        height > 0
      ) {
        try {
          if (guest.getWebContentsId() <= 0) {
            finish({ viewport: null, reason: "guest-unavailable" });
            return;
          }
          const viewport = await guest.executeJavaScript(
            "({width:window.innerWidth,height:window.innerHeight})",
          );
          if (finished) return;
          if (
            typeof viewport === "object" &&
            viewport !== null &&
            "width" in viewport &&
            "height" in viewport &&
            viewport.width === width &&
            viewport.height === height
          ) {
            matchedFrames += 1;
            if (matchedFrames >= 2) {
              finish({ viewport: { width, height } });
              return;
            }
          } else matchedFrames = 0;
        } catch {
          finish({ viewport: null, reason: "guest-unavailable" });
          return;
        }
      } else matchedFrames = 0;
      if (!finished)
        frame = requestAnimationFrame(() => {
          void check();
        });
    };
    frame = requestAnimationFrame(() => {
      void check();
    });
  });
}

/** Each runtime tab owns its activity leases, including acquires still waiting on layout. */
export function createDesktopBrowserSurfaceLeaseController(input: {
  readonly runtimeTabId: string;
  readonly ready: (
    request: DesktopBrowserSurfaceRequest,
    signal: AbortSignal,
  ) => Promise<DesktopBrowserSurfaceResponse>;
  readonly respond: (response: DesktopBrowserSurfaceResponse) => void;
}) {
  const leases = new Map<
    string,
    { readonly abort: AbortController; readonly release: () => void }
  >();
  let disposed = false;
  const release = (leaseId: string) => {
    const lease = leases.get(leaseId);
    if (!lease) return;
    leases.delete(leaseId);
    lease.abort.abort();
    lease.release();
  };
  return {
    handle: (request: DesktopBrowserSurfaceRequest) => {
      if (disposed || request.runtimeTabId !== input.runtimeTabId) return;
      release(request.leaseId);
      if (request.action === "release") {
        input.respond({ requestId: request.requestId, viewport: null });
        return;
      }
      const lease = {
        abort: new AbortController(),
        release: acquireBrowserSurfaceActivity(input.runtimeTabId),
      };
      leases.set(request.leaseId, lease);
      void input.ready(request, lease.abort.signal).then(
        (response) => {
          if (leases.get(request.leaseId) !== lease) return;
          if (response.viewport === null) release(request.leaseId);
          input.respond(response);
        },
        () => {
          if (leases.get(request.leaseId) !== lease) return;
          release(request.leaseId);
          input.respond({
            requestId: request.requestId,
            viewport: null,
            reason: "guest-unavailable",
          });
        },
      );
    },
    dispose: () => {
      disposed = true;
      for (const leaseId of leases.keys()) release(leaseId);
    },
  };
}
