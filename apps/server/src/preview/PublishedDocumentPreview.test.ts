import { expect, it } from "@effect/vitest";
import {
  AssetWorkspaceResolutionError,
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type AssetAccessError,
  type AssetCreateUrlInput,
  type AssetCreateUrlResult,
  type PreviewAutomationMcpOpenInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NetAddress from "effect/net/NetAddress";
import { HttpServer } from "effect/http";

import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import { make } from "./PublishedDocumentPreview.ts";

const owner = ThreadId.make("document-owner");
const other = ThreadId.make("other-document-owner");
const scope = (threadId = owner): McpInvocationContext.McpThreadInvocationScope => ({
  environmentId: EnvironmentId.make("document-environment"),
  thread: {
    threadId,
    providerSessionId: `session-${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  requestNamespace: `thread:${threadId}`,
  capabilities: new Set(["preview"]),
  issuedAt: 1,
});
const request: PreviewAutomationMcpOpenInput = {
  target: { kind: "published-document", path: "report.html" },
  open: false,
  reuseExistingTab: false,
};
const signed = (token: string): AssetCreateUrlResult => ({
  relativeUrl: `/api/assets/${token}/report.html`,
  expiresAt: 1,
});

const fixture = (
  issue: (input: AssetCreateUrlInput) => Effect.Effect<AssetCreateUrlResult, AssetAccessError>,
  address: NetAddress.SocketAddress = NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43127),
) => {
  const navigations: Broker.PreviewAutomationInvokeInput[] = [];
  return make(issue).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(HttpServer.HttpServer)({ address }),
        Layer.mock(Broker.PreviewAutomationBroker)({
          invoke: <A>(input: Broker.PreviewAutomationInvokeInput) => {
            navigations.push(input);
            return Effect.succeed({ available: true, ...(input.input as object) } as A);
          },
        }),
      ),
    ),
    Effect.map((preview) => ({ preview, navigations })),
  );
};

// Publication parsing/signing and sandbox policy have their own lower-level suites:
// ThreadLinkedFiles.test.ts, AssetAccess.test.ts, and http.test.ts.
it.effect.each([
  { address: "0.0.0.0", origin: "http://127.0.0.1:43127", profile: {} },
  { address: "::", origin: "http://[::1]:43127", profile: {} },
  { address: "127.0.0.2", origin: "http://127.0.0.2:43127", profile: { profileName: "Default" } },
  { address: "::1", origin: "http://[::1]:43127", profile: { profileId: "incognito" } },
])(
  "opens signed documents on the bound $address environment listener",
  ({ address, origin, profile }) =>
    Effect.gen(function* () {
      const { preview, navigations } = yield* fixture(
        () => Effect.succeed(signed("signed-document")),
        NetAddress.inetAddressFromIpStringUnsafe(address, 43127),
      );
      const tabId = PreviewTabId.make("document-tab");
      const input = { ...request, ...profile, tabId };
      const result = yield* preview.open(scope(), input);
      expect(result.url).toBe(`${origin}/api/assets/signed-document/report.html`);
      expect(navigations).toEqual([
        {
          scope: scope(),
          operation: Object.keys(profile).length ? "openWithProfile" : "open",
          tabId,
          input: {
            open: false,
            reuseExistingTab: false,
            ...profile,
            browserHost: "environment",
            url: result.url,
          },
        },
      ]);
    }),
);

it.effect("rechecks the calling thread's publication before every navigation", () =>
  Effect.gen(function* () {
    const publications = new Map<ThreadId, AssetCreateUrlResult>([
      [owner, signed("owner-original")],
      [other, signed("other-document")],
    ]);
    const { preview, navigations } = yield* fixture(({ resource }) =>
      Effect.suspend(() => {
        const publication =
          resource._tag === "media-file" &&
          resource.linkedThreadFile === true &&
          resource.path === "report.html"
            ? publications.get(resource.threadId)
            : undefined;
        return publication
          ? Effect.succeed(publication)
          : Effect.fail(
              new AssetWorkspaceResolutionError({ resource, cause: "Publication denied" }),
            );
      }),
    );
    expect((yield* preview.open(scope(owner), request)).url).toContain("/owner-original/");
    expect((yield* preview.open(scope(other), request)).url).toContain("/other-document/");
    publications.set(owner, signed("owner-revised"));
    expect((yield* preview.open(scope(owner), request)).url).toContain("/owner-revised/");
    publications.delete(owner);
    for (const input of [
      request,
      { ...request, target: { kind: "published-document" as const, path: "private.html" } },
    ]) {
      const denied = yield* preview.open(scope(owner), input).pipe(Effect.flip);
      expect(denied).toMatchObject({
        _tag: "PreviewAutomationPublishedDocumentError",
        threadId: owner,
        reason: "file-unavailable",
        cause: { _tag: "AssetWorkspaceResolutionError" },
      });
    }
    expect(navigations).toHaveLength(3);
  }),
);

it.effect.each([
  {
    address: NetAddress.unixPathAddress("/test/server.sock"),
    input: request,
    reason: "http-unavailable",
  },
  {
    address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43127),
    input: {},
    reason: "file-unavailable",
  },
])("rejects $reason before issuing a capability or navigating", ({ address, input, reason }) =>
  Effect.gen(function* () {
    const { preview, navigations } = yield* fixture(
      () => Effect.die("Invalid requests must not mint capabilities"),
      address,
    );
    expect(yield* preview.open(scope(), input).pipe(Effect.flip)).toMatchObject({
      _tag: "PreviewAutomationPublishedDocumentError",
      threadId: owner,
      reason,
    });
    expect(navigations).toEqual([]);
  }),
);
