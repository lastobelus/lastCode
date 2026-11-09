// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- The isolated HTTP fixture and in-browser fetch calls measure Chromium's actual cache.
import * as NodeHttp from "node:http";
import { chromium, type CDPSession } from "playwright-core";
import { expect, it, vi } from "vite-plus/test";

import { installThreadLinkNavigation } from "./ThreadLinkNavigation.ts";

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
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await context.route(hosted, (route) =>
      route.fulfill({ contentType: "text/html", body: "Hosted popup fixture" }),
    );
    let opened = Promise.withResolvers<string>();
    const requests: string[] = [];
    await page.setContent(
      `<a id="custom" href="${href}">Custom</a><a id="hosted" href="${hosted}">Hosted</a><button id="location" onclick="location.href='${hosted}'">Navigate</button><button id="popup" onclick="window.open('${href}')">Popup</button><a id="hostedPopup" href="${hosted}" target="_blank">Hosted popup</a>`,
    );
    await installThreadLinkNavigation(
      page,
      cdp,
      false,
      (url) => {
        requests.push(url);
        opened.resolve(url);
      },
      () => {},
    );
    for (const [selector, expected] of [
      ["#custom", href],
      ["#hosted", hosted],
      ["#location", hosted],
      ["#popup", href],
      ["#hostedPopup", hosted],
    ]) {
      opened = Promise.withResolvers<string>();
      const detached =
        selector === "#hostedPopup"
          ? new Promise<void>((resolve) =>
              page.once("popup", (popup) => popup.once("close", () => resolve())),
            )
          : undefined;
      await page.locator(selector!).click();
      expect(await opened.promise).toBe(expected);
      if (detached) {
        await detached;
        expect(context.pages()).toEqual([page]);
      }
      expect(page.url()).toBe("about:blank");
    }
    expect(requests).toEqual([href, hosted, hosted, href, hosted]);
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
      (url) => opened.push(url),
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
    await installThreadLinkNavigation(
      page,
      cdp,
      false,
      (url) => opened.push(url),
      () => {},
    );
    expect(await page.evaluate(() => fetch("/asset").then((response) => response.text()))).toBe(
      "cached",
    );
    expect(assetRequests).toBe(1);
    expect(send.mock.calls.some(([method]) => method === "Network.setCacheDisabled")).toBe(false);
    const fixture = await context.newCDPSession(page);
    await fulfillHosted(fixture);
    await page.goto(hosted);
    expect(page.url()).toBe(hosted);
    expect(opened).toEqual([]);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
