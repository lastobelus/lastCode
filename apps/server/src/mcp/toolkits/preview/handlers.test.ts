import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import {
  createPendingAttachmentId,
  parseThreadSegmentFromAttachmentId,
} from "../../../attachmentStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as PreviewHosting from "../../../preview/Hosting.ts";
import * as PublishedDocumentPreview from "../../../preview/PublishedDocumentPreview.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { toolkitRegistration } from "../../McpHttpServer.ts";
import { claimPreviewRecording, normalizePreviewOpenInput, layerStandard } from "./handlers.ts";
import { PreviewStandardToolkit } from "./tools.ts";

it.effect.each([
  { name: "preview_navigate", operation: "navigate", arguments: { url: "https://page.example/" } },
  { name: "preview_wait_for", operation: "waitFor", arguments: { text: "ready" } },
  { name: "preview_evaluate", operation: "evaluate", arguments: { expression: "1" } },
] as const)("%s retains safe native failure diagnostics through MCP registration", (tool) =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope: McpInvocationContext.McpThreadInvocationScope = {
        environmentId: EnvironmentId.make("diagnostic-environment"),
        thread: {
          threadId: ThreadId.make("diagnostic-thread"),
          providerSessionId: "diagnostic-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        requestNamespace: "diagnostic-session",
        capabilities: new Set(["preview"]),
        issuedAt: 0,
      };
      const client = McpSchema.McpServerClient.of({
        clientId: 1,
        protocolVersion: "2025-06-18",
        clientCapabilities: {},
        clientInfo: { name: "preview-diagnostic-test", version: "1" },
        initializePayload: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "preview-diagnostic-test", version: "1" },
        },
        getClient: Effect.die("unused"),
      });
      const broker = yield* PreviewAutomationBroker.make.pipe(Effect.provide(NodeServices.layer));
      const hostId = "https://workstation.example/private-host";
      const events = yield* broker.connect({
        clientId: hostId,
        environmentId: scope.environmentId,
      });
      const connected = yield* Deferred.make<void>();
      const requests: Array<{ operation: string; requestId: string; connectionId: string }> = [];
      let detail: unknown;
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Deferred.succeed(connected, undefined);
        requests.push({
          operation: event.request.operation,
          requestId: event.request.requestId,
          connectionId: event.connectionId,
        });
        return broker.respond({
          clientId: hostId,
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: false,
          error: {
            _tag: "PreviewAutomationRemoteUnavailableError",
            message: "Private remote message: https://page.example/?token=credential",
            ...(detail === undefined ? {} : { detail }),
          },
        });
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(connected);
      const dependencies = Layer.mergeAll(
        McpToolAccessTestkit.liveThreadsLayer,
        Layer.succeed(PreviewAutomationBroker.PreviewAutomationBroker, broker),
        Layer.mock(PreviewHosting.PreviewHosting)({}),
        Layer.mock(PublishedDocumentPreview.PublishedDocumentPreview)({}),
        ServerConfig.layerTest(process.cwd(), { prefix: "preview-diagnostic-test-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
        NodeServices.layer,
      );
      const registration = toolkitRegistration(PreviewStandardToolkit, layerStandard).pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(dependencies),
      );
      yield* Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const call = (caller = scope) =>
          server
            .callTool({ name: tool.name, arguments: tool.arguments })
            .pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, caller),
              Effect.provideService(McpSchema.McpServerClient, client),
            );
        for (const reason of [
          "guest-unavailable",
          "surface-unsupported",
          "layout-timeout",
          "host-unavailable",
          "https://workstation.example/unknown-reason",
          undefined,
        ]) {
          detail =
            reason === undefined
              ? undefined
              : {
                  reason,
                  url: "https://page.example/?token=credential",
                  profile: "private-profile",
                  frame: "private-frame",
                };
          const result = yield* call();
          expect(result.isError).toBe(true);
          expect(result.structuredContent).toBeUndefined();
          expect(result.content).toHaveLength(1);
          const content = result.content[0];
          expect(content?.type).toBe("text");
          if (content?.type !== "text") return;
          const request = requests.at(-1)!;
          expect(JSON.parse(content.text)).toEqual({
            _tag: "PreviewAutomationRemoteUnavailableError",
            message: `Preview automation ${tool.operation} is unavailable.`,
            ...request,
            ...(reason !== undefined && !reason.startsWith("https:") ? { reason } : {}),
          });
          expect(content.text).not.toMatch(/private|credential|https:|cause|stack/);
        }
        // The diagnostic mapping must not bypass or reclassify the access gate.
        const denied = yield* call({ ...scope, capabilities: new Set() });
        expect(denied.isError).toBe(true);
        expect(denied.content).toEqual([
          { type: "text", text: expect.stringContaining("capability") },
        ]);
        expect(requests).toHaveLength(6);
      }).pipe(Effect.provide(registration));
    }),
  ),
);

