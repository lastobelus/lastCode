import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  SERVER_BROWSER_AUTOMATION_CLIENT_ID,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";
import { chromium } from "playwright-core";
import { vi } from "vite-plus/test";
import * as ServerConfig from "../config.ts";
import * as Hosting from "../preview/Hosting.ts";
import * as PublishedDocumentPreview from "../preview/PublishedDocumentPreview.ts";
import * as ServerBrowserPage from "../preview/ServerBrowserPage.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";
import * as Broker from "./PreviewAutomationBroker.ts";

const environmentId = EnvironmentId.make("click-timeout-test");
const invocation = {
  environmentId,
  requestNamespace: "click-timeout-test",
  thread: {
    threadId: ThreadId.make("click-timeout-test"),
    providerSessionId: "click-timeout-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "test", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const layer = McpHttpServer.layerPreviewToolkit.pipe(
  Layer.provide(Layer.mock(Hosting.PreviewHosting)({})),
  Layer.provide(Layer.mock(PublishedDocumentPreview.PublishedDocumentPreview)({})),
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
  Layer.provideMerge(Broker.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "click-timeout-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

it.live.each([
  { name: "absent subcap", html: "", selector: "#submit", timeoutMs: 100, budget: 100, entries: 0 },
  {
    name: "disabled postentry",
    html: '<button id="submit" disabled>Submit</button>',
    selector: "#submit",
    timeoutMs: 300,
    budget: 300,
    entries: 1,
  },
  {
    name: "obscured postentry",
    html: '<button id="submit">Submit</button><div style="position:fixed;inset:0"></div>',
    selector: "#submit",
    timeoutMs: 300,
    budget: 300,
    entries: 1,
  },
  {
    name: "applied stalled navigation",
    html: '<button id="submit" onclick="location.href=\'http://click.test/submit\'">Submit</button>',
    selector: "#submit",
    timeoutMs: 300,
    budget: 300,
    entries: 1,
    mutations: 1,
  },
])("preserves $name through the MCP boundary", (fixture) =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Effect.acquireRelease(
        Effect.promise(() => chromium.launch({ headless: true })),
        (browser) => Effect.promise(() => browser.close()),
      );
      const page = yield* Effect.promise(() => browser.newPage());
      let clicks = 0;
      let mutations = 0;
      const applied = Promise.withResolvers<void>();
      yield* Effect.promise(() =>
        page.exposeFunction("recordClick", () => {
          clicks++;
        }),
      );
      yield* Effect.promise(() =>
        page.exposeFunction("recordMutation", () => {
          mutations++;
          applied.resolve();
        }),
      );
      yield* Effect.promise(() =>
        page.setContent(
          `<body data-clicks="0" data-mutations="0" onclick="window.recordClick();this.dataset.mutations=Number(this.dataset.mutations)+1">${fixture.html}<script>new MutationObserver(() => window.recordMutation()).observe(document.body, { attributes: true, attributeFilter: ["data-mutations"] });</script></body>`,
        ),
      );
      // Freeze only our budget accounting; Chromium still performs real timed operations.
      using _now = vi.spyOn(Date, "now").mockReturnValue(0);
      yield* Effect.promise(() => page.route("http://click.test/submit", () => {}));
      let entries = 0;
      const pendingLayout: Promise<unknown>[] = [];
      const locate = page.locator.bind(page);
      using _locator = vi.spyOn(page, "locator").mockImplementation((selector, options) => {
        const locator = locate(selector, options);
        const click = locator.click.bind(locator);
        vi.spyOn(locator, "click").mockImplementation((options) => {
          entries++;
          return click(options);
        });
        const scroll = locator.scrollIntoViewIfNeeded.bind(locator);
        vi.spyOn(locator, "scrollIntoViewIfNeeded").mockImplementation((options) => {
          const pending = scroll(options);
          pendingLayout.push(pending.catch(() => undefined));
          return pending;
        });
        return locator;
      });
      const broker = yield* Broker.PreviewAutomationBroker;
      const connected = yield* Deferred.make<void>();
      let remote: ServerBrowserPage.ServerBrowserOperationError | undefined;
      const events = yield* broker.connect({
        clientId: SERVER_BROWSER_AUTOMATION_CLIENT_ID,
        environmentId,
      });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Deferred.succeed(connected, undefined);
        return Effect.promise(async () => {
          try {
            return {
              ok: true as const,
              result: await ServerBrowserPage.click(page, {
                selector: fixture.selector,
                timeoutMs: fixture.timeoutMs,
              }),
            };
          } catch (cause) {
            remote = ServerBrowserPage.toOperationError(cause, fixture.timeoutMs);
            return {
              ok: false as const,
              error: { _tag: remote.tag, message: remote.message, detail: remote.detail },
            };
          }
        }).pipe(
          Effect.flatMap((response) =>
            broker.respond({
              clientId: SERVER_BROWSER_AUTOMATION_CLIENT_ID,
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ...response,
            }),
          ),
        );
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(connected);
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({
          name: "preview_act",
          arguments: {
            action: "click",
            selector: fixture.selector,
            timeoutMs: fixture.timeoutMs,
          },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      // A rejected budget cannot resume into click when Playwright's uncancelled layout settles.
      yield* Effect.promise(() => Promise.all(pendingLayout));
      expect(entries).toBe(fixture.entries);
      if (fixture.mutations) yield* Effect.promise(() => applied.promise);
      expect(clicks).toBe(fixture.mutations ?? 0);
      expect(mutations).toBe(fixture.mutations ?? 0);
      expect(result.isError).toBe(true);
      const text = result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      if (fixture.entries === 0) {
        expect(remote?.detail).toMatchObject({ stage: "target layout", timeoutMs: fixture.budget });
        expect(text).toContain(`timed out after ${fixture.budget}ms`);
        expect(text).toContain("Click not attempted");
        expect(text).toContain("target layout");
        expect(text).toContain("10000ms");
        expect(text).toContain("snapshot");
        expect(text).not.toContain("may have happened");
      } else {
        expect(text).toContain("The click may have happened");
        expect(text).not.toContain("Click not attempted");
      }
    }),
  ).pipe(Effect.provide(layer)),
);
