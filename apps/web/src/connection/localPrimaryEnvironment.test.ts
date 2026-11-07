import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isClientLocalPrimaryTarget } from "./localPrimaryEnvironment";

const primary = (httpBaseUrl: string) =>
  new PrimaryConnectionTarget({
    environmentId: EnvironmentId.make("primary"),
    label: "Workstation",
    httpBaseUrl,
    wsBaseUrl: "ws://localhost",
  });

describe("client-local pause target", () => {
  it.each(["http://localhost", "http://127.0.0.1", "http://[::1]"])(
    "allows a browser's primary loopback environment at %s",
    (url) => expect(isClientLocalPrimaryTarget(primary(url), false)).toBe(true),
  );

  it("keeps the desktop's registered primary local without reading live bootstrap IPC", () => {
    expect(isClientLocalPrimaryTarget(primary("http://workstation.example"), true)).toBe(true);
  });

  it("keeps a browser's remotely hosted primary out of the local sidebar", () => {
    expect(isClientLocalPrimaryTarget(primary("https://managed-server.example"), false)).toBe(
      false,
    );
  });

  it.each([false, true])("never substitutes a saved remote on desktop=%s", (desktop) => {
    const remote = new BearerConnectionTarget({
      environmentId: EnvironmentId.make("remote"),
      label: "Managed server",
      connectionId: "saved-remote",
    });
    expect(isClientLocalPrimaryTarget(remote, desktop)).toBe(false);
    expect(isClientLocalPrimaryTarget(undefined, desktop)).toBe(false);
  });

  it("hides the browser control instead of throwing for an invalid cached URL", () => {
    expect(isClientLocalPrimaryTarget(primary("invalid URL"), false)).toBe(false);
  });
});
