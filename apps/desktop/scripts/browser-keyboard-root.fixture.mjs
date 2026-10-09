// Production root creation, keyboard routing, capture and close stay outside the host frame tree.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { nativeImage } from "electron";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as BrowserRootWindow from "../src/preview/BrowserRootWindow.ts";
import { resolvePartitionScope } from "../src/preview/BrowserProfileScope.ts";
import { chromium } from "playwright-core";

import * as ServerBrowserPage from "../../server/src/preview/ServerBrowserPage.ts";

export async function runNativeKeyboardFixture({
  scratch,
  fixtureOrigin,
  hostWindow,
  nativeGuests,
  tabs,
  WebSocketServer,
  host,
  browserSessions,
  environmentId,
}) {
  const windows = [];
  const browsers = [];
  const sockets = new Map();
  const requests = new Map();
  const pendingInput = new Map();
  const desktopHostId = "keyboard-fixture-host";
  const rootKey = (id) => ({ threadId: "keyboard-fixture-thread", tabId: id });
  const send = (command) => Effect.runPromise(host.handleRemoteCommand({ desktopHostId, command }));
  const acknowledge = async (command) => {
    const request = Promise.withResolvers();
    requests.set(command.requestId, request);
    const timer = setTimeout(
      () => request.reject(new Error(`Native ${command.type} did not acknowledge.`)),
      5000,
    );
    try {
      await send(command);
      return await request.promise;
    } finally {
      clearTimeout(timer);
      requests.delete(command.requestId);
    }
  };
  const commands = [];
  const nativeWindowEvents = [];
  const attempts = [];
  const profileOwnership = [];
  const relayServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => relayServer.once("listening", resolve));
  const hostState = () => hostWindow.webContents.executeJavaScript("surfaceSmokeKeyboardState()");
  let expectedHost;
  const assertHost = (state) => {
    NodeAssert.equal(state.activeElement, "host-sentinel", "host keeps its focused textarea");
    NodeAssert.equal(state.value, expectedHost.value, "host value stays unchanged");
    for (const name of ["selectionStart", "selectionEnd", "selectionDirection"])
      NodeAssert.equal(state[name], expectedHost[name], `host ${name} stays unchanged`);
    NodeAssert.equal(state.events.length, 0, "host receives no guest keyboard events");
    for (const event of state.ownershipEvents) {
      NodeAssert.equal(
        event.type,
        "selectionchange",
        "host never loses focus or receives guest input",
      );
      NodeAssert.equal(event.activeElement, "host-sentinel");
      NodeAssert.equal(event.value, expectedHost.value);
      for (const name of ["selectionStart", "selectionEnd", "selectionDirection"])
        NodeAssert.equal(event[name], expectedHost[name], `event keeps host ${name}`);
    }
    NodeAssert.equal(hostWindow.isVisible(), false);
    NodeAssert.equal(hostWindow.isFocused(), false);
    for (const window of windows) {
      if (window.isDestroyed()) continue;
      NodeAssert.equal(window.isVisible(), false, "independent root stays hidden");
      NodeAssert.equal(window.isFocused(), false, "independent root never activates");
      NodeAssert.equal(window.isFocusable(), false, "independent root cannot accept OS focus");
    }
    NodeAssert.deepEqual(nativeWindowEvents, [], "no native window was shown or focused");
  };
  const watchWindow = (window, id) => {
    for (const type of ["focus", "show"])
      window.on(type, () => nativeWindowEvents.push({ id, type }));
  };
  watchWindow(hostWindow, "host");
  const rootDefinitions = [
    { id: "root-default-a", profile: tabs[0], marker: "default-a" },
    { id: "root-default-b", profile: tabs[0], marker: "default-b" },
    { id: "root-synthetic", profile: tabs[1], marker: "synthetic" },
  ];
  const roots = new Map();
  const events = Effect.runFork(
    host.remoteEvents.pipe(
      Stream.runForEach(({ desktopHostId: sender, event }) => {
        if (sender !== desktopHostId) return Effect.void;
        return Effect.tryPromise(async () => {
          if (
            event.type === "rootCreated" ||
            event.type === "rootAccepted" ||
            event.type === "surfaceReady"
          )
            requests.get(event.requestId)?.resolve(event);
          if (event.type === "rootClosed") requests.get(`close:${event.rootId}`)?.resolve(event);
          if (event.type !== "cdp") return;
          const message = JSON.parse(event.message);
          const pending = pendingInput.get(`${event.tabId}:${message.id}`);
          if (pending) {
            pendingInput.delete(`${event.tabId}:${message.id}`);
            const state = await hostState();
            commands.push({ root: event.tabId, method: pending, phase: "after", host: state });
            assertHost(state);
          }
          sockets.get(event.tabId)?.send(event.message);
        });
      }),
    ),
  );
  relayServer.on("connection", (socket, request) => {
    const root = roots.get(request.url);
    if (!root) {
      socket.close();
      return;
    }
    sockets.set(root.id, socket);
    socket.on("message", (raw) => {
      void (async () => {
        const message = JSON.parse(String(raw));
        if (message.method === "Input.insertText" || message.method === "Input.dispatchKeyEvent") {
          const state = await hostState();
          commands.push({ root: root.id, method: message.method, phase: "before", host: state });
          assertHost(state);
          pendingInput.set(`${root.id}:${message.id}`, message.method);
        }
        await send({ type: "cdp", ...rootKey(root.id), message: String(raw) });
      })().catch((cause) => socket.close(1011, cause.message.slice(0, 100)));
    });
    socket.on("close", () => {
      if (sockets.get(root.id) === socket) sockets.delete(root.id);
    });
  });
  let completed = false;
  try {
    const sessions = tabs.map((tab) => nativeGuests.get(tab.tabId).session);
    // Seed authentication in the already-selected fixture sessions, before root creation.
    for (const [index, session] of sessions.entries()) {
      await session.cookies.set({
        url: fixtureOrigin,
        name: "fixture-auth",
        value: index === 0 ? "default-session" : "synthetic-session",
        httpOnly: true,
      });
    }
    expectedHost = await hostWindow.webContents.executeJavaScript(
      "surfaceSmokeWatchHostOwnership()",
    );
    await Effect.runPromise(
      host.bindEnvironment(desktopHostId, environmentId, (profileId) =>
        Effect.succeed(resolvePartitionScope(environmentId, profileId, environmentId)),
      ),
    );
    host.setRootFactory((input) =>
      BrowserRootWindow.create(browserSessions, input, input.partition).pipe(
        Effect.tap((window) =>
          Effect.sync(() => {
            windows.push(window);
            watchWindow(window, `native-root-${windows.length}`);
          }),
        ),
      ),
    );
    for (const definition of rootDefinitions) {
      const selectedSession = nativeGuests.get(definition.profile.tabId).session;
      const response = await acknowledge({
        type: "createRoot",
        serverEpoch: "server-epoch-a",
        ...rootKey(definition.id),
        requestId: `create:${definition.id}`,
        profileId: definition.profile.profileId,
        url: `${fixtureOrigin}/${definition.id}`,
        viewport: { _tag: "freeform", width: 390, height: 844 },
      });
      NodeAssert.ok(
        response.rootId && !response.reason,
        "production creation acknowledges native root identity",
      );
      const window = windows.at(-1);
      NodeAssert.equal(
        window.webContents.session,
        selectedSession,
        "root uses the exact selected session",
      );
      NodeAssert.equal(window.webContents.hostWebContents, null, "root has no composer embedder");
      const root = {
        ...definition,
        window,
        rootId: response.rootId,
        initialThrottling: window.webContents.getBackgroundThrottling(),
      };
      roots.set(`/${root.id}`, root);
      const ready = await acknowledge({
        type: "surface",
        ...rootKey(root.id),
        requestId: `acquire:${root.id}`,
        leaseId: `keyboard:${root.id}`,
        action: "acquire",
        viewport: { _tag: "freeform", width: 390, height: 844 },
      });
      NodeAssert.deepEqual(ready.viewport, { width: 390, height: 844 });
      assertHost(await hostState());
    }
    for (const root of roots.values()) {
      const browser = await chromium.connectOverCDP(
        `ws://127.0.0.1:${relayServer.address().port}/${root.id}`,
        { timeout: 10000 },
      );
      browsers.push(browser);
      root.page = browser.contexts()[0].pages()[0];
      root.cdp = await root.page.context().newCDPSession(root.page);
      const accepted = await acknowledge({
        type: "acceptRoot",
        ...rootKey(root.id),
        rootId: root.rootId,
        requestId: `create:${root.id}`,
        profileId: root.profile.profileId,
      });
      NodeAssert.equal(accepted.accepted, true, "connected native root accepts exact creation");
      await send({
        type: "publishRoot",
        ...rootKey(root.id),
        rootId: root.rootId,
        requestId: `create:${root.id}`,
        profileId: root.profile.profileId,
      });
      await root.page.goto(`${fixtureOrigin}/${root.id}`, { waitUntil: "commit" });
      root.targetId = (
        await root.window.webContents.debugger.sendCommand("Target.getTargetInfo")
      ).targetInfo.targetId;
      const expectedAuth = root.profile === tabs[0] ? "default-session" : "synthetic-session";
      const receivedCookie = await root.page.evaluate(() => window.receivedCookie);
      NodeAssert.ok(receivedCookie.includes(`fixture-auth=${expectedAuth}`));
      NodeAssert.equal(
        await root.page.evaluate(() => document.cookie),
        "",
        "authentication stays HttpOnly",
      );
      for (const [width, height] of [
        [720, 480],
        [390, 844],
      ]) {
        const resized = await acknowledge({
          type: "surface",
          ...rootKey(root.id),
          requestId: `resize:${root.id}:${width}`,
          leaseId: `keyboard:${root.id}`,
          action: "acquire",
          viewport: { _tag: "freeform", width, height },
        });
        NodeAssert.deepEqual(resized.viewport, { width, height });
        await root.page.waitForFunction(
          ({ width, height }) => innerWidth === width && innerHeight === height,
          { width, height },
          { timeout: 5000 },
        );
        assertHost(await hostState());
      }
      profileOwnership.push({
        root: root.id,
        webContentsId: root.window.webContents.id,
        targetId: root.targetId,
        selectedPartition: root.profile.partition,
        exactSession:
          root.window.webContents.session === nativeGuests.get(root.profile.tabId).session,
        receivedCookie,
      });
    }
    const keyboardOutcomes = await Promise.allSettled(
      [...roots.values()].map(async (root) => {
        const steps = [];
        const attempt = { root: root.id, steps, guest: null };
        attempts.push(attempt);
        for (const [target, suffix] of [
          ["#draft", "textarea"],
          ["#rich", "rich"],
        ]) {
          const text = `${root.marker} ${suffix} α`;
          const record = async (operation, expected) => {
            const actual = await root.page
              .locator(target)
              .evaluate((element) =>
                element.tagName === "TEXTAREA" ? element.value : element.textContent,
              );
            const host = await hostState();
            steps.push({ target, operation, expected, actual, host });
            assertHost(host);
            NodeAssert.equal(actual, expected, `${root.id} ${target} ${operation}`);
          };
          await ServerBrowserPage.type(root.page, { selector: target, text, clear: true });
          await record("replace", text);
          await ServerBrowserPage.type(root.page, {
            selector: target,
            text: " append",
            clear: false,
          });
          await record("append", `${text} append`);
          await ServerBrowserPage.press(root.page, { key: "q" });
          await record("printable key", `${text} appendq`);
          await ServerBrowserPage.press(root.page, { key: "Backspace" });
          await record("editing key", `${text} append`);
        }
        const guest = await root.page.evaluate(() => ({
          hasFocus: document.hasFocus(),
          activeElement: document.activeElement?.id,
          events: [...window.keyboardEvents],
        }));
        attempt.guest = guest;
        for (const target of ["draft", "rich"]) {
          const events = guest.events.filter((event) => event.target === target);
          NodeAssert.ok(events.length > 0 && events.every((event) => event.trusted));
          for (const type of ["beforeinput", "input", "keydown", "keyup"])
            NodeAssert.ok(
              events.some((event) => event.type === type),
              `${root.id} ${target} receives trusted ${type}`,
            );
        }
        for (const method of ["Input.insertText", "Input.dispatchKeyEvent"])
          NodeAssert.ok(
            commands.some((command) => command.root === root.id && command.method === method),
          );
      }),
    );
    for (const outcome of keyboardOutcomes) if (outcome.status === "rejected") throw outcome.reason;
    const defaultRoots = [...roots.values()].filter((root) => root.profile === tabs[0]);
    // Match the incident exactly: focus B, then send another key to A.
    for (const candidate of defaultRoots)
      await candidate.page.locator("#draft").evaluate((element) => {
        element.value = "";
        window.keyboardEvents = [];
      });
    await defaultRoots[0].page.locator("#draft").click();
    await ServerBrowserPage.press(defaultRoots[0].page, { key: "x" });
    await defaultRoots[1].page.locator("#draft").click();
    await ServerBrowserPage.press(defaultRoots[0].page, { key: "y" });
    const crossTabInput = await Promise.all(
      defaultRoots.map((candidate) =>
        candidate.page.evaluate(() => ({
          value: document.querySelector("#draft").value,
          events: [...window.keyboardEvents],
        })),
      ),
    );
    NodeAssert.deepEqual(
      crossTabInput.map((state) => state.value),
      ["xy", ""],
    );
    NodeAssert.ok(crossTabInput[0].events.some((event) => event.key === "y"));
    NodeAssert.ok(crossTabInput[1].events.every((event) => event.key !== "y"));
    assertHost(await hostState());
    attempts.push({ operation: "focus B then press y on A", crossTabInput });
    await defaultRoots[0].page.evaluate(() => {
      document.cookie = "root-shared=default; path=/";
    });
    NodeAssert.equal(
      await defaultRoots[1].page.evaluate(() => document.cookie),
      "root-shared=default",
    );
    NodeAssert.equal(
      await nativeGuests.get(tabs[0].tabId).executeJavaScript("document.cookie"),
      "root-shared=default",
    );
    NodeAssert.equal(await roots.get("/root-synthetic").page.evaluate(() => document.cookie), "");
    const root = defaultRoots[0];
    const renderScale = await root.page.evaluate(() => devicePixelRatio);
    const snapshot = await ServerBrowserPage.snapshot({
      page: root.page,
      cdp: root.cdp,
      renderScale,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
      includeImage: true,
      timeoutMs: 5000,
    });
    NodeAssert.ok(
      snapshot.screenshot &&
        !nativeImage.createFromBuffer(Buffer.from(snapshot.screenshot.data, "base64")).isEmpty(),
    );
    NodeAssert.ok(snapshot.accessibilityTree.includes("xy"));
    const streamedFrame = Promise.withResolvers();
    const onFrame = (frame) => {
      void root.cdp
        .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
        .then(() => streamedFrame.resolve(frame), streamedFrame.reject);
    };
    root.cdp.on("Page.screencastFrame", onFrame);
    const streamTimer = setTimeout(
      () => streamedFrame.reject(new Error("Independent hidden root did not stream.")),
      5000,
    );
    try {
      await root.cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
      const frame = await streamedFrame.promise;
      NodeAssert.ok(!nativeImage.createFromBuffer(Buffer.from(frame.data, "base64")).isEmpty());
    } finally {
      clearTimeout(streamTimer);
      root.cdp.off("Page.screencastFrame", onFrame);
      await root.cdp.send("Page.stopScreencast");
    }
    assertHost(await hostState());
    NodeAssert.equal(
      root.page.url(),
      `${fixtureOrigin}/${root.id}`,
      "capture and stream keep the controlled page",
    );
    NodeAssert.equal(
      (await root.window.webContents.debugger.sendCommand("Target.getTargetInfo")).targetInfo
        .targetId,
      root.targetId,
      "capture and stream retain the native control target",
    );
    completed = true;
    return "independent hidden roots: concurrent trusted keyboard input, same-session authentication/cookies, immutable capture and stream, uninterrupted host focus/selection";
  } finally {
    const closeResults = [];
    for (const browser of browsers) await browser.close().catch(() => undefined);
    for (const socket of sockets.values()) socket.terminate();
    relayServer.close();
    for (const root of roots.values()) {
      let stage = "release surface";
      const restoration = {
        initial: root.initialThrottling,
        beforeRelease: null,
        afterRelease: null,
      };
      try {
        restoration.beforeRelease = root.window.webContents.getBackgroundThrottling();
        await acknowledge({
          type: "surface",
          ...rootKey(root.id),
          requestId: `release:${root.id}`,
          leaseId: `keyboard:${root.id}`,
          action: "release",
        });
        restoration.afterRelease = root.window.webContents.getBackgroundThrottling();
        NodeAssert.equal(
          restoration.afterRelease,
          true,
          `${root.id} restores background throttling`,
        );
        stage = "close root";
        const closed = Promise.withResolvers();
        requests.set(`close:${root.rootId}`, closed);
        const timer = setTimeout(
          () => closed.reject(new Error("Native root close did not acknowledge.")),
          5000,
        );
        try {
          await send({
            type: "closeRoot",
            ...rootKey(root.id),
            rootId: root.rootId,
            requestId: `close:${root.id}`,
          });
          await closed.promise;
          NodeAssert.equal(
            root.window.isDestroyed(),
            true,
            `${root.id} is destroyed before rootClosed acknowledges`,
          );
          assertHost(await hostState());
        } finally {
          clearTimeout(timer);
          requests.delete(`close:${root.rootId}`);
        }
        closeResults.push({ root: root.id, passed: true, restoration });
      } catch (cause) {
        closeResults.push({
          root: root.id,
          passed: false,
          stage,
          restoration,
          error: String(cause),
          stack: cause.stack,
        });
      }
    }
    await Effect.runPromise(Fiber.interrupt(events));
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    const hostStateAfterClose = await hostWindow.webContents.executeJavaScript(
      "surfaceSmokeStopWatchingHostOwnership()",
    );
    const closedAll = closeResults.every((result) => result.passed);
    await NodeFSP.writeFile(
      NodePath.join(scratch, "keyboard-root-result.json"),
      JSON.stringify(
        {
          passed: completed && closedAll,
          attempts,
          commands,
          profileOwnership,
          closeResults,
          host: hostStateAfterClose,
          nativeWindowEvents,
          scope:
            "production BrowserRootWindow, DesktopBrowserHost creation/leases/CDP/close, BrowserSession and ServerBrowserPage; fixture bridge bypasses DesktopBrowserChannel and manager publication; no active human OS-key proof",
        },
        null,
        2,
      ),
    );
    NodeAssert.ok(closedAll, JSON.stringify(closeResults));
  }
}
