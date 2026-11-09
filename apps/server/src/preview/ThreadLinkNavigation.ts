import { createBrowserThreadLinkNavigation } from "@t3tools/shared/threadLinks";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import type { CDPSession, Frame, Page, Route } from "playwright-core";

/** Native navigation is canceled by Electron before a network request can start. */
export async function installThreadLinkNavigation(
  page: Page,
  cdp: CDPSession,
  native: boolean,
  open: (href: string) => void,
  blockPopup: (popup: Page) => void = () => {},
) {
  const navigation = createBrowserThreadLinkNavigation(open);
  const windows = new Map<string, number>();
  cdp.on("Page.windowOpen", (event) => {
    if (!native && event.url.startsWith("https:") && parseThreadLinkHref(event.url))
      windows.set(event.url, (windows.get(event.url) ?? 0) + 1);
    return navigation.receive("Page.windowOpen", event);
  });
  for (const event of [
    "Runtime.executionContextCreated",
    "Runtime.executionContextDestroyed",
    "Runtime.executionContextsCleared",
    "Runtime.bindingCalled",
    "Page.frameRequestedNavigation",
  ] as const)
    cdp.on(event, (params) => navigation.receive(event, params));
  await navigation.install((method, params) =>
    cdp.send(method as Parameters<CDPSession["send"]>[0], params),
  );
  if (native) return;
  const matches = (url: URL) => parseThreadLinkHref(url.href) !== null;
  const intercept = async (route: Route) => {
    const request = route.request();
    if (!request.isNavigationRequest()) return route.fallback();
    let frame: Frame;
    try {
      frame = request.frame();
    } catch {
      // Initial popup requests precede their frame; the opener's CDP event identifies the destination.
      const count = windows.get(request.url()) ?? 0;
      if (count === 0) return route.fallback();
      if (count === 1) windows.delete(request.url());
      else windows.set(request.url(), count - 1);
      await route.abort("aborted");
      return;
    }
    const destination = frame.page();
    if (frame !== destination.mainFrame()) return route.fallback();
    if (destination !== page && (await destination.opener()) !== page) return route.fallback();
    if (destination !== page) blockPopup(destination);
    await route.abort("aborted");
    if (destination !== page) await destination.close().catch(() => undefined);
  };
  await page.context().route(matches, intercept);
  page.once("close", () => {
    void page
      .context()
      .unroute(matches, intercept)
      .catch(() => undefined);
  });
}
