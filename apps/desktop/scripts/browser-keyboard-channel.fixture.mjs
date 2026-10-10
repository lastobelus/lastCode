// Exercise the production broker, server, channel and native root together.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as BrowserRootWindow from "../src/preview/BrowserRootWindow.ts";
import { resolvePartitionScope } from "../src/preview/BrowserProfileScope.ts";
import * as ServerConfig from "../../server/src/config.ts";
import * as ServerEnvironment from "../../server/src/environment/ServerEnvironment.ts";
import * as Broker from "../../server/src/mcp/PreviewAutomationBroker.ts";
import * as Channel from "../../server/src/preview/DesktopBrowserChannel.ts";
import * as Manager from "../../server/src/preview/Manager.ts";
import * as PreviewBrowser from "../../server/src/preview/PreviewBrowser.ts";
import * as ServerBrowser from "../../server/src/preview/ServerBrowser.ts";

export async function runNativeKeyboardChannelFixture({
  scratch,
  fixtureOrigin,
  hostWindow,
  host,
  browserSessions,
  environmentId,
}) {
  const desktopHostId = "keyboard-channel-host";
  const owner = "keyboard-channel-owner";
  const roots = [];
  const commands = [];
  const steps = [];
  const scope = {
    environmentId: EnvironmentId.make(environmentId),
    thread: {
      threadId: ThreadId.make("keyboard-channel-thread"),
      providerSessionId: "keyboard-channel-agent",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    requestNamespace: "keyboard-channel-fixture",
    capabilities: new Set(["preview"]),
    issuedAt: 1,
  };
  const hostState = () => hostWindow.webContents.executeJavaScript("surfaceSmokeKeyboardState()");
  const initialWindow = { visible: hostWindow.isVisible(), focused: hostWindow.isFocused() };
  const expectedHost = await hostWindow.webContents.executeJavaScript(
    "surfaceSmokeWatchHostOwnership()",
  );
  const assertHost = async () => {
    const state = await hostState();
    NodeAssert.equal(state.activeElement, "host-sentinel");
    for (const field of ["value", "selectionStart", "selectionEnd", "selectionDirection"])
      NodeAssert.equal(state[field], expectedHost[field], `host retains ${field}`);
    NodeAssert.deepEqual(state.events, [], "host receives no keyboard events");
    for (const event of state.ownershipEvents) {
      NodeAssert.equal(event.type, "selectionchange", "host focus does not change");
      NodeAssert.equal(event.activeElement, "host-sentinel");
      for (const field of ["value", "selectionStart", "selectionEnd", "selectionDirection"])
        NodeAssert.equal(event[field], expectedHost[field]);
    }
    NodeAssert.equal(hostWindow.isVisible(), initialWindow.visible);
    NodeAssert.equal(hostWindow.isFocused(), initialWindow.focused);
    return state;
  };
  await Effect.runPromise(
    host.bindEnvironment(desktopHostId, environmentId, (profileId) =>
      Effect.succeed(resolvePartitionScope(environmentId, profileId, environmentId)),
    ),
  );
  host.setRootFactory((input) =>
    BrowserRootWindow.create(browserSessions, input, input.partition).pipe(
      Effect.tap((window) => Effect.sync(() => roots.push(window))),
    ),
  );

  let completed = false;
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const configContext = yield* Layer.build(
            ServerConfig.layerTest(process.cwd(), NodePath.join(scratch, "keyboard-channel-state")),
          );
          const configLayer = Layer.succeed(
            ServerConfig.ServerConfig,
            Context.get(configContext, ServerConfig.ServerConfig),
          );
          const channelContext = yield* Layer.build(Channel.layer.pipe(Layer.provide(configLayer)));
          const channel = Context.get(channelContext, Channel.DesktopBrowserChannel);
          // Only replace the renderer IPC delivery: the channel's CDP WebSocket
          // endpoint, request acknowledgments and native debugger relay stay real.
          yield* host.remoteEvents.pipe(
            Stream.runForEach(({ desktopHostId: sender, event }) =>
              sender === desktopHostId
                ? channel.receiveEvent(owner, desktopHostId, event)
                : Effect.void,
            ),
            Effect.forkScoped,
          );
          yield* Effect.yieldNow;
          const announced = yield* Deferred.make();
          yield* channel.subscribeCommands(owner, desktopHostId).pipe(
            Stream.runForEach((command) => {
              commands.push(
                command.type === "cdp" ? JSON.parse(command.message).method : command.type,
              );
              if (command.type === "resolveUrl")
                return channel.receiveEvent(owner, desktopHostId, {
                  type: "resolvedUrl",
                  requestId: command.requestId,
                  url: command.url,
                });
              return host
                .handleRemoteCommand({ desktopHostId, command })
                .pipe(
                  Effect.andThen(
                    command.type === "announce"
                      ? Deferred.succeed(announced, undefined)
                      : Effect.void,
                  ),
                );
            }),
            Effect.forkScoped,
          );
          yield* Deferred.await(announced);
          const dependencies = Layer.mergeAll(
            Broker.layer,
            Manager.layer.pipe(Layer.provide(configLayer)),
            configLayer,
            Layer.succeed(Channel.DesktopBrowserChannel, channel),
            Layer.succeed(ServerEnvironment.ServerEnvironment, {
              getEnvironmentId: Effect.succeed(scope.environmentId),
              getDescriptor: Effect.die(
                "Native keyboard fixture does not need an environment descriptor",
              ),
            }),
            Layer.succeed(PreviewBrowser.PreviewBrowser, {
              executable: Effect.die("Native keyboard fixture must not launch headless Chromium"),
              installed: Effect.die("Native keyboard fixture must not inspect installed Chromium"),
            }),
          );
          const services = yield* Layer.build(
            ServerBrowser.layer.pipe(Layer.provideMerge(dependencies)),
          );
          const broker = Context.get(services, Broker.PreviewAutomationBroker);
          const manager = Context.get(services, Manager.PreviewManager);
          yield* Effect.yieldNow;
          const opened = yield* broker.invoke({
            scope,
            operation: "open",
            input: {
              url: `${fixtureOrigin}/keyboard-channel`,
              reuseExistingTab: false,
              show: false,
            },
            timeoutMs: 15_000,
          });
          NodeAssert.ok(opened.tabId, "broker returns the native automation tab");
          const tabId = opened.tabId;
          const sessions = yield* manager.list({ threadId: scope.thread.threadId });
          NodeAssert.equal(
            sessions.sessions.find((tab) => tab.tabId === tabId)?.backingPage,
            "desktop-root",
          );
          NodeAssert.equal(roots.length, 1);
          NodeAssert.equal(roots[0].webContents.hostWebContents, null);
          NodeAssert.equal(roots[0].isVisible(), false);
          NodeAssert.equal(roots[0].isFocusable(), false);
          const invoke = (operation, input) =>
            broker.invoke({ scope, tabId, operation, input, timeoutMs: 10_000 });
          yield* invoke("type", { selector: "#draft", text: "channel keyboard α", clear: true });
          steps.push({ operation: "type", host: yield* Effect.promise(assertHost) });
          yield* invoke("press", { key: "q" });
          steps.push({ operation: "press", host: yield* Effect.promise(assertHost) });
          const actual = yield* invoke("evaluate", {
            expression: "document.querySelector('#draft').value",
          });
          NodeAssert.equal(actual, "channel keyboard αq");
          const keyboardEvents = yield* invoke("evaluate", { expression: "window.keyboardEvents" });
          NodeAssert.ok(keyboardEvents.some((event) => event.type === "input"));
          NodeAssert.ok(
            keyboardEvents.some((event) => event.type === "keydown" && event.key === "q"),
          );
          NodeAssert.ok(
            keyboardEvents.every((event) => event.trusted && event.target === "draft"),
            "the native target receives trusted keyboard events",
          );
          NodeAssert.ok(commands.includes("Input.insertText"));
          NodeAssert.ok(commands.includes("Input.dispatchKeyEvent"));
          const navigations = [];
          roots[0].webContents.on("did-start-navigation", (_event, url) => navigations.push(url));
          for (const url of ["", "about:blank"]) {
            const popup = yield* invoke("evaluate", {
              expression: `window.open(${JSON.stringify(url)}, 'auth', 'width=500,height=600') === null`,
            });
            NodeAssert.equal(popup, true, "blank popup is denied");
            NodeAssert.equal(roots[0].webContents.getURL(), `${fixtureOrigin}/keyboard-channel`);
            NodeAssert.equal(
              yield* invoke("evaluate", { expression: "document.querySelector('#draft').value" }),
              "channel keyboard αq",
              "denying a blank popup preserves its opener document",
            );
          }
          NodeAssert.deepEqual(navigations, [], "blank popup requests never navigate the opener");
          steps.push({ operation: "blank popups", host: yield* Effect.promise(assertHost) });
          yield* invoke("close", {});
          NodeAssert.equal(
            roots[0].isDestroyed(),
            true,
            "production close destroys the native root",
          );
          NodeAssert.equal(
            yield* channel.isAttached({ threadId: scope.thread.threadId, tabId, desktopHostId }),
            false,
          );
          steps.push({ operation: "close", host: yield* Effect.promise(assertHost) });
          completed = true;
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
    return "production broker → server → channel CDP endpoint → independent native root: trusted typing, key press, preserved blank-popup opener, unchanged host ownership and confirmed close";
  } finally {
    await Effect.runPromise(
      host.handleRemoteCommand({ desktopHostId, command: { type: "disconnect" } }),
    );
    for (const window of roots) if (!window.isDestroyed()) window.destroy();
    await hostWindow.webContents.executeJavaScript("surfaceSmokeStopWatchingHostOwnership()");
    await NodeFSP.writeFile(
      NodePath.join(scratch, "keyboard-channel-result.json"),
      JSON.stringify({ passed: completed, initialWindow, steps, commands }, null, 2),
    );
  }
}
