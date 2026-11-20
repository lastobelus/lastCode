import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PEER_ARCHIVE_ROUTE,
  type PeerArchiveInventory,
  type PeerArchiveInventoryInput,
  type PeerArchiveUnavailable,
  PeerLinkError,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient, HttpClient, HttpRouter } from "effect/http";

import { McpClientAuthenticator } from "../mcp/McpHttpServer.ts";
import { type McpClientCaller, type McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as ArchiveTransport from "./LastCodePeerArchiveTransport.ts";
import * as PeerLinks from "./PeerLinks.ts";

const url = "https://peer.example";
const environmentId = EnvironmentId.make("peer");
const token = "fixture";
const input: PeerArchiveInventoryInput = {
  ownerEnvironmentId: EnvironmentId.make("owner"),
  ownerThreadIds: [ThreadId.make("owner-thread")],
  keptOwnerThreadIds: [],
};
const inventory: PeerArchiveInventory = {
  environmentId,
  threads: [],
  typedInThreadIds: [],
  activeThreadIds: [],
  unreadThreadIds: [],
  protectedThreadIds: [],
  keptThreadIds: [],
};
const peerClient: McpClientCaller = {
  linked: true,
  access: "auto",
  sessionId: "peer-session",
  label: "Owner",
};
const changed = { status: "blocked", reason: "changed" } satisfies PeerArchiveUnavailable;

const makeRoutes = (
  inventory: ArchiveTransport.PeerArchiveHandler["Service"]["inventory"],
  enabled = true,
) =>
  HttpRouter.toWebHandler(
    ArchiveTransport.routeLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ArchiveTransport.PeerArchiveHandler, { inventory }),
          ServerSettingsService.layerTest(
            { linkedEnvironmentsEnabled: enabled },
            {
              organization: "Fixture",
              lockedSettings: [],
              limits: { maxRuntimeMode: "auto-accept-edits" },
            },
          ),
          Layer.succeed(McpClientAuthenticator, {
            authenticate: (request) => {
              const authorization = request.headers.authorization;
              if (
                !["Bearer fixture", "Bearer ordinary", "Bearer readonly"].includes(
                  authorization ?? "",
                )
              ) {
                return Effect.undefined;
              }
              const client: McpClientCaller =
                authorization === "Bearer ordinary"
                  ? { ...peerClient, linked: false }
                  : authorization === "Bearer readonly"
                    ? { ...peerClient, access: "read-only" }
                    : peerClient;
              return Effect.succeed({
                environmentId,
                requestNamespace: "client:peer-session",
                capabilities: new Set(["orchestration"]),
                issuedAt: 0,
                thread: undefined,
                client,
              } satisfies McpInvocationScope);
            },
          }),
        ),
      ),
    ),
    { disableLogger: true },
  );

const resolve = () =>
  Effect.succeed({
    url,
    token,
    link: {
      environmentId,
      label: "Peer",
      urls: [url],
      access: "auto" as const,
      linkedAt: DateTime.makeUnsafe(0),
      expiresAt: DateTime.makeUnsafe(1),
      lastReachedAt: null,
      lastError: null,
    },
  });

const transportLayer = (
  resolveLink: PeerLinks.PeerLinks["Service"]["resolve"] = resolve,
  enabled = true,
) =>
  ArchiveTransport.layer.pipe(
    Layer.provide(
      Layer.mock(PeerLinks.PeerLinks)({ enabled: Effect.succeed(enabled), resolve: resolveLink }),
    ),
  );

it.effect("round trips inventory, enforces the mode ceiling, and preserves typed refusals", () =>
  Effect.gen(function* () {
    const callers: McpClientCaller[] = [];
    const web = yield* Effect.acquireRelease(
      Effect.sync(() =>
        makeRoutes((client, received) => {
          expect(received).toEqual(input);
          callers.push(client);
          return callers.length === 2 ? Effect.fail(changed) : Effect.succeed(inventory);
        }),
      ),
      (web) => Effect.promise(web.dispose),
    );
    const transport = yield* ArchiveTransport.LastCodePeerArchiveTransport;
    const fetch: typeof globalThis.fetch = (url, init) => web.handler(new Request(url, init));
    expect(
      yield* transport
        .inventory(environmentId, input, {
          runtimeMode: "full-access",
          interactionMode: "default",
        })
        .pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)),
    ).toEqual(inventory);
    expect(
      yield* transport
        .inventory(environmentId, input, {
          runtimeMode: "approval-required",
          interactionMode: "plan",
        })
        .pipe(Effect.provideService(FetchHttpClient.Fetch, fetch), Effect.flip),
    ).toEqual(changed);
    expect(callers).toEqual([
      {
        ...peerClient,
        narrowedTo: { runtimeMode: "auto-accept-edits", interactionMode: "default" },
      },
      { ...peerClient, narrowedTo: { runtimeMode: "approval-required", interactionMode: "plan" } },
    ]);
  }).pipe(Effect.provide(transportLayer().pipe(Layer.provide(FetchHttpClient.layer)))),
);

