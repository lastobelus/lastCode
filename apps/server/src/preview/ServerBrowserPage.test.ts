// @effect-diagnostics-next-line nodeBuiltinImport:off -- An ephemeral HTTP fixture verifies real Chromium redirects across origins.
import * as NodeHttp from "node:http";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Temporary loopback TLS fixture; no certificate or key is retained.
import * as NodeHttps from "node:https";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Temporary loopback TLS fixture.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Temporary loopback TLS fixture.
import * as NodePath from "node:path";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Generates an ephemeral test certificate, as in PortScanner.test.ts.
import * as NodeChildProcess from "node:child_process";

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

  it("automatically authenticates a fresh HTTPS cookie context before its first document load", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "preview-cold-tls-"));
    const key = NodePath.join(directory, "test.key");
    const certificate = NodePath.join(directory, "test.crt");
    const requests: string[] = [];
    const authenticationAndDocuments: { request: string; cookie: string | undefined }[] = [];
    let server: NodeHttps.Server | undefined;
    let fresh: BrowserContext | undefined;
    let control: BrowserContext | undefined;
    try {
      NodeChildProcess.execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-days",
          "1",
          "-subj",
          "/CN=localhost",
          "-keyout",
          key,
          "-out",
          certificate,
        ],
        { stdio: "ignore" },
      );
      server = NodeHttps.createServer(
        {
          key: NodeFS.readFileSync(key),
          cert: NodeFS.readFileSync(certificate),
        },
        (request, response) => {
          const entry = `${request.method} ${request.url}`;
          requests.push(entry);
          if (
            request.url === "/api/auth/browser-session" ||
            request.headers["sec-fetch-dest"] === "document"
          ) {
            authenticationAndDocuments.push({ request: entry, cookie: request.headers.cookie });
          }
          if (request.url === "/api/auth/browser-session") {
            let body = "";
            request.setEncoding("utf8");
            request.on("data", (chunk) => {
              body += chunk;
            });
            request.on("end", () => {
              if (JSON.parse(body).credential !== "fixture-one-use") {
                response.writeHead(401).end();
                return;
              }
              response.setHeader(
                "Set-Cookie",
                "fixture-session=accepted; Path=/; Secure; HttpOnly; SameSite=Lax",
              );
              response.setHeader("Content-Type", "application/json");
              response.end("{}");
            });
            return;
          }
          const authenticated = request.headers.cookie?.includes("fixture-session=accepted");
          if (request.url === "/api/auth/session") {
            response.writeHead(authenticated ? 200 : 401).end();
            return;
          }
          if (request.url === "/qa" && !authenticated) {
            response.writeHead(302, { Location: "/pair" }).end();
            return;
          }
          response.setHeader("Content-Type", "text/html");
          response.end(request.url === "/pair" ? "<h1>Pair</h1>" : "<h1>cold-bootstrap-ready</h1>");
        },
      );
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("Missing TLS fixture listener");
      const origin = `https://127.0.0.1:${address.port}`;
      // Trust is confined to this throwaway certificate/context, never production.
      fresh = await browser.newContext({ ignoreHTTPSErrors: true });
      const selected = await fresh.newPage();
      expect(await fresh.cookies()).toEqual([]);
      const unauthenticated = await fresh.request.get(`${origin}/api/auth/session`);
      expect(unauthenticated.status()).toBe(401);
      await unauthenticated.dispose();
      requests.length = 0;
      await ServerBrowserPage.prepareBrowserCredential(
        selected,
        `${origin}/qa`,
        "fixture-one-use",
        15_000,
      );
      await selected.goto(`${origin}/qa`);
      expect(await selected.locator("h1").innerText()).toBe("cold-bootstrap-ready");
      expect(selected.url()).toBe(`${origin}/qa`);
      expect((await fresh.cookies()).map((cookie) => cookie.name)).toEqual(["fixture-session"]);
      // Assert every document load and its cookie; ancillary HTTP traffic is
      // not a navigation and must not define the first-document auth gate.
      expect(authenticationAndDocuments).toEqual([
        { request: "POST /api/auth/browser-session", cookie: undefined },
        { request: "GET /qa", cookie: "fixture-session=accepted" },
      ]);
      expect(requests).not.toContain("GET /pair");
      control = await browser.newContext({ ignoreHTTPSErrors: true });
      expect(await control.cookies()).toEqual([]);
      const unprepared = await control.newPage();
      await unprepared.goto(`${origin}/qa`);
      expect(unprepared.url()).toBe(`${origin}/pair`);
    } finally {
      await control?.close();
      await fresh?.close();
      if (server)
        await new Promise<void>((resolve, reject) =>
          server!.close((error) => (error ? reject(error) : resolve())),
        );
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
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
          method: Parameters<CDPSession["send"]>[0],
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
          return nativeSession.send(method, options);
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
      expect(send).toHaveBeenCalledWith("Page.captureScreenshot", {
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

  it("shows dotted fields as dots wherever their value appears, keeping text values and refs", async () => {
    await page.setContent(`
      <table><tr><td>password:</td><td><input id="pw" type="password" aria-label="Password"></td></tr></table>
      <input aria-label="Username" value="maria">
      <input type="password" aria-label='saved" [ref=e2]: x' placeholder="hint" value="saved-pass">
      <input type="password" role="combobox" aria-label="Code" value="role-pass">
      <input aria-label="PIN" style="-webkit-text-security: disc" value="styled-pass">
      <div contenteditable style="-webkit-text-security: disc">editable-pass</div>
      <iframe srcdoc="<input type=password aria-label=child value=frame-pass>"></iframe>
      <iframe id="blank" src="javascript:false"></iframe>
      <p>Order styled-pass-2</p>
      <script>
        // A frame that never commits a document, filled by its parent.
        blank.contentDocument.body.innerHTML = "<input type=password aria-label=blank value=blank-pass>";
        // Page script can't change the value the snapshot sees.
        Object.defineProperty(HTMLInputElement.prototype, "value", { get: () => "" });
      </script>`);
    await page.frameLocator("iframe[srcdoc]").getByRole("textbox").waitFor();
    await ServerBrowserPage.type(page, { locator: "#pw", text: "typed-pass" });
    const result = await takeSnapshot();
    const tree = String(result.accessibilityTree);
    expect(tree).toContain('textbox "blank"');
    expect(tree).not.toMatch(
      /typed-pass|saved-pass|role-pass|styled-pass|editable-pass|frame-pass|blank-pass/,
    );
    expect(result.visibleText).not.toContain("editable-pass");
    // Page text masks the same values, so it can't be compared against the tree.
    expect(result.visibleText).toContain("Order ••••••••-2");
    expect(tree).toMatch(/row "password: •+"/);
    expect(tree).toMatch(/textbox "Username" [^\n]*: maria$/m);
    const line = tree.split("\n").find((line) => line.includes('textbox "Password"'));
    expect(line).toMatch(/: •+$/);
    await ServerBrowserPage.type(page, { locator: locators(line)[0]!, text: "next", clear: true });
    expect(await page.locator("#pw").inputValue()).toBe("next");
  });

  it("masks dotted values in page text next to punctuation, with odd spaces, and at the cut", async () => {
    await page.setContent(`
      <input type="password" aria-label="PIN" value="123">
      <input type="password" aria-label="Phrase" value="open&nbsp;sesame">
      <p>PIN: 123. Code (123) id 1234</p>
      <p>open&nbsp;sesame</p>`);
    const text = (await takeSnapshot()).visibleText;
    expect(text).toContain("PIN: ••••••••. Code (••••••••) id 1234");
    expect(text).not.toMatch(/open|sesame/);
    await page.setContent(`
      <p>${"x".repeat(19_995)}long-secret</p>
      <input type="password" aria-label="Long" value="long-secret">`);
    const cut = (await takeSnapshot()).visibleText;
    expect(cut.length).toBe(20_000);
    // Masked before the cut, so no prefix of the value is left.
    expect(cut.slice(-8)).toBe("xxx•••••");
  });

  it("shows a data: link or blocked data: navigation by media type only", async () => {
    // Chromium keeps raw spaces and quotes in both, so a payload can't be cut at either.
    await page.setContent(`
      <a download href="data:text/plain;charset=&quot;a,b&quot;,head PAYLOAD'tail">Key</a>
      <a href="https://example.com/data:report,2026">Report</a>
      <a href="#">data:text/plain,label</a>
      <a href='"data:text/plain,relative'>Relative</a>
      <a href=" data:text/plain,PAYLOAD">Spaced</a>
      <a href="da&#9;ta:text/plain,PAYLOAD">Tabbed</a>
      <a href="data:text/plain,head&#x2028;PAYLOAD">Separated</a>
      <a href="data:PAYLOAD,x">Typeless</a>
      <a href="&#11;data:text/plain,PAYLOAD">Vertical tab</a>
      <a href="&#8;data:text/plain,PAYLOAD">Backspace</a>
      <a id="controlled">Controlled</a>
      <a id="escaped">Escaped</a>
      <script>
        controlled.href = "\\x01data:text/plain,PAYLOAD";
        escaped.href = "\\x02da\\tta:text/plain,PAYLOAD";
      </script>`);
    const tree = String((await takeSnapshot()).accessibilityTree);
    expect(tree.match(/\/url: data:text\/plain,…$/gm)).toHaveLength(8);
    expect(tree).toContain("/url: data:,…");
    expect(tree).toContain("/url: https://example.com/data:report,2026");
    expect(tree).toMatch(/link "data:text\/plain,label" \[ref=t3-/);
    expect(tree).not.toMatch(/PAYLOAD|tail|charset|\u2028/);
    expect(tree).toContain('/url: "\\"data:text/plain,relative"');
  });

  it("redacts a data: link whose scheme a password value would mask", async () => {
    await page.setContent(`
      <input type="password" aria-label="Scheme" value="data">
      <a download href="data:text/plain,PAYLOAD">Key</a>`);
    const tree = String((await takeSnapshot()).accessibilityTree);
    expect(tree).toContain("/url: ••••••••:text/plain,…");
    expect(tree).not.toContain("PAYLOAD");
  });

  it("rejects refs from another tab", async () => {
    await page.setContent("<button>same label</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "same label");
    const other = await context.newPage();
    await other.setContent("<button>same label</button>");
    await expect(ServerBrowserPage.click(other, { locator })).rejects.toThrow(/another tab/);
  });

  it("revokes refs after navigation even when labels are identical", async () => {
    await page.goto("data:text/html,<button>continue</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "continue");
    await page.goto("data:text/html,<button>continue</button><p>new document</p>");
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

  it("preserves quoted attribute values containing ref engine text", async () => {
    await page.setContent(
      '<button data-example=" >> aria-ref=e1" onclick="this.textContent=\'saved\'">save</button>',
    );
    await ServerBrowserPage.click(page, { selector: 'button[data-example=" >> aria-ref=e1"]' });
    expect(await page.locator("button").textContent()).toBe("saved");
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
      for (let turn = 0; turn < 2; turn++) {
        // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- Node emits unhandledRejection only between macrotasks; no promise can mark that point.
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(finished).toBe(false);
      targetBox.resolve(box);

      expect(await settled).toBe(timedOut);
      expect(unobserved).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
