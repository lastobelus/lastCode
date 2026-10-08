// Only this fixture process creates windows; its ordinary host remains hidden throughout.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { app, BrowserWindow, ipcMain, nativeImage, webContents } from "electron";
import { chromium } from "playwright-core";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as DesktopBrowserHost from "../src/preview/DesktopBrowserHost.ts";
import * as DesktopClientSettings from "../src/settings/DesktopClientSettings.ts";
import * as ServerBrowserPage from "../../server/src/preview/ServerBrowserPage.ts";
import { DESKTOP_BROWSER_SURFACE_RESPONSE_CHANNEL } from "../src/ipc/channels.ts";

const [scratch, wsModulePath] = process.argv.slice(2);
NodeAssert.ok(scratch && wsModulePath, "isolated fixture arguments required");
app.setPath("userData", NodePath.join(scratch, "user-data"));
app.on("window-all-closed", () => {});
// Force a real child target for the cross-site frame relay regression.
app.commandLine.appendSwitch("site-per-process");
const require = NodeModule.createRequire(NodePath.join(scratch, "main.cjs"));
const { wsServer: WebSocketServer } = require(wsModulePath);
const tabs = [
  {
    runtimeTabId: "surface-default",
    tabId: "tab-default",
    partition: "persist:t3code-preview-profile-default",
  },
  {
    runtimeTabId: "surface-synthetic",
    tabId: "tab-synthetic",
    partition: "persist:t3code-preview-profile-synthetic",
  },
];
const key = (tab) => ({ threadId: "surface-smoke-thread", tabId: tab.tabId });
const viewport = { _tag: "freeform", width: 390, height: 844 };

