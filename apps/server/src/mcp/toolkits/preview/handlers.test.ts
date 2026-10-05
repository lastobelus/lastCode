import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import {
  createPendingAttachmentId,
  parseThreadSegmentFromAttachmentId,
} from "../../../attachmentStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as PreviewHosting from "../../../preview/Hosting.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  claimPreviewRecording,
  normalizePreviewOpenInput,
  PreviewStandardToolkitHandlersLive,
} from "./handlers.ts";
import { PreviewStandardToolkit } from "./tools.ts";

it.effect("preview_host returns structured startup diagnostics to its owning agent", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("preview-startup-thread");
    const dependencies = Layer.mergeAll(
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
      Effect.provide(PreviewStandardToolkitHandlersLive.pipe(Layer.provide(dependencies))),
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
                runtimeModeCeiling: "approval-required",
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
        Effect.provide(PreviewStandardToolkitHandlersLive.pipe(Layer.provide(dependencies))),
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
          _tag: "PreviewAutomationUnavailableError",
          capability: "preview",
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
