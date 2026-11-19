import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const readPreparedConnection = vi.fn();
vi.mock("~/state/session", () => ({ readPreparedConnection }));

const environmentId = EnvironmentId.make("environment-1");

function createSessionStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

describe("native remote browser transport", () => {
  beforeEach(() => {
    readPreparedConnection.mockReset();
    vi.resetModules();
    vi.stubGlobal("window", { sessionStorage: createSessionStorage() });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("maps environment loopback URLs without losing path, query, or fragment", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://192.168.1.20:3773" });
    const { resolveDesktopBrowserUrl } = await import("./desktopBrowserTransport");
    expect(resolveDesktopBrowserUrl(environmentId, "http://localhost:5173/path?q=1#result")).toBe(
      "http://192.168.1.20:5173/path?q=1#result",
    );
    expect(
      resolveDesktopBrowserUrl(
        environmentId,
        "http://viewer:example@localhost:5173/path?q=1#result",
      ),
    ).toBe("http://viewer:example@192.168.1.20:5173/path?q=1#result");
    expect(resolveDesktopBrowserUrl(environmentId, "https://example.com/path?q=1#result")).toBe(
      "https://example.com/path?q=1#result",
    );
  });

  it("fails closed for loopback on unsupported relay origins and missing connections", async () => {
    const { resolveDesktopBrowserUrl } = await import("./desktopBrowserTransport");
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "https://relay.example.com" });
    expect(resolveDesktopBrowserUrl(environmentId, "http://127.0.0.1:5173/")).toBeNull();
    readPreparedConnection.mockReturnValue(null);
    expect(resolveDesktopBrowserUrl(environmentId, "http://[::1]:5173/")).toBeNull();
  });

  it("keeps host identity stable per environment and distinct across environments", async () => {
    const { getDesktopBrowserHostId } = await import("./desktopBrowserTransport");
    expect(getDesktopBrowserHostId(environmentId)).toBe(getDesktopBrowserHostId(environmentId));
    expect(getDesktopBrowserHostId(EnvironmentId.make("environment-2"))).not.toBe(
      getDesktopBrowserHostId(environmentId),
    );
  });

  it("retains each environment's owner when renderer modules reload", async () => {
    const firstRenderer = await import("./desktopBrowserTransport");
    const otherEnvironment = EnvironmentId.make("environment-2");
    const firstOwner = firstRenderer.getDesktopBrowserHostId(environmentId);
    const otherOwner = firstRenderer.getDesktopBrowserHostId(otherEnvironment);
    vi.resetModules();
    const reloadedRenderer = await import("./desktopBrowserTransport");
    expect(reloadedRenderer.getDesktopBrowserHostId(environmentId)).toBe(firstOwner);
    expect(reloadedRenderer.getDesktopBrowserHostId(otherEnvironment)).toBe(otherOwner);
    expect(otherOwner).not.toBe(firstOwner);
  });

  it("keeps independent desktop window sessions distinct for the same environment", async () => {
    const firstSession = window.sessionStorage;
    const firstRenderer = await import("./desktopBrowserTransport");
    const firstOwner = firstRenderer.getDesktopBrowserHostId(environmentId);
    vi.stubGlobal("window", { sessionStorage: createSessionStorage() });
    vi.resetModules();
    const otherRenderer = await import("./desktopBrowserTransport");
    const otherOwner = otherRenderer.getDesktopBrowserHostId(environmentId);
    expect(otherOwner).not.toBe(firstOwner);
    vi.stubGlobal("window", { sessionStorage: firstSession });
    vi.resetModules();
    const resumedRenderer = await import("./desktopBrowserTransport");
    expect(resumedRenderer.getDesktopBrowserHostId(environmentId)).toBe(firstOwner);
  });
});
