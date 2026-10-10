import * as NodeHttp from "node:http";

import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "playwright-core";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { presentAsChrome } from "./ServerBrowserContexts.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";

describe("native viewport", () => {
  it("uses the CDP guest dimensions and scroll offset for a scaled capture", async () => {
    const page = { viewportSize: () => null } as unknown as Page;
    const send = vi.fn(async (method: string) =>
      method === "Page.getLayoutMetrics"
        ? { cssVisualViewport: { clientWidth: 390, clientHeight: 844, pageX: 20, pageY: 30 } }
        : { data: "image" },
    );
    const cdp = { send } as unknown as CDPSession;
    expect(await ServerBrowserPage.viewportSize(page, cdp)).toEqual({ width: 390, height: 844 });
    expect(await ServerBrowserPage.captureViewport(page, cdp, { format: "png", scale: 0.5 })).toBe(
      "image",
    );
    expect(send).toHaveBeenLastCalledWith("Page.captureScreenshot", {
      format: "png",
      clip: { x: 20, y: 30, width: 390, height: 844, scale: 0.5 },
    });
  });

  it.each([
    {
      zoom: 1.25,
      css: { width: 800, height: 600 },
      dip: { x: 25, y: 50, width: 1000, height: 750 },
    },
    {
      zoom: 0.75,
      css: { width: 800, height: 600 },
      dip: { x: 15, y: 30, width: 600, height: 450 },
    },
  ])(
    "converts a zoomed native capture and its document offsets to DIP ($zoom)",
    async ({ zoom, css, dip }) => {
      const page = { viewportSize: () => null } as unknown as Page;
      const send = vi.fn(async (method: string) =>
        method === "Page.getLayoutMetrics"
          ? {
              cssVisualViewport: {
                clientWidth: css.width,
                clientHeight: css.height,
                pageX: 20,
                pageY: 40,
                zoom,
              },
            }
          : { data: "image" },
      );
      const cdp = { send } as unknown as CDPSession;
      expect(await ServerBrowserPage.viewportSize(page, cdp)).toEqual(css);
      await ServerBrowserPage.captureViewport(page, cdp, { format: "png", scale: 0.5 });
      expect(send).toHaveBeenLastCalledWith("Page.captureScreenshot", {
        format: "png",
        clip: { ...dip, scale: 0.5 },
      });
    },
  );

  it("retains the configured emulated viewport and offsets despite native zoom metrics", async () => {
    const page = { viewportSize: () => ({ width: 1000, height: 750 }) } as unknown as Page;
    const send = vi.fn(async (method: string) =>
      method === "Page.getLayoutMetrics"
        ? {
            cssVisualViewport: {
              clientWidth: 800,
              clientHeight: 600,
              pageX: 20,
              pageY: 40,
              zoom: 1.25,
            },
          }
        : { data: "image" },
    );
    await ServerBrowserPage.captureViewport(page, { send } as unknown as CDPSession, {
      format: "png",
      scale: 0.5,
    });
    expect(send).toHaveBeenLastCalledWith("Page.captureScreenshot", {
      format: "png",
      clip: { x: 20, y: 40, width: 1000, height: 750, scale: 0.5 },
    });
  });
});

