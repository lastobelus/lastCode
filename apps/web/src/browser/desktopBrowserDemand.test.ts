import { afterEach, expect, it, vi } from "vite-plus/test";

import {
  ensureDesktopBrowserTab,
  markDesktopBrowserTabReady,
  markDesktopBrowserTabUnavailable,
  registerDesktopBrowserDemand,
} from "./desktopBrowserDemand";

afterEach(() => vi.useRealTimers());

it("coalesces concurrent cold demand and releases background activity once the actual guest is ready", async () => {
  const release = vi.fn();
  const request = vi.fn(() => release);
  const unregister = registerDesktopBrowserDemand("shared-demand", request);
  const first = ensureDesktopBrowserTab("shared-demand", "https://example.test/");
  const second = ensureDesktopBrowserTab("shared-demand", "https://example.test/");
  expect(request).toHaveBeenCalledOnce();
  expect(release).not.toHaveBeenCalled();
  markDesktopBrowserTabReady("shared-demand");
  await Promise.all([first, second]);
  await ensureDesktopBrowserTab("shared-demand");
  expect(request).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledOnce();
  unregister();
});

it("retries a failed reservation or preparation while the same tab remains selected", async () => {
  const release = vi.fn();
  const request = vi.fn(() => release);
  const unregister = registerDesktopBrowserDemand("failed-demand", request);
  const first = ensureDesktopBrowserTab("failed-demand");
  const failure = new Error("All desktop previews are currently in use.");
  markDesktopBrowserTabUnavailable("failed-demand", failure);
  await expect(first).rejects.toBe(failure);
  const retry = ensureDesktopBrowserTab("failed-demand");
  expect(request).toHaveBeenCalledTimes(2);
  markDesktopBrowserTabReady("failed-demand");
  await retry;
  expect(release).toHaveBeenCalledTimes(2);
  unregister();
});

it("lets a new address supersede a stalled cold recovery without waiting for the old target", async () => {
  const release = vi.fn();
  const request = vi.fn(() => release);
  const unregister = registerDesktopBrowserDemand("new-address", request);
  const old = ensureDesktopBrowserTab("new-address");
  const latest = ensureDesktopBrowserTab("new-address", "https://new.example.test/");
  await expect(old).rejects.toThrow("superseded");
  expect(request.mock.calls).toEqual([[undefined], ["https://new.example.test/"]]);
  expect(release).toHaveBeenCalledOnce();
  markDesktopBrowserTabReady("new-address");
  await latest;
  unregister();
});

it("bounds a missing desktop and releases activity without polling", async () => {
  vi.useFakeTimers();
  const release = vi.fn();
  const unregister = registerDesktopBrowserDemand("missing-desktop", () => release);
  const request = ensureDesktopBrowserTab("missing-desktop");
  const rejected = expect(request).rejects.toThrow("did not restore");
  await vi.advanceTimersByTimeAsync(45_000);
  await rejected;
  expect(release).toHaveBeenCalledOnce();
  unregister();
});
