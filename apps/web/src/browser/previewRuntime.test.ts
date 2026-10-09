import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  electron: true,
  desktop: true,
  primary: "primary" as string | null,
  serverBrowser: new Set<string>(),
  localDesktopBrowser: true as boolean | undefined,
}));
vi.mock("~/env", () => ({
  get isElectron() {
    return state.electron;
  },
}));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => state.primary } }));
vi.mock("~/state/primaryEnvironment", () => ({ primaryEnvironmentIdAtom: {} }));
vi.mock("~/previewStateStore", () => ({ isPreviewSupportedInRuntime: () => state.desktop }));
vi.mock("~/state/entities", () => ({
  readEnvironmentHasLocalDesktopBrowser: () => state.localDesktopBrowser,
  readEnvironmentSupportsServerBrowser: (id: string) => state.serverBrowser.has(id),
  useEnvironmentSupportsServerBrowser: () => true,
}));
vi.mock("./desktopBrowserTransport", () => ({
  getDesktopBrowserHostId: (environmentId: string) => `host-${environmentId}`,
}));

import {
  alternatePreviewRuntime,
  desktopBrowserHostFor,
  previewRuntimeFor,
  rendersServerTabNatively,
} from "./previewRuntime";

const primary = EnvironmentId.make("primary");
const remote = EnvironmentId.make("remote");

beforeEach(() => {
  state.electron = true;
  state.desktop = true;
  state.primary = primary;
  state.serverBrowser = new Set([primary, remote]);
  state.localDesktopBrowser = true;
});

describe("previewRuntimeFor", () => {
  it("opens a remote environment's tabs on this computer in the desktop app", () => {
    expect(previewRuntimeFor(remote)).toBeUndefined();
    expect(previewRuntimeFor(primary)).toBe("server");
  });

  it("uses the environment's browser where the client has none of its own", () => {
    state.electron = false;
    state.desktop = false;
    state.serverBrowser = new Set([remote]);

    expect(previewRuntimeFor(remote)).toBe("server");
  });
});

describe("alternatePreviewRuntime", () => {
  it("moves a remote environment's tab between this computer and the environment", () => {
    expect(alternatePreviewRuntime(remote, primary, true, {})).toBe("server");
    expect(alternatePreviewRuntime(remote, primary, true, { runtime: "server" })).toBe("desktop");
    expect(alternatePreviewRuntime(primary, primary, true, {})).toBeNull();
    expect(alternatePreviewRuntime(remote, primary, false, {})).toBeNull();
  });

  it("offers no move outside the desktop app", () => {
    state.electron = false;
    state.desktop = false;

    expect(alternatePreviewRuntime(remote, null, true, { runtime: "server" })).toBeNull();
  });
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

  it("renders only the selected remote desktop, including a primary server using RPC", () => {
    state.localDesktopBrowser = false;
    expect(desktopBrowserHostFor(primary)).toBe("host-primary");
    expect(desktopBrowserHostFor(remote)).toBe("host-remote");
    expect(previewRuntimeFor(remote)).toBeUndefined();
    for (const environmentId of [primary, remote]) {
      expect(
        rendersServerTabNatively(environmentId, primary, {
          runtime: "server",
          backingPage: "desktop",
          desktopHostId: `host-${environmentId}`,
        }),
      ).toBe(true);
      expect(
        rendersServerTabNatively(environmentId, primary, {
          runtime: "server",
          backingPage: "desktop",
          desktopHostId: "another-desktop",
        }),
      ).toBe(false);
    }
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

describe("runtime and native ownership boundaries", () => {
  it("does not select a server browser the environment does not support", () => {
    state.serverBrowser.clear();

    expect(previewRuntimeFor(primary)).toBeUndefined();
    state.desktop = false;
    expect(previewRuntimeFor(remote)).toBeUndefined();
  });

  it("moves explicit desktop tabs but offers no move without a tab", () => {
    expect(alternatePreviewRuntime(remote, primary, true, { runtime: "desktop" })).toBe("server");
    expect(alternatePreviewRuntime(remote, primary, true, null)).toBeNull();
    expect(alternatePreviewRuntime(remote, primary, true, undefined)).toBeNull();
  });

  it("does not borrow local ownership for a remote environment or missing primary", () => {
    expect(
      rendersServerTabNatively(remote, primary, {
        runtime: "server",
        backingPage: "desktop",
        desktopHostId: "local",
      }),
    ).toBe(false);
    expect(
      rendersServerTabNatively(primary, null, {
        runtime: "server",
        backingPage: "desktop",
        desktopHostId: "local",
      }),
    ).toBe(false);
  });

  it("does not attach a server guest to a desktop-runtime tab or a non-desktop client", () => {
    for (const runtime of [undefined, "desktop"] as const) {
      expect(
        rendersServerTabNatively(remote, primary, {
          runtime,
          backingPage: "desktop",
          desktopHostId: "host-remote",
        }),
      ).toBe(false);
    }
    expect(rendersServerTabNatively(remote, primary, null)).toBe(false);
    state.electron = false;
    expect(desktopBrowserHostFor(remote)).toBeUndefined();
    expect(
      rendersServerTabNatively(remote, primary, {
        runtime: "server",
        backingPage: "desktop",
        desktopHostId: "host-remote",
      }),
    ).toBe(false);
  });
});
