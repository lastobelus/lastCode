import { assert, describe, it } from "@effect/vitest";

import {
  DEV_PROXIED_ORIGIN_PRESERVING_PREFIXES,
  resolveWebDevServerHost,
  SHARED_DEV_LOOPBACK_HOST,
} from "./devProxy.ts";

describe("resolveWebDevServerHost", () => {
  it("uses the same IPv4 loopback selected for Tailscale sharing", () => {
    assert.equal(
      resolveWebDevServerHost({
        explicitHost: undefined,
        sharedBindHost: SHARED_DEV_LOOPBACK_HOST,
      }),
      "127.0.0.1",
    );
  });

  it("keeps ordinary local development and explicit desktop hosts unchanged", () => {
    assert.equal(
      resolveWebDevServerHost({ explicitHost: undefined, sharedBindHost: undefined }),
      "localhost",
    );
    assert.equal(
      resolveWebDevServerHost({
        explicitHost: "192.0.2.10",
        sharedBindHost: undefined,
      }),
      "192.0.2.10",
    );
  });

  it("does not let an environment HOST override the shared proxy address", () => {
    assert.equal(
      resolveWebDevServerHost({
        explicitHost: "localhost",
        sharedBindHost: SHARED_DEV_LOOPBACK_HOST,
      }),
      "127.0.0.1",
    );
  });
});

describe("dev proxy origin policy", () => {
  it("preserves browser Host for cookie-authenticated API and RPC WebSocket upgrades", () => {
    assert.isTrue(DEV_PROXIED_ORIGIN_PRESERVING_PREFIXES.has("/api"));
    assert.isTrue(DEV_PROXIED_ORIGIN_PRESERVING_PREFIXES.has("/ws"));
  });
});
