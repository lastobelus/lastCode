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

const clientLayer = (fetch: typeof globalThis.fetch) =>
  FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)));

describe("managed preview browser authentication", () => {
  it.effect("does not authenticate arbitrary previews or disclose their environment", () =>
    Effect.gen(function* () {
      const token = yield* HostingAuth.prepareBrowserCredential({
        url: lease.url,
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
      const first = yield* HostingAuth.prepareBrowserCredential(lease);
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