it.effect("preview_host returns structured startup diagnostics to its owning agent", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("preview-startup-thread");
    const dependencies = Layer.mergeAll(
      McpToolAccessTestkit.liveThreadsLayer,
      Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("preview-startup-environment"),
        thread: {
          threadId,
          providerSessionId: "preview-startup-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        requestNamespace: "thread:preview-startup-thread",
        capabilities: new Set(["preview"] as const),
        issuedAt: 0,
      }),
      Layer.mock(PreviewHosting.PreviewHosting)({
        launch: (input) => {
          expect(input.threadId).toBe(threadId);
          return Effect.fail(
            new PreviewHosting.PreviewHostingError({
              operation: "ready",
              statePath: "/isolated/preview-hosting.json",
              threadId,
              url: "http://localhost:5173/",
              detail: "Terminal: exited; running subprocess: no; exit code: 1.",
            }),
          );
        },
      }),
    );
    const toolkit = yield* PreviewStandardToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(layerStandard).pipe(Layer.provide(dependencies)),
      ),
    );
    const results = yield* toolkit
      .handle("preview_host", {
        command: "pnpm dev",
        cwd: "/workspace",
        url: "http://localhost:5173/",
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies), Effect.result);
    expect(results._tag).toBe("Failure");
    if (results._tag !== "Failure") return;
    expect(results.failure).toMatchObject({
      _tag: "PreviewHostingError",
      reason: "unavailable",
      message: expect.stringContaining("Terminal: exited"),
    });
    expect(results.failure).not.toHaveProperty("statePath");
  }),
);

it.effect.each([true, false])(
  "preview_stop_thread cleans up only its authenticated owner (thread caller: %s)",
  (threadCaller) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("preview-stop-thread");
      const stoppedThreads: Array<string> = [];
      const dependencies = Layer.mergeAll(
        McpToolAccessTestkit.liveThreadsLayer,
        Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("preview-stop-environment"),
          thread: threadCaller
            ? {
                threadId,
                providerSessionId: "preview-stop-session",
                providerInstanceId: ProviderInstanceId.make("codex"),
              }
            : undefined,
          client: threadCaller
            ? undefined
            : {
                sessionId: "external-session",
                label: "External client",
                access: "approval-required",
              },
          requestNamespace: threadCaller ? "thread:preview-stop-thread" : "client:external-session",
          capabilities: new Set(["preview"] as const),
          issuedAt: 0,
        }),
        Layer.mock(PreviewHosting.PreviewHosting)({
          stopThread: (ownerThreadId) =>
            Effect.sync(() => {
              stoppedThreads.push(ownerThreadId);
            }),
        }),
      );
      const toolkit = yield* PreviewStandardToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(layerStandard).pipe(Layer.provide(dependencies)),
        ),
      );
      const result = yield* toolkit
        .handle("preview_stop_thread", {})
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies), Effect.result);

      if (threadCaller) {
        expect(result._tag).toBe("Success");
        expect(stoppedThreads).toEqual([threadId]);
      } else {
        expect(result._tag).toBe("Failure");
        if (result._tag !== "Failure") return;
        expect(result.failure).toMatchObject({
          _tag: "OrchestratorMcpFailure",
          code: "thread_credential_required",
        });
        expect(stoppedThreads).toEqual([]);
      }
    }),
);

