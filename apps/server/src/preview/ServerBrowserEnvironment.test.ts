// @effect-diagnostics nodeBuiltinImport:off globalProcess:off -- Scoped loopback fixture and optional test browser executable.
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import { chromium } from "playwright-core";
import { afterEach, beforeEach, expect, vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as DesktopChannel from "./DesktopBrowserChannel.ts";
import * as Hosting from "./Hosting.ts";
import * as Manager from "./Manager.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";
import * as ServerBrowser from "./ServerBrowser.ts";

const scope = {
  environmentId: EnvironmentId.make("environment-browser-test"),
  thread: {
    threadId: ThreadId.make("environment-browser-thread"),
    providerSessionId: "agent-a",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  requestNamespace: "environment-browser-test",
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};

const platform = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-environment-browser-",
}).pipe(Layer.provideMerge(NodeServices.layer));
const desktop = Layer.effect(
  DesktopChannel.DesktopBrowserChannel,
  Effect.gen(function* () {
    const channel = yield* DesktopChannel.DesktopBrowserChannel;
    return {
      ...channel,
      available: true,
      // A connected desktop must not be consulted for this explicit server page.
      getProfiles: () => Effect.die("Unexpected desktop catalogue request"),
      resolveUrl: () => Effect.die("Unexpected desktop URL resolution"),
      createRoot: () => Effect.die("Unexpected native root creation"),
    };
  }),
).pipe(Layer.provide(DesktopChannel.layer.pipe(Layer.provide(platform))));
const executable = process.env.T3CODE_TEST_BROWSER_EXECUTABLE ?? chromium.executablePath();
const launch = chromium.launch.bind(chromium);
beforeEach(() => {
  // CI installs Playwright's headless shell. Keep production launch options,
  // but let Playwright locate that test binary when no executable was supplied.
  vi.spyOn(chromium, "launch").mockImplementation((options) => {
    const launchOptions = { ...options };
    const testExecutable = process.env.T3CODE_TEST_BROWSER_EXECUTABLE;
    if (testExecutable) launchOptions.executablePath = testExecutable;
    else delete launchOptions.executablePath;
    return launch(launchOptions);
  });
});
afterEach(() => vi.restoreAllMocks());
const dependencies = Layer.mergeAll(
  Broker.layer,
  Manager.layer,
  desktop,
  Layer.mock(Hosting.PreviewHosting)({
    prepareNavigation: () => Effect.succeed({ managed: false }),
  }),
  Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(scope.environmentId),
    getDescriptor: Effect.die("Unused descriptor"),
  }),
  Layer.succeed(PreviewBrowser.PreviewBrowser, {
    executable: Effect.succeed(executable),
    installed: Effect.succeed(Option.some(executable)),
  }),
).pipe(Layer.provideMerge(platform));
const layer = ServerBrowser.layer.pipe(Layer.provideMerge(dependencies));

it.live("an explicit environment page renders loopback and accepts streamed viewer input", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const server = NodeHttp.createServer((_request, response) => {
            response.setHeader("Content-Type", "text/html");
            response.end(
              '<!doctype html><title>Environment fixture</title><h1>environment-browser-ready</h1><label>Note <input id="note"></label>',
            );
          });
          await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
          return server;
        }),
        (server) =>
          Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
      );
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Missing test port");
      const url = `http://127.0.0.1:${address.port}/`;
      const browser = yield* ServerBrowser.ServerBrowser;
      const broker = yield* Broker.PreviewAutomationBroker;
      yield* Effect.yieldNow;
      const opened = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { browserHost: "environment", url, open: false, reuseExistingTab: false },
      });
      expect(opened).toMatchObject({
        browserHost: "environment",
        profileId: "incognito",
        url,
        nativePresented: false,
        control: { owner: "agent", ownedByCaller: true },
      });
      const tabId = PreviewTabId.make(opened.tabId!);
      const snapshot = yield* broker.invoke<PreviewAutomationSnapshot>({
        scope,
        tabId,
        operation: "snapshot",
        input: { includeImage: true },
      });
      expect(snapshot.visibleText).toContain("environment-browser-ready");
      expect(snapshot.screenshot?.data).toBeTruthy();
      const viewer = yield* browser.attachViewer({
        threadId: scope.thread.threadId,
        tabId,
        canOperate: true,
        maxWidth: 800,
        maxHeight: 600,
        quality: 70,
      });
      const frame = yield* Queue.take(viewer.output).pipe(
        Effect.repeat({ until: (output) => output._tag === "frame" }),
      );
      if (frame._tag !== "frame") throw new Error("Missing frame");
      expect(frame.data.byteLength).toBeGreaterThan(100);
      yield* frame.ack;
      yield* broker.invoke({ scope, tabId, operation: "click", input: { selector: "#note" } });
      yield* viewer.input({ type: "takeControl" });
      yield* viewer.input({ type: "text", text: "viewer input" });
      yield* viewer.input({ type: "releaseControl" });
      const value = yield* broker.invoke({
        scope,
        tabId,
        operation: "evaluate",
        input: { expression: 'document.querySelector("#note").value' },
      });
      expect(value).toBe("viewer input");
    }),
  ).pipe(Effect.provide(layer)),
);
