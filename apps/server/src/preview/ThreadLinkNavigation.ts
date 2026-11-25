import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import {
  createBrowserThreadLinkNavigation,
  matchesThreadLinkPopup,
} from "@t3tools/shared/server/threadLinkGesture";
import type { CDPSession, Page } from "playwright-core";

import { installDocumentNavigation, type DocumentNavigationHandler } from "./DocumentNavigation.ts";

const HOSTED_THREAD_DOCUMENT = {
  urlPattern: `${DEFAULT_HOSTED_APP_URL}/threads/*/*`,
  resourceType: "Document" as const,
  requestStage: "Request" as const,
};

export async function installThreadLinkNavigation(
  page: Page,
  cdp: CDPSession,
  native: boolean,
  open: (href: string, kind: "navigation" | "window") => boolean,
  blockPopup: (popup: Page) => void,
  documentHandlers: ReadonlyArray<DocumentNavigationHandler> = [],
) {
  const announced = new Set<string>();
  const dispatched = new Map<string, string>();
  const intercepted = new Set<string>();
  let windowHref: string | undefined;
  const resumeDeclined = (href: string, kind: "navigation" | "window") => {
    // Electron cancels renderer navigations synchronously. A programmatic load
    // bypasses will-frame-navigate when the server cannot deliver the app-open.
    if (native && kind === "navigation" && href.startsWith("https:"))
      void page.goto(href).catch(() => undefined);
  };
  const navigation = createBrowserThreadLinkNavigation(
    (href, kind) => {
      if (!open(href, kind)) {
        resumeDeclined(href, kind);
        return;
      }
      if (kind === "window") windowHref = href;
      else announced.add(href);
    },
    "t3-thread-link-activation",
    resumeDeclined,
  );
  for (const event of [
    "Runtime.executionContextCreated",
    "Runtime.executionContextDestroyed",
    "Runtime.executionContextsCleared",
    "Runtime.bindingCalled",
    "Page.windowOpen",
    "Page.frameRequestedNavigation",
  ] as const)
    cdp.on(event, (params) => {
      if (event === "Page.windowOpen") windowHref = undefined;
      navigation.receive(event, params);
      // A cancelled navigation must not authorise a later address-bar or agent load.
      if (!navigation.active) announced.clear();
    });
  await navigation.install((method, params) =>
    cdp.send(method as Parameters<CDPSession["send"]>[0], params),
  );
  cdp.on("Network.requestWillBeSent", ({ requestId, request, type }) => {
    if (type === "Document" && announced.delete(request.url))
      dispatched.set(requestId, request.url);
  });
  const complete = ({ requestId }: { requestId: string }) => {
    dispatched.delete(requestId);
  };
  cdp.on("Network.loadingFailed", complete);
  cdp.on("Network.loadingFinished", complete);
  await cdp.send("Network.enable");
  await installDocumentNavigation(cdp, [
    ...documentHandlers,
    ...(native
      ? []
      : [
          {
            patterns: [HOSTED_THREAD_DOCUMENT],
            accepts: (event) =>
              event.responseStatusCode === undefined &&
              event.responseErrorReason === undefined &&
              event.resourceType === "Document" &&
              parseThreadLinkHref(event.request.url) !== null,
            async handle({ requestId, request, networkId }) {
              if (
                (networkId !== undefined && dispatched.delete(networkId)) ||
                announced.delete(request.url)
              ) {
                intercepted.add(request.url);
                await cdp.send("Fetch.failRequest", { requestId, errorReason: "Aborted" });
              } else {
                await cdp.send("Fetch.continueRequest", { requestId });
              }
            },
          } satisfies DocumentNavigationHandler,
        ]),
  ]);

  // Popup requests can precede their frame. Close an announced thread popup before the host adopts it.
  page.on("popup", (popup) => {
    if (!matchesThreadLinkPopup(windowHref, popup.url())) return;
    windowHref = undefined;
    blockPopup(popup);
    void popup.close().catch(() => undefined);
  });
  return {
    isThreadNavigation: (url: string) =>
      announced.has(url) || intercepted.has(url) || [...dispatched.values()].includes(url),
    consumeFailedNavigation: (url: string) => intercepted.delete(url),
  };
}
