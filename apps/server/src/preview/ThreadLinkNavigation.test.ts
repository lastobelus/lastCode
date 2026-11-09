import type { CDPSession, Page, Route } from "playwright-core";
import { chromium } from "playwright-core";
import { describe, expect, it, vi } from "vite-plus/test";

import { installThreadLinkNavigation } from "./ThreadLinkNavigation.ts";

const href = "t3-thread://v2/linked-environment/missing-thread";
const hosted = "https://app.t3.codes/threads/linked-environment/missing-thread";

function fixture(native = false, active = false) {
  const listeners = new Map<string, (event: Record<string, unknown>) => Promise<void> | void>();
  const routes: Array<{
    matches: (url: URL) => boolean;
    intercept: (route: Route) => Promise<void>;
  }> = [];
  const frame = { page: () => page };
  const context = {
    route: async (matches: (url: URL) => boolean, intercept: (route: Route) => Promise<void>) => {
      routes.push({ matches, intercept });
    },
  };
  const page = {
    context: () => context,
    mainFrame: () => frame,
    once: vi.fn(),
    on: vi.fn(),
  } as unknown as Page;
  const send = vi.fn(async (method: string) => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 42 };
    return { result: { value: active } };
  });
  const cdp = {
    send,
    on: (name: string, listener: (event: Record<string, unknown>) => Promise<void> | void) => {
      listeners.set(name, listener);
    },
  } as unknown as CDPSession;
  const open = vi.fn();
  return {
    open,
    send,
    install: () => installThreadLinkNavigation(page, cdp, native, open),
    navigation: (url = href, frameId = "main") =>
      listeners.get("Page.frameRequestedNavigation")?.({ url, frameId, disposition: "currentTab" }),
    popup: (url: string, userGesture: boolean) =>
      listeners.get("Page.windowOpen")?.({ url, userGesture }),
    request: async (url: string, gesture: boolean, navigation = true, main = true) => {
      const abort = vi.fn(async () => {});
      const fallback = vi.fn(async () => {});
      const request = {
        url: () => url,
        headers: () => (gesture ? { "sec-fetch-user": "?1" } : {}),
        frame: () => (main ? frame : { page: () => page }),
        isNavigationRequest: () => navigation,
      };
      const route = { request: () => request, abort, fallback } as unknown as Route;
      const found = routes.find((entry) => entry.matches(new URL(url)));
      await found?.intercept(route);
      return { abort, fallback, intercepted: found !== undefined };
    },
  };
}

describe("Browser thread navigation", () => {
  it.each([false, true])(
    "requires Chromium activation for native=%s navigation",
    async (active) => {
      const test = fixture(true, active);
      await test.install();
      for (const url of [href, "t3-thread://v1/thread", hosted]) await test.navigation(url);
      expect(test.open.mock.calls.map(([url]) => url)).toEqual(
        active ? [href, "t3-thread://v1/thread", hosted] : [],
      );
      expect(test.send).toHaveBeenCalledWith("Runtime.evaluate", {
        contextId: 42,
        expression: "navigator.userActivation.isActive",
        returnByValue: true,
      });
      await test.navigation(hosted, "child");
      await test.navigation("t3-thread://v2/environment/%ZZ");
      await test.navigation("https://app.t3.codes/settings");
      expect(test.open).toHaveBeenCalledTimes(active ? 3 : 0);
    },
  );

  it("requires a gesture for window.open in both hosts", async () => {
    for (const native of [false, true]) {
      const test = fixture(native);
      await test.install();
      for (const url of [href, hosted]) {
        await test.popup(url, false);
        expect(test.open).not.toHaveBeenCalled();
      }
      await test.popup("https://app.t3.codes/settings", true);
      await test.popup("t3-thread://v2/environment/%ZZ", true);
      expect(test.open).not.toHaveBeenCalled();
      await test.popup(href, true);
      await test.popup(hosted, true);
      expect(test.open.mock.calls).toEqual([[href], [hosted]]);
    }
  });

  it("cancels only hosted thread document navigations, including missing targets", async () => {
    const test = fixture();
    await test.install();
    expect((await test.request(hosted, false)).abort).toHaveBeenCalledWith("aborted");
    expect(test.open).not.toHaveBeenCalled();
    const ordinary = await test.request("https://app.t3.codes/settings", true);
    expect(ordinary.intercepted).toBe(false);
    expect((await test.request(hosted, true, false)).fallback).toHaveBeenCalledOnce();
    expect((await test.request(hosted, true, true, false)).fallback).toHaveBeenCalledOnce();
    await test.request(hosted, true);
    expect(test.open).not.toHaveBeenCalled();
  });

  it("keeps the environment page when Chromium handles clicked and scripted thread links", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      let opened = Promise.withResolvers<string>();
      const requests: string[] = [];
      await page.setContent(
        `<a id="custom" href="${href}">Custom</a><a id="hosted" href="${hosted}">Hosted</a><button id="popup" onclick="window.open('${href}')">Popup</button><a id="hostedPopup" href="${hosted}" target="_blank">Hosted popup</a>`,
      );
      await installThreadLinkNavigation(page, cdp, false, (url) => {
        requests.push(url);
        opened.resolve(url);
      });
      await page.locator("#custom").click();
      expect(await opened.promise).toBe(href);
      expect(page.url()).toBe("about:blank");
      opened = Promise.withResolvers<string>();
      await page.locator("#hosted").click();
      expect(await opened.promise).toBe(hosted);
      expect(page.url()).toBe("about:blank");
      opened = Promise.withResolvers<string>();
      await page.locator("#popup").click();
      expect(await opened.promise).toBe(href);
      expect(requests).toEqual([href, hosted, href]);
      opened = Promise.withResolvers<string>();
      const abortedPopup = context.waitForEvent("requestfailed", {
        predicate: (request) => request.url() === hosted,
      });
      await page.locator("#hostedPopup").click();
      expect(await opened.promise).toBe(hosted);
      await abortedPopup;
      expect(context.pages()).toEqual([page]);
      expect(page.url()).toBe("about:blank");
    } finally {
      await browser.close();
    }
  });
});
