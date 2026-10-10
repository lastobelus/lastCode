import { assert, describe, it } from "@effect/vitest";
import { AuthAdministrativeScopes } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient, HttpClient } from "effect/http";

import * as HostingAuth from "./HostingAuth.ts";

const lease = {
  browserAuth: "t3-dev" as const,
  url: "http://localhost:5173/threads/qa?view=preview#details",
  env: { T3CODE_DEV_AUTH_TOKEN: "private-stable-development-credential" },
};
const remoteBrowserUrl = "http://managed-server:5173/threads/qa?view=preview#details";
const descriptor = {
  environmentId: "hosted-application-environment",
  label: "Hosted application",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.0",
  capabilities: { repositoryIdentity: false },
};

const clientLayer = (fetch: typeof globalThis.fetch) =>
  FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)));

describe("managed preview browser authentication", () => {
  it.effect("does not authenticate arbitrary previews or disclose their environment", () =>
    Effect.gen(function* () {
      const token = yield* HostingAuth.prepareBrowserCredential({
        url: lease.url,
        browserUrl: remoteBrowserUrl,
        env: lease.env,
      });
      assert.equal(token, undefined);
    }).pipe(
      Effect.provide(clientLayer(() => Promise.reject(new Error("Unexpected auth request")))),
    ),
  );

  it.effect("mints a separate administrative pairing credential for every navigation", () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    return Effect.gen(function* () {
      const first = yield* HostingAuth.prepareBrowserCredential({
        ...lease,
        browserUrl: "http://localhost:5173/another?mode=dark#anchor",
      });
      const second = yield* HostingAuth.prepareBrowserCredential(lease);
      assert.equal(first, "one-time-1");
      assert.equal(second, "one-time-2");
      assert.equal(requests.length, 2);
      for (const request of requests) {
        assert.equal(request.url, "http://localhost:5173/api/auth/pairing-token");
        assert.equal(request.init?.redirect, "manual");
        assert.equal(
          new Headers(request.init?.headers).get("authorization"),
          `Bearer ${lease.env.T3CODE_DEV_AUTH_TOKEN}`,
        );
        const body = JSON.parse(new TextDecoder().decode(request.init?.body as Uint8Array));
        assert.deepEqual(body.scopes, [...AuthAdministrativeScopes]);
      }
    }).pipe(
      Effect.provide(
        clientLayer((url, init) => {
          requests.push({ url: String(url), ...(init === undefined ? {} : { init }) });
          return Promise.resolve(
            Response.json({
              id: `grant-${requests.length}`,
              credential: `one-time-${requests.length}`,
              expiresAt: "2026-10-07T22:00:00.000Z",
            }),
          );
        }),
      ),
    );
  });

  it.effect(
    "checks both application identities without credentials before minting remote auth",
    () => {
      const requests: Array<{ url: string; init?: RequestInit }> = [];
      const entered = Promise.withResolvers<void>();
      const remote = Promise.withResolvers<Response>();
      return Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => remote.resolve(Response.json(descriptor))),
        );
        const request = yield* HostingAuth.prepareBrowserCredential({
          ...lease,
          browserUrl: remoteBrowserUrl,
        }).pipe(Effect.forkScoped);
        yield* Effect.promise(() => entered.promise);
        assert.equal(requests.length, 2);
        assert.isTrue(requests.every(({ init }) => init?.method === "GET"));
        remote.resolve(Response.json(descriptor));
        assert.equal(yield* Fiber.join(request), "one-time-remote");
        assert.equal(requests.length, 3);
        assert.deepEqual(
          requests
            .slice(0, 2)
            .map(({ url }) => url)
            .sort(),
          [
            "http://localhost:5173/.well-known/t3/environment",
            "http://managed-server:5173/.well-known/t3/environment",
          ].sort(),
        );
        for (const { init } of requests.slice(0, 2)) {
          const headers = new Headers(init?.headers);
          assert.equal(headers.get("authorization"), null);
          assert.equal(headers.get("cookie"), null);
          assert.equal(init?.body, undefined);
          assert.equal(init?.credentials, "omit");
          assert.equal(init?.redirect, "manual");
        }
        assert.equal(requests[2]!.url, "http://localhost:5173/api/auth/pairing-token");
        assert.equal(requests[2]!.init?.method, "POST");
      }).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, {
          credentials: "include",
          headers: { cookie: "fixture-profile-cookie", authorization: "Bearer fixture-ambient" },
        }),
        Effect.provide(
          clientLayer((url, init) => {
            requests.push({ url: String(url), ...(init === undefined ? {} : { init }) });
            if (init?.method === "POST")
              return Promise.resolve(
                Response.json({
                  id: "remote-grant",
                  credential: "one-time-remote",
                  expiresAt: "2026-10-07T22:00:00.000Z",
                }),
              );
            if (new URL(String(url)).hostname === "managed-server") {
              entered.resolve();
              return remote.promise;
            }
            return Promise.resolve(Response.json(descriptor));
          }),
        ),
      );
    },
  );

  it.effect.each([
    {
      name: "a distinct listener",
      response: () => Response.json({ ...descriptor, environmentId: "another-application" }),
    },
    { name: "missing metadata", response: () => new Response(null, { status: 404 }) },
    {
      name: "missing identity",
      response: () => Response.json({ ...descriptor, environmentId: undefined }),
    },
    {
      name: "invalid metadata",
      response: () => Response.json({ ...descriptor, platform: "invalid" }),
    },
    {
      name: "an empty identity",
      response: () => Response.json({ ...descriptor, environmentId: "" }),
    },
    {
      name: "a redirect",
      response: () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://other-server:5173/.well-known/t3/environment" },
        }),
    },
  ])("rejects $name before minting or forwarding a credential", ({ response }) => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    return Effect.gen(function* () {
      const result = yield* HostingAuth.prepareBrowserCredential({
        ...lease,
        browserUrl: remoteBrowserUrl,
      }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.reason, "bootstrap_failed");
        assert.notInclude(JSON.stringify(result.failure), lease.env.T3CODE_DEV_AUTH_TOKEN);
      }
      assert.isTrue(requests.every(({ init }) => init?.method === "GET"));
      assert.isTrue(requests.every(({ init }) => init?.redirect === "manual"));
      assert.isTrue(requests.every(({ url }) => url.endsWith("/.well-known/t3/environment")));
    }).pipe(
      Effect.provide(
        clientLayer((url, init) => {
          requests.push({ url: String(url), ...(init === undefined ? {} : { init }) });
          return Promise.resolve(
            new URL(String(url)).hostname === "managed-server"
              ? response()
              : Response.json(descriptor),
          );
        }),
      ),
    );
  });

  it.effect.each([
    "not a URL",
    "https://public.example/qa",
    "http://fixture:credential@managed-server:5173/qa",
  ])("rejects an invalid remote development destination: %s", (browserUrl) =>
    HostingAuth.prepareBrowserCredential({ ...lease, browserUrl }).pipe(
      Effect.flip,
      Effect.tap((error) => Effect.sync(() => assert.equal(error.reason, "invalid_configuration"))),
      Effect.provide(clientLayer(() => Promise.reject(new Error("Unexpected request")))),
    ),
  );

  it.effect("bounds descriptor checks before private credential creation", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const methods: string[] = [];
      const request = yield* HostingAuth.prepareBrowserCredential({
        ...lease,
        browserUrl: remoteBrowserUrl,
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            methods.push(request.method);
            return Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
          }),
        ),
        Effect.result,
        Effect.forkScoped,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust("5 seconds");
      const result = yield* Fiber.join(request);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.reason, "bootstrap_failed");
      assert.isTrue(methods.every((method) => method === "GET"));
    }),
  );

  it.effect("cancels pending descriptor HTTP requests without minting a credential", () => {
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const methods: string[] = [];
    return Effect.gen(function* () {
      const request = yield* HostingAuth.prepareBrowserCredential({
        ...lease,
        browserUrl: remoteBrowserUrl,
      }).pipe(Effect.forkScoped);
      yield* Effect.promise(() => entered.promise);
      yield* Fiber.interrupt(request);
      yield* Effect.promise(() => aborted.promise);
      assert.isTrue(methods.every((method) => method === "GET"));
    }).pipe(
      Effect.provide(
        clientLayer((_url, init) => {
          methods.push(init!.method!);
          entered.resolve();
          return new Promise<Response>((_resolve, reject) => {
            init!.signal!.addEventListener(
              "abort",
              () => {
                aborted.resolve();
                reject(new Error("Fixture descriptor request cancelled"));
              },
              { once: true },
            );
          });
        }),
      ),
    );
  });

  it.effect("rejects nonlocal destinations before sending the retained credential", () =>
    Effect.gen(function* () {
      const result = yield* HostingAuth.prepareBrowserCredential({
        ...lease,
        url: "https://unrelated.example/qa",
      }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.reason, "invalid_configuration");
      }
    }).pipe(
      Effect.provide(clientLayer(() => Promise.reject(new Error("Unexpected auth request")))),
    ),
  );

  it.effect("fails closed when the listener redirects authentication elsewhere", () =>
    Effect.gen(function* () {
      const result = yield* HostingAuth.prepareBrowserCredential(lease).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.reason, "bootstrap_failed");
    }).pipe(
      Effect.provide(
        clientLayer(() =>
          Promise.resolve(
            new Response(null, { status: 302, headers: { location: "https://unrelated.example" } }),
          ),
        ),
      ),
    ),
  );

  it.effect("rejects a listener response without a valid one-time credential", () =>
    Effect.gen(function* () {
      const result = yield* HostingAuth.prepareBrowserCredential(lease).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.reason, "bootstrap_failed");
        assert.notInclude(JSON.stringify(result.failure), lease.env.T3CODE_DEV_AUTH_TOKEN);
        assert.notInclude(JSON.stringify(result.failure), "ephemeral-response-credential");
        assert.notInclude(JSON.stringify(result.failure), lease.url);
      }
    }).pipe(
      Effect.provide(
        clientLayer(() =>
          Promise.resolve(
            Response.json({
              credential: "ephemeral-response-credential",
              secret: lease.env.T3CODE_DEV_AUTH_TOKEN,
            }),
          ),
        ),
      ),
    ),
  );

  it.effect("bounds an unresponsive authentication endpoint", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const request = yield* HostingAuth.prepareBrowserCredential(lease).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() =>
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        ),
        Effect.result,
        Effect.forkScoped,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust("5 seconds");
      const result = yield* Fiber.join(request);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.reason, "bootstrap_failed");
    }),
  );
});
