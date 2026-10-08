import {
  createDesktopBrowserSurfaceLeaseController,
  waitForDesktopBrowserSurface,
} from "../../web/src/browser/desktopBrowserSurfaceLease.ts";
import { useBrowserSurfaceStore } from "../../web/src/browser/browserSurfaceStore.ts";
import { resolveHostedBrowserWebviewWrapperStyle } from "../../web/src/browser/hostedBrowserWebviewStyle.ts";
import {
  browserViewportSettingKey,
  resolveBrowserViewportLayout,
} from "../../web/src/browser/browserViewportLayout.ts";

async function main() {
  // The fixture replaces app hydration; activity, geometry, readiness, and leases use production helpers.
  const bridge = window.surfaceSmokeBridge;
  const fixtures = new Map();
  for (const tab of await bridge.configuration()) {
    const wrapper = document.createElement("div");
    const guest = document.createElement("webview");
    wrapper.style.position = "fixed";
    wrapper.style.overflow = "hidden";
    guest.style.position = "absolute";
    guest.style.display = "flex";
    guest.setAttribute("partition", tab.partition);
    guest.setAttribute(
      "webpreferences",
      "backgroundThrottling=no,contextIsolation=yes,sandbox=yes",
    );
    guest.setAttribute("src", tab.url);
    wrapper.append(guest);
    document.body.append(wrapper);
    const fixture = { wrapper, guest, viewport: { _tag: "freeform", width: 390, height: 844 } };
    const controller = createDesktopBrowserSurfaceLeaseController({
      runtimeTabId: tab.runtimeTabId,
      ready: (request, signal) =>
        waitForDesktopBrowserSurface({
          request,
          signal,
          wrapper: () => wrapper,
          guest: () => guest,
        }),
      respond: (response) => {
        void bridge.respond(response);
      },
    });
    fixtures.set(tab.runtimeTabId, { ...fixture, controller });
  }
  const paint = () => {
    for (const [runtimeTabId, fixture] of fixtures) {
      const { wrapper, guest, viewport } = fixture;
      const renderingActive =
        (useBrowserSurfaceStore.getState().activityByTabId[runtimeTabId] ?? 0) > 0;
      const size = { width: viewport.width, height: viewport.height };
      const style = resolveHostedBrowserWebviewWrapperStyle({
        active: false,
        renderingActive,
        keepPaintableWhenInactive: false,
        rect: null,
        hiddenSize: size,
      });
      const layout = resolveBrowserViewportLayout(size, viewport, 1);
      for (const [name, value] of Object.entries(style)) {
        wrapper.style[name] =
          typeof value === "number" && name !== "zIndex" ? `${value}px` : String(value);
      }
      guest.style.width = `${layout.viewportWidth / layout.viewportScale}px`;
      guest.style.height = `${layout.viewportHeight / layout.viewportScale}px`;
      guest.dataset.previewViewportKey = browserViewportSettingKey(viewport);
      guest.dataset.previewCssWidth = String(viewport.width);
      guest.dataset.previewCssHeight = String(viewport.height);
      wrapper.dataset.previewRendering = renderingActive ? "active" : "suspended";
    }
  };
  useBrowserSurfaceStore.subscribe(paint);
  paint();
  bridge.onRequest((request) => {
    const fixture = fixtures.get(request.runtimeTabId);
    if (!fixture) return;
    if (request.viewport) fixture.viewport = request.viewport;
    fixture.controller.handle(request);
    paint();
  });
  window.surfaceSmokeState = () =>
    [...fixtures].map(([runtimeTabId, { wrapper, guest }]) => ({
      runtimeTabId,
      activity: useBrowserSurfaceStore.getState().activityByTabId[runtimeTabId] ?? 0,
      rect: wrapper.getBoundingClientRect().toJSON(),
      rendering: wrapper.dataset.previewRendering,
      cssWidth: Number(guest.dataset.previewCssWidth),
      cssHeight: Number(guest.dataset.previewCssHeight),
    }));
  await Promise.all(
    [...fixtures].map(
      ([runtimeTabId, { guest }]) =>
        new Promise((resolve, reject) => {
          guest.addEventListener(
            "dom-ready",
            () => {
              void bridge
                .registerGuest(runtimeTabId, guest.getWebContentsId())
                .then(resolve, reject);
            },
            { once: true },
          );
        }),
    ),
  );
  await bridge.ready();
}
void main().catch((cause) => {
  console.error(cause);
});
