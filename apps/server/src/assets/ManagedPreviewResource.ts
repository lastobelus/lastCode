import { PreviewHostingLeaseId, ThreadId } from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import { stripPreviewBootstrapTokenFromUrl } from "@t3tools/shared/remote";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpServerResponse } from "effect/http";

import * as PreviewHosting from "../preview/Hosting.ts";

let resourceActivitySequence = 0;

const MEDIA_CONTENT_TYPE = /^(?:(?:image|video|audio)\/[\w!#$&^.+-]+|application\/pdf)$/i;
const FORWARDED_RESPONSE_HEADERS = [
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
] as const;
const RESPONSE_HEADERS = {
  "cache-control": "private, no-store, no-transform",
  "x-content-type-options": "nosniff",
};

/** A signed resource cannot leave the listener origin or carry a one-use Browser credential. */
export function canonicalManagedPreviewResource(url: string, leaseUrl: string): string | null {
  try {
    const target = new URL(url);
    const listener = new URL(leaseUrl);
    if (
      (target.protocol !== "http:" && target.protocol !== "https:") ||
      !isLoopbackHost(target.hostname) ||
      target.origin !== listener.origin ||
      target.username !== "" ||
      target.password !== ""
    )
      return null;
    const canonical = stripPreviewBootstrapTokenFromUrl(target);
    canonical.hash = "";
    return canonical.href;
  } catch {
    return null;
  }
}

export const managedPreviewResourceResponse = Effect.fn("ManagedPreviewResource.response")(
  function* (
    asset: { readonly threadId: string; readonly leaseId: string; readonly url: string },
    requestHeaders: Record<string, string | undefined>,
    method: "GET" | "HEAD" = "GET",
  ) {
    const hosting = yield* PreviewHosting.PreviewHosting;
    const lease = (yield* hosting.list(asset.threadId)).find(
      (candidate) => candidate.id === asset.leaseId && candidate.threadId === asset.threadId,
    );
    const target = lease ? canonicalManagedPreviewResource(asset.url, lease.url) : null;
    if (target === null || lease === undefined)
      return HttpServerResponse.empty({ status: 404, headers: RESPONSE_HEADERS });
    const activityId = `resource:${resourceActivitySequence++}`;
    const activity = { activityId, threadId: asset.threadId, url: lease.url };
    yield* Effect.acquireRelease(hosting.setActivity({ ...activity, active: true }), () =>
      hosting.setActivity({ ...activity, active: false }),
    );
    const recovered = yield* hosting.recover({
      threadId: ThreadId.make(asset.threadId),
      leaseId: PreviewHostingLeaseId.make(asset.leaseId),
      url: lease.url,
    });
    if (recovered === null || canonicalManagedPreviewResource(target, recovered.url) !== target)
      return HttpServerResponse.empty({ status: 404, headers: RESPONSE_HEADERS });
    const headers: Record<string, string> = { "accept-encoding": "identity" };
    for (const name of ["range", "if-range"] as const) {
      if (requestHeaders[name] !== undefined) headers[name] = requestHeaders[name];
    }
    const client = HttpClient.withScope(yield* HttpClient.HttpClient);
    const response = yield* client
      .execute(
        (method === "HEAD" ? HttpClientRequest.head(target) : HttpClientRequest.get(target)).pipe(
          HttpClientRequest.setHeaders(headers),
        ),
      )
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
    // Never follow application redirects: the capability covers these exact bytes only.
    if (response.status >= 300 && response.status < 400)
      return HttpServerResponse.empty({ status: 502, headers: RESPONSE_HEADERS });
    if (response.status !== 200 && response.status !== 206 && response.status !== 416)
      return HttpServerResponse.empty({
        status: response.status >= 500 ? 502 : response.status,
        headers: RESPONSE_HEADERS,
      });
    if (response.status === 416)
      return HttpServerResponse.empty({
        status: 416,
        headers: {
          ...RESPONSE_HEADERS,
          ...(response.headers["content-range"] === undefined
            ? {}
            : { "content-range": response.headers["content-range"] }),
        },
      });
    const contentType = response.headers["content-type"]?.split(";", 1)[0]?.trim() ?? "";
    if (!MEDIA_CONTENT_TYPE.test(contentType))
      return HttpServerResponse.empty({ status: 415, headers: RESPONSE_HEADERS });
    const responseHeaders: Record<string, string> = {
      ...RESPONSE_HEADERS,
      "content-type": contentType,
      ...(contentType.toLowerCase() === "image/svg+xml"
        ? { "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" }
        : {}),
    };
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      if (response.headers[name] !== undefined) responseHeaders[name] = response.headers[name];
    }
    return method === "HEAD"
      ? HttpServerResponse.empty({ status: response.status, headers: responseHeaders })
      : HttpServerResponse.stream(response.stream, {
          status: response.status,
          headers: responseHeaders,
          contentType,
        });
  },
);