async function main() {
  await app.whenReady();
  app.dock?.hide();
  const scope = await Effect.runPromise(Scope.make());
  const host = await Effect.runPromise(
    DesktopBrowserHost.make.pipe(
      Effect.provide(DesktopClientSettings.layerTest()),
      Effect.provideService(Scope.Scope, scope),
    ),
  );
  const rendererReady = Promise.withResolvers();
  const nativeGuests = new Map();
  const pending = new Map();
  const sockets = new Map();
  const browsers = [];
  const attachments = new Map(tabs.map((tab) => [tab.tabId, Promise.withResolvers()]));
  const presentationEvents = [];
  const results = [];
  let nextRequest = 0;
  let failCapture = false;
  let finishFailedCapture;
  let renderScale = 1;
  const resumedChildSessions = new Set();
  const fixtureServer = NodeHttp.createServer((request, response) => {
    if (request.url === "/child-frame") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        '<!doctype html><title>Child frame</title><script>parent.postMessage("child-frame-ran", "*")</script>',
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      `<!doctype html><title>Isolated browser surface</title><style>html,body{margin:0;background:#ffcc66;color:#000}button{margin:20px}</style><h1>Native surface fixture</h1><button id="choose" onclick="document.querySelector('#upload').click()">Choose fixture file</button><input id="upload" type="file"><pre id="uploaded"></pre><script>document.querySelector('#upload').addEventListener('change', async event => { const file=event.target.files[0]; document.querySelector('#uploaded').textContent=file.name+':'+await file.text(); });</script>`,
    );
  });
  await new Promise((resolve) => fixtureServer.listen(0, "127.0.0.1", resolve));
  const fixtureOrigin = `http://127.0.0.1:${fixtureServer.address().port}`;
  const relayServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => relayServer.once("listening", resolve));
  const relayPort = relayServer.address().port;
  const hostWindow = new BrowserWindow({
    show: false,
    width: 900,
    height: 1000,
    webPreferences: {
      offscreen: false,
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      preload: NodePath.join(scratch, "preload.cjs"),
    },
  });
  host.setMainWindow(hostWindow);
  // A registered PiP window is not presented when Electron has never shown it.
  const hiddenPictureInPicture = new BrowserWindow({ show: false, width: 390, height: 844 });
  host.setPictureInPictureWindow(tabs[0].runtimeTabId, hiddenPictureInPicture);
  hostWindow.webContents.on("console-message", (_event, ...details) =>
    console.error("fixture renderer:", ...details),
  );
  hostWindow.webContents.on("render-process-gone", (_event, details) =>
    rendererReady.reject(new Error(`Fixture renderer exited: ${details.reason}`)),
  );
  const startupTimer = setTimeout(
    () => rendererReady.reject(new Error("Fixture renderer did not register both native guests.")),
    12000,
  );
  const send = (command) => Effect.runPromise(host.handleCommandLine(JSON.stringify(command)));
  const events = Effect.runFork(
    host.events.pipe(
      Stream.runForEach((line) =>
        Effect.sync(() => {
          const event = JSON.parse(new TextDecoder().decode(line));
          if (event.type === "attached") attachments.get(event.tabId)?.resolve(event);
          if (event.type === "presentation") presentationEvents.push(event);
          if (event.type === "surfaceReady") pending.get(event.requestId)?.resolve(event);
          if (event.type === "cdp") sockets.get(event.tabId)?.send(event.message);
        }),
      ),
    ),
  );
  ipcMain.handle("surface-smoke:configuration", () =>
    tabs.map((tab) => ({ ...tab, url: `${fixtureOrigin}/${tab.tabId}` })),
  );
  ipcMain.handle("surface-smoke:register-guest", (_event, { runtimeTabId, webContentsId }) => {
    const tab = tabs.find((candidate) => candidate.runtimeTabId === runtimeTabId);
    const guest = webContents.fromId(webContentsId);
    NodeAssert.ok(tab && guest, "fixture guest exists");
    if (!guest.debugger.isAttached()) guest.debugger.attach("1.3");
    guest.setBackgroundThrottling(true);
    const debuggerProxy = {
      on: guest.debugger.on.bind(guest.debugger),
      off: guest.debugger.off.bind(guest.debugger),
      sendCommand: (method, ...args) => {
        if (method === "Runtime.runIfWaitingForDebugger" && typeof args[1] === "string")
          resumedChildSessions.add(args[1]);
        if (failCapture && tab === tabs[0] && method === "Page.captureScreenshot")
          return new Promise((resolve) => {
            finishFailedCapture = resolve;
          });
        return guest.debugger.sendCommand(method, ...args);
      },
    };
    nativeGuests.set(tab.tabId, guest);
    NodeAssert.equal(guest.hostWebContents?.id, hostWindow.webContents.id);
    // Exercise the real host's pending selected-slot report before native attachment.
    host.setPresentation({ runtimeTabId, presented: true }, hostWindow.webContents.id);
    host.attach(key(tab), { webContents: guest, debugger: debuggerProxy }, runtimeTabId);
  });
  ipcMain.handle("surface-smoke:ready", () => rendererReady.resolve());
  ipcMain.handle(DESKTOP_BROWSER_SURFACE_RESPONSE_CHANNEL, (event, response) =>
    host.surfaceResponse(response, event.sender.id),
  );
  relayServer.on("connection", (socket, request) => {
    const tab = tabs.find((candidate) => `/${candidate.tabId}` === request.url);
    if (!tab) {
      socket.close();
      return;
    }
    sockets.set(tab.tabId, socket);
    socket.on("message", (message) => {
      void send({ type: "cdp", ...key(tab), message: String(message) });
    });
    socket.on("close", () => {
      if (sockets.get(tab.tabId) === socket) sockets.delete(tab.tabId);
    });
  });
  const surface = async (tab, action, leaseId, timeoutMs) => {
    const requestId = `fixture-${++nextRequest}`;
    const result = Promise.withResolvers();
    pending.set(requestId, result);
    const timer = setTimeout(
      () => result.reject(new Error(`Surface ${action} did not acknowledge.`)),
      4000,
    );
    try {
      await send({
        type: "surface",
        ...key(tab),
        requestId,
        leaseId,
        action,
        viewport,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
      return await result.promise;
    } finally {
      clearTimeout(timer);
      pending.delete(requestId);
    }
  };
  const takeSnapshot = (page, cdp, includeImage, timeoutMs = 5000) =>
    ServerBrowserPage.snapshot({
      page,
      cdp,
      renderScale,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
      includeImage,
      timeoutMs,
    });
  try {
    await hostWindow.loadFile(NodePath.join(scratch, "index.html"));
    await rendererReady.promise;
    const attached = await Promise.all([...attachments.values()].map((entry) => entry.promise));
    NodeAssert.ok(attached.every((event) => event.presented !== true));
    NodeAssert.equal(hiddenPictureInPicture.isVisible(), false);
    NodeAssert.equal(hiddenPictureInPicture.isFocused(), false);
    results.push(
      "selected slots and registered hidden PiP window announce native presentation false",
    );
    clearTimeout(startupTimer);
    hostWindow.webContents.setBackgroundThrottling(true);
    const pages = [];
    for (const tab of tabs) {
      const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${relayPort}/${tab.tabId}`, {
        timeout: 10000,
      });
      browsers.push(browser);
      const page = browser.contexts()[0].pages()[0];
      pages.push({ page, cdp: await page.context().newCDPSession(page) });
    }
    const { page, cdp } = pages[0];
    const childOrigin = `http://localhost:${fixtureServer.address().port}`;
    await page.evaluate((origin) => {
      window.childFrameRan = false;
      const frame = document.createElement("iframe");
      frame.hidden = true;
      window.addEventListener("message", (event) => {
        if (
          event.source === frame.contentWindow &&
          event.origin === origin &&
          event.data === "child-frame-ran"
        )
          window.childFrameRan = true;
      });
      frame.src = `${origin}/child-frame`;
      document.body.append(frame);
    }, childOrigin);
    await page.waitForFunction(() => window.childFrameRan === true, null, { timeout: 5000 });
    NodeAssert.ok(
      resumedChildSessions.size > 0,
      "cross-site child resumed through the native CDP relay",
    );
    results.push(
      "cross-site iframe runs after child-session resume through production native CDP relay",
    );
    const nativeGuest = nativeGuests.get(tabs[0].tabId);
    const nativeGuestId = nativeGuest.id;
    await page.evaluate(() => {
      window.backingPageIdentity = "written-through-cdp";
    });
    NodeAssert.equal(
      await nativeGuest.executeJavaScript("window.backingPageIdentity"),
      "written-through-cdp",
    );
    await nativeGuest.executeJavaScript('window.backingPageIdentity = "written-through-native"');
    NodeAssert.equal(
      await page.evaluate(() => window.backingPageIdentity),
      "written-through-native",
    );
    NodeAssert.equal(browsers[0].contexts().length, 1);
    NodeAssert.equal(browsers[0].contexts()[0].pages().length, 1);
    results.push("CDP and native WebContents mutate the same single backing page");
    const acquired = await surface(tabs[0], "acquire", "snapshot-lease");
    NodeAssert.deepEqual(acquired.viewport, { width: 390, height: 844 });
    NodeAssert.equal(hostWindow.isVisible(), false);
    NodeAssert.equal(hostWindow.isFocused(), false);
    NodeAssert.deepEqual(await page.evaluate(() => ({ width: innerWidth, height: innerHeight })), {
      width: 390,
      height: 844,
    });
    renderScale = await page.evaluate(() => devicePixelRatio);
    const textSnapshot = await takeSnapshot(page, cdp, false);
    NodeAssert.ok(textSnapshot.visibleText.includes("Native surface fixture"));
    NodeAssert.ok(textSnapshot.accessibilityTree.includes("Choose fixture file"));
    const buttonBox = await page.locator("#choose").boundingBox();
    NodeAssert.ok(
      buttonBox &&
        buttonBox.width > 0 &&
        buttonBox.height > 0 &&
        buttonBox.x >= 0 &&
        buttonBox.y >= 0 &&
        buttonBox.x + buttonBox.width <= 390 &&
        buttonBox.y + buttonBox.height <= 844,
    );
    NodeAssert.equal(textSnapshot.screenshot, undefined);
    const imageSnapshot = await takeSnapshot(page, cdp, true);
    NodeAssert.ok(imageSnapshot.screenshot);
    const decodedImage = nativeImage.createFromBuffer(
      Buffer.from(imageSnapshot.screenshot.data, "base64"),
    );
    const imageSize = decodedImage.getSize();
    NodeAssert.deepEqual(imageSize, {
      width: imageSnapshot.screenshot.width,
      height: imageSnapshot.screenshot.height,
    });
    const bitmap = decodedImage.getBitmap();
    const probeOffset =
      (Math.floor(imageSize.height * 0.9) * imageSize.width + Math.floor(imageSize.width * 0.9)) *
      4;
    NodeAssert.deepEqual(
      [...bitmap.subarray(probeOffset, probeOffset + 4)],
      [0x66, 0xcc, 0xff, 0xff],
      "native PNG contains the fixture background rather than a blank compositor surface",
    );
    await NodeFSP.writeFile(
      NodePath.join(scratch, "snapshot.png"),
      Buffer.from(imageSnapshot.screenshot.data, "base64"),
    );
    NodeAssert.deepEqual(await ServerBrowserPage.viewportSize(page, cdp), {
      width: 390,
      height: 844,
    });
    results.push(
      "ordinary hidden window: acquire, 390x844 CSS geometry, text/image snapshots, native colored pixels at device scale",
    );
    const streamedFrame = Promise.withResolvers();
    let receivedFrame = false;
    const onScreencastFrame = (frame) => {
      if (receivedFrame) return;
      receivedFrame = true;
      void cdp
        .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
        .then(() => streamedFrame.resolve(frame), streamedFrame.reject);
    };
    cdp.on("Page.screencastFrame", onScreencastFrame);
    const streamTimer = setTimeout(
      () =>
        streamedFrame.reject(
          new Error("Hidden guest did not deliver and acknowledge a screencast frame."),
        ),
      5000,
    );
    try {
      const [, frame] = await Promise.all([
        cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 }),
        streamedFrame.promise,
      ]);
      NodeAssert.ok(frame.data.length > 0, "native screencast emitted an image");
      NodeAssert.ok(frame.sessionId >= 0, "native screencast frame carries an ACK session");
      NodeAssert.equal(
        nativeImage.createFromBuffer(Buffer.from(frame.data, "base64")).isEmpty(),
        false,
      );
      NodeAssert.equal(hostWindow.isVisible(), false);
      NodeAssert.equal(hostWindow.isFocused(), false);
    } finally {
      clearTimeout(streamTimer);
      cdp.off("Page.screencastFrame", onScreencastFrame);
      await cdp.send("Page.stopScreencast");
    }
    results.push(
      "hidden guest native screencast start, image frame ACK, and stop through production CDP relay",
    );
    const uploadPath = NodePath.join(scratch, "fixture-upload.txt");
    await NodeFSP.writeFile(uploadPath, "isolated upload fixture");
    NodeAssert.equal(
      await ServerBrowserPage.setInputFiles(page, {
        ...key(tabs[0]),
        selector: "#upload",
        paths: [uploadPath],
      }),
      true,
    );
    await page.waitForFunction(
      () =>
        document.querySelector("#uploaded").textContent ===
        "fixture-upload.txt:isolated upload fixture",
    );
    const chooser = page.waitForEvent("filechooser", { timeout: 5000 });
    await page.locator("#choose").click();
    await (await chooser).setFiles(uploadPath);
    results.push("production setInputFiles plus intercepted native file chooser upload");
    await page.evaluate(() => {
      document.cookie = "profile=default; path=/";
    });
    NodeAssert.equal(await pages[1].page.evaluate(() => document.cookie), "");
    await pages[1].page.evaluate(() => {
      document.cookie = "profile=synthetic; path=/";
    });
    NodeAssert.equal(await page.evaluate(() => document.cookie), "profile=default");
    results.push("isolated default and synthetic persistent profile cookies");
    await surface(tabs[0], "release", "snapshot-lease");
    const released = await hostWindow.webContents.executeJavaScript("surfaceSmokeState()");
    NodeAssert.ok(released.every((state) => state.activity === 0 && state.rect.right < 0));
    NodeAssert.equal(hostWindow.webContents.getBackgroundThrottling(), true);
    results.push("release restores off-window placement and host throttling");
    await surface(tabs[0], "acquire", "timeout-lease", 500);
    failCapture = true;
    const started = performance.now();
    await NodeAssert.rejects(
      takeSnapshot(page, cdp, true, 2000),
      (cause) => ServerBrowserPage.toOperationError(cause).tag === "PreviewAutomationTimeoutError",
    );
    NodeAssert.ok(performance.now() - started < 1500, "native timeout settles promptly");
    failCapture = false;
    finishFailedCapture?.({ data: "ignored late capture" });
    await surface(tabs[0], "release", "timeout-lease");
    NodeAssert.equal(await page.evaluate(() => 21 * 2), 42);
    NodeAssert.equal(await pages[1].page.evaluate(() => 6 * 7), 42);
    await surface(tabs[0], "acquire", "recovery-lease");
    NodeAssert.ok((await takeSnapshot(page, cdp, true)).screenshot);
    await surface(tabs[0], "release", "recovery-lease");
    results.push(
      "native stalled-capture deadline, same/other-tab evaluation, subsequent image capture",
    );
    NodeAssert.equal(hostWindow.isVisible(), false);
    NodeAssert.equal(hostWindow.isFocused(), false);
    // Re-announcement samples production registry state after all rendering leases.
    // It resets relay sessions, so perform it after the final CDP operation.
    for (const tab of tabs) attachments.set(tab.tabId, Promise.withResolvers());
    await send({ type: "announce" });
    const reattached = await Promise.all([...attachments.values()].map((entry) => entry.promise));
    NodeAssert.ok(reattached.every((event) => event.presented !== true));
    NodeAssert.ok(presentationEvents.every((event) => event.presented === false));
    NodeAssert.equal(nativeGuests.get(tabs[0].tabId).id, nativeGuestId);
    NodeAssert.equal(
      await nativeGuest.executeJavaScript("window.backingPageIdentity"),
      "written-through-native",
    );
    results.push(
      "hidden capture and stream leases never mark native presentation true or replace the backing page",
    );
    const report = {
      passed: true,
      results,
      scope:
        "production native host/CDP relay, actual hidden-window presentation registry, surface helpers, ServerBrowserPage; fixture bridge bypasses DesktopBrowserChannel and orchestration broker; no React hydration, visible-window transitions, OS-minimized-window, Windows, or WSL proof",
    };
    await NodeFSP.writeFile(NodePath.join(scratch, "result.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    clearTimeout(startupTimer);
    for (const tab of tabs) host.detach(key(tab));
    for (const browser of browsers) await browser.close().catch(() => undefined);
    for (const socket of sockets.values()) socket.terminate();
    relayServer.close();
    fixtureServer.close();
    await Effect.runPromise(Fiber.interrupt(events));
    hiddenPictureInPicture.destroy();
    hostWindow.destroy();
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
  }
}
void main().then(
  () => app.exit(0),
  (cause) => {
    console.error(cause);
    app.exit(1);
  },
);
