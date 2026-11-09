import type { CDPSession } from "playwright-core";

import type { DocumentNavigationHandler } from "./DocumentNavigation.ts";

const escapeHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

export const isPdfAssetUrl = (url: string) => {
  const { pathname } = new URL(url);
  return pathname.startsWith("/api/assets/") && /\.pdf$/i.test(pathname);
};

export async function createPdfDocumentNavigation(
  cdp: CDPSession,
): Promise<DocumentNavigationHandler | null> {
  const nativeViewer = await cdp.send("Runtime.evaluate", {
    expression: "navigator.pdfViewerEnabled",
    returnByValue: true,
  });
  if (nativeViewer.result?.value === true) return null;
  const { frameTree } = await cdp.send("Page.getFrameTree");
  // The shell cannot open PDFs. Commit a document at the original URL so the
  // client can embed its signed bytes while Back and Forward keep working.
  return {
    // Only document navigations pause; the client's PDF fetch gets the original bytes.
    patterns: [
      { urlPattern: "*/api/assets/*", resourceType: "Document", requestStage: "Response" },
    ],
    accepts: (event) =>
      event.resourceType === "Document" &&
      isPdfAssetUrl(event.request.url) &&
      (event.responseStatusCode !== undefined || event.responseErrorReason !== undefined),
    async handle(event) {
      const { requestId, request, frameId } = event;
      const proceed = () => cdp.send("Fetch.continueRequest", { requestId });
      if (
        request.method !== "GET" ||
        frameId !== frameTree.frame.id ||
        !isPdfAssetUrl(request.url)
      ) {
        await proceed();
        return;
      }
      const status = event.responseStatusCode;
      if (status === undefined || (status >= 300 && status < 400)) {
        await proceed();
        return;
      }
      const contentType = event.responseHeaders
        ?.find((header) => header.name.toLowerCase() === "content-type")
        ?.value.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (status < 200 || status >= 300 || contentType !== "application/pdf") {
        // Reach the browser's requestfailed path instead of committing a successful PDF tab.
        await cdp.send("Fetch.failRequest", { requestId, errorReason: "Failed" });
        return;
      }
      const name = escapeHtml(
        decodeURIComponent(new URL(request.url).pathname.split("/").at(-1) ?? "PDF"),
      );
      await cdp.send("Fetch.fulfillRequest", {
        requestId,
        responseCode: 200,
        responseHeaders: [
          { name: "Content-Type", value: "text/html; charset=utf-8" },
          { name: "Cache-Control", value: "no-store" },
          { name: "Content-Security-Policy", value: "default-src 'none'; sandbox" },
          { name: "X-Content-Type-Options", value: "nosniff" },
        ],
        body: Buffer.from(
          `<!doctype html><html><head><title>${name}</title></head><body><h1>${name}</h1><p>This PDF is displayed in the connected client.</p></body></html>`,
        ).toString("base64"),
      });
    },
  };
}
