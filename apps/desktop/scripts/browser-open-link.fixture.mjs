// Opt-in renderer routing proof, deliberately independent of the lifecycle/cookie smoke fixtures.
import * as NodeAssert from "node:assert/strict";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { AuthPreviewOperateScope, DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { getPairingTokenFromUrl, stripPreviewBootstrapTokenFromUrl } from "@t3tools/shared/remote";
import { isLoopbackHost } from "@t3tools/shared/preview";
import * as Channels from "../src/ipc/channels.ts";

const [scratch] = process.argv.slice(2);
NodeAssert.ok(scratch, "Isolated scratch directory required");
app.setPath("userData", NodePath.join(scratch, "user-data"));
app.on("window-all-closed", () => {});
const threadRef = { environmentId: "fixture-remote", threadId: "fixture-owner" };
const projectKey = "fixture-remote:fixture-project";
const environmentUrl = "http://managed-server";
const bootstrapToken = "fixture-navigation-token";
const reports = [];
const recoveries = [];
const listings = [];
const opens = [];
const externalRequests = [];
const nativeShellRequests = [];
const failures = [];
const changed = new NodeEvents.EventEmitter();
let settingsReads = 0;
let window;
let server;

function waitForReport(type) {
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      clearTimeout(timer);
      changed.off("changed", check);
      if (error) reject(error);
      else resolve(value);
    };
    const check = () => {
      const failure = reports.find((report) => report.type === "failure");
      if (failure || failures.length)
        return finish(new Error(failure?.error ?? failures.join("\n")));
      const report = reports.find((report) => report.type === type);
      if (report) finish(null, report);
    };
    const timer = setTimeout(() => finish(new Error(`Timed out awaiting renderer ${type}`)), 10000);
    changed.on("changed", check);
    check();
  });
}

