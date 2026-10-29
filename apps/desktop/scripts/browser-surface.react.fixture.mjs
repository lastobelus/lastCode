// Opt-in integration fixture: React creates/removes every guest. Native policy and IPC are real.
import * as NodeAssert from "node:assert/strict";
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeEvents from "node:events";
import { app, BrowserWindow, ipcMain } from "electron";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as BrowserSession from "../src/preview/BrowserSession.ts";
import * as BrowserHost from "../src/preview/DesktopBrowserHost.ts";
import * as Manager from "../src/preview/Manager.ts";
import * as Passkeys from "../src/preview/Passkeys.ts";
import * as DesktopEnvironment from "../src/app/DesktopEnvironment.ts";
import * as RendererHistory from "../src/telemetry/DesktopRendererHistory.ts";
import * as ClientSettings from "../src/settings/DesktopClientSettings.ts";
import * as ElectronDialog from "../src/electron/ElectronDialog.ts";
import * as DesktopIpc from "../src/ipc/DesktopIpc.ts";
import * as PreviewIpc from "../src/ipc/methods/preview.ts";
import * as BrowserIpc from "../src/ipc/methods/desktopBrowser.ts";
import { resolvePartitionScope } from "../src/preview/BrowserProfileScope.ts";
import {
  NATIVE_BROWSER_PAGE_LIMIT,
  NATIVE_BROWSER_IDLE_MS,
} from "../src/preview/NativeBrowserLifetime.ts";
import * as Channels from "../src/ipc/channels.ts";

const [scratch] = process.argv.slice(2);
NodeAssert.ok(scratch, "isolated scratch directory required");
app.setPath("userData", NodePath.join(scratch, "user-data"));
app.on("window-all-closed", () => {});
let currentStage = "startup";
const trace = (record) => {
  const line = JSON.stringify({ stage: currentStage, ...record });
  console.log(line);
  NodeFS.appendFileSync(NodePath.join(scratch, "react-events.ndjson"), `${line}\n`);
};
const stage = (name) => {
  currentStage = name;
  trace({ checkpoint: "stage.started" });
};
const milestone = async (label, action) => {
  const stageAtStart = currentStage;
  trace({ checkpoint: "started", label });
  try {
    const result = await action();
    trace({ checkpoint: "completed", label, stage: stageAtStart });
    return result;
  } catch (cause) {
    trace({ checkpoint: "failed", label, stage: stageAtStart, error: String(cause) });
    throw new Error(`[${stageAtStart}] ${label}: ${cause?.message ?? cause}`, { cause });
  }
};

