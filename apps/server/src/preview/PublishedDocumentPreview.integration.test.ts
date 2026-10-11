// @effect-diagnostics globalProcess:off -- Optional fixture browser executable, never an installed app.
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpRouter, HttpServer } from "effect/http";
import { chromium } from "playwright-core";
import { afterEach, beforeEach, vi } from "vite-plus/test";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";

import * as NativeAppIconResolver from "../assets/NativeAppIconResolver.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerHttp from "../http.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as McpToolAccessTestkit from "../mcp/McpToolAccess.testkit.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ThreadLinkedFiles from "../workspace/ThreadLinkedFiles.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as DesktopChannel from "./DesktopBrowserChannel.ts";
import * as Hosting from "./Hosting.ts";
import * as Manager from "./Manager.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";
import * as PublishedDocumentPreview from "./PublishedDocumentPreview.ts";
import * as ServerBrowser from "./ServerBrowser.ts";

const environmentId = EnvironmentId.make("published-document-environment");
const owner = ThreadId.make("document-owner");
const other = ThreadId.make("other-document-thread");
const projectId = ProjectId.make("document-project");
const scope = (threadId: ThreadId): McpInvocationContext.McpThreadInvocationScope => ({
  environmentId,
  thread: {
    threadId,
    providerSessionId: `session-${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  requestNamespace: `thread:${threadId}`,
  capabilities: new Set(["preview"]),
  issuedAt: 1,
});
const launch = chromium.launch.bind(chromium);
beforeEach(() => {
  vi.spyOn(chromium, "launch").mockImplementation((options) => {
    const launchOptions = { ...options };
    if (process.env.T3CODE_TEST_BROWSER_EXECUTABLE) {
      launchOptions.executablePath = process.env.T3CODE_TEST_BROWSER_EXECUTABLE;
    } else {
      delete launchOptions.executablePath;
    }
    return launch(launchOptions);
  });
});
afterEach(() => vi.restoreAllMocks());

const RpcResponse = Schema.Struct({
  result: Schema.Struct({
    isError: Schema.optional(Schema.Boolean),
    structuredContent: Schema.optional(Schema.Unknown),
    content: Schema.Array(
      Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
    ),
  }),
});
const decodeStatus = Schema.decodeUnknownEffect(PreviewAutomationStatus);
const decodeRpc = Schema.decodeUnknownEffect(Schema.fromJsonString(RpcResponse));

it.live("MCP opens only its own current publication through signed HTTP in real Chromium", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-published-document-" });
    const now = yield* DateTime.now;
    const publishedPath = path.join(root, "report.html");
    yield* fs.writeFileString(
      publishedPath,
      '<!doctype html><title>Published report</title><h1>published-document-ready</h1><script>document.body.dataset.scriptRan="yes"</script>',
    );
    yield* fs.writeFileString(path.join(root, "unpublished.html"), "<h1>Unpublished</h1>");
    yield* fs.writeFileString(path.join(root, "other.html"), "<h1>Other thread</h1>");
    yield* fs.writeFileString(path.join(root, "sibling.html"), "<h1>Unpublished sibling</h1>");
    const project = {
      projectId,
      title: "Published documents",
      workspaceRoot: root,
      defaultModelSelection: null,
      defaultThreadEnvMode: null,
      autoPull: false,
      faviconPath: null,
      projectIcon: null,
      scripts: [],
      createdAt: DateTime.formatIso(now),
      updatedAt: DateTime.formatIso(now),
      deletedAt: null,
    } satisfies ProjectStore.ProjectRow;
    const entries = WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer));
    const workspace = Layer.mergeAll(
      WorkspacePaths.layer,
      entries,
      WorkspaceFileSystem.layer.pipe(Layer.provide(WorkspacePaths.layer), Layer.provide(entries)),
    );
    const documents = ThreadLinkedFiles.layer.pipe(Layer.provideMerge(workspace));
    const services = Layer.mergeAll(
      Broker.layer,
      Manager.layer,
      DesktopChannel.layer,
      ProjectionStore.layerMemory,
      McpToolAccessTestkit.liveThreadsLayer,
      Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeed(Option.some(project)) }),
      Layer.mock(Hosting.PreviewHosting)({
        prepareNavigation: () => Effect.succeed({ managed: false }),
      }),
      Layer.mock(Orchestrator.OrchestratorV2)({}),
      Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({}),
      Layer.mock(NativeAppIconResolver.NativeAppIconResolver)({}),
      Layer.mock(GitHubCredentials.GitHubCredentials)({}),
      ServerSecretStore.layer,
      Layer.succeed(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(environmentId),
        getDescriptor: Effect.die("Unused descriptor"),
      }),
      Layer.succeed(PreviewBrowser.PreviewBrowser, {
        executable: Effect.succeed(
          process.env.T3CODE_TEST_BROWSER_EXECUTABLE ?? chromium.executablePath(),
        ),
        installed: Effect.succeed(Option.some(chromium.executablePath())),
      }),
      Layer.mock(McpSessionRegistry.McpSessionRegistry)({
        resolve: (token) =>
          Effect.succeed(
            token === "owner" ? scope(owner) : token === "other" ? scope(other) : undefined,
          ),
      }),
    );
    const application = Layer.mergeAll(PublishedDocumentPreview.layer, ServerBrowser.layer).pipe(
      Layer.provideMerge(documents.pipe(Layer.provideMerge(services))),
    );
    const context = yield* Layer.build(application);
    yield* Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      for (const threadId of [owner, other]) {
        yield* projections.apply({
          id: EventId.make(`created-${threadId}`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId,
            title: threadId,
            providerInstanceId: ProviderInstanceId.make("codex"),
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "example-model",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: root,
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });
      }
      const publish = (threadId: ThreadId, text: string) =>
        projections.apply({
          id: EventId.make(`publication-${threadId}-${text.length}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`publication-${threadId}`),
            threadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "assistant_message",
            messageId: MessageId.make(`message-${threadId}`),
            text,
            streaming: false,
          },
        });
      yield* publish(owner, `[Report](${publishedPath})`);
      yield* publish(other, "[Other report](./other.html)");
      const routes = Layer.mergeAll(
        McpHttpServer.layerPreviewToolkit.pipe(Layer.provideMerge(McpHttpServer.layerMcpTransport)),
        ServerHttp.layerAssetRoute,
      );
      yield* HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const http = yield* HttpClient.HttpClient;
      const call = Effect.fnUntraced(function* (token: string, args: unknown) {
        const headers = {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        };
        const initialized = yield* http.post("/mcp", {
          headers,
          body: HttpBody.text(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "document-fixture", version: "1" },
              },
            }),
            "application/json",
          ),
        });
        expect({ status: initialized.status, body: yield* initialized.text }).toMatchObject({
          status: 200,
        });
        const response = yield* http.post("/mcp", {
          headers: {
            ...headers,
            "mcp-session-id": initialized.headers["mcp-session-id"]!,
            "mcp-protocol-version": "2025-06-18",
          },
          body: HttpBody.text(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: { name: "preview_open", arguments: args },
            }),
            "application/json",
          ),
        });
        expect(response.status).toBe(200);
        return yield* response.text.pipe(Effect.flatMap(decodeRpc));
      });
      const request = (filePath: string) => ({
        target: { kind: "published-document", path: filePath },
        open: false,
        reuseExistingTab: false,
      });
      const opened = yield* call("owner", request(publishedPath));
      expect(opened.result.isError).not.toBe(true);
      const status = yield* decodeStatus(opened.result.structuredContent);
      expect(status).toMatchObject({
        browserHost: "environment",
        profileId: "incognito",
        title: "Published report",
        nativePresented: false,
      });
      expect(status.url).toContain("/api/assets/");
      const address = (yield* HttpServer.HttpServer).address;
      if (address._tag === "UnixPathAddress") throw new Error("Expected a bound test TCP port");
      expect(address.port).toBeGreaterThan(0);
      expect(new URL(status.url!).port).toBe(String(address.port));
      const response = yield* http.get(new URL(status.url!).pathname);
      expect(response.status).toBe(200);
      expect(response.headers["content-security-policy"]).toContain("sandbox allow-scripts");
      expect(response.headers["content-security-policy"]).not.toContain("allow-same-origin");
      const broker = yield* Broker.PreviewAutomationBroker;
      const rendered = yield* broker.invoke({
        scope: scope(owner),
        tabId: status.tabId!,
        operation: "evaluate",
        input: {
          expression:
            '({text: document.body.innerText, origin: self.origin, scriptRan: document.body.dataset.scriptRan, storageBlocked: (() => { try { localStorage.getItem("test"); return false; } catch { return true; } })()})',
        },
      });
      expect(rendered).toMatchObject({
        text: "published-document-ready",
        origin: "null",
        scriptRan: "yes",
        storageBlocked: true,
      });
      const sibling = new URL("sibling.html", status.url!);
      expect((yield* http.get(sibling.pathname)).status).toBe(404);
      for (const [token, filePath] of [
        ["owner", "unpublished.html"],
        ["owner", "other.html"],
        ["other", publishedPath],
      ]) {
        const denied = yield* call(token!, request(filePath!));
        expect(denied.result.isError).toBe(true);
        expect(denied.result.content.map((block) => block.text).join(" ")).toContain(
          "not published by an assistant in this thread",
        );
      }
      // A later invocation cannot retain publication authority after its text changes.
      yield* publish(owner, "The report is no longer published.");
      expect((yield* call("owner", request(publishedPath))).result.isError).toBe(true);
      const ownOtherDocument = yield* call("other", request("other.html"));
      expect(ownOtherDocument.result.isError).not.toBe(true);
      const manager = yield* Manager.PreviewManager;
      const tabs = yield* manager.list({ threadId: owner });
      expect(tabs.sessions).toHaveLength(1);
    }).pipe(Effect.provide(context));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeHttpServer.layerTest,
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-document-preview-config-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
        NodeServices.layer,
      ),
    ),
    Effect.scoped,
  ),
);