async function main() {
  // Neither production shell IPC nor any accidental direct native shell call may leave this process.
  shell.openExternal = async (url) => {
    nativeShellRequests.push(url);
    throw new Error("Native shell opening is forbidden in this fixture");
  };
  await app.whenReady();
  app.dock?.hide();
  server = NodeHttp.createServer((request, response) => {
    const file = request.url === "/renderer.js" ? "renderer.js" : "index.html";
    response.writeHead(200, {
      "content-type": file.endsWith(".js") ? "text/javascript" : "text/html",
    });
    response.end(NodeFS.readFileSync(NodePath.join(scratch, file)));
  });
  server.listen(0, "127.0.0.1");
  await NodeEvents.once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const path = "/app/a%2Fb?q=1#section";
  const sourceUrl = `http://localhost:${server.address().port}${path}`;
  const localUrl = `${origin}${path}`;
  const lease = { leaseId: "fixture-lease", threadId: threadRef.threadId, url: localUrl };
  const ownRenderer = (event) => {
    NodeAssert.equal(
      event.sender.id,
      window.webContents.id,
      "Only the fixture renderer may use IPC",
    );
  };
  const handle = (channel, handler) =>
    ipcMain.handle(channel, (event, ...args) => {
      ownRenderer(event);
      return handler(...args);
    });
  window = new BrowserWindow({
    show: false,
    focusable: false,
    width: 800,
    height: 600,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      preload: NodePath.join(scratch, "preload.cjs"),
    },
  });
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const allowed = new URL(details.url).origin === origin;
    if (!allowed) failures.push(`Blocked non-fixture request: ${details.url}`);
    callback({ cancel: !allowed });
    changed.emit("changed");
  });
  window.webContents.setWindowOpenHandler(() => {
    failures.push("Renderer tried to open another native window");
    changed.emit("changed");
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => {
    event.preventDefault();
    failures.push("Renderer tried to navigate away from the fixture");
    changed.emit("changed");
  });
  window.webContents.on("preload-error", (_event, _path, cause) => {
    failures.push(`Production preload failed: ${cause.message}`);
    changed.emit("changed");
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    failures.push(`Renderer exited: ${details.reason}`);
    changed.emit("changed");
  });
  for (const [channel, value] of [
    [Channels.TAKE_LEGACY_LOCAL_STORAGE_CHANNEL, {}],
    [Channels.GET_LOCAL_ENVIRONMENT_BOOTSTRAPS_CHANNEL, []],
  ])
    ipcMain.on(channel, (event) => {
      ownRenderer(event);
      event.returnValue = value;
    });
  handle(Channels.COMPLETE_LEGACY_LOCAL_STORAGE_CHANNEL, () => undefined);
  handle(Channels.GET_CLIENT_SETTINGS_CHANNEL, () => {
    settingsReads += 1;
    return DEFAULT_CLIENT_SETTINGS;
  });
  handle(Channels.OPEN_EXTERNAL_CHANNEL, (url) => {
    externalRequests.push(url);
    throw new Error("System browser IPC is forbidden for a managed remote link");
  });
  handle("open-link-fixture:configuration", () => ({
    threadRef,
    projectKey,
    environmentUrl,
    sourceUrl,
  }));
  handle("open-link-fixture:hosting", ({ operation, input }) => {
    if (operation === "list") {
      listings.push(input);
      NodeAssert.deepEqual(input, { threadRef, url: sourceUrl });
      return [lease];
    }
    NodeAssert.equal(operation, "recover");
    recoveries.push(input);
    NodeAssert.deepEqual(input, { lease, options: { bootstrap: true } });
    return { restarted: true, runId: "fixture-run", bootstrapToken };
  });
  handle("open-link-fixture:open", (request) => {
    opens.push(request);
    NodeAssert.equal(request.environmentId, threadRef.environmentId);
    const input = request.input;
    NodeAssert.equal(input.threadId, threadRef.threadId);
    NodeAssert.equal(input.runtime, "server");
    NodeAssert.equal(input.browserHost, "environment");
    NodeAssert.equal(input.desktopHostId, undefined);
    NodeAssert.equal(input.profileId, "default");
    NodeAssert.equal(input.background, undefined);
    NodeAssert.equal(isLoopbackHost(new URL(input.url).hostname), true);
    NodeAssert.equal(stripPreviewBootstrapTokenFromUrl(new URL(input.url)).href, localUrl);
    NodeAssert.equal(getPairingTokenFromUrl(new URL(input.url)), bootstrapToken);
    NodeAssert.ok(input.focus?.clientId);
    return {
      threadId: input.threadId,
      tabId: "fixture-owner-browser",
      runtime: "server",
      backingPage: "server",
      navStatus: { _tag: "Success", url: localUrl, title: "Fixture" },
      canGoBack: false,
      canGoForward: false,
      viewport: input.viewport,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
  });
  handle("open-link-fixture:report", (report) => {
    reports.push(report);
    changed.emit("changed");
  });
  const js = (code) => window.webContents.executeJavaScript(code);
  await window.loadURL(origin);
  const ready = await waitForReport("ready");
  NodeAssert.equal(ready.desktopBridgePresent, true);
  NodeAssert.equal(ready.isElectron, true);
  NodeAssert.equal(ready.surface.id, "files");
  NodeAssert.equal(settingsReads, 0, "Desktop settings must be requested by the click");
  NodeAssert.equal(ready.preparationCount, 0);
  const point = await js(`(() => {
    const r = document.querySelector('#managed-link').getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  NodeAssert.equal(window.isVisible(), false);
  NodeAssert.equal(window.isFocused(), false);
  window.webContents.sendInputEvent({ type: "mouseMove", ...point });
  window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
  window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
  const clicked = await waitForReport("clicked");
  NodeAssert.deepEqual(clicked.input, {
    trusted: true,
    desktopBridgeAtClick: true,
    metaKey: false,
    ctrlKey: false,
    button: 0,
  });
  NodeAssert.equal(reports.filter((report) => report.type === "clicked").length, 1);
  NodeAssert.equal(clicked.preference, "system");
  NodeAssert.equal(settingsReads, 1, "Real production desktop settings IPC must be observed");
  NodeAssert.equal(listings.length, 1);
  NodeAssert.equal(recoveries.length, 1);
  NodeAssert.equal(clicked.preparationCount, 1);
  NodeAssert.equal(clicked.prepared.managed, true);
  NodeAssert.equal(clicked.prepared.localUrl, localUrl);
  NodeAssert.equal(isLoopbackHost(new URL(clicked.prepared.url).hostname), false);
  NodeAssert.equal(new URL(clicked.prepared.url).hostname, "managed-server");
  NodeAssert.ok(
    clicked.scopes.some(
      (entry) =>
        entry.environmentId === threadRef.environmentId && entry.scope === AuthPreviewOperateScope,
    ),
  );
  NodeAssert.equal(opens.length, 1);
  NodeAssert.equal(opens[0].input.focus.userActionRevision, ready.initialRevision + 1);
  NodeAssert.equal(clicked.revision, ready.initialRevision + 1);
  NodeAssert.deepEqual(clicked.surface, {
    id: "browser:fixture-owner-browser",
    kind: "preview",
    resourceId: "fixture-owner-browser",
  });
  NodeAssert.equal(clicked.activeTabId, "fixture-owner-browser");
  NodeAssert.equal(clicked.sessions[clicked.activeTabId].navStatus.url, localUrl);
  NodeAssert.deepEqual(new Set(clicked.recentlySeenUrls), new Set([sourceUrl, localUrl]));
  NodeAssert.deepEqual(
    clicked.history.map((entry) => entry.url),
    [sourceUrl],
  );
  NodeAssert.deepEqual(externalRequests, []);
  NodeAssert.deepEqual(nativeShellRequests, []);
  NodeAssert.deepEqual(failures, []);
  NodeAssert.equal(BrowserWindow.getAllWindows().length, 1);
  NodeAssert.equal(window.isVisible(), false);
  NodeAssert.equal(window.isFocused(), false);
  const proof = {
    result: "passed",
    mode: "open-link",
    desktopSettingsIpcReads: settingsReads,
    preparationCount: clicked.preparationCount,
    recoveryCount: recoveries.length,
    browserOpen: opens[0],
    renderer: clicked,
    externalRequests,
    nativeShellRequests,
    actual:
      "trusted native input in hidden Electron renderer; production useOpenLink DESKTOP branch, browser defaults/target, openPreparedUrlInPreview, preparedPreviewOpenTarget, preview/focus/panel/history stores, LocalApi, preload contextBridge and settings IPC transport",
    mocked:
      "settings hydration wrapper and IPC reply, owner scope/server-browser capability, configured remote address, lease/recovery replies and Browser RPC transport/reply; random UUID helper; rejecting external-open IPC/native-shell guards",
    excluded:
      "remote WS, full app hydration, actual server Browser page/rendering, real recovery/process restart, real credentials/network, modifier/local-loopback cases (source tests own these), lifecycle/cookie regressions and foreground/human QA",
  };
  NodeFS.writeFileSync(
    NodePath.join(scratch, "open-link-proof.json"),
    JSON.stringify(proof, null, 2),
  );
  console.log(JSON.stringify(proof));
}

void main().then(
  () => cleanup(0),
  async (cause) => {
    console.error("Desktop renderer link fixture failed:", cause?.stack ?? cause);
    NodeFS.writeFileSync(
      NodePath.join(scratch, "open-link-failure.json"),
      JSON.stringify(
        {
          error: cause?.stack ?? String(cause),
          reports,
          recoveries,
          opens,
          settingsReads,
          externalRequests,
          nativeShellRequests,
          failures,
        },
        null,
        2,
      ),
    );
    await cleanup(1);
  },
);

async function cleanup(code) {
  try {
    if (window && !window.isDestroyed()) {
      await window.webContents
        .executeJavaScript("window.openLinkFixture?.dispose(); void 0")
        .catch(() => undefined);
      window.destroy();
    }
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    app.exit(code);
  }
}
