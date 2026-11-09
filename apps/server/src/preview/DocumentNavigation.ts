import { constVoid } from "effect/Function";
import type { CDPSession } from "playwright-core";

export interface PausedDocumentRequest {
  requestId: string;
  frameId: string;
  resourceType: string;
  request: { url: string; method: string };
  responseStatusCode?: number;
  responseErrorReason?: string;
  responseHeaders?: Array<{ name: string; value: string }>;
}

export interface DocumentNavigationHandler {
  patterns: Array<{
    urlPattern: string;
    resourceType: "Document";
    requestStage: "Request" | "Response";
  }>;
  accepts: (event: PausedDocumentRequest) => boolean;
  handle: (event: PausedDocumentRequest) => Promise<unknown>;
}

export async function installDocumentNavigation(
  cdp: CDPSession,
  handlers: ReadonlyArray<DocumentNavigationHandler>,
) {
  if (handlers.length === 0) return;
  // Fetch is session-wide: exactly one listener must settle each pause, including
  // non-PDF documents caught by the asset URL pattern and failed responses.
  cdp.on("Fetch.requestPaused", (event) => {
    const proceed = () => cdp.send("Fetch.continueRequest", { requestId: event.requestId });
    const owner = handlers.find((handler) => handler.accepts(event));
    if (owner) void owner.handle(event).catch(() => proceed().catch(constVoid));
    else void proceed().catch(constVoid);
  });
  await cdp.send("Fetch.enable", { patterns: handlers.flatMap((handler) => handler.patterns) });
}
