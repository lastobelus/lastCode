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

import { PreviewAutomationEvaluateInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
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
import { SessionControl } from "./SessionControl.ts";

const decodeEvaluateInput = Schema.decodeUnknownSync(PreviewAutomationEvaluateInput);

describe("server browser capture deadlines", () => {
  it("releases control after an unanswered capture and ignores its late reply", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const captured = Promise.withResolvers<{ data: string }>();
      const send = vi.fn(async (method: string) =>
        method === "Page.captureScreenshot"
          ? captured.promise
          : { result: { value: "still responsive" } },
      );
      const cdp = { send } as unknown as CDPSession;
      const control = new SessionControl("agent");
      let outcome: unknown;
      const capture = control
        .agent("agent", () => ServerBrowserPage.captureViewport(cdp, { format: "png" }))
        .catch((cause: unknown) => {
          outcome = cause;
        });
      const evaluation = control.agent("agent", () =>
        ServerBrowserPage.evaluate(cdp, { expression: "document.title" }, { timeoutMs: 1_000 }),
      );

      await vi.advanceTimersByTimeAsync(3_000);
      expect(outcome).toMatchObject({
        tag: "PreviewAutomationExecutionError",
        message: expect.stringContaining("not producing screenshot frames"),
      });
      await capture;
      expect(await evaluation).toBe("still responsive");
      expect(vi.getTimerCount()).toBe(0);

      captured.resolve({ data: "late-frame" });
      await captured.promise;
      expect(outcome).toBeInstanceOf(ServerBrowserPage.ServerBrowserOperationError);
      expect(send.mock.calls.map(([method]) => method)).toEqual([
        "Page.captureScreenshot",
        "Runtime.evaluate",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("native viewport", () => {
  it("reads the native CSS viewport and captures without a clip", async () => {
    const page = { viewportSize: () => null } as unknown as Page;
    const send = vi.fn(async (method: string) =>
      method === "Page.getLayoutMetrics"
        ? { cssVisualViewport: { clientWidth: 390, clientHeight: 844, pageX: 20, pageY: 30 } }
        : { data: "image" },
    );
    const cdp = { send } as unknown as CDPSession;
    expect(await ServerBrowserPage.viewportSize(page, cdp)).toEqual({ width: 390, height: 844 });
    expect(await ServerBrowserPage.captureViewport(cdp, { format: "png" })).toBe("image");
    expect(send).toHaveBeenLastCalledWith("Page.captureScreenshot", {
      format: "png",
    });
  });

  it.each([
    {
      zoom: 1.25,
      css: { width: 800, height: 600 },
    },
    {
      zoom: 0.75,
      css: { width: 800, height: 600 },
    },
  ])(
    "keeps native CSS dimensions and leaves capture unscaled at zoom $zoom",
    async ({ zoom, css }) => {
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
      await ServerBrowserPage.captureViewport(cdp, { format: "png" });
      expect(send).toHaveBeenLastCalledWith("Page.captureScreenshot", {
        format: "png",
      });
    },
  );

  it("retains the emulated viewport without consulting native zoom metrics", async () => {
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
    const cdp = { send } as unknown as CDPSession;
    expect(await ServerBrowserPage.viewportSize(page, cdp)).toEqual({ width: 1000, height: 750 });
    await ServerBrowserPage.captureViewport(cdp, { format: "png" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith("Page.captureScreenshot", {
      format: "png",
    });
  });
});

describe("browser credential failures", () => {
  it.each([
    ["Protocol error (Storage.getCookies): unsupported; private diagnostic", "cookie-context"],
    ["Protocol error (Storage.setCookies): unsupported; private diagnostic", "cookie-context"],
    ["Request timed out; private diagnostic", "timeout"],
    ["CERT_HAS_EXPIRED; private diagnostic", "TLS error"],
    ["ECONNREFUSED; private diagnostic", "network error"],
  ])("reports a safe failure category for %s", async (message, category) => {
    const post = vi.fn().mockRejectedValue(new Error(message));
    const page = { context: () => ({ request: { post } }) } as unknown as Page;
    const error = await ServerBrowserPage.prepareBrowserCredential(
      page,
      "https://managed-server.example/qa",
      "private-one-use-credential",
      15_000,
    ).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ServerBrowserPage.ServerBrowserOperationError);
    expect(error).toMatchObject({ detail: { boundary: "browser-credential", category } });
    expect(String(error)).not.toContain("private");
    expect(String(error)).not.toContain("managed-server.example");
    if (category === "cookie-context") expect(String(error)).not.toContain("--share");
  });

  it.each([302, 401, 503])(
    "preserves HTTP %s and disposes its response without exposing its body",
    async (status) => {
      const dispose = vi.fn().mockResolvedValue(undefined);
      const page = {
        context: () => ({
          request: {
            post: vi.fn().mockResolvedValue({ ok: () => false, status: () => status, dispose }),
          },
        }),
      } as unknown as Page;
      const error = await ServerBrowserPage.prepareBrowserCredential(
        page,
        "https://managed-server.example/qa",
        "private-one-use-credential",
        15_000,
      ).catch((error: unknown) => error);
      expect(error).toMatchObject({ detail: { category: "http", status } });
      expect(String(error)).toContain(`HTTP ${status}`);
      expect(String(error)).not.toContain("--share");
      expect(String(error)).not.toContain("private");
      expect(dispose).toHaveBeenCalledOnce();
    },
  );
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
      // Native window dimensions vary by Chromium build; model zoom against its actual pixels.
      expect(nativePage.viewportSize()).toBeNull();
      const unscaled = await nativeSession.send("Page.captureScreenshot", { format: "png" });
      const unscaledPng = Buffer.from(unscaled.data, "base64");
      const unscaledSize = {
        width: unscaledPng.readUInt32BE(16),
        height: unscaledPng.readUInt32BE(20),
      };
      expect(unscaledSize.width).toBeGreaterThan(1280);
      const send = vi.fn(
        async (
          method: Parameters<CDPSession["send"]>[0],
          options?: Parameters<CDPSession["send"]>[1],
        ) => {
          if (method === "Page.getLayoutMetrics")
            return {
              cssVisualViewport: {
                clientWidth: unscaledSize.width / 2.5,
                clientHeight: unscaledSize.height / 2.5,
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
      expect(pixels).toEqual({
        width: 1280,
        height: Math.round((unscaledSize.height * 1280) / unscaledSize.width),
      });
      expect(result.screenshot).toMatchObject(pixels);
      expect(send).toHaveBeenCalledWith("Page.captureScreenshot", { format: "png" });
      expect(send).toHaveBeenCalledWith(
        "Runtime.callFunctionOn",
        expect.objectContaining({
          arguments: [
            { value: expect.any(String) },
            { value: pixels.width },
            { value: pixels.height },
          ],
          awaitPromise: true,
          returnByValue: true,
        }),
      );
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

  it("tells a click target that matches nothing from one that never becomes clickable", async () => {
    await page.setContent(`<button hidden>hidden</button>`);
    const failure = (selector: string) =>
      ServerBrowserPage.click(page, { selector, timeoutMs: 500 }).then(
        () => expect.unreachable(),
        ServerBrowserPage.toOperationError,
      );

    const absent = await failure(".definitely-no-such-t3-target");
    expect(absent.tag).toBe("PreviewAutomationTimeoutError");
    expect(absent.message).toBe(
      'The click may have happened and removed its target or navigated; check the page before retrying. No element matches ".definitely-no-such-t3-target" after the timeout; take a fresh snapshot and use its locator.',
    );
    expect(absent.cause).toMatchObject({ name: "TimeoutError" });
    const hidden = await failure("button");
    expect(hidden.tag).toBe("PreviewAutomationTimeoutError");
    expect(hidden.message).toBe(
      'The click may have happened; check the page before retrying. "button" still matches an element after the timeout.',
    );
  });

  it("gives a late target only the click's remaining time, not a fresh timeout", async () => {
    await page.setContent(`<script>
      setTimeout(() => document.body.insertAdjacentHTML("beforeend",
        '<button id="save" disabled onclick="document.body.dataset.clicked = 1">Save</button>'), 1000);
      setTimeout(() => document.querySelector("#save").disabled = false, 2500);
    </script>`);
    await expect(
      ServerBrowserPage.click(page, { selector: "#save", timeoutMs: 2_000 }),
    ).rejects.toThrow();
    expect(await page.locator("body").getAttribute("data-clicked")).toBeNull();
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
    expect(result.visibleText).toContain("Order ••••••••-2");
    expect(tree).toMatch(
      /row [^\n]*:\n\s+- cell "password:"[^\n]*\n\s+- cell[^\n]*:\n\s+- textbox "Password"[^\n]*: •+$/m,
    );
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

  it("shows a data: page's own URL by media type only", async () => {
    await page.goto("data:text/html,<title>Key</title>PAYLOAD");
    expect((await takeSnapshot()).url).toBe("data:text/html,…");
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

  it("evaluates top-level await and returns the last expression's value", async () => {
    await page.setContent("<title>Ready</title>");
    const result = await ServerBrowserPage.evaluate(
      cdp,
      { expression: "await Promise.resolve(); document.title" },
      { timeoutMs: 5_000 },
    );
    expect(result).toBe("Ready");
  });

  it("returns object contents even when a legacy caller asks for a remote reference", async () => {
    const input = decodeEvaluateInput({
      expression: "({ answer: 42, nested: { ready: true } })",
      returnByValue: false,
    });
    const result = await ServerBrowserPage.evaluate(cdp, input, { timeoutMs: 5_000 });
    expect(result).toEqual({ answer: 42, nested: { ready: true } });
  });

  it("still awaits the promise an async function returns", async () => {
    const result = await ServerBrowserPage.evaluate(
      cdp,
      { expression: "(async () => { await 0; return 1 })()" },
      { timeoutMs: 5_000 },
    );
    expect(result).toBe(1);
  });

  it("does not rerun an expression whose SyntaxError is thrown at runtime", async () => {
    const evaluation = ServerBrowserPage.evaluate(
      cdp,
      { expression: "window.runs = (window.runs ?? 0) + 1; new Function('await 0')" },
      { timeoutMs: 5_000 },
    );
    await expect(evaluation).rejects.toThrow("await is only valid");
    expect(await page.evaluate("window.runs")).toBe(1);
  });

  it("does not rerun an expression whose awaited browser call rejects with a SyntaxError", async () => {
    let posts = 0;
    await page.route("http://preview.test/**", (route) => {
      if (route.request().method() === "POST") posts++;
      return route.fulfill({ contentType: "text/html", body: "<title>Ready</title>" });
    });
    await page.goto("http://preview.test/");
    const evaluation = ServerBrowserPage.evaluate(
      cdp,
      {
        expression:
          "(async () => { const r = await fetch('/api', { method: 'POST' }); return r.json() })()",
      },
      { timeoutMs: 5_000 },
    );
    await expect(evaluation).rejects.toThrow("is not valid JSON");
    expect(posts).toBe(1);
  });

  it("returns the result of a top-level await expression that reloads the page", async () => {
    await page.route("http://preview.test/", (route) =>
      route.fulfill({ contentType: "text/html", body: "<title>Ready</title>" }),
    );
    await page.goto("http://preview.test/");
    const result = await ServerBrowserPage.evaluate(
      cdp,
      { expression: "await 0; location.reload(); ({ clicked: true })" },
      { timeoutMs: 5_000 },
    );
    expect(result).toEqual({ clicked: true });
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

describe("server browser snapshot screenshot", () => {
  let browser: Browser;
  let context: BrowserContext;

  beforeAll(async () => {
    // ServerBrowserContexts launches with these, and the capture scale depends on them.
    browser = await chromium.launch({
      headless: true,
      args: ["--disable-gpu", "--force-device-scale-factor=2"],
    });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
  });
  afterEach(async () => {
    await context.close();
  });

  // Blue on the left half and red on the right, so a mirrored left half shows up on the right.
  const halves = (overlay: string) => `
    <style>
      body { margin: 0; background: white; }
      .half { position: absolute; top: 0; width: 640px; height: 800px; }
      .overlay { position: fixed; inset: 0; ${overlay} }
    </style>
    <div class="half" style="left: 0; background: #2563eb"></div>
    <div class="half" style="left: 640px; background: #ef4444"></div>
    <div class="overlay"></div>`;

  const screenshotOf = async (html: string) => {
    const page = await context.newPage();
    await page.setContent(html);
    const { screenshot, fullScreenshot } = await ServerBrowserPage.snapshot({
      page,
      cdp: await context.newCDPSession(page),
      renderScale: 2,
      fullScreenshot: true,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
    });
    if (screenshot === undefined) throw new Error("Expected snapshot screenshot");
    // The server has no DOM types, so the decoder runs as page source.
    const points = [
      [0.15, 0.75],
      [0.85, 0.25],
      [0.85, 0.75],
    ];
    const pixels = (await page.evaluate(`(async () => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(screenshot.data)}), (char) => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      return ${JSON.stringify(points)}.map(([x, y]) =>
        Array.from(context.getImageData(x * bitmap.width, y * bitmap.height, 1, 1).data),
      );
    })()`)) as Array<[number, number, number, number]>;
    return { screenshot, fullScreenshot, pixels };
  };
  const colorOf = ([red, green, blue]: readonly [number, number, number, number]) =>
    blue - red > 100 ? "blue" : red - blue > 100 ? "red" : `rgb(${red}, ${green}, ${blue})`;

  it("captures a blurred backdrop-filter page as rendered, not mirrored", async () => {
    const { screenshot, pixels } = await screenshotOf(halves("backdrop-filter: blur(4px);"));

    expect({
      size: [screenshot.width, screenshot.height],
      colors: pixels.map(colorOf),
    }).toEqual({ size: [1280, 800], colors: ["blue", "red", "red"] });
  });

  it("captures a plain page at the shrunk size with its content in place", async () => {
    const { screenshot, fullScreenshot, pixels } = await screenshotOf(halves(""));

    expect({
      size: [screenshot.width, screenshot.height],
      fullSize: [fullScreenshot?.width, fullScreenshot?.height],
      colors: pixels.map(colorOf),
    }).toEqual({ size: [1280, 800], fullSize: [2560, 1600], colors: ["blue", "red", "red"] });
  });

  it("records the destination of a finite entrance animation without waiting on infinite ones", async () => {
    const page = await context.newPage();
    await page.setContent(`
      <style>
        body { margin: 0; background: #2563eb; }
        @keyframes enter { from { opacity: 0; } to { opacity: 1; } }
        @keyframes pulse { from { opacity: 0.5; } to { opacity: 1; } }
        button { animation: pulse 2s infinite; }
        #paused { animation: enter 2s paused; }
        #overlay { display: none; position: fixed; inset: 0; background: #ef4444; }
        #overlay.open { display: block; animation: enter 200ms both; }
      </style>
      <button onclick="document.querySelector('#overlay').classList.add('open')">Open</button>
      <div id="paused"></div>
      <div id="overlay"></div>
    `);
    await page.getByRole("button", { name: "Open" }).click();
    const frame = await ServerBrowserPage.captureFinalRecordingFrame(
      await context.newCDPSession(page),
      80,
    );
    expect(frame).toBeDefined();
    const pixel = (await page.evaluate(`(async () => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(frame)}), char => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      return Array.from(context.getImageData(bitmap.width / 2, bitmap.height / 2, 1, 1).data);
    })()`)) as [number, number, number, number];
    expect(colorOf(pixel)).toBe("red");
  });

  it("shrinks the screenshot of an XML document, whose createElement makes no canvas", async () => {
    const page = await context.newPage();
    await page.goto("data:text/xml,<a/>");
    const { screenshot } = await ServerBrowserPage.snapshot({
      page,
      cdp: await context.newCDPSession(page),
      renderScale: 2,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
    });

    if (screenshot === undefined) throw new Error("Expected snapshot screenshot");
    expect([screenshot.width, screenshot.height]).toEqual([1280, 800]);
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

  it("moves the mouse after dragstart, so pages that track a drag with mousemove see it", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <div style="display:flex;gap:40px">
          <div id="source" draggable="true" style="width:200px;height:120px">source</div>
          <div id="target" style="width:200px;height:120px">target</div>
        </div>
        <script>
          window.events = [];
          let dragging = false;
          source.addEventListener("dragstart", (event) => {
            event.preventDefault();
            dragging = true;
            events.push("dragstart");
          });
          addEventListener("mousemove", () => dragging && events.push("mousemove"));
          addEventListener("mouseup", () => events.push("mouseup"));
        </script>`);

      await ServerBrowserPage.drag(page, { source: "#source", target: "#target" });

      const events = (await page.evaluate("window.events")) as Array<string>;
      expect(events.slice(0, 2)).toEqual(["dragstart", "mousemove"]);
      expect(events.at(-1)).toBe("mouseup");
    } finally {
      await browser.close();
    }
  });
});

describe("server browser click", () => {
  it("clicks a target the page replaced while it was being scrolled into view", async () => {
    let scrolls = 0;
    const clicks: Array<unknown> = [];
    const page = {
      locator: () => ({
        // Playwright resolves the node once; a page re-rendering it detaches that node.
        scrollIntoViewIfNeeded: async () => {
          if (scrolls++ === 0) {
            throw new Error("locator.scrollIntoViewIfNeeded: Element is not attached to the DOM");
          }
        },
        boundingBox: async () => ({ x: 0, y: 0, width: 20, height: 20 }),
        click: async (options: unknown) => {
          clicks.push(options);
        },
        count: async () => 1,
      }),
      once: () => {},
      off: () => {},
    } as unknown as Page;

    await expect(ServerBrowserPage.click(page, { selector: "#save" })).resolves.toEqual({
      x: 10,
      y: 10,
    });
    expect(clicks).toHaveLength(1);
  });

  it("retries a replaced target only within the action's timeout", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const timeouts: Array<number | undefined> = [];
      const clicks: Array<unknown> = [];
      const detached = new Error(
        "locator.scrollIntoViewIfNeeded: Element is not attached to the DOM",
      );
      const page = {
        locator: () => ({
          scrollIntoViewIfNeeded: async (options?: { timeout?: number }) => {
            timeouts.push(options?.timeout);
            vi.setSystemTime(timeouts.length * 60);
            throw detached;
          },
          click: async (options: unknown) => {
            clicks.push(options);
          },
          count: async () => 1,
        }),
      } as unknown as Page;

      const failure = await ServerBrowserPage.click(page, {
        selector: "#save",
        timeoutMs: 100,
      }).then(
        () => expect.unreachable(),
        (cause: ServerBrowserPage.ServerBrowserOperationError) => cause,
      );
      expect(failure).toMatchObject({
        tag: "PreviewAutomationTimeoutError",
        message:
          'The click may have happened; check the page before retrying. "#save" still matches an element after the timeout.',
      });
      expect(failure.cause).toMatchObject({
        tag: "PreviewAutomationTimeoutError",
        detail: { stage: "target layout", timeoutMs: 100 },
      });
      expect((failure.cause as ServerBrowserPage.ServerBrowserOperationError).cause).toBe(detached);
      expect(timeouts).toEqual([100, 40]);
      expect(clicks).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("server browser evaluate", () => {
  it("does not retry a parse error that arrives after the timeout", async () => {
    vi.useFakeTimers();
    try {
      const classic = Promise.withResolvers<unknown>();
      const send = vi.fn((method: string) =>
        method === "Runtime.evaluate" ? classic.promise : Promise.resolve({}),
      );
      const cdp = { send } as unknown as CDPSession;
      const evaluation = ServerBrowserPage.evaluate(
        cdp,
        { expression: "await 0; 1" },
        { timeoutMs: 10 },
      );
      const rejected = expect(evaluation).rejects.toMatchObject({
        tag: "PreviewAutomationTimeoutError",
      });
      await vi.advanceTimersByTimeAsync(10);
      await rejected;
      classic.resolve({
        result: { type: "object" },
        exceptionDetails: {
          text: "Uncaught",
          scriptId: "4",
          exception: { type: "object", className: "SyntaxError" },
        },
      });
      await classic.promise;
      expect(send.mock.calls.map(([method]) => method)).toEqual([
        "Runtime.evaluate",
        "Runtime.terminateExecution",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("server browser unresponsive script", () => {
  it("leaves a page that answers alone", async () => {
    const send = vi.fn(async (_method: string) => ({}));
    await ServerBrowserPage.stopUnresponsiveScript({ send } as unknown as CDPSession);
    expect(send.mock.calls.map(([method]) => method)).toEqual(["Runtime.evaluate"]);
  });
});

describe("server browser wait", () => {
  it("ends at its timeout when a check never answers", async () => {
    // As on a desktop tab whose Playwright utility world never answers.
    const page = {
      locator: () => ({ count: () => new Promise<number>(() => {}) }),
    } as unknown as Page;
    vi.useFakeTimers();
    try {
      let failure: unknown;
      void ServerBrowserPage.waitFor(page, { selector: "button", timeoutMs: 300 }).catch(
        (error: unknown) => (failure = error),
      );
      await vi.advanceTimersByTimeAsync(300);
      expect(failure).toMatchObject({ tag: "PreviewAutomationTimeoutError" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("server browser net errors", () => {
  it.each([
    ["net::ERR_CONNECTION_REFUSED", "ERR_CONNECTION_REFUSED", -102],
    [
      "page.goto: net::ERR_HTTP2_PROTOCOL_ERROR at https://localhost:5173/",
      "ERR_HTTP2_PROTOCOL_ERROR",
      -2,
    ],
    ["net::ERR_TLS13_DOWNGRADE_DETECTED", "ERR_TLS13_DOWNGRADE_DETECTED", -2],
  ])("reads the whole error name from %j", (errorText, description, code) => {
    expect(ServerBrowserPage.parseNetError(errorText)).toEqual({ description, code });
  });
});
