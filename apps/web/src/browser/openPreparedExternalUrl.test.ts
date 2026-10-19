import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ openExternal: vi.fn(async (_url: string) => undefined) }));
vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({ shell: { openExternal: mocks.openExternal } }),
}));

import { openPreparedExternalUrl } from "./openPreparedExternalUrl";

function installBrowser() {
  const referrer = { name: "", content: "" };
  const tab = {
    opener: {},
    closed: false,
    close: vi.fn(),
    location: { replace: vi.fn() },
    document: { createElement: () => referrer, head: { append: vi.fn() } },
  };
  const open = vi.fn(() => tab);
  vi.stubGlobal("window", { open });
  return { open, tab, referrer };
}

afterEach(() => {
  vi.unstubAllGlobals();
  mocks.openExternal.mockClear();
});

describe("prepared external navigation", () => {
  it("reserves a tab synchronously and navigates it after delayed recovery", async () => {
    const { open, tab, referrer } = installBrowser();
    let complete!: (url: string) => void;
    const prepared = new Promise<string>((resolve) => {
      complete = resolve;
    });
    const opening = openPreparedExternalUrl("http://localhost:5173/qa", () => prepared);
    expect(open).toHaveBeenCalledExactlyOnceWith("about:blank", "_blank");
    expect(tab.opener).toBeNull();
    expect(referrer.content).toBe("no-referrer");
    expect(tab.location.replace).not.toHaveBeenCalled();
    complete("http://workstation.example:5173/qa");
    await opening;
    expect(tab.location.replace).toHaveBeenCalledExactlyOnceWith(
      "http://workstation.example:5173/qa",
    );
    expect(open).toHaveBeenCalledTimes(1);
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it("closes the reserved tab when preparation fails", async () => {
    const { tab } = installBrowser();
    await expect(
      openPreparedExternalUrl("https://example.com/qa", async () => {
        throw new Error("Recovery unavailable");
      }),
    ).rejects.toThrow("Recovery unavailable");
    expect(tab.close).toHaveBeenCalledOnce();
    expect(tab.location.replace).not.toHaveBeenCalled();
  });

  it("reports a blocked popup before starting recovery", async () => {
    vi.stubGlobal("window", { open: vi.fn(() => null) });
    const prepare = vi.fn(async () => "https://example.com/qa");
    await expect(openPreparedExternalUrl("https://example.com/qa", prepare)).rejects.toThrow(
      "Allow popups",
    );
    expect(prepare).not.toHaveBeenCalled();
  });

  it("keeps desktop opening behind recovery without reserving a web tab", async () => {
    const open = vi.fn();
    vi.stubGlobal("window", { desktopBridge: {}, open });
    await openPreparedExternalUrl(
      "http://localhost:5173/qa",
      async () => "http://workstation.example:5173/qa",
    );
    expect(open).not.toHaveBeenCalled();
    expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith(
      "http://workstation.example:5173/qa",
    );
  });
});