describe("server browser element refs", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let cdp: CDPSession;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext();
    page = await context.newPage();
    cdp = await context.newCDPSession(page);
  });
  afterEach(async () => {
    await context.close();
  });

  const takeSnapshot = () =>
    ServerBrowserPage.snapshot({
      page,
      cdp,
      renderScale: 1,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
    });

  it.each(["back", "forward", "reload", "same-document back"])(
    "redirects a changed origin during %s without adding a history entry",
    async (operation) => {
      const requests: string[] = [];
      const server = NodeHttp.createServer((request, response) => {
        requests.push(`http://${request.headers.host}${request.url}`);
        response.setHeader("Content-Type", "text/html");
        response.end("<p>report</p>");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (address === null || typeof address === "string")
          throw new Error("Missing test listener");
        const origin = `http://127.0.0.1:${address.port}`;
        const before = `${origin}/before`;
        const after = `${origin}/after`;
        const stored = `${origin}/report?mode=dark#anchor`;
        const target =
          operation === "same-document back" ? stored.replace("#anchor", "#first") : stored;
        const destination = target.replace("127.0.0.1", "localhost");
        await page.goto(before);
        if (operation === "same-document back") await page.goto(target);
        await page.goto(stored);
        if (operation === "back" || operation === "forward") await page.goto(after);
        if (operation === "forward") {
          await page.goBack();
          await page.goBack();
        }
        const history = await cdp.send("Page.getNavigationHistory");
        requests.length = 0;
        await ServerBrowserPage.navigateWithRedirect(page, target, destination, async () => {
          if (operation === "forward") await page.goForward({ waitUntil: "commit" });
          else if (operation === "reload") await page.reload({ waitUntil: "commit" });
          else await page.goBack({ waitUntil: "commit" });
        });
        const navigated = await cdp.send("Page.getNavigationHistory");
        expect(page.url()).toBe(destination);
        expect(navigated.entries).toHaveLength(history.entries.length);
        expect(navigated.currentIndex).toBe(
          history.currentIndex + (operation === "forward" ? 1 : operation === "reload" ? 0 : -1),
        );
        expect(requests.filter((url) => new URL(url).pathname === "/report")).toEqual([
          destination.split("#")[0],
        ]);
        await page.goBack();
        expect(page.url()).toBe(before);
        await page.goForward();
        expect(page.url()).toBe(destination);
        if (operation === "back" || operation === "forward") {
          await page.goForward();
          expect(page.url()).toBe(after);
        }
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );

  it("captures the full native DIP viewport with actual PNG pixels matching bounded snapshot metadata", async () => {
    const nativeBrowser = await chromium.launch({
      headless: true,
      args: ["--force-device-scale-factor=2", "--window-size=1000,750"],
    });
    try {
      const nativeContext = await nativeBrowser.newContext({ viewport: null });
      const nativePage = await nativeContext.newPage();
      const nativeSession = await nativeContext.newCDPSession(nativePage);
      await nativePage.setContent('<p style="margin:0">native viewport</p>');
      // Model native page zoom through its layout metrics; Chromium still encodes the real image.
      expect(nativePage.viewportSize()).toBeNull();
      const send = vi.fn(
        async (
          method: string,
          options?: {
            format: "png";
            clip?: { x: number; y: number; width: number; height: number; scale: number };
          },
        ) => {
          if (method === "Page.getLayoutMetrics")
            return {
              cssVisualViewport: {
                clientWidth: 800,
                clientHeight: 600,
                pageX: 0,
                pageY: 0,
                zoom: 1.25,
              },
            };
          expect(method).toBe("Page.captureScreenshot");
          return nativeSession.send("Page.captureScreenshot", options);
        },
      );
      const result = await ServerBrowserPage.snapshot({
        page: nativePage,
        cdp: { send } as unknown as CDPSession,
        renderScale: 2.5,
        consoleEntries: [],
        networkEntries: [],
        actionTimeline: [],
      });
      const png = Buffer.from(result.screenshot!.data, "base64");
      expect(png.subarray(12, 16).toString()).toBe("IHDR");
      const pixels = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
      expect(pixels).toEqual({ width: 1280, height: 960 });
      expect(result.screenshot).toMatchObject(pixels);
      expect(send).toHaveBeenLastCalledWith("Page.captureScreenshot", {
        format: "png",
        clip: { x: 0, y: 0, width: 1000, height: 750, scale: 0.64 },
      });
    } finally {
      await nativeBrowser.close();
    }
  });
  const locators = (tree: unknown) => {
    expect(typeof tree).toBe("string");
    return Array.from(
      String(tree).matchAll(/\[ref=([^\]]+)\]/g),
      (match) => `aria-ref=${match[1]}`,
    );
  };
  const buttonLocator = (tree: unknown, name: string) => {
    const line = String(tree)
      .split("\n")
      .find((line) => line.includes(`button "${name}"`));
    const locator = locators(line)[0];
    expect(locator).toBeDefined();
    return locator!;
  };
  const repeatedRows = `<ul>${Array.from({ length: 5 }, (_, i) => `<li>row ${i + 1}<button data-testid="delete-row" onclick="this.parentElement.remove()">delete</button></li>`).join("")}</ul>`;

  it("clicks the fifth repeated delete control without touching row one", async () => {
    await page.setContent(repeatedRows);
    const result = await takeSnapshot();
    const buttons = String(result.accessibilityTree)
      .split("\n")
      .filter((line) => line.includes('button "delete"'));
    expect(buttons).toHaveLength(5);
    await ServerBrowserPage.click(page, { locator: locators(buttons[4])[0]!, timeoutMs: 1_000 });
    expect(await page.locator("li").allTextContents()).toEqual([
      "row 1delete",
      "row 2delete",
      "row 3delete",
      "row 4delete",
    ]);
  });

  it("returns from a click once it opens a dialog", async () => {
    await page.setContent(
      `<button onclick="document.body.dataset.answer = String(confirm('sure?'))">Confirm</button>`,
    );
    const dialog = new Promise<import("playwright-core").Dialog>((resolve) =>
      page.once("dialog", resolve),
    );
    await ServerBrowserPage.click(page, {
      locator: buttonLocator((await takeSnapshot()).accessibilityTree, "Confirm"),
      timeoutMs: 1_000,
    });
    await (await dialog).accept();
    await expect.poll(() => page.locator("body").getAttribute("data-answer")).toBe("true");
  });

  it("rejects ambiguous CSS controls without clicking any row", async () => {
    await page.setContent(repeatedRows);
    await expect(
      ServerBrowserPage.click(page, {
        selector: 'button[data-testid="delete-row"]',
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/strict mode violation/);
    expect(await page.locator("li").count()).toBe(5);
  });

  it("does not retarget a removed ref to a replacement node", async () => {
    await page.setContent("<button onclick=\"this.textContent='clicked'\">original</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "original");
    await page.setContent("<button onclick=\"this.textContent='clicked'\">replacement</button>");
    await expect(ServerBrowserPage.click(page, { locator, timeoutMs: 100 })).rejects.toThrow();
    expect(await page.locator("button").textContent()).toBe("replacement");
  });

  it("targets iframe input refs and preserves the parent form", async () => {
    await page.setContent(
      '<input aria-label="parent"><iframe srcdoc="<input aria-label=child>"></iframe>',
    );
    await page.frameLocator("iframe").getByRole("textbox").waitFor();
    const result = await takeSnapshot();
    const line = String(result.accessibilityTree)
      .split("\n")
      .find((line) => line.includes('textbox "child"'));
    const locator = locators(line)[0]!;
    await ServerBrowserPage.type(page, { locator, text: "inside iframe", clear: true });
    expect(await page.frameLocator("iframe").getByRole("textbox").inputValue()).toBe(
      "inside iframe",
    );
    expect(await page.getByRole("textbox", { name: "parent" }).inputValue()).toBe("");
  });

  it("rejects refs from another tab", async () => {
    await page.setContent("<button>same label</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "same label");
    const other = await context.newPage();
    await other.setContent("<button>same label</button>");
    await expect(ServerBrowserPage.click(other, { locator })).rejects.toThrow(/another tab/);
  });

  it("revokes refs on takeover and issues usable refs in the next snapshot", async () => {
    await page.setContent("<button onclick=\"this.textContent='clicked'\">continue</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "continue");
    ServerBrowserPage.invalidateRefs(page);
    await expect(ServerBrowserPage.click(page, { locator })).rejects.toThrow(/stale/);
    const fresh = buttonLocator((await takeSnapshot()).accessibilityTree, "continue");
    await ServerBrowserPage.click(page, { locator: fresh });
    expect(await page.locator("button").textContent()).toBe("clicked");
  });

  it("revokes refs after navigation even when labels are identical", async () => {
    await page.goto("data:text/html,<button>continue</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "continue");
    await page.goto("data:text/html,<button>continue</button><p>new document</p>");
    await expect(ServerBrowserPage.click(page, { locator })).rejects.toThrow(/stale/);
  });

  it("only accepts refs from the most recent snapshot", async () => {
    await page.setContent("<button>continue</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "continue");
    await takeSnapshot();
    await expect(ServerBrowserPage.click(page, { locator })).rejects.toThrow(/stale/);
  });

  it.each(["aria-ref=e1", " aria-ref=e1", "css=body >> aria-ref=e1"])(
    "does not allow native refs to bypass generation validation (%s)",
    async (locator) => {
      await page.setContent("<button>continue</button>");
      await takeSnapshot();
      await expect(ServerBrowserPage.click(page, { locator })).rejects.toThrow(/stale/);
    },
  );

  it("preserves CSS selectors containing an aria-ref attribute", async () => {
    await page.setContent(
      '<button aria-ref="save" onclick="this.textContent=\'saved\'">save</button>',
    );
    await ServerBrowserPage.click(page, { selector: 'button[aria-ref="save"]' });
    expect(await page.locator("button").textContent()).toBe("saved");
  });

  it("preserves quoted attribute values containing ref engine text", async () => {
    await page.setContent(
      '<button data-example=" >> aria-ref=e1" onclick="this.textContent=\'saved\'">save</button>',
    );
    await ServerBrowserPage.click(page, { selector: 'button[data-example=" >> aria-ref=e1"]' });
    expect(await page.locator("button").textContent()).toBe("saved");
  });

  it("right-clicks, double-clicks, hovers, selects, and drags like a pointer user", async () => {
    await page.setContent(`
      <style>#menu { position: absolute; display: none } #hover:hover + #menu { display: block }</style>
      <button id="target">target</button>
      <div id="hover">hover me</div><div id="menu">menu item</div>
      <select id="size"><option value="s">Small</option><option value="l">Large</option></select>
      <div id="card" draggable="true">card</div><div id="lane" style="height:40px">lane</div>
      <p id="log"></p>
      <script>
        const log = (text) => (document.getElementById("log").textContent += text + ";");
        const target = document.getElementById("target");
        target.addEventListener("contextmenu", (event) => { event.preventDefault(); log("context"); });
        target.addEventListener("dblclick", () => log("dblclick"));
        document.getElementById("card").addEventListener("dragstart", (event) =>
          event.dataTransfer.setData("text/plain", "card"),
        );
        for (const type of ["dragenter", "dragover"])
          document.getElementById("lane").addEventListener(type, (event) => event.preventDefault());
        document.getElementById("lane").addEventListener("drop", () => log("drop"));
      </script>`);
    await ServerBrowserPage.click(page, { locator: "#target", button: "right" });
    await ServerBrowserPage.click(page, { locator: "#target", clickCount: 2 });
    await ServerBrowserPage.hover(page, { locator: "#hover" });
    expect(await page.isVisible("#menu")).toBe(true);
    // A visible label selects the same option as its value.
    expect(await ServerBrowserPage.select(page, { locator: "#size", values: ["Large"] })).toEqual({
      selected: ["l"],
    });
    await ServerBrowserPage.drag(page, { source: "#card", target: "#lane" });
    expect(await page.textContent("#log")).toBe("context;dblclick;drop;");
    await expect(
      ServerBrowserPage.select(page, { locator: "#target", values: ["s"] }),
    ).rejects.toMatchObject({ tag: "PreviewAutomationTargetNotEditableError" });
  });

  it("shows the agent's pointer at each target before the action reaches the page", async () => {
    await page.setContent(`
      <button id="go" style="position:absolute;left:100px;top:40px;width:80px;height:20px">go</button>
      <div id="tip" style="position:absolute;left:300px;top:40px;width:60px;height:20px">tip</div>
      <div id="card" draggable="true" style="position:absolute;left:20px;top:120px;width:40px;height:40px">card</div>
      <div id="lane" style="position:absolute;left:220px;top:120px;width:100px;height:40px">lane</div>
      <script>
        window.seen = [];
        go.onclick = () => seen.push("click");
        tip.onmouseenter = () => seen.push("hover");
        card.ondragstart = (event) => event.dataTransfer.setData("text/plain", "card");
        lane.ondragover = (event) => event.preventDefault();
        lane.ondrop = () => seen.push("drop");
      </script>`);
    const shown: Array<string> = [];
    const pointer: ServerBrowserPage.PointerReporter = async ({ x, y }, phase) => {
      const seen = await page.evaluate("window.seen.length");
      shown.push(`${phase}@${Math.round(x)},${Math.round(y)} after ${seen}`);
    };
    await ServerBrowserPage.click(page, { locator: "#go" }, pointer);
    await ServerBrowserPage.hover(page, { locator: "#tip" }, pointer);
    await ServerBrowserPage.drag(page, { source: "#card", target: "#lane" }, pointer);
    expect(shown).toEqual([
      "click@140,50 after 0",
      "move@330,50 after 1",
      "move@40,140 after 2",
      "move@270,140 after 2",
    ]);
    expect(await page.evaluate("window.seen")).toEqual(["click", "hover", "drop"]);
  });

  it("presents a headless page as Chrome, with client hints that agree", async () => {
    await presentAsChrome(cdp, { platform: "linux", arch: "x64" });
    // userAgentData exists only in secure contexts; https comes from a route.
    let secChUa: string | undefined;
    await page.route("https://example.test/", (route) => {
      secChUa = route.request().headers()["sec-ch-ua"];
      return route.fulfill({ contentType: "text/html", body: "<p>hi</p>" });
    });
    await page.goto("https://example.test/");
    const identity = (await page.evaluate(`(async () => ({
      userAgent: navigator.userAgent,
      brands: navigator.userAgentData.brands.map((brand) => brand.brand),
      full: (await navigator.userAgentData.getHighEntropyValues(["fullVersionList"]))
        .fullVersionList.map((brand) => brand.brand),
    }))()`)) as { userAgent: string; brands: string[]; full: string[] };
    expect(identity.userAgent).not.toContain("Headless");
    expect(identity.userAgent).toMatch(/ Chrome\/\d+\.0\.0\.0 /);
    expect(identity.brands).toContain("Google Chrome");
    expect([...identity.brands, ...identity.full].join()).not.toContain("Headless");
    expect(secChUa).toContain('"Google Chrome"');
    expect(secChUa).not.toContain("Headless");
  });

  it("stops an evaluation at its deadline so the page answers the next one", async () => {
    await expect(
      ServerBrowserPage.evaluate(cdp, { expression: "for (;;) {}" }, { timeoutMs: 200 }),
    ).rejects.toMatchObject({ tag: "PreviewAutomationTimeoutError" });
    expect(
      await ServerBrowserPage.evaluate(cdp, { expression: "1 + 1" }, { timeoutMs: 2_000 }),
    ).toBe(2);
  });
});

describe("server browser drag", () => {
  it("fails the drag, not the server, when it times out while the cursor is still moving", async () => {
    const timedOut = new Error("locator.dragTo: Timeout 30000ms exceeded.");
    const box = { x: 0, y: 0, width: 20, height: 20 };
    const targetBox = Promise.withResolvers<typeof box>();
    // Only the calls `drag` makes. The drag fails at once; the target's position arrives only
    // when the test hands it over, after the rejection has had a turn to go unobserved.
    const page = {
      locator: (selector: string) =>
        selector === "#card"
          ? {
              scrollIntoViewIfNeeded: async () => {},
              boundingBox: async () => box,
              dragTo: () => Promise.reject(timedOut),
            }
          : { boundingBox: () => targetBox.promise },
    } as unknown as Page;
    const unobserved: Array<unknown> = [];
    const onUnhandled = (reason: unknown) => unobserved.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let finished = false;
      const settled = ServerBrowserPage.drag(page, { source: "#card", target: "#lane" }).then(
        () => null,
        (error: unknown) => error,
      );
      void settled.then(() => (finished = true));
      // Two macrotask turns: Node reports a rejection nobody observed after the first.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      // The failed drag waits for the cursor to reach the target before it reports.
      expect(finished).toBe(false);
      targetBox.resolve(box);

      expect(await settled).toBe(timedOut);
      expect(unobserved).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
