// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- The isolated HTTP fixture and in-browser fetch calls measure Chromium's actual cache.
import * as NodeHttp from "node:http";
import * as NodeEvents from "node:events";
import { chromium, type CDPSession, type Page } from "playwright-core";
import { expect, it, vi } from "vite-plus/test";

import { installThreadLinkNavigation } from "./ThreadLinkNavigation.ts";
import { createPdfDocumentNavigation } from "./PdfDocumentNavigation.ts";

const href = "t3-thread://v2/linked-environment/missing-thread";
const hosted = "https://app.t3.codes/threads/linked-environment/missing-thread";

async function fulfillHosted(cdp: CDPSession) {
  cdp.on("Fetch.requestPaused", ({ requestId }) =>
    cdp.send("Fetch.fulfillRequest", {
      requestId,
      responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "text/html" }],
      body: Buffer.from("<!doctype html><p>Hosted document</p>").toString("base64"),
    }),
  );
  await cdp.send("Fetch.enable", {
    patterns: [{ urlPattern: "https://app.t3.codes/threads/*/*", resourceType: "Document" }],
  });
}

it("keeps clicked thread navigations in the app, including hosted new windows", async () => {
  const browser = await chromium.launch({ headless: true, channel: "chromium" });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const browserCdp = await browser.newBrowserCDPSession();
    const { targetInfo: sourceTarget } = await cdp.send("Target.getTargetInfo");
    let closeProtocolPopup = false;
    browserCdp.on("Target.targetCreated", ({ targetInfo }) => {
      if (
        closeProtocolPopup &&
        targetInfo.type === "page" &&
        targetInfo.targetId !== sourceTarget.targetId
      )
        void browserCdp.send("Target.closeTarget", { targetId: targetInfo.targetId });
    });
    await browserCdp.send("Target.setDiscoverTargets", { discover: true });
    await context.route(hosted, (route) =>
      route.fulfill({ contentType: "text/html", body: "Hosted popup fixture" }),
    );
    let opened = Promise.withResolvers<string>();
    const requests: string[] = [];
    const blockPopup = vi.fn();
    const source = "https://source.example.test/";
    await context.route(source, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<a id="custom" href="${href}">Custom</a><a id="hosted" href="${hosted}">Hosted</a><button id="location" onclick="location.href='${hosted}'">Navigate</button><button id="popup" onclick="window.open('${href}')">Popup</button><a id="customPopup" href="${href}" target="_blank">Custom popup</a><a id="hostedPopup" href="${hosted}" target="_blank">Hosted popup</a>`,
      }),
    );
    await page.goto(source);
    await installThreadLinkNavigation(
      page,
      cdp,
      false,
      (url) => {
        requests.push(url);
        opened.resolve(url);
        return true;
      },
      blockPopup,
    );
    for (const [selector, expected] of [
      ["#custom", href],
      ["#hosted", hosted],
      ["#location", hosted],
      ["#popup", href],
      ["#customPopup", href],
      ["#hostedPopup", hosted],
    ]) {
      opened = Promise.withResolvers<string>();
      // A custom-protocol target has no document to finish initialising. Close
      // the real Chromium target to exercise its uncommitted, already-closed popup event.
      closeProtocolPopup = selector === "#popup" || selector === "#customPopup";
      const detached = ["#popup", "#customPopup", "#hostedPopup"].includes(selector!)
        ? new Promise<Page>((resolve) => page.once("popup", resolve))
        : undefined;
      await page.locator(selector!).click();
      expect(await opened.promise).toBe(expected);
      if (detached) {
        const popup = await detached;
        expect(blockPopup).toHaveBeenCalledWith(popup);
        if (!popup.isClosed())
          await new Promise<void>((resolve) => popup.once("close", () => resolve()));
        expect(context.pages()).toEqual([page]);
      }
      expect(page.url()).toBe(source);
    }
    expect(requests).toEqual([href, hosted, hosted, href, href, hosted]);
  } finally {
    await browser.close();
  }
});

it("does not open a delayed navigation after an unrelated trusted click", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const opened: string[] = [];
    await page.setContent(
      `<button onclick="setTimeout(() => location.href = '${href}', 0)">Unrelated click</button>`,
    );
    await installThreadLinkNavigation(
      page,
      cdp,
      false,
      (url) => {
        opened.push(url);
        return true;
      },
      () => {},
    );
    const attempted = new Promise<void>((resolve) =>
      cdp.on("Page.frameRequestedNavigation", ({ url }) => {
        if (url === href) resolve();
      }),
    );
    await page.getByRole("button").click();
    await attempted;
    expect(opened).toEqual([]);
  } finally {
    await browser.close();
  }
});

it("preserves HTTP caching and lets typed or agent-loaded hosted documents load", async () => {
  let assetRequests = 0;
  const server = NodeHttp.createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    if (request.url === "/asset") {
      assetRequests += 1;
      response.setHeader("Cache-Control", "public, max-age=600");
    }
    response.end(request.url === "/asset" ? "cached" : "<!doctype html><p>Ordinary page</p>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture listener");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/`);
    expect(await page.evaluate(() => fetch("/asset").then((response) => response.text()))).toBe(
      "cached",
    );
    const cdp = await context.newCDPSession(page);
    const send = vi.spyOn(cdp, "send");
    const opened: string[] = [];
    const pdf = await createPdfDocumentNavigation(cdp);
    expect(pdf).not.toBeNull();
    await installThreadLinkNavigation(
      page,
      cdp,
      false,
      (url) => {
        opened.push(url);
        return false;
      },
      () => {},
      pdf ? [pdf] : [],
    );
    expect(await page.evaluate(() => fetch("/asset").then((response) => response.text()))).toBe(
      "cached",
    );
    expect(assetRequests).toBe(1);
    expect(send.mock.calls.some(([method]) => method === "Network.setCacheDisabled")).toBe(false);
    for (const path of ["/api/assets/image.png", "/docs/api/assets/readme"]) {
      const response = await page.goto(`http://127.0.0.1:${address.port}${path}`);
      expect(response?.status()).toBe(200);
      expect(new URL(page.url()).pathname).toBe(path);
    }
    const fixture = await context.newCDPSession(page);
    await fulfillHosted(fixture);
    await page.goto(hosted);
    expect(page.url()).toBe(hosted);
    expect(opened).toEqual([]);
    await page.evaluate(
      `document.body.innerHTML = ${JSON.stringify(`<a href="${hosted}">Agent click without a viewer</a>`)}`,
    );
    await Promise.all([
      page.waitForNavigation({ waitUntil: "load" }),
      page.getByRole("link").click(),
    ]);
    expect(await page.locator("p").textContent()).toBe("Hosted document");
    expect(opened).toEqual([hosted]);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("continues dropped opens and expires announcements before a later typed navigation", async () => {
  const events = new NodeEvents.EventEmitter();
  const send = vi.fn(async (method: string) =>
    method === "Page.getFrameTree" ? { frameTree: { frame: { id: "main" } } } : {},
  );
  const cdp = Object.assign(events, { send }) as unknown as CDPSession;
  const open = vi.fn(() => false);
  const page = new NodeEvents.EventEmitter();
  const blockPopup = vi.fn();
  const navigation = await installThreadLinkNavigation(
    page as unknown as Page,
    cdp,
    false,
    open,
    blockPopup,
  );
  events.emit("Runtime.executionContextCreated", {
    context: { id: 1, name: "t3-thread-link-activation", auxData: { frameId: "main" } },
  });
  const gesture = (payload: string) =>
    events.emit("Runtime.bindingCalled", {
      name: "t3ThreadLinkGesture",
      payload,
      executionContextId: 1,
    });
  const announce = () =>
    events.emit("Page.frameRequestedNavigation", {
      frameId: "main",
      disposition: "currentTab",
      url: hosted,
    });
  const pause = (requestId: string, response: object = {}) =>
    events.emit("Fetch.requestPaused", {
      requestId,
      frameId: "main",
      resourceType: "Document",
      request: { url: hosted, method: "GET" },
      ...response,
    });
  gesture("active");
  events.emit("Page.windowOpen", { url: href, userGesture: true });
  const popup = { url: () => ":", close: vi.fn() };
  page.emit("popup", popup);
  expect(blockPopup).not.toHaveBeenCalled();
  expect(popup.close).not.toHaveBeenCalled();
  announce();
  pause("dropped-open");
  expect(navigation.isThreadNavigation(hosted)).toBe(false);
  open.mockReturnValue(true);
  announce();
  expect(navigation.isThreadNavigation(hosted)).toBe(true);
  gesture("inactive");
  expect(navigation.isThreadNavigation(hosted)).toBe(false);
  pause("typed-after-cancelled-click");
  pause("failed-response", { responseErrorReason: "Failed" });
  gesture("active");
  announce();
  events.emit("Network.requestWillBeSent", {
    requestId: "sent",
    type: "Document",
    request: { url: hosted },
  });
  gesture("inactive");
  expect(navigation.isThreadNavigation(hosted)).toBe(true);
  pause("dispatched-during-click", { networkId: "sent" });
  expect(navigation.consumeFailedNavigation(hosted)).toBe(true);
  expect(navigation.isThreadNavigation(hosted)).toBe(false);
  expect(
    send.mock.calls.filter(([method]) => method.startsWith("Fetch.") && method !== "Fetch.enable"),
  ).toEqual([
    ["Fetch.continueRequest", { requestId: "dropped-open" }],
    ["Fetch.continueRequest", { requestId: "typed-after-cancelled-click" }],
    ["Fetch.continueRequest", { requestId: "failed-response" }],
    ["Fetch.failRequest", { requestId: "dispatched-during-click", errorReason: "Aborted" }],
  ]);
});
