import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import type { CDPSession, Page } from "playwright-core";

import { createBrowserThreadLinkNavigation } from "./ThreadLinkGesture.ts";

const HOSTED_THREAD_DOCUMENT = {
  urlPattern: `${DEFAULT_HOSTED_APP_URL}/threads/*/*`,
  resourceType: "Document" as const,
  requestStage: "Request" as const,
};

export async function installThreadLinkNavigation(
  page: Page,
  cdp: CDPSession,
  native: boolean,
  open: (href: string, kind: "navigation" | "window") => void,
  blockPopup: (popup: Page) => void,
  extraPatterns: ReadonlyArray<{
    urlPattern: string;
    resourceType: "Document";
    requestStage: "Response";
  }> = [],
) {
  const announced = new Set<string>();
  const windows = new Set<string>();
  const navigation = createBrowserThreadLinkNavigation((href, kind) => {
    if (kind === "window") windows.add(href);
    else announced.add(href);
    open(href, kind);
  });
  for (const event of [
    "Runtime.executionContextCreated",
    "Runtime.executionContextDestroyed",
    "Runtime.executionContextsCleared",
    "Runtime.bindingCalled",
    "Page.windowOpen",
    "Page.frameRequestedNavigation",
  ] as const)
    cdp.on(event, (params) => navigation.receive(event, params));
  await navigation.install((method, params) =>
    cdp.send(method as Parameters<CDPSession["send"]>[0], params),
  );
  if (native) return;

  cdp.on("Fetch.requestPaused", (event) => {
    if (event.responseStatusCode !== undefined) return;
    const { requestId, request, resourceType } = event;
    const intercepted =
      resourceType === "Document" &&
      parseThreadLinkHref(request.url) !== null &&
      announced.delete(request.url);
    return cdp
      .send(intercepted ? "Fetch.failRequest" : "Fetch.continueRequest", {
        requestId,
        ...(intercepted ? { errorReason: "Aborted" as const } : {}),
      })
      .catch(() => undefined);
  });
  await cdp.send("Fetch.enable", { patterns: [HOSTED_THREAD_DOCUMENT, ...extraPatterns] });

  // Popup requests can precede their frame. Close an announced thread popup before the host adopts it.
  page.on("popup", (popup) => {
    if (!windows.delete(popup.url())) return;
    blockPopup(popup);
    void popup.close().catch(() => undefined);
  });
}