async function main() {
  stage("isolated native setup");
  await app.whenReady();
  app.dock?.hide();
  const scope = await Effect.runPromise(Scope.make());
  const changed = new NodeEvents.EventEmitter();
  const checkpoints = new Set();
  const guests = new Map();
  const observedGuests = new Set();
  const lifecycle = new Map();
  const requests = [];
  const nativeEvents = [];
  const registrations = [];
  const failures = [];
  let nativeClockShift = 0n;
  let holdActivity = null;
  const notify = () => changed.emit("changed");
  const wait = (label, read) =>
    milestone(
      label,
      () =>
        new Promise((resolve, reject) => {
          const check = () => {
            if (failures.length) return finish(new Error(failures.join("\n")));
            const value = read();
            if (value) finish(null, value);
          };
          const finish = (error, value) => {
            clearTimeout(timer);
            changed.off("changed", check);
            if (error) reject(error);
            else resolve(value);
          };
          const timer = setTimeout(() => finish(new Error(`Timed out: ${label}`)), 15000);
          changed.on("changed", check);
          check();
        }),
    );
  const recordFailure = (message) => {
    failures.push(message);
    notify();
  };
  const server = NodeHttp.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><title>${request.url}</title><input id="draft"><script>
      window.fixtureDocumentId = crypto.randomUUID();
      window.fixtureLoads = Number(sessionStorage.getItem('loads') || 0) + 1;
      sessionStorage.setItem('loads', window.fixtureLoads);
    </script>`);
  });
  server.listen(0, "localhost");
  await NodeEvents.once(server, "listening");
  // Managed preview recovery canonicalizes loopback destinations to localhost.
  const origin = `http://localhost:${server.address().port}`;
  const observeGuest = (guest, { tabId }) =>
    Effect.sync(() => {
      if (guests.get(tabId) === guest) return;
      guests.set(tabId, guest);
      observedGuests.add(guest);
      registrations.push({ tabId, webContentsId: guest.id });
      trace({ native: "guest.registered", tabId, webContentsId: guest.id });
      lifecycle.delete(tabId);
      const debuggerInstance = guest.debugger;
      const send = debuggerInstance.sendCommand.bind(debuggerInstance);
      debuggerInstance.sendCommand = async (method, ...args) => {
        const result = await send(method, ...args);
        if (method === "Page.setWebLifecycleState" && guests.get(tabId) === guest) {
          lifecycle.set(tabId, args[0].state);
          trace({
            native: "guest.lifecycle",
            tabId,
            webContentsId: guest.id,
            state: args[0].state,
          });
          notify();
        }
        return result;
      };
      guest.on("destroyed", () => {
        trace({ native: "guest.destroyed", tabId, webContentsId: guest.id });
        notify();
      });
      guest.on("did-finish-load", notify);
      guest.on("did-stop-loading", notify);
      guest.on("render-process-gone", (_event, details) =>
        recordFailure(`Guest exited: ${details.reason}`),
      );
      notify();
    });
  const services = Layer.mergeAll(
    NodeServices.layer,
    ElectronDialog.layer,
    ClientSettings.layerTest(),
    Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
      path: NodePath,
      dirname: scratch,
      browserArtifactsDir: NodePath.join(scratch, "artifacts"),
    }),
    Layer.succeed(RendererHistory.DesktopRendererHistory, {
      register: observeGuest,
      recordMetrics: () => Effect.void,
      shutdown: Effect.void,
    }),
    Layer.succeed(Passkeys.PreviewPasskeys, {
      bridgeEnabled: false,
      configure: Effect.void,
      installSessionHandlers: () => {},
      attachGuest: () => () => {},
    }),
  );
  const { host, manager, run } = await Effect.runPromise(
    Effect.gen(function* () {
      const context = yield* Effect.context();
      const run = Effect.runPromiseWith(context);
      const browserSession = yield* BrowserSession.make;
      const clock = yield* Clock.Clock;
      const host = yield* BrowserHost.make.pipe(
        Effect.provideService(Clock.Clock, {
          currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
          currentTimeMillis: clock.currentTimeMillis,
          currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
          currentTimeNanos: clock.currentTimeNanos,
          monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe() + nativeClockShift,
          monotonicTimeNanos: Effect.sync(
            () => clock.monotonicTimeNanosUnsafe() + nativeClockShift,
          ),
          sleep: (duration) => clock.sleep(duration),
        }),
      );
      const manager = yield* Manager.make.pipe(
        Effect.provideService(BrowserSession.BrowserSession, browserSession),
        Effect.provideService(BrowserHost.DesktopBrowserHost, host),
      );
      return { host, manager, run };
    }).pipe(Effect.provide(services), Effect.provideService(Scope.Scope, scope)),
  );
  const window = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      backgroundThrottling: false,
      preload: NodePath.join(scratch, "preload.cjs"),
    },
  });
  const js = (code) => window.webContents.executeJavaScript(code);
  const tabId = (index) => `react-tab-${index.toString().padStart(2, "0")}`;
  const guestFor = (index) =>
    guests.get(JSON.stringify(["fixture-remote", "fixture-thread", "fixture-epoch", tabId(index)]));
  const runtimeId = (index) =>
    JSON.stringify(["fixture-remote", "fixture-thread", "fixture-epoch", tabId(index)]);
  const demand = (index) =>
    milestone(`demand guest ${index}`, () => js(`reactSmoke.demand(${index})`));
  const hide = (index) => js(`reactSmoke.hide(${index}); void 0`);
  const state = (index) =>
    guestFor(index).executeJavaScript(`({
    documentId: window.fixtureDocumentId, loads: window.fixtureLoads,
    draft: document.querySelector('#draft').value, cookie: document.cookie,
    memory: window.fixtureMemory ?? null,
  })`);
  const settle = () =>
    js("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const loaded = (index) =>
    wait(`guest ${index} loaded`, () => {
      const guest = guestFor(index);
      return (
        guest &&
        !guest.isDestroyed() &&
        guest.getURL() === `${origin}/${tabId(index)}` &&
        !guest.isLoading()
      );
    });
  const frozen = (index, state) =>
    state === "active"
      ? milestone(`guest ${index} runs scheduled JavaScript`, async () => {
          let timer;
          try {
            await Promise.race([
              guestFor(index).executeJavaScript(
                "new Promise(resolve => setTimeout(() => resolve('active'), 0))",
              ),
              new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error("Guest remained frozen")), 15000);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        })
      : wait(`guest ${index} ${state}`, () => lifecycle.get(runtimeId(index)) === state);
  const liveGuests = () => [...observedGuests].filter((guest) => !guest.isDestroyed());
  window.webContents.on("preload-error", (_event, _path, error) =>
    recordFailure(`Preload failed: ${error}`),
  );
  window.webContents.on("render-process-gone", (_event, details) =>
    recordFailure(`React renderer exited: ${details.reason}`),
  );
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") recordFailure(`React renderer: ${details.message}`);
  });
  const ipc = DesktopIpc.make(ipcMain);
  const install = (method) =>
    run(
      ipc
        .handle({
          ...method,
          handler: (input, event) =>
            Effect.suspend(() => {
              trace({ ipc: method.channel, status: "started", tabId: input?.tabId });
              return method.handler(input, event).pipe(
                Effect.onExit((exit) =>
                  Effect.sync(() => {
                    trace({
                      ipc: method.channel,
                      status: exit._tag,
                      ...(exit._tag === "Failure" ? { cause: String(exit.cause) } : {}),
                    });
                  }),
                ),
              );
            }),
        })
        .pipe(
          Effect.provideService(Manager.PreviewManager, manager),
          Effect.provideService(BrowserHost.DesktopBrowserHost, host),
        ),
    );
  try {
    await run(manager.setMainWindow(window));
    await run(
      host.remoteEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            nativeEvents.push(event);
            if (event.event.type !== "cdp")
              trace({ native: event.event.type, tabId: event.event.tabId });
            notify();
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      ),
    );
    for (const method of [
      PreviewIpc.createTab,
      PreviewIpc.closeTab,
      PreviewIpc.registerWebview,
      PreviewIpc.getPreviewConfig,
      PreviewIpc.setAnnotationTheme,
      PreviewIpc.refresh,
      PreviewIpc.navigate,
      BrowserIpc.browserPresentation,
    ])
      await install(method);
    // Profiles use the isolated default partition, so no backend or identity discovery runs.
    ipcMain.handle(Channels.DESKTOP_BROWSER_ENVIRONMENT_CHANNEL, (_event, input) =>
      run(
        host.bindEnvironment(input.desktopHostId, input.environmentId, (profileId) =>
          Effect.succeed(resolvePartitionScope(input.environmentId, profileId, "fixture-primary")),
        ),
      ),
    );
    ipcMain.on(Channels.TAKE_LEGACY_LOCAL_STORAGE_CHANNEL, (event) => {
      event.returnValue = {};
    });
    ipcMain.handle(Channels.COMPLETE_LEGACY_LOCAL_STORAGE_CHANNEL, () => undefined);
    ipcMain.on(Channels.GET_LOCAL_ENVIRONMENT_BOOTSTRAPS_CHANNEL, (event) => {
      event.returnValue = [];
    });
    ipcMain.handle("react-smoke:configuration", () => ({
      origin,
      pageLimit: NATIVE_BROWSER_PAGE_LIMIT,
    }));
    ipcMain.handle("react-smoke:checkpoint", (_event, name) => {
      checkpoints.add(name);
      trace({ renderer: name });
      notify();
    });
    ipcMain.handle("react-smoke:hosting", async (_event, request) => {
      requests.push(request);
      trace({
        hosting: request.operation,
        url: request.input.input?.url ?? request.input.lease?.url ?? request.input.url,
        ...(request.operation === "activity" ? { active: request.input.input.active } : {}),
      });
      notify();
      if (request.operation === "activity") {
        if (request.input.input.active && holdActivity) await holdActivity.promise;
        return;
      }
      if (request.operation === "list")
        return [
          {
            leaseId: "fixture-lease",
            threadId: "fixture-thread",
            url: `${origin}/`,
          },
        ];
      if (request.operation === "recover")
        return { restarted: false, runId: "fixture-healthy-run" };
      throw new Error(`Unexpected fixture hosting operation: ${request.operation}`);
    });
    stage("renderer startup");
    await milestone("load fixture document", () =>
      window.loadFile(NodePath.join(scratch, "index.html")),
    );
    await wait("renderer initialized", () => checkpoints.has("ready"));
    const hydration = await js("reactSmoke.diagnostics()");
    NodeAssert.equal(
      hydration.connection._tag,
      "Success",
      "fixture connection was lost before guest subscription",
    );
    NodeAssert.equal(hydration.connection.value.phase, "connected");
    NodeAssert.ok(hydration.config !== null, "fixture config was lost before guest subscription");

    stage("old-host capability fallback");
    await demand(0);
    await loaded(0);
    NodeAssert.equal(
      requests.some(({ operation }) => operation === "activity"),
      false,
      "old host without activity capability must mount without an unsupported RPC",
    );
    await wait("remote desktop-runtime attached to native host", () =>
      nativeEvents.some(({ event }) => event.type === "attached" && event.tabId === tabId(0)),
    );

    stage("activity acknowledgment gate");
    await js("reactSmoke.activityCapability(true)");
    holdActivity = Promise.withResolvers();
    const firstDemand = demand(1);
    const activeForHealthyTab = ({ operation, input }) =>
      operation === "activity" && input.input.active && input.input.url === `${origin}/${tabId(1)}`;
    const recoverOwnedApp = ({ operation, input }) =>
      operation === "recover" && input.lease.url === `${origin}/`;
    await wait("advertised activity requested", () => requests.some(activeForHealthyTab));
    NodeAssert.equal(
      guestFor(1),
      undefined,
      "React must wait for activity ACK before native creation",
    );
    NodeAssert.equal(await js("document.querySelectorAll('webview').length"), 1);
    holdActivity.resolve();
    holdActivity = null;
    await firstDemand;
    await loaded(1);
    await frozen(1, "active");
    await guestFor(1).executeJavaScript(`
      document.querySelector('#draft').value = 'retained React draft';
      document.cookie = 'reactFixture=retained; path=/'; window.fixtureMemory = 'retained';
    `);
    const healthy = guestFor(1);
    const healthySession = healthy.session;
    const healthyState = await state(1);
    stage("connection-generation re-registration");
    const registrationCount = registrations.length;
    const activityBefore = requests.filter(activeForHealthyTab).length;
    const oldActivityId = requests.findLast(activeForHealthyTab).input.input.activityId;
    const recoverBefore = requests.filter(recoverOwnedApp).length;
    await js("reactSmoke.generation(2)");
    await wait(
      "generation activity redeclared",
      () => requests.filter(activeForHealthyTab).length > activityBefore,
    );
    await wait(
      "generation recovery checked",
      () => requests.filter(recoverOwnedApp).length > recoverBefore,
    );
    await settle();
    NodeAssert.notEqual(
      requests.findLast(activeForHealthyTab).input.input.activityId,
      oldActivityId,
    );
    NodeAssert.equal(guestFor(1).id, healthy.id);
    NodeAssert.equal(
      registrations.length,
      registrationCount,
      "generation change must not remount healthy guests",
    );
    NodeAssert.deepEqual(
      await state(1),
      healthyState,
      "generation change must preserve the loaded document",
    );

    stage("hidden freeze and warm return");
    await hide(0);
    await frozen(0, "frozen");
    await hide(1);
    await frozen(1, "frozen");
    nativeClockShift += BigInt(NATIVE_BROWSER_IDLE_MS - 3600000) * 1000000n;
    await demand(1);
    await frozen(1, "active");
    NodeAssert.equal(guestFor(1).id, healthy.id);
    NodeAssert.deepEqual(
      await state(1),
      healthyState,
      "hidden freeze/thaw must retain form and memory",
    );
    await hide(1);
    await frozen(1, "frozen");
    stage("idle unload and cold restoration");
    nativeClockShift += BigInt(NATIVE_BROWSER_IDLE_MS + 3600000) * 1000000n;
    await js(
      `desktopBridge.preview.browserPresentation({runtimeTabId: reactSmoke.runtimeId(1), presented: false, rendering: false})`,
    );
    await wait("idle guests unloaded by native policy and React", () => liveGuests().length === 0);
    NodeAssert.equal(await js("document.querySelectorAll('webview').length"), 0);
    await demand(1);
    await loaded(1);
    await frozen(1, "active");
    NodeAssert.notEqual(guestFor(1).id, healthy.id);
    NodeAssert.equal(guestFor(1).session, healthySession);
    const restored = await state(1);
    NodeAssert.notEqual(restored.documentId, healthyState.documentId);
    NodeAssert.equal(restored.draft, "");
    NodeAssert.equal(restored.memory, null);
    NodeAssert.match(restored.cookie, /reactFixture=retained/);
    await hide(1);
    await frozen(1, "frozen");

    // Fill the real 32-page cache sequentially. Only index 0 remains demanded.
    stage("native page capacity");
    for (let index = 0; index <= NATIVE_BROWSER_PAGE_LIMIT; index++) {
      await demand(index);
      await loaded(index);
      await frozen(index, "active");
      if (index !== 0) {
        await hide(index);
        await frozen(index, "frozen");
      }
      NodeAssert.ok(liveGuests().length <= NATIVE_BROWSER_PAGE_LIMIT, "native guest cap exceeded");
    }
    NodeAssert.equal(liveGuests().length, NATIVE_BROWSER_PAGE_LIMIT);
    const dormant = nativeEvents.filter(({ event }) => event.type === "dormant");
    NodeAssert.ok(
      dormant.length >= 3,
      "idle and capacity policy must both unload remote desktop-runtime guests",
    );
    stage("capacity victim restoration");
    const capacityVictim = dormant.at(-1).event.tabId;
    const victimIndex = Number(capacityVictim.slice("react-tab-".length));
    const protectedGuest = guestFor(0);
    const previousVictim = guestFor(victimIndex);
    NodeAssert.ok(previousVictim.isDestroyed());
    await demand(victimIndex);
    await loaded(victimIndex);
    await frozen(victimIndex, "active");
    NodeAssert.notEqual(guestFor(victimIndex).id, previousVictim.id);
    NodeAssert.equal(
      guestFor(0).id,
      protectedGuest.id,
      "demanded guest must survive capacity eviction",
    );
    NodeAssert.equal(liveGuests().length, NATIVE_BROWSER_PAGE_LIMIT);
    NodeAssert.deepEqual(failures, []);
    NodeAssert.equal(window.isVisible(), false);
    NodeAssert.equal(window.isFocused(), false);
    console.log(
      JSON.stringify({
        result: "passed",
        mode: "react-lifecycle",
        pageLimit: NATIVE_BROWSER_PAGE_LIMIT,
        assertions: [
          "old-host capability fallback",
          "activity ACK gates React mount",
          "generation re-registration without document reload",
          "hidden freeze/thaw retains document",
          "24-hour idle unload and restoration",
          "32-guest cap and protected return",
        ],
        actual:
          "production ElectronBrowserHost + HostedBrowserWebview, preload contextBridge, preview IPC methods, Manager, BrowserSession, DesktopBrowserHost and lifetime policy",
        mocked:
          "application hydration, permissions, remote config/hosting replies, connection generation, monotonic clock, passkeys and renderer telemetry",
        excluded:
          "real WS reconnect, external server process recovery, full app hydration/CDP subscriptions, recordings, OS visibility transitions, day-long wall time",
      }),
    );
  } catch (cause) {
    const diagnostics = {
      stage: currentStage,
      error: cause?.stack ?? String(cause),
      renderer: window.isDestroyed()
        ? "destroyed"
        : await js("window.reactSmoke?.diagnostics() ?? null").catch((error) => ({
            error: String(error),
          })),
      registrations,
      guests: [...guests].map(([tabId, guest]) => ({
        tabId,
        webContentsId: guest.id,
        destroyed: guest.isDestroyed(),
        ...(guest.isDestroyed() ? {} : { url: guest.getURL(), loading: guest.isLoading() }),
        lifecycle: lifecycle.get(tabId),
      })),
      requests,
      nativeEvents: nativeEvents.filter(({ event }) => event.type !== "cdp"),
      failures,
    };
    const path = NodePath.join(scratch, "react-failure.json");
    NodeFS.writeFileSync(path, JSON.stringify(diagnostics, null, 2));
    trace({
      checkpoint: "failure-diagnostics",
      path,
      renderer: diagnostics.renderer,
      guests: diagnostics.guests,
    });
    throw new Error(`[${currentStage}] ${cause?.message ?? cause}`, { cause });
  } finally {
    holdActivity?.resolve();
    if (!window.isDestroyed()) {
      await js("reactSmoke?.dispose(); void 0").catch(() => undefined);
      await settle().catch(() => undefined);
      window.destroy();
    }
    await Effect.runPromise(Scope.close(scope, Exit.void));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
void main().then(
  () => app.exit(0),
  (cause) => {
    console.error(
      `React browser lifecycle fixture failed at [${currentStage}]:`,
      cause?.stack ?? cause,
    );
    app.exit(1);
  },
);
