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
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { chromium } from "playwright-core";
import { afterEach, beforeEach, expect, vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as DesktopChannel from "./DesktopBrowserChannel.ts";
import * as Hosting from "./Hosting.ts";
import * as Manager from "./Manager.ts";
import * as PreviewAgentActivity from "./PreviewAgentActivity.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";
import * as ServerBrowser from "./ServerBrowser.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

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
let hostingPreparation: Hosting.PreviewHosting["Service"]["prepareNavigation"] = () =>
  Effect.succeed({ managed: false });
beforeEach(() => {
  hostingPreparation = () => Effect.succeed({ managed: false });
  // Match the other real-Chromium fixtures: Playwright's test binary and
  // default test sandbox policy. Production sandbox requirements are unchanged.
  vi.spyOn(chromium, "launch").mockImplementation((options) => {
    const launchOptions = { ...options, chromiumSandbox: false };
    const testExecutable = process.env.T3CODE_TEST_BROWSER_EXECUTABLE;
    if (testExecutable) launchOptions.executablePath = testExecutable;
    else delete launchOptions.executablePath;
    return launch(launchOptions);
  });
});
afterEach(() => vi.restoreAllMocks());
const dependencies = Layer.mergeAll(
  Broker.layer,
  PreviewAgentActivity.layer,
  Manager.layer,
  Layer.mock(ServerSecretStore.ServerSecretStore)({
    getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(7)),
  }),
  desktop,
  Layer.mock(Hosting.PreviewHosting)({
    setActivity: () => Effect.void,
    list: () => Effect.succeed([]),
    prepareNavigation: (input) => Effect.suspend(() => hostingPreparation(input)),
  }),
  Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(scope.environmentId),
    getDescriptor: Effect.die("Unused descriptor"),
  }),
  Layer.succeed(PreviewBrowser.PreviewBrowser, {
    executable: Effect.succeed(executable),
    installed: Effect.succeedSome(executable),
  }),
).pipe(Layer.provideMerge(platform));
const layer = ServerBrowser.layer.pipe(Layer.provideMerge(dependencies));

it.live(
  "a returned app with a fragment reloads the document after a different observer restarts it",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let run = "first";
        let requests = 0;
        const server = yield* Effect.acquireRelease(
          Effect.promise(async () => {
            const server = NodeHttp.createServer((_request, response) => {
              requests += 1;
              response.setHeader("Content-Type", "text/html");
              response.setHeader("Cache-Control", "no-store");
              response.end(`<!doctype html><title>${run}</title><input id="note" value="${run}">`);
            });
            await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
            return server;
          }),
          (server) =>
            Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
        );
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("Missing test port");
        const url = `http://127.0.0.1:${address.port}/return?mode=fixture#preview`;
        hostingPreparation = () => Effect.succeed({ managed: true, runId: run });
        const browser = yield* ServerBrowser.ServerBrowser;
        const broker = yield* Broker.PreviewAutomationBroker;
        yield* Effect.yieldNow;
        const opened = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { browserHost: "environment", url, open: false },
        });
        const tabId = PreviewTabId.make(opened.tabId!);
        const attach = Effect.scoped(
          browser.attachViewer({
            threadId: scope.thread.threadId,
            tabId,
            canOperate: false,
            maxWidth: 800,
            maxHeight: 600,
            quality: 70,
          }),
        );
        yield* broker.invoke({
          scope,
          tabId,
          operation: "evaluate",
          input: { expression: 'document.querySelector("#note").value = "retained"' },
        });
        const before = requests;
        yield* attach;
        expect(requests).toBe(before);
        run = "second";
        yield* attach;
        const rendered = yield* broker.invoke({
          scope,
          tabId,
          operation: "evaluate",
          input: {
            expression: '({title:document.title,value:document.querySelector("#note").value})',
          },
        });
        expect(rendered).toEqual({ title: "second", value: "second" });
        expect(requests).toBe(before + 1);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("an environment page renders loopback, accepts input, and resumes after idle release", () =>
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
      yield* Effect.scoped(
        Effect.gen(function* () {
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
      );
      const manager = yield* Manager.PreviewManager;
      const saved = (yield* manager.list({ threadId: scope.thread.threadId })).sessions[0]!;
      expect(saved.navStatus).toMatchObject({ _tag: "Success", url });
      const initial = yield* Clock.currentTimeMillis;
      const clock = vi.spyOn(Date, "now").mockReturnValue(initial + 23 * 60 * 60_000);
      yield* Effect.addFinalizer(() => Effect.sync(() => clock.mockRestore()));
      yield* broker.invoke({
        scope: { ...scope, thread: { ...scope.thread, providerSessionId: "warm-sweep-agent" } },
        operation: "open",
        input: { browserHost: "environment", open: false, reuseExistingTab: false },
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* browser.attachViewer({
            threadId: scope.thread.threadId,
            tabId,
            canOperate: true,
            maxWidth: 800,
            maxHeight: 600,
            quality: 70,
          });
          const retainedInput = yield* broker.invoke({
            scope,
            tabId,
            operation: "evaluate",
            input: { expression: 'document.querySelector("#note").value' },
          });
          expect(retainedInput).toBe("viewer input");
        }),
      );
      clock.mockReturnValue(initial + 49 * 60 * 60_000);
      yield* broker.invoke({
        scope: { ...scope, thread: { ...scope.thread, providerSessionId: "sweep-agent" } },
        operation: "open",
        input: { browserHost: "environment", open: false, reuseExistingTab: false },
      });
      expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toContainEqual(
        saved,
      );
      expect(
        yield* broker.invoke<PreviewAutomationStatus>({ scope, operation: "status", input: {} }),
      ).toMatchObject({ available: false, tabId, url, browserHost: "environment" });
      const resumedViewer = yield* browser.attachViewer({
        threadId: scope.thread.threadId,
        tabId,
        canOperate: true,
        maxWidth: 800,
        maxHeight: 600,
        quality: 70,
      });
      const resumedFrame = yield* Queue.take(resumedViewer.output).pipe(
        Effect.repeat({ until: (output) => output._tag === "frame" }),
      );
      if (resumedFrame._tag !== "frame") throw new Error("Missing resumed frame");
      expect(resumedFrame.data.byteLength).toBeGreaterThan(100);
      yield* resumedFrame.ack;
      const resumedSnapshot = yield* broker.invoke<PreviewAutomationSnapshot>({
        scope,
        operation: "snapshot",
        input: { includeImage: true },
      });
      expect(resumedSnapshot.url).toBe(url);
      expect(resumedSnapshot.visibleText).toContain("environment-browser-ready");
      expect(resumedSnapshot.screenshot?.data).toBeTruthy();
    }),
  ).pipe(Effect.provide(layer)),
);