describe("normalizePreviewOpenInput", () => {
  it("leaves an unstated visibility for the client preference to decide", () => {
    // Filling `open` in here would outrank `browserAutoShowFloatingPreview`,
    // which is desktop-local and cannot be read from the server.
    expect(normalizePreviewOpenInput({})).toEqual({ reuseExistingTab: true });
  });

  it("preserves an explicit background-only opt-out", () => {
    expect(normalizePreviewOpenInput({ open: false })).toEqual({
      open: false,
      reuseExistingTab: true,
      show: false,
    });
  });

  it("supports show as a legacy alias while preferring open", () => {
    expect(normalizePreviewOpenInput({ show: false })).toEqual({
      open: false,
      reuseExistingTab: true,
      show: false,
    });
    expect(normalizePreviewOpenInput({ open: true, show: false })).toEqual({
      open: true,
      reuseExistingTab: true,
      show: true,
    });
  });
});

describe("claimPreviewRecording", () => {
  it.effect("overlapping and repeated claims return the same retained recording", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const uploadedAttachmentId = createPendingAttachmentId(".webm");
      const pendingPath = path.join(config.attachmentsDir, `${uploadedAttachmentId}.webm`);
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(pendingPath, "video!");
      const response = {
        id: "desktop-recording",
        tabId: "tab-1",
        path: "/desktop/recording.webm",
        mimeType: "video/webm",
        sizeBytes: 6,
        createdAt: "2026-09-07T00:00:00.000Z",
        uploadedAttachmentId,
      };
      const claim = claimPreviewRecording(ThreadId.make("thread-1"), response);
      const [first, second] = yield* Effect.all([claim, claim], { concurrency: "unbounded" });
      expect(first).toEqual(second);
      expect(yield* claim).toEqual(first);
      expect(yield* fileSystem.readFileString(first.path)).toBe("video!");
      expect(yield* fileSystem.exists(pendingPath)).toBe(false);
      const wrongThread = yield* claimPreviewRecording(ThreadId.make("thread-2"), response).pipe(
        Effect.result,
      );
      expect(wrongThread._tag).toBe("Failure");
      const wrongPath = yield* claimPreviewRecording(ThreadId.make("thread-1"), {
        ...response,
        uploadedAttachmentId: `../${uploadedAttachmentId}`,
      }).pipe(Effect.result);
      expect(wrongPath._tag).toBe("Failure");
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-recording-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect.each([6, 5])(
    "claims only a complete uploaded recording (reported bytes: %s)",
    (sizeBytes) =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const uploadedAttachmentId = createPendingAttachmentId(".webm");
        const pendingPath = path.join(config.attachmentsDir, `${uploadedAttachmentId}.webm`);
        yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
        yield* fileSystem.writeFileString(pendingPath, "video!");
        const response = {
          id: "desktop-recording",
          tabId: "tab-1",
          path: "/desktop/recording.webm",
          mimeType: "video/webm",
          sizeBytes,
          createdAt: "2026-09-07T00:00:00.000Z",
          uploadedAttachmentId,
        };
        const result = yield* claimPreviewRecording(ThreadId.make("thread-1"), response).pipe(
          Effect.result,
        );
        if (sizeBytes === 6) {
          expect(result._tag).toBe("Success");
          if (result._tag !== "Success") return;
          expect(result.success.path).not.toBe(response.path);
          expect(parseThreadSegmentFromAttachmentId(result.success.id)).toBe("thread-1");
          expect(yield* fileSystem.readFileString(result.success.path)).toBe("video!");
          expect(yield* fileSystem.exists(pendingPath)).toBe(false);
        } else {
          expect(result._tag).toBe("Failure");
          if (result._tag !== "Failure") return;
          expect(result.failure._tag).toBe("PreviewAutomationRecordingTransferError");
          expect(yield* fileSystem.exists(pendingPath)).toBe(true);
        }
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-recording-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect("reports an older desktop without returning its inaccessible path", () =>
    Effect.gen(function* () {
      const result = yield* claimPreviewRecording(ThreadId.make("thread-1"), {
        id: "desktop-recording",
        tabId: "tab-1",
        path: "/desktop/recording.webm",
        mimeType: "video/webm",
        sizeBytes: 6,
        createdAt: "2026-09-07T00:00:00.000Z",
      }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") return;
      expect(result.failure._tag).toBe("PreviewAutomationRecordingDesktopUpdateRequiredError");
      expect(result.failure.message).toContain("Update the desktop app");
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-recording-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
});
