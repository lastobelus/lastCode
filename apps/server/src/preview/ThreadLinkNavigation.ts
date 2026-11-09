import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import { createBrowserThreadLinkNavigation } from "@t3tools/shared/server/threadLinkGesture";
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
  const intercepted = new Set<string>();
  const windows = new Set<string>();
  const navigation = createBrowserThreadLinkNavigation((href, kind) => {
    if (!open(href, kind)) return;
    if (kind === "window") windows.add(href);
    else announced.add(href);
  });
  for (const event of [
    "Runtime.executionContextCreated",
    "Runtime.executionContextDestroyed",
    "Runtime.executionContextsCleared",
    "Runtime.bindingCalled",
    "Page.windowOpen",
    "Page.frameRequestedNavigation",
  ] as const)
    cdp.on(event, (params) => {
      if (event === "Page.windowOpen") windows.clear();
      navigation.receive(event, params);
      // A cancelled navigation must not authorise a later address-bar or agent load.
      if (!navigation.active) announced.clear();
    });
  await navigation.install((method, params) =>
    cdp.send(method as Parameters<CDPSession["send"]>[0], params),
  );
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
            async handle({ requestId, request }) {
              if (announced.delete(request.url)) {
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
  if (!native)
    page.on("popup", (popup) => {
      if (!windows.delete(popup.url())) return;
      blockPopup(popup);
      void popup.close().catch(() => undefined);
    });
  return {
    isThreadNavigation: (url: string) => announced.has(url) || intercepted.has(url),
    consumeFailedNavigation: (url: string) => intercepted.delete(url),
  };
}