it.effect("authenticates and checks access before decoding the inventory request", () =>
  Effect.gen(function* () {
    for (const [enabled, headers, body, expected] of [
      [true, {}, "invalid json", 401],
      [true, { authorization: "Bearer revoked" }, "invalid json", 401],
      [true, { authorization: "Bearer ordinary" }, "invalid json", 403],
      [true, { authorization: "Bearer readonly" }, "invalid json", 403],
      [
        true,
        { authorization: "Bearer fixture", origin: "https://example.com" },
        JSON.stringify(input),
        403,
      ],
      [false, { authorization: "Bearer fixture" }, "invalid json", 403],
      [
        true,
        { authorization: "Bearer fixture", "t3-mode-limit": "auto/default/extra" },
        JSON.stringify(input),
        400,
      ],
      [
        true,
        { authorization: "Bearer fixture" },
        JSON.stringify({ ...input, ownerThreadIds: [] }),
        400,
      ],
    ] as const) {
      const statusAndBody = yield* Effect.acquireUseRelease(
        Effect.sync(() => makeRoutes(() => Effect.die("inventory must not be called"), enabled)),
        (web) =>
          Effect.promise(async () => {
            const response = await web.handler(
              new Request(`${url}${PEER_ARCHIVE_ROUTE}`, {
                method: "POST",
                headers,
                body,
              }),
            );
            return [response.status, await response.text()];
          }),
        (web) => Effect.promise(web.dispose),
      );
      expect(statusAndBody).toEqual([expected, ""]);
    }
  }),
);

it.effect("classifies HTTP refusals and keeps the link credential on the resolved origin", () =>
  Effect.gen(function* () {
    const transport = yield* ArchiveTransport.LastCodePeerArchiveTransport;
    for (const [response, expected] of [
      [new Response(null, { status: 404 }), { status: "blocked", reason: "unsupported" }],
      [new Response(null, { status: 405 }), { status: "blocked", reason: "unsupported" }],
      [new Response(null, { status: 401 }), { status: "blocked", reason: "denied" }],
      [new Response(null, { status: 403 }), { status: "blocked", reason: "denied" }],
      [new Response(null, { status: 503 }), { status: "pending", reason: "offline" }],
      [new Response("unexpected"), { status: "blocked", reason: "unsupported" }],
      [Response.json({ ...inventory, environmentId: "other" }), changed],
      [
        Response.redirect("https://other.example/", 307),
        { status: "blocked", reason: "unsupported" },
      ],
    ] as const) {
      let requests = 0;
      const fetch: typeof globalThis.fetch = async (destination, init) => {
        requests += 1;
        expect(String(destination)).toBe(`${url}${PEER_ARCHIVE_ROUTE}`);
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
        expect(init?.redirect).toBe("manual");
        return response;
      };
      expect(
        yield* transport
          .inventory(environmentId, input)
          .pipe(Effect.provideService(FetchHttpClient.Fetch, fetch), Effect.flip),
      ).toEqual(expected);
      expect(requests).toBe(1);
    }
    const disconnected: typeof globalThis.fetch = () =>
      Promise.reject(new Error("test connection failed"));
    expect(
      yield* transport
        .inventory(environmentId, input)
        .pipe(Effect.provideService(FetchHttpClient.Fetch, disconnected), Effect.flip),
    ).toEqual({ status: "pending", reason: "offline" });
  }).pipe(Effect.provide(transportLayer().pipe(Layer.provide(FetchHttpClient.layer)))),
);

it.effect("keeps disabled and unlinked requests off the network", () =>
  Effect.gen(function* () {
    const http = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("unexpected POST")),
    );
    const call = ArchiveTransport.LastCodePeerArchiveTransport.pipe(
      Effect.flatMap((transport) => transport.inventory(environmentId, input)),
      Effect.flip,
    );
    const failResolve = (reason: PeerLinkError["reason"]) => () =>
      Effect.fail(new PeerLinkError({ reason, message: "fixture" }));
    expect(
      yield* call.pipe(
        Effect.provide(
          transportLayer(() => Effect.die("unexpected resolve"), false).pipe(Layer.provide(http)),
        ),
      ),
    ).toEqual({ status: "blocked", reason: "denied" });
    for (const [reason, expected] of [
      ["unknown_link", { status: "blocked", reason: "unlinked" }],
      ["expired", { status: "blocked", reason: "denied" }],
      ["incompatible", { status: "blocked", reason: "unsupported" }],
      ["unreachable", { status: "pending", reason: "offline" }],
    ] as const) {
      expect(
        yield* call.pipe(
          Effect.provide(transportLayer(failResolve(reason)).pipe(Layer.provide(http))),
        ),
      ).toEqual(expected);
    }
  }),
);

it.effect("times out a silent peer and aborts the request", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<AbortSignal>();
    const http = HttpClient.make((_request, _url, signal) =>
      Deferred.succeed(started, signal).pipe(Effect.andThen(Effect.never)),
    );
    const pending = yield* ArchiveTransport.LastCodePeerArchiveTransport.pipe(
      Effect.flatMap((transport) => transport.inventory(environmentId, input)),
      Effect.provide(
        transportLayer().pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http))),
      ),
      Effect.flip,
      Effect.forkScoped,
    );
    const signal = yield* Deferred.await(started);
    yield* TestClock.adjust("10 seconds");
    expect(yield* Fiber.join(pending)).toEqual({ status: "pending", reason: "offline" });
    expect(signal.aborted).toBe(true);
  }),
);
