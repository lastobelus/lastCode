import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  electron: true,
  localDesktopBrowser: true as boolean | undefined,
}));
vi.mock("~/env", () => ({
  get isElectron() {
    return state.electron;
  },
}));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => "primary" } }));
vi.mock("~/state/primaryEnvironment", () => ({ primaryEnvironmentIdAtom: {} }));
vi.mock("~/previewStateStore", () => ({ isPreviewSupportedInRuntime: () => true }));
vi.mock("~/state/entities", () => ({
  readEnvironmentHasLocalDesktopBrowser: () => state.localDesktopBrowser,
  readEnvironmentSupportsServerBrowser: () => true,
  useEnvironmentSupportsServerBrowser: () => true,
}));
vi.mock("./desktopBrowserTransport", () => ({
  getDesktopBrowserHostId: (environmentId: string) => `host-${environmentId}`,
}));

import { desktopBrowserHostFor, rendersServerTabNatively } from "./previewRuntime";

const primary = EnvironmentId.make("primary");
const remote = EnvironmentId.make("remote");

beforeEach(() => {
  state.electron = true;
  state.localDesktopBrowser = true;
});

describe("authoritative server page selection", () => {
  it("preserves older remote tabs only for the explicit matching desktop owner", () => {
    for (const environmentId of [primary, remote]) {
      const owner = `host-${environmentId}`;
      expect(
        rendersServerTabNatively(environmentId, primary, {
          runtime: "server",
          desktopHostId: owner,
        }),
      ).toBe(true);
      for (const desktopHostId of [undefined, "local", "another-desktop"]) {
        expect(
          rendersServerTabNatively(environmentId, primary, {
            runtime: "server",
            desktopHostId,
          }),
        ).toBe(false);
      }
      expect(
        rendersServerTabNatively(environmentId, primary, {
          runtime: "server",
          desktopHostId: owner,
          backingPage: "server",
        }),
      ).toBe(false);
    }
    state.electron = false;
    expect(
      rendersServerTabNatively(remote, primary, {
        runtime: "server",
        desktopHostId: "host-remote",
      }),
    ).toBe(false);
  });

  it("streams headless tabs even in the desktop's primary environment", () => {
    expect(
      rendersServerTabNatively(primary, primary, {
        runtime: "server",
        backingPage: "server",
      }),
    ).toBe(false);
    expect(
      rendersServerTabNatively(primary, primary, {
        runtime: "server",
        backingPage: "desktop",
        desktopHostId: "local",
      }),
    ).toBe(true);
    expect(rendersServerTabNatively(primary, primary, { runtime: "server" })).toBe(false);
    expect(
      rendersServerTabNatively(primary, primary, {
        runtime: "server",
        backingPage: "desktop",
      }),
    ).toBe(false);
  });

  it("streams existing native popups without creating another guest", () => {
    for (const [environment, host] of [
      [primary, "local"],
      [remote, "host-remote"],
    ] as const)
      expect(
        rendersServerTabNatively(environment, primary, {
          runtime: "server",
          backingPage: "desktop-popup",
          desktopHostId: host,
        }),
      ).toBe(false);
  });

  it("renders only the selected remote desktop, including WSL primary via RPC", () => {
    state.localDesktopBrowser = false;
    expect(desktopBrowserHostFor(primary)).toBe("host-primary");
    expect(desktopBrowserHostFor(remote)).toBe("host-remote");
    expect(
      rendersServerTabNatively(primary, primary, {
        runtime: "server",
        backingPage: "desktop",
        desktopHostId: "host-primary",
      }),
    ).toBe(true);
    expect(
      rendersServerTabNatively(primary, primary, {
        runtime: "server",
        backingPage: "desktop",
        desktopHostId: "another-desktop",
      }),
    ).toBe(false);
  });

  it("pins local desktop profiles only when the server has its inherited IPC", () => {
    expect(desktopBrowserHostFor(primary)).toBe("local");
    state.localDesktopBrowser = undefined;
    expect(desktopBrowserHostFor(primary)).toBeUndefined();
    state.electron = false;
    expect(desktopBrowserHostFor(primary)).toBeUndefined();
    expect(
      rendersServerTabNatively(primary, primary, {
        runtime: "server",
        backingPage: "desktop",
        desktopHostId: "local",
      }),
    ).toBe(false);
  });
});
